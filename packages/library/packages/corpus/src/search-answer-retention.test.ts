import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { searchApi } from './search-api.js';
import { signalSearch } from './signal-search.js';
import { loadRun } from './search-store.js';
import { loadLibrary } from './library.js';

it('retains only an explicitly selected server-owned answer, with exact replay and no inference on save', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-answer-retention-')));
  let calls = 0;
  const api = searchApi(root, (request, dependencies) => {
    calls++;
    return signalSearch(request, {
      ...dependencies,
      runner: {
        evidenceClass: 'fixture',
        readiness: async () => ({
          available: true,
          broadSearch: true,
          runner: 'fixture',
          reason: 'No native provider.',
        }),
        discover: async () => ({
          searches: 0,
          usage: null,
          proposal: {
            answer:
              'A qualified possibility. [Guide](https://example.com/guide). Fit remains unknown.',
          },
        }),
      },
    });
  });
  const server = createServer((request, response) => {
    void api(request, response);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing_port');
  const base = `http://127.0.0.1:${address.port}/signals-ai/__signals/api/`;
  const { token } = (await (await fetch(base + 'session')).json()) as { token: string };
  const headers = { 'content-type': 'application/json', 'x-signals-token': token };
  const post = (route: string, body: unknown, extra = {}) =>
    fetch(base + route, {
      method: 'POST',
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
    });
  try {
    const started = await post('search', {
      query: 'An ordinary question',
      method: 'answer-first',
      cache: 'memory',
      save: 'never',
    });
    const { id } = (await started.json()) as { id: string };
    let snapshot = await (await fetch(base + 'runs/' + id)).json();
    for (let i = 0; i < 80 && !snapshot.result; i++) {
      await new Promise((done) => setTimeout(done, 25));
      snapshot = await (await fetch(base + 'runs/' + id)).json();
    }
    const result = snapshot.result;
    expect(result.answerReceipt.state).toBe('unassessed');
    expect(await loadLibrary(root)).toEqual([]);
    expect(
      (await post('retain-answer', { runId: result.runId }, { 'x-signals-token': 'wrong' })).status,
    ).toBe(403);
    expect(
      (await post('retain-answer', { runId: result.runId }, { origin: 'https://evil.example' }))
        .status,
    ).toBe(403);
    expect((await post('retain-answer', { runId: result.runId, brief: 'forged' })).status).toBe(
      400,
    );
    expect((await post('retain-answer', { runId: randomUUID() })).status).toBe(400);
    expect(await loadLibrary(root)).toEqual([]);
    expect((await post('retain-answer', { runId: result.runId })).status).toBe(200);
    expect(await loadRun(result.runId, root)).toEqual(result);
    const path = join(root, '.signals/runs', result.runId + '.json');
    const bytes = await readFile(path);
    expect((await post('retain-answer', { runId: result.runId })).status).toBe(200);
    expect(await readFile(path)).toEqual(bytes);
    const finding = (await loadLibrary(root))[0]!;
    expect(finding.saved).toBe(true);
    expect(finding.answerText).toBe(result.brief.text);
    expect((await post('library-saved', { key: finding.key, saved: false })).status).toBe(200);
    expect((await loadLibrary(root))[0]!.saved).toBe(false);
    expect(await readFile(path)).toEqual(bytes);
    expect(calls).toBe(1);
    await writeFile(join(root, '.signals/library-state.json'), '{"version":999}');
    const partial = await post('retain-answer', { runId: result.runId });
    expect(partial.status).toBe(500);
    expect(await partial.json()).toEqual({
      code: 'answer_retained_library_update_failed',
      retained: true,
      key: finding.key,
    });
    expect(await readFile(path)).toEqual(bytes);
    expect(calls).toBe(1);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
