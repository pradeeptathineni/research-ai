import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { searchApi } from './search-api.js';
import { signalSearch } from './signal-search.js';
import { RunnerFailure } from './search-runner.js';
import { loadLibrary } from './library.js';
import { loadRun, cleanRuns } from './search-store.js';
import { searchLibrary } from '../../domain/src/library-search.js';
import { saveLibraryLead } from './library-leads.js';

it('retains an incomplete note, reconciles a cold acknowledgement, and preserves its history after unsave', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-s04-note-')));
  const note =
    'Provisional 🧪 [field guide](https://example.org/field-guide). Export rights remain unknown.';
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
          reason: 'offline',
        }),
        discover: async (_request, _signal, _progress, _hints, brief) => {
          brief?.({ format: 'markdown', text: note });
          throw new RunnerFailure(
            'cancelled',
            0,
            { cleanup: { complete: false, error: 'process_group_cleanup_failed' } },
            { format: 'markdown', text: note },
          );
        },
      },
    });
  });
  const server = createServer((request, response) => void api(request, response));
  let coldServer: ReturnType<typeof createServer> | null = null;
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing_test_port');
  const base = `http://127.0.0.1:${address.port}/signals-ai/__signals/api/`;
  try {
    const { token } = (await (await fetch(base + 'session')).json()) as { token: string };
    const post = (route: string, body: unknown) =>
      fetch(base + route, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-signals-token': token },
        body: JSON.stringify(body),
      });
    const started = await post('search', {
      query: 'portable field guide',
      method: 'answer-first',
      cache: 'memory',
      save: 'never',
    });
    const { id } = (await started.json()) as { id: string };
    let run: {
      result?: { runId: string; status: string; brief?: { text: string }; answerReceipt?: unknown };
    } = {};
    for (let attempt = 0; attempt < 80; attempt++) {
      run = await (await fetch(base + 'runs/' + id)).json();
      if (run.result) break;
      await new Promise((done) => setTimeout(done, 25));
    }
    expect(run.result?.brief?.text).toBe(note);
    expect(run.result?.answerReceipt).toBeUndefined();
    const runId = run.result!.runId;
    expect(await loadLibrary(root)).toEqual([]);
    expect((await post('retain-answer', { runId })).status).toBe(200);
    const path = join(root, '.signals/runs', runId + '.json');
    const original = await readFile(path);
    const retry = await post('retain-answer', { runId });
    expect(retry.status).toBe(200);
    expect(await readFile(path)).toEqual(original);
    const [finding] = searchLibrary(await loadLibrary(root), '"field guide"');
    expect(finding?.finding.partialNote).toMatchObject({
      status: expect.stringMatching(/failed|cancelled/),
      sha256: createHash('sha256').update(note).digest('hex'),
    });
    expect((await loadRun(runId, root)).brief?.text).toBe(note);
    expect((await post('library-saved', { key: finding!.finding.key, saved: false })).status).toBe(
      200,
    );
    expect((await loadLibrary(root)).find((row) => row.key === finding!.finding.key)?.saved).toBe(
      false,
    );
    expect(await readFile(path)).toEqual(original);
    expect(calls).toBe(1);
    expect((await post('retain-answer', { runId: randomUUID() })).status).toBe(400);
    const coldApi = searchApi(root, () => {
      calls++;
      throw new Error('generation_must_not_run');
    });
    coldServer = createServer((request, response) => void coldApi(request, response));
    await new Promise<void>((done) => coldServer!.listen(0, '127.0.0.1', done));
    const coldAddress = coldServer.address();
    if (!coldAddress || typeof coldAddress === 'string') throw new Error('missing_cold_port');
    const coldBase = `http://127.0.0.1:${coldAddress.port}/signals-ai/__signals/api/`;
    const coldToken = ((await (await fetch(coldBase + 'session')).json()) as { token: string })
      .token;
    expect(
      (
        await fetch(coldBase + 'retain-answer', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-signals-token': coldToken },
          body: JSON.stringify({ runId }),
        })
      ).status,
    ).toBe(200);
    expect(calls).toBe(1);
    expect(await readFile(path)).toEqual(original);
    await utimes(path, new Date(0), new Date(0));
    await cleanRuns(root);
    expect(await readFile(path)).toEqual(original);
    const lead = await saveLibraryLead(
      root,
      {
        uri: 'https://example.org/unrelated',
        name: 'Unrelated valid lead',
        description: 'Still available',
        limits: [],
      },
      runId,
      'unrelated valid selection',
    );
    await writeFile(path, '{');
    const coverage: string[] = [];
    const available = await loadLibrary(root, { coverage });
    expect(available.find((row) => row.key === lead.key)?.title).toBe('Unrelated valid lead');
    expect(coverage).toEqual(
      expect.arrayContaining([expect.stringContaining('unavailable or invalid')]),
    );
    expect(available.find((row) => row.key === finding!.finding.key)?.partialNote).toMatchObject({
      status: 'unknown',
      unavailableReason: expect.any(String),
    });
  } finally {
    if (coldServer) await new Promise<void>((done) => coldServer!.close(() => done()));
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
