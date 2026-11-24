import type { DrumHitEvent, MidiNoteEvent, SongProject, StemId, StemMixerState } from '../types/music';
import { midiToFrequency } from './notationEngine';

export class MultiStemAudioEngine {
  private ctx: AudioContext | null = null;
  private sources: Partial<Record<StemId, AudioBufferSourceNode>> = {};
  private gains: Partial<Record<StemId, GainNode>> = {};
  private panners: Partial<Record<StemId, StereoPannerNode>> = {};
  private masterGain: GainNode | null = null;
  private masterLimiter: DynamicsCompressorNode | null = null;

  private project: SongProject | null = null;
  private mixerState: Record<StemId, StemMixerState> | null = null;

  private isPlaying = false;
  private playbackRate = 1.0;
  private transposeSemitones = 0;
  private loopEnabled = true;
  private metronomeEnabled = false;
  private midiPreviewMode: 'off' | 'keyboards' | 'drums' | 'combined' = 'off';
  private midiKeyNotes: MidiNoteEvent[] = [];
  private midiDrumHits: DrumHitEvent[] = [];

  private startedAtCtxTime = 0;
  private pausedOffsetSec = 0;
  private schedulerTimer: number | null = null;
  private lastScheduledBeat = -1;

  public ensureContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.94;

      // Transparent studio brickwall limiter prevents digital clipping even if stem faders are boosted
      this.masterLimiter = this.ctx.createDynamicsCompressor();
      this.masterLimiter.threshold.value = -1.5;
      this.masterLimiter.knee.value = 4;
      this.masterLimiter.ratio.value = 16;
      this.masterLimiter.attack.value = 0.002;
      this.masterLimiter.release.value = 0.08;

      this.masterGain.connect(this.masterLimiter);
      this.masterLimiter.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  public loadProject(
    project: SongProject,
    mixer: Record<StemId, StemMixerState>,
    midiKeyNotes: MidiNoteEvent[],
    midiDrumHits: DrumHitEvent[]
  ): void {
    this.stop();
    this.project = project;
    this.mixerState = mixer;
    this.midiKeyNotes = midiKeyNotes;
    this.midiDrumHits = midiDrumHits;
    this.pausedOffsetSec = 0;
  }

  public updateMidiData(keyNotes: MidiNoteEvent[], drumHits: DrumHitEvent[]): void {
    this.midiKeyNotes = keyNotes;
    this.midiDrumHits = drumHits;
  }

  public setMidiPreviewMode(mode: 'off' | 'keyboards' | 'drums' | 'combined'): void {
    this.midiPreviewMode = mode;
    this.applyMixerGains();
  }

  public setMixerState(mixer: Record<StemId, StemMixerState>): void {
    this.mixerState = mixer;
    this.applyMixerGains();
  }

  public setPlaybackRate(rate: number): void {
    const current = this.getCurrentTime();
    this.playbackRate = Math.max(0.5, Math.min(1.5, rate));
    if (this.isPlaying) {
      this.startFrom(current);
    }
  }

  public setTranspose(semitones: number): void {
    this.transposeSemitones = Math.max(-6, Math.min(6, semitones));
    const detuneCents = this.transposeSemitones * 100;
    const melodicStems: StemId[] = ['vocals', 'guitar', 'bass', 'keyboards'];
    for (const id of melodicStems) {
      const src = this.sources[id];
      if (src) {
        src.detune.setValueAtTime(detuneCents, this.ctx?.currentTime ?? 0);
      }
    }
  }

  public setLoop(enabled: boolean): void {
    this.loopEnabled = enabled;
    Object.values(this.sources).forEach((src) => {
      if (src) src.loop = enabled;
    });
  }

  public setMetronome(enabled: boolean): void {
    this.metronomeEnabled = enabled;
  }

  public getIsPlaying(): boolean {
    return this.isPlaying;
  }

  public getCurrentTime(): number {
    if (!this.project) return 0;
    if (!this.isPlaying || !this.ctx) return this.pausedOffsetSec;

    const elapsed = (this.ctx.currentTime - this.startedAtCtxTime) * this.playbackRate;
    const raw = this.pausedOffsetSec + elapsed;
    if (this.loopEnabled && this.project.duration > 0) {
      return raw % this.project.duration;
    }
    return Math.min(this.project.duration, raw);
  }

  public async play(): Promise<void> {
    if (!this.project) return;
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    if (this.pausedOffsetSec >= this.project.duration - 0.05) {
      this.pausedOffsetSec = 0;
    }
    this.startFrom(this.pausedOffsetSec);
  }

