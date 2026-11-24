import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GPU_SERVER_URL,
  checkGpuServerHealth,
  createProject,
  normalizeServerUrl,
  resolveServerUrl,
  waitForProject,
  type JobStatus,
} from './serverApi';

test('normalizeServerUrl cleans whitespace, scheme, and trailing slashes', () => {
  assert.equal(normalizeServerUrl(''), DEFAULT_GPU_SERVER_URL);
  assert.equal(normalizeServerUrl(' 127.0.0.1:8000/ '), 'http://127.0.0.1:8000');
  assert.equal(normalizeServerUrl('http://localhost:8000///'), 'http://localhost:8000');
  assert.equal(normalizeServerUrl('https://gpu.local:9000/'), 'https://gpu.local:9000');
});

test('resolveServerUrl joins relative paths and preserves absolute URLs', () => {
  assert.equal(resolveServerUrl('http://127.0.0.1:8000/', '/projects/abc/stems/vocals.flac'), 'http://127.0.0.1:8000/projects/abc/stems/vocals.flac');
  assert.equal(resolveServerUrl('http://127.0.0.1:8000', 'https://cdn.local/guitar.wav'), 'https://cdn.local/guitar.wav');
});

test('checkGpuServerHealth parses the RTX 4070 health payload', async () => {
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
        vram_free_gb: 10.8,
        model_loaded: true,
        transcriber: 'basic-pitch',
        drum_transcriber: 'adtof',
        projects: true,
        projects_dir: 'D:\\Documents\\StemForge\\Projects',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;

  const status = await checkGpuServerHealth('127.0.0.1:8000/', mockFetch);
  assert.equal(status.ok, true);
  assert.equal(status.cuda, true);
  assert.equal(status.gpu, 'NVIDIA GeForce RTX 4070');
  assert.equal(status.vramGb, 12.0);
  assert.equal(status.vramFreeGb, 10.8);
  assert.equal(status.drumTranscriber, 'adtof');
  assert.equal(status.supportsProjects, true);
});

test('createProject uploads the file with processing options, then waitForProject polls to completion', async () => {
  const calls: string[] = [];
  let polls = 0;
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/projects') && init?.method === 'POST') {
      const form = init.body as FormData;
      const opts = JSON.parse(String(form.get('options')));
      assert.equal(opts.quality, 'high');
      assert.equal((form.get('file') as File).name, 'riff.flac');
      return new Response(JSON.stringify({ id: 'p1', title: 'riff' }), { status: 200 });
    }
    if (url.endsWith('/projects/p1/status')) {
      polls += 1;
      const body: JobStatus =
        polls < 3
          ? { status: 'processing', stage: 'Separating', percent: polls * 30, error: null }
          : { status: 'ready', stage: 'Done', percent: 100, error: null };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;

  const file = new File([new Uint8Array([1, 2, 3])], 'riff.flac', { type: 'audio/flac' });
  const created = await createProject('http://127.0.0.1:8000', file, { quality: 'high' }, mockFetch);
  assert.equal(created.id, 'p1');

  const seen: number[] = [];
  const final = await waitForProject('http://127.0.0.1:8000', 'p1', (s) => seen.push(s.percent), { intervalMs: 1 }, mockFetch);
  assert.equal(final.status, 'ready');
  assert.deepEqual(seen, [30, 60, 100]);
  assert.ok(calls.includes('POST http://127.0.0.1:8000/projects'));
});

test('server errors surface the detail message', async () => {
  const mockFetch = (async () => new Response(JSON.stringify({ detail: 'The GPU ran out of memory' }), { status: 503 })) as typeof fetch;
  const file = new File([new Uint8Array([1])], 'a.wav');
  await assert.rejects(() => createProject('http://127.0.0.1:8000', file, {}, mockFetch), /GPU ran out of memory/);
});
