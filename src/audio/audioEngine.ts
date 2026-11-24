import type { DrumHitEvent, MidiNoteEvent, SongProject, StemId, StemMixerState } from '../types/music';
import { ALL_STEM_IDS } from '../types/music';
import { midiToFrequency } from './notationEngine';
import { barStartsFor, isBarStart } from './bars';
import { beatToTime, quarterBeatsPerMeasure, timeToBeat } from './timeline';

/**
 * Pitch handling:
 *  - 'buffers'   : the caller swaps in pitch-shifted stems (server Rubber Band render) so key changes
 *                  keep the original tempo. Used for songs in the project library.
 *  - 'varispeed' : every stem (drums included) is resampled together, like a tape machine, so the
 *                  tracks stay in sync; key and speed change together. Used for demos/browser imports.
 */
export type PitchMode = 'buffers' | 'varispeed';

export class MultiStemAudioEngine {
  private ctx: AudioContext | null = null;
  private sources: Partial<Record<StemId, AudioBufferSourceNode>> = {};
  private gains: Partial<Record<StemId, GainNode>> = {};
  private panners: Partial<Record<StemId, StereoPannerNode>> = {};
  private masterGain: GainNode | null = null;
  private masterLimiter: DynamicsCompressorNode | null = null;

  private project: SongProject | null = null;
  private mixerState: Record<StemId, StemMixerState> | null = null;
  private bufferOverrides: Partial<Record<StemId, AudioBuffer>> = {};

  private isPlaying = false;
  private playbackRate = 1.0;
  private transposeSemitones = 0;
  private pitchMode: PitchMode = 'varispeed';
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