  public pause(): void {
    if (!this.isPlaying) return;
    this.pausedOffsetSec = this.getCurrentTime();
    this.teardownSources();
    this.isPlaying = false;
  }

  public stop(): void {
    this.teardownSources();
    this.isPlaying = false;
    this.pausedOffsetSec = 0;
    this.lastScheduledBeat = -1;
  }

  public seek(timeSec: number): void {
    if (!this.project) return;
    const clamped = Math.max(0, Math.min(this.project.duration, timeSec));
    this.pausedOffsetSec = clamped;
    this.lastScheduledBeat = -1;
    if (this.isPlaying) {
      this.startFrom(clamped);
    }
  }

  /**
   * Triggers a single immediate MIDI preview tone when clicking notes in Piano Roll or Chord Diagrams.
   */
  public triggerPreviewNote(midi: number, durationSec = 0.4, isDrum = false): void {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }
    const now = ctx.currentTime;
    if (isDrum) {
      this.scheduleDrumSynthHit(ctx, midi, now, 110);
    } else {
      this.scheduleKeySynthNote(ctx, midi + this.transposeSemitones, now, durationSec, 95);
    }
  }

  public triggerChordPreview(midis: number[]): void {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }
    const now = ctx.currentTime;
    midis.forEach((m, idx) => {
      this.scheduleKeySynthNote(ctx, m + this.transposeSemitones, now + idx * 0.03, 0.75, 82);
    });
  }

  private startFrom(offsetSec: number): void {
    if (!this.project || !this.mixerState) return;
    const ctx = this.ensureContext();
    this.teardownSources();

    const startTime = ctx.currentTime + 0.02;
    this.startedAtCtxTime = startTime;
    this.pausedOffsetSec = offsetSec;
    this.isPlaying = true;
    this.lastScheduledBeat = -1;

    const stemIds: StemId[] = ['vocals', 'guitar', 'bass', 'drums', 'keyboards'];
    for (const id of stemIds) {
      const stem = this.project.stems[id];
      const src = ctx.createBufferSource();
      src.buffer = stem.buffer;
      src.playbackRate.value = this.playbackRate;
      src.loop = this.loopEnabled;
      if (id !== 'drums') {
        src.detune.value = this.transposeSemitones * 100;
      }

      const gain = ctx.createGain();
      const panner = ctx.createStereoPanner();
      src.connect(gain);
      gain.connect(panner);
      panner.connect(this.masterGain!);

      this.sources[id] = src;
      this.gains[id] = gain;
      this.panners[id] = panner;

      src.start(startTime, offsetSec % Math.max(0.01, stem.buffer.duration));
    }

    this.applyMixerGains();
    this.startAuxScheduler();
  }

  private applyMixerGains(): void {
    if (!this.mixerState || !this.ctx) return;
    const anySolo = (Object.values(this.mixerState) as StemMixerState[]).some((s) => s.solo);
    const now = this.ctx.currentTime;

    (['vocals', 'guitar', 'bass', 'drums', 'keyboards'] as StemId[]).forEach((id) => {
      const state = this.mixerState![id];
      const gainNode = this.gains[id];
      const panNode = this.panners[id];
      if (!gainNode || !panNode) return;

      let effectiveGain = state.muted ? 0 : state.volume;
      if (anySolo && !state.solo) {
        effectiveGain = 0;
      }

      // If MIDI Preview Mode is active, gently duck the corresponding acoustic stem so the MIDI synth shines
      if (
        (this.midiPreviewMode === 'keyboards' && id === 'keyboards') ||
        (this.midiPreviewMode === 'drums' && id === 'drums') ||
        (this.midiPreviewMode === 'combined' && (id === 'keyboards' || id === 'drums'))
      ) {
        effectiveGain *= 0.15;
      }

      gainNode.gain.setTargetAtTime(effectiveGain, now, 0.015);
      panNode.pan.setTargetAtTime(state.pan, now, 0.015);
    });
  }

  private startAuxScheduler(): void {
    if (this.schedulerTimer !== null) {
      window.clearInterval(this.schedulerTimer);
    }
    this.schedulerTimer = window.setInterval(() => {
      if (!this.isPlaying || !this.project || !this.ctx) return;
      const curTime = this.getCurrentTime();
      const bpm = this.project.bpm;
      const secPerBeat = 60 / bpm;
      const currentBeat = curTime / secPerBeat;
      const lookaheadBeats = 0.25;

      // Metronome click on quarter beats
      if (this.metronomeEnabled) {
        const nextWholeBeat = Math.floor(currentBeat + 0.05);
        if (nextWholeBeat !== this.lastScheduledBeat && nextWholeBeat >= 0) {
          this.lastScheduledBeat = nextWholeBeat;
          const isDownbeat = nextWholeBeat % this.project.timeSignature[0] === 0;
          this.scheduleClick(this.ctx, this.ctx.currentTime + 0.01, isDownbeat);
        }
      }

      // Real-time MIDI Synth Preview scheduling
      if (this.midiPreviewMode !== 'off') {
        const winStart = currentBeat;
        const winEnd = currentBeat + lookaheadBeats;

        if (this.midiPreviewMode === 'keyboards' || this.midiPreviewMode === 'combined') {
          for (const n of this.midiKeyNotes) {
            if (n.startBeat >= winStart && n.startBeat < winEnd) {
              const dt = ((n.startBeat - winStart) * secPerBeat) / this.playbackRate;
              this.scheduleKeySynthNote(
                this.ctx,
                n.midi + this.transposeSemitones,
                this.ctx.currentTime + dt,
                Math.min(0.8, (n.durationBeats * secPerBeat) / this.playbackRate),
                n.velocity
              );
            }
          }
        }

        if (this.midiPreviewMode === 'drums' || this.midiPreviewMode === 'combined') {
          for (const h of this.midiDrumHits) {
            if (h.startBeat >= winStart && h.startBeat < winEnd) {
              const dt = ((h.startBeat - winStart) * secPerBeat) / this.playbackRate;
              this.scheduleDrumSynthHit(this.ctx, h.midi, this.ctx.currentTime + dt, h.velocity);
            }
          }
        }
      }
    }, 60);
  }

  private scheduleClick(ctx: AudioContext, time: number, accent: boolean): void {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(accent ? 1320 : 880, time);
    g.gain.setValueAtTime(accent ? 0.22 : 0.12, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.04);
    osc.connect(g).connect(this.masterGain!);
    osc.start(time);
    osc.stop(time + 0.05);
  }

  private scheduleKeySynthNote(
    ctx: AudioContext,
    midi: number,
    time: number,
    duration: number,
    velocity: number
  ): void {
    const osc = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const g = ctx.createGain();
    const freq = midiToFrequency(midi);
    osc.type = 'triangle';
    osc2.type = 'sine';
    osc.frequency.setValueAtTime(freq, time);
    osc2.frequency.setValueAtTime(freq * 2, time);

    const amp = (velocity / 127) * 0.16;
    g.gain.setValueAtTime(0.001, time);
    g.gain.linearRampToValueAtTime(amp, time + 0.012);
    g.gain.exponentialRampToValueAtTime(0.001, time + Math.max(0.08, duration));

    osc.connect(g);
    osc2.connect(g);
    g.connect(this.masterGain!);
    osc.start(time);
    osc2.start(time);
    osc.stop(time + duration + 0.05);
    osc2.stop(time + duration + 0.05);
  }

  private scheduleDrumSynthHit(ctx: AudioContext, midi: number, time: number, velocity: number): void {
    const amp = (velocity / 127) * 0.35;
    if (midi === 36) {
      // Kick
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.frequency.setValueAtTime(140, time);
      osc.frequency.exponentialRampToValueAtTime(45, time + 0.12);
      g.gain.setValueAtTime(amp, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.18);
      osc.connect(g).connect(this.masterGain!);
      osc.start(time);
      osc.stop(time + 0.2);
    } else if (midi === 38 || midi === 45) {
      // Snare / Tom
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(midi === 38 ? 210 : 130, time);
      osc.frequency.exponentialRampToValueAtTime(midi === 38 ? 110 : 80, time + 0.1);
      g.gain.setValueAtTime(amp * 0.85, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.14);
      osc.connect(g).connect(this.masterGain!);
      osc.start(time);
      osc.stop(time + 0.16);
    } else {
      // Hi-hat / Crash
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(midi === 49 ? 6200 : 8400, time);
      g.gain.setValueAtTime(amp * 0.25, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + (midi === 42 ? 0.05 : 0.18));
      osc.connect(g).connect(this.masterGain!);
      osc.start(time);
      osc.stop(time + 0.2);
    }
  }

  private teardownSources(): void {
    if (this.schedulerTimer !== null) {
      window.clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    Object.values(this.sources).forEach((src) => {
      if (!src) return;
      try {
        src.stop();
        src.disconnect();
      } catch {
        // Already stopped
      }
    });
    this.sources = {};
    this.gains = {};
    this.panners = {};
  }

  public dispose(): void {
    this.stop();
    if (this.ctx && this.ctx.state !== 'closed') {
      void this.ctx.close();
    }
    this.ctx = null;
  }
}
