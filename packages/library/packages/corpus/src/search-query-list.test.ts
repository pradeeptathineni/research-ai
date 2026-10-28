import { it, expect } from 'vitest';
import { mkdtemp, realpath, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runQueryListOnce, loadQueryBatch, queryBatchHistory } from './search-query-list.js';
import { defaultSettings } from './search-settings.js';
import { atomicJson } from './search-store.js';
import { budgets, parseRequest, type SearchResult } from '../../domain/src/search-contract.js';

it.each(['native', 'assessed'] as const)(
  'forwards the %s route, keeps recurrence disabled and resumes only pending work without repeating inference',
  async (route) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-list-')));
    const settings = {
      ...structuredClone(defaultSettings),
      profile: 'quick' as const,
      route,
      queries: ['first', 'second', 'third'].map((id) => ({
        id,
        query: `${id} need`,
        context: 'Research reusable practices.',
        concepts: [`concept.${id}`],
        enabled: true,
        everyDays: 7,
        offsetMinutes: 0,
        supplementalSites: ['https://www.reddit.com/r/codex'],
      })),
    };
    let calls = 0;
    const controller = new AbortController();
    const search = async (input: unknown): Promise<SearchResult> => {
      const request = parseRequest(input);
      calls++;
      expect(request.route).toBe(route);
      expect(request.context).toBe('Research reusable practices.');
      expect(request.supplementalSites).toContain('https://www.reddit.com/r/codex');
      controller.abort();
      return {
        schemaVersion: 2,
        runId: randomUUID(),
        query: request.query,
        status: 'cancelled',
        items: [],
        sources: [],
        coverage: [],
        gaps: ['cancelled'],
        counts: { leads: 0, distinct: 0, duplicates: 0, omitted: 0 },
        limits: budgets.quick,
        usage: {
          searches: 0,
          documents: 0,
          elapsedMs: 0,
          modelCalls: 0,
          providerUsage: null,
          cost: null,
        },
      };
    };
    try {
      const first = await runQueryListOnce({ root, settings, signal: controller.signal, search });
      expect((await queryBatchHistory(root))[0]!.pending).toBe(2);
      expect((await loadQueryBatch(first.id, root)).jobs).toEqual(first.jobs);
      expect(settings.queryDiscovery).toBe(false);
      expect(first.jobs.map((job) => job.status)).toEqual(['cancelled', 'pending', 'pending']);
      const path = join(root, '.signals/query-batches', `${first.id}.json`);
      first.jobs[1]!.status = 'running';
      await atomicJson(path, first);
      const resumed = await runQueryListOnce({ root, settings, resume: first.id, search });
      expect(resumed.jobs.map((job) => job.status)).toEqual([
        'cancelled',
        'uncertain',
        'cancelled',
      ]);
      expect(calls).toBe(2);
      await runQueryListOnce({ root, settings, resume: first.id, search });
      expect(calls).toBe(2);
      expect(JSON.parse(await readFile(path, 'utf8')).jobs).toHaveLength(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('rejects concurrent activation of the same batch before model invocation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-list-lease-')));
  const id = randomUUID();
  try {
    await atomicJson(join(root, '.signals/query-batches', `${id}.lease.json`), {
      pid: process.pid,
    });
    await expect(runQueryListOnce({ root, resume: id })).rejects.toThrow('query_batch_busy');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