      // Transparent brickwall limiter prevents digital clipping even if stem faders are boosted
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
    this.bufferOverrides = {};
    this.pausedOffsetSec = 0;
    this.pitchMode = project.serverProjectId ? 'buffers' : 'varispeed';
    this.applyMasterLevel();
  }

  /** Updates note data / tempo grid without interrupting playback. */
  public updateProject(project: SongProject): void {
    this.project = project;
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
    if (this.isPlaying) this.startFrom(current);
  }

  public getPitchMode(): PitchMode {
    return this.pitchMode;
  }

  public setTranspose(semitones: number): void {
    const current = this.getCurrentTime();
    this.transposeSemitones = Math.max(-12, Math.min(12, Math.round(semitones)));
    if (this.pitchMode === 'varispeed' && this.isPlaying) this.startFrom(current);
  }

  /**
   * Swaps in alternative audio for some stems (e.g. pitch-shifted renders) and continues
   * playing from the same position. Pass an empty object to restore the originals.
   */
  public setBufferOverrides(overrides: Partial<Record<StemId, AudioBuffer>>): void {
    const current = this.getCurrentTime();
    this.bufferOverrides = overrides;
    if (this.isPlaying) this.startFrom(current);
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

  private effectiveRate(): number {
    return this.pitchMode === 'varispeed' ? this.playbackRate * 2 ** (this.transposeSemitones / 12) : this.playbackRate;
  }

  /** Song position the audio clock is rendering now (used to schedule sounds). */
  public getCurrentTime(): number {
    if (!this.project) return 0;
    if (!this.isPlaying || !this.ctx) return this.pausedOffsetSec;
    return this.songTimeAt(this.ctx.currentTime);
  }

  /**
   * Song position that is being HEARD right now. The audio clock runs ahead of the speakers by the
   * output latency (buffering + driver + device; Bluetooth can add 100-300 ms), so the playhead and
   * the tab highlight use this instead of getCurrentTime().
   */
  public getAudibleTime(): number {
    if (!this.project) return 0;
    if (!this.isPlaying || !this.ctx) return this.pausedOffsetSec;
    return this.songTimeAt(this.audibleContextTime());
  }

  /** Output latency in seconds (0 when unknown). */
  public getOutputLatency(): number {
    if (!this.ctx) return 0;
    return Math.max(0, this.ctx.currentTime - this.audibleContextTime());
  }

  private audibleContextTime(): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    const now = ctx.currentTime;
    try {
      const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
      if (ts && typeof ts.contextTime === 'number' && typeof ts.performanceTime === 'number' && ts.performanceTime > 0) {
        const est = ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
        const lag = now - est;
        if (lag >= 0 && lag < 0.5) return est;
      }
    } catch {
      // not supported: fall through
    }
    const lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
    return now - (lat > 0 && lat < 0.5 ? lat : 0);
  }

  private songTimeAt(ctxTime: number): number {
    if (!this.project) return 0;
    const elapsed = Math.max(0, ctxTime - this.startedAtCtxTime) * this.effectiveRate();
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
    this.pausedOffsetSec = this.getAudibleTime(); // resume where the listener stopped hearing
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

  /** Single immediate preview tone when clicking notes in the piano roll or chord diagrams. */
  public triggerPreviewNote(midi: number, durationSec = 0.4, isDrum = false): void {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const now = ctx.currentTime;
    if (isDrum) {
      this.scheduleDrumSynthHit(ctx, midi, now, 110);
    } else {
      this.scheduleKeySynthNote(ctx, midi + this.transposeSemitones, now, durationSec, 95);
    }
  }

  public triggerChordPreview(midis: number[]): void {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const now = ctx.currentTime;
    midis.forEach((m, idx) => {
      this.scheduleKeySynthNote(ctx, m + this.transposeSemitones, now + idx * 0.03, 0.75, 82);
    });
  }

  private applyMasterLevel(): void {
    if (!this.masterGain) return;
    const comp = this.project?.levelCompensation ?? 1;
    this.masterGain.gain.value = 0.94 * comp;
  }

  private startFrom(offsetSec: number): void {
    if (!this.project || !this.mixerState) return;
    const ctx = this.ensureContext();
    this.teardownSources();
    this.applyMasterLevel();

    const startTime = ctx.currentTime + 0.02;
    this.startedAtCtxTime = startTime;
    this.pausedOffsetSec = offsetSec;
    this.isPlaying = true;
    this.lastScheduledBeat = -1;

    for (const id of ALL_STEM_IDS) {
      const stem = this.project.stems[id];
      if (!stem) continue;
      const buffer = this.bufferOverrides[id] ?? stem.buffer;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = this.playbackRate;
      src.loop = this.loopEnabled;
      if (this.pitchMode === 'varispeed') {
        src.detune.value = this.transposeSemitones * 100; // all stems together keeps them in sync
      }

      const gain = ctx.createGain();
      const panner = ctx.createStereoPanner();
      src.connect(gain);
      gain.connect(panner);
      panner.connect(this.masterGain!);

      this.sources[id] = src;
      this.gains[id] = gain;
      this.panners[id] = panner;

      src.start(startTime, offsetSec % Math.max(0.01, buffer.duration));
    }

    this.applyMixerGains();
    this.startAuxScheduler();
  }

  private applyMixerGains(): void {
    if (!this.mixerState || !this.ctx || !this.project) return;
    const present = ALL_STEM_IDS.filter((id) => this.project!.stems[id]);
    const anySolo = present.some((id) => this.mixerState![id]?.solo);
    const now = this.ctx.currentTime;

    present.forEach((id) => {
      const state = this.mixerState![id];
      const gainNode = this.gains[id];
      const panNode = this.panners[id];
      if (!gainNode || !panNode || !state) return;

      let effectiveGain = state.muted ? 0 : state.volume;
      if (anySolo && !state.solo) effectiveGain = 0;

      // MIDI preview: duck the matching acoustic stem so the synth is audible
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
    if (this.schedulerTimer !== null) window.clearInterval(this.schedulerTimer);
    this.schedulerTimer = window.setInterval(() => {
      if (!this.isPlaying || !this.project || !this.ctx) return;
      const curTime = this.getCurrentTime();
      const grid = this.project; // bpm / offset or the tempo map
      const currentBeat = timeToBeat(grid, curTime);
      const at = (beat: number) => (beatToTime(grid, beat) - curTime) / rate; // seconds from now
      const rate = this.effectiveRate();
      const lookaheadBeats = 0.25;

      if (this.metronomeEnabled) {
        // schedule each click ahead of time at the beat's exact time (tempo map aware)
        const nextBeat = Math.ceil(currentBeat - 1e-6);
        if (nextBeat !== this.lastScheduledBeat && nextBeat >= 0) {
          const dt = at(nextBeat);
          if (dt <= 0.15) {
            this.lastScheduledBeat = nextBeat;
            const perBar = quarterBeatsPerMeasure(this.project.timeSignature);
            this.scheduleClick(this.ctx, this.ctx.currentTime + Math.max(0, dt), isBarStart(barStartsFor(this.project), nextBeat, perBar));
          }
        }
      }

      if (this.midiPreviewMode !== 'off') {
        const winStart = currentBeat;
        const winEnd = currentBeat + lookaheadBeats;

        if (this.midiPreviewMode === 'keyboards' || this.midiPreviewMode === 'combined') {
          for (const n of this.midiKeyNotes) {
            if (n.startBeat >= winStart && n.startBeat < winEnd) {
              const dt = Math.max(0, at(n.startBeat));
              this.scheduleKeySynthNote(
                this.ctx,
                n.midi + this.transposeSemitones,
                this.ctx.currentTime + dt,
                Math.min(0.8, Math.max(0.03, at(n.startBeat + n.durationBeats) - at(n.startBeat))),
                n.velocity
              );
            }
          }
        }

        if (this.midiPreviewMode === 'drums' || this.midiPreviewMode === 'combined') {
          for (const h of this.midiDrumHits) {
            if (h.startBeat >= winStart && h.startBeat < winEnd) {
              const dt = Math.max(0, at(h.startBeat));
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
    osc.connect(g).connect(this.masterLimiter ?? this.masterGain!);
    osc.start(time);
    osc.stop(time + 0.05);
  }

  private scheduleKeySynthNote(ctx: AudioContext, midi: number, time: number, duration: number, velocity: number): void {
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
    g.connect(this.masterLimiter ?? this.masterGain!);
    osc.start(time);
    osc2.start(time);
    osc.stop(time + duration + 0.05);
    osc2.stop(time + duration + 0.05);
  }

  private scheduleDrumSynthHit(ctx: AudioContext, midi: number, time: number, velocity: number): void {
    const out = this.masterLimiter ?? this.masterGain!;
    const amp = (velocity / 127) * 0.35;
    if (midi === 36 || midi === 35) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.frequency.setValueAtTime(140, time);
      osc.frequency.exponentialRampToValueAtTime(45, time + 0.12);
      g.gain.setValueAtTime(amp, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.18);
      osc.connect(g).connect(out);
      osc.start(time);
      osc.stop(time + 0.2);
    } else if (midi === 38 || midi === 45) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(midi === 38 ? 210 : 130, time);
      osc.frequency.exponentialRampToValueAtTime(midi === 38 ? 110 : 80, time + 0.1);
      g.gain.setValueAtTime(amp * 0.85, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.14);
      osc.connect(g).connect(out);
      osc.start(time);
      osc.stop(time + 0.16);
    } else {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(midi === 49 ? 6200 : 8400, time);
      g.gain.setValueAtTime(amp * 0.25, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + (midi === 42 ? 0.05 : 0.18));
      osc.connect(g).connect(out);
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
    if (this.ctx && this.ctx.state !== 'closed') void this.ctx.close();
    this.ctx = null;
  }
}
