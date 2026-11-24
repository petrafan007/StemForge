import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GPU_SERVER_URL,
  checkGpuServerHealth,
  normalizeServerUrl,
  resolveStemUrl,
  separateViaGpuServer,
} from './gpuClient';

test('normalizeServerUrl cleans whitespace, scheme, and trailing slashes', () => {
  assert.equal(normalizeServerUrl(''), DEFAULT_GPU_SERVER_URL);
  assert.equal(normalizeServerUrl(' 127.0.0.1:8000/ '), 'http://127.0.0.1:8000');
  assert.equal(normalizeServerUrl('http://localhost:8000///'), 'http://localhost:8000');
  assert.equal(normalizeServerUrl('https://gpu.local:9000/'), 'https://gpu.local:9000');
});

test('resolveStemUrl joins relative paths and preserves absolute URLs', () => {
  assert.equal(
    resolveStemUrl('http://127.0.0.1:8000/', '/stems/abc123/vocals.wav'),
    'http://127.0.0.1:8000/stems/abc123/vocals.wav'
  );
  assert.equal(
    resolveStemUrl('http://127.0.0.1:8000', 'https://cdn.local/guitar.wav'),
    'https://cdn.local/guitar.wav'
  );
});

test('checkGpuServerHealth parses NVIDIA RTX 4070 health payload', async () => {
  const mockFetch = (async (input: RequestInfo | URL) => {
    assert.equal(String(input), 'http://127.0.0.1:8000/health');
    return new Response(
      JSON.stringify({
        ok: true,
        model: 'htdemucs_6s',
        device: 'cuda',
        cuda: true,
        gpu: 'NVIDIA GeForce RTX 4070',
        vram_gb: 12.0,
        model_loaded: true,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;

  const status = await checkGpuServerHealth('127.0.0.1:8000/', mockFetch);
  assert.equal(status.ok, true);
  assert.equal(status.cuda, true);
  assert.equal(status.gpu, 'NVIDIA GeForce RTX 4070');
  assert.equal(status.vramGb, 12.0);
  assert.equal(status.model, 'htdemucs_6s');
});

test('separateViaGpuServer uploads audio, downloads all 5 WAV stems, and cleans up job', async () => {
  const calledUrls: string[] = [];
  const fakeWav = new Uint8Array([0x52, 0x49, 0x46, 0x46]).buffer;

  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calledUrls.push(`${init?.method ?? 'GET'} ${url}`);

    if (url.includes('/separate')) {
      return new Response(
        JSON.stringify({
          job_id: 'job99',
          model: 'htdemucs_6s',
          device: 'cuda',
          gpu: 'NVIDIA GeForce RTX 4070',
          sample_rate: 44100,
          elapsed_sec: 7.4,
          stems: {
            vocals: '/stems/job99/vocals.wav',
            guitar: '/stems/job99/guitar.wav',
            bass: '/stems/job99/bass.wav',
            drums: '/stems/job99/drums.wav',
            keyboards: '/stems/job99/keyboards.wav',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (init?.method === 'DELETE') {
      return new Response(JSON.stringify({ deleted: true }), { status: 200 });
    }

    return new Response(fakeWav, { status: 200, headers: { 'Content-Type': 'audio/wav' } });
  }) as typeof fetch;

  const file = new File([new Uint8Array([1, 2, 3, 4])], 'rock_song.mp3', { type: 'audio/mpeg' });
  const result = await separateViaGpuServer(file, 'http://127.0.0.1:8000', false, undefined, mockFetch);

  assert.equal(result.meta.gpu, 'NVIDIA GeForce RTX 4070');
  assert.equal(result.meta.elapsed_sec, 7.4);
  assert.equal(result.wavBytes.vocals.byteLength, 4);
  assert.equal(result.wavBytes.guitar.byteLength, 4);
  assert.equal(result.wavBytes.bass.byteLength, 4);
  assert.equal(result.wavBytes.drums.byteLength, 4);
  assert.equal(result.wavBytes.keyboards.byteLength, 4);
  assert.ok(calledUrls.some((c) => c === 'POST http://127.0.0.1:8000/separate?piano_only=false&transcribe=true'));
  assert.ok(calledUrls.some((c) => c === 'DELETE http://127.0.0.1:8000/stems/job99'));
});
