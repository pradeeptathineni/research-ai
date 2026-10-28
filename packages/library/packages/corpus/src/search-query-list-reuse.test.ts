import { expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  runQueryListOnce,
  loadQueryBatch,
  queryBatchHistory,
  planQueryAcquisition,
} from './search-query-list.js';
import { defaultSettings, type SearchSettings } from './search-settings.js';
import { selectionHistory, atomicJson, saveEntities } from './search-store.js';
import { budgets, parseRequest, type SearchResult } from '../../domain/src/search-contract.js';
import { digest } from './search-fetch.js';
import { acceptDiscovery } from './signal-search.js';

const interests = (): SearchSettings => ({
  ...structuredClone(defaultSettings),
  route: 'native',
  profile: 'quick',
  batchSize: 10,
  destination: 'private',
  supplementalSites: [],
  queries: ['first', 'second'].map((id) => ({
    id,
    query: 'wet soil drainage',
    context: 'Garden maintenance',
    concepts: [`concept.${id}`],
    supplementalSites: [],
    enabled: true,
    everyDays: 7,
    offsetMinutes: 0,
  })),
});
function result(input: unknown, status: SearchResult['status'] = 'completed'): SearchResult {
  const request = parseRequest(input);
  return {
    schemaVersion: 2,
    runId: randomUUID(),
    query: request.query,
    status,
    items: [],
    sources: [],
    coverage: [],
    gaps: ['fixture scope gap'],
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
}
async function fixture(operation: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-exact-needs-')));
  try {
    await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it('claims exact aliases together and retains both interest receipts with one underlying run', async () => {
  await fixture(async (root) => {
    const acquired = await acceptDiscovery(
      {
        sources: [
          {
            uri: 'https://example.org/drainage',
            title: 'Drainage guide',
            publisher: 'Author',
            family: 'primary',
            publishedAt: null,
            origin: 'original',
          },
        ],
        candidates: [
          {
            uri: 'https://example.org/drainage',
            name: 'Drainage guide',
            kind: 'learning-resource',
            identity: 'resolved',
            aliases: [],
            description: 'Drainage methods',
            facets: {
              domains: [],
              capabilities: [],
              interfaces: [],
              deliveryForms: [],
              platforms: [],
              licenses: [],
              tags: [],
            },
            limits: [],
            match: { level: 'direct', reason: 'Addresses drainage', sources: [0] },
            observations: [
              {
                source: 0,
                feature: 'defining',
                indicator: 'defines',
                statement: 'Describes drainage methods.',
                quote: 'Describes drainage methods',
                independent: false,
                origin: 'original',
                status: 'supported',
              },
            ],
          },
        ],
        coverage: [],
        gaps: [],
      },
      { query: 'wet soil drainage' },
      {
        fetch: async (uri) => ({
          uri,
          text: 'Describes drainage methods for wet soil.',
          digest: digest('fixture drainage text'),
        }),
      },
    );
    let calls = 0;
    const batch = await runQueryListOnce({
      root,
      settings: interests(),
      search: async (input) => {
        calls++;
        const pending = await loadQueryBatch((await queryBatchHistory(root))[0]!.id, root);
        expect(pending.jobs.map((job) => job.status)).toEqual(['running', 'running']);
        expect(pending.jobs[1]!.reusedFromJobId).toBe('first');
        return { ...result(input, 'partial'), ...acquired, gaps: ['fixture scope gap'] };
      },
    });
    expect(calls).toBe(1);
    expect(batch.jobs.map((job) => job.status)).toEqual(['partial', 'partial']);
    expect(batch.jobs[0]!.runId).toBe(batch.jobs[1]!.runId);
    expect(batch.jobs.map((job) => job.gaps)).toEqual([
      ['fixture scope gap'],
      ['fixture scope gap'],
    ]);
    const receipts = await selectionHistory(root);
    expect(receipts.map((row) => row.queryId)).toEqual(['first', 'second']);
    expect(receipts.map((row) => row.concepts)).toEqual([['concept.first'], ['concept.second']]);
    expect(new Set(receipts.map((row) => row.id)).size).toBe(2);
    expect(new Set(receipts.map((row) => row.runId)).size).toBe(1);
    expect(receipts.map((row) => row.selected)).toEqual([
      [acquired.items[0]!.entity.id],
      [acquired.items[0]!.entity.id],
    ]);
  });
});

it('does not merge changed context or scopes and snapshots settings before acquisition', async () => {
  await fixture(async (root) => {
    const settings = interests();
    settings.queries[1]!.context = 'Indoor plants';
    settings.queries.push({
      ...settings.queries[0]!,
      id: 'third',
      supplementalSites: ['https://example.org'],
    });
    const requests: ReturnType<typeof parseRequest>[] = [];
    const batch = await runQueryListOnce({
      root,
      settings,
      search: async (input) => {
        requests.push(parseRequest(input));
        settings.route = 'assessed';
        settings.queries[1]!.context = 'mutated after snapshot';
        return result(input);
      },
    });
    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.route)).toEqual(['native', 'native', 'native']);
    expect(requests[1]!.context).toBe('Indoor plants');
    expect(requests[2]!.supplementalSites).toEqual(['https://example.org/']);
    expect(batch.jobs.every((job) => !job.reusedFromJobId)).toBe(true);
  });
});

it('counts the limit in interests and does not reuse a prior invocation on resume', async () => {
  await fixture(async (root) => {
    let calls = 0;
    const search = async (input: unknown) => {
      calls++;
      return result(input);
    };
    const first = await runQueryListOnce({ root, settings: interests(), limit: 1, search });
    expect(first.jobs.map((job) => job.status)).toEqual(['completed', 'pending']);
    const resumed = await runQueryListOnce({
      root,
      settings: interests(),
      resume: first.id,
      search,
    });
    expect(calls).toBe(2);
    expect(resumed.jobs.every((job) => job.status === 'completed')).toBe(true);
    expect(resumed.jobs[0]!.runId).not.toBe(resumed.jobs[1]!.runId);
    expect(resumed.jobs[1]!.reusedFromJobId).toBeUndefined();
  });
});

it('leaves interrupted aliases uncertain and never implicitly retries them', async () => {
  await fixture(async (root) => {
    let calls = 0;
    const search = async (input: unknown) => {
      calls++;
      return result(input);
    };
    await expect(
      runQueryListOnce({
        root,
        settings: interests(),
        search,
        progress: (event) => {
          if (event.startsWith('Research ')) throw new Error('simulated interruption');
        },
      }),
    ).rejects.toThrow('simulated interruption');
    const id = (await queryBatchHistory(root))[0]!.id;
    expect((await loadQueryBatch(id, root)).jobs.map((job) => job.status)).toEqual([
      'running',
      'running',
    ]);
    const resumed = await runQueryListOnce({ root, settings: interests(), resume: id, search });
    expect(resumed.jobs.map((job) => job.status)).toEqual(['uncertain', 'uncertain']);
    expect(calls).toBe(0);
  });
});

it('cancels exact aliases together while unrelated pending work remains pending', async () => {
  await fixture(async (root) => {
    const settings = interests();
    settings.queries.push({ ...settings.queries[0]!, id: 'third', query: 'roof drainage' });
    const controller = new AbortController();
    let calls = 0;
    const batch = await runQueryListOnce({
      root,
      settings,
      signal: controller.signal,
      search: async (input) => {
        calls++;
        controller.abort();
        return result(input, 'cancelled');
      },
    });
    expect(calls).toBe(1);
    expect(batch.jobs.map((job) => job.status)).toEqual(['cancelled', 'cancelled', 'pending']);
    expect(await selectionHistory(root)).toHaveLength(0);
  });
});

it('preserves a historical receipt ID and appends distinct scope-aware successors idempotently', async () => {
  await fixture(async (root) => {
    const runId = randomUUID();
    const oldId = digest(`${runId}:eligible:private:`);
    const original = {
      id: oldId,
      at: '2026-10-07T00:00:00Z',
      runId,
      query: 'wet soil drainage',
      kind: 'query-discovery' as const,
      queryId: 'first',
      concepts: ['concept.first'],
      mode: 'eligible',
      destination: 'private',
      selected: [],
      changed: [],
      skipped: [],
    };
    await atomicJson(join(root, '.signals/selections.json'), [original]);
    for (const queryId of ['first', 'second', 'second'])
      await saveEntities([], 'eligible', root, 'private', 75, false, {
        runId,
        query: original.query,
        kind: 'query-discovery',
        queryId,
        concepts: [`concept.${queryId}`],
        needDigest: digest('bounded effective configuration'),
      });
    const rows = await selectionHistory(root);
    expect(rows[0]).toEqual(original);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
  });
});

it('shares native-suggested acquisition while retaining separate reasoning, delivery and status', async () => {
  await fixture(async (root) => {
    const settings = interests();
    settings.queries[1]!.query = 'drainage for indoor containers';
    settings.queries[1]!.context = 'Indoor plants';
    settings.acquisitionGroups = [
      {
        id: 'drainage',
        members: ['first', 'second'],
        query: 'drainage',
        reason:
          'Native planner suggested shared source acquisition; garden and container fit differ.',
        proposedBy: 'native',
      },
    ];
    expect(planQueryAcquisition(settings).groups[0]!.members).toEqual(['first', 'second']);
    let acquired = 0;
    const requests: string[] = [];
    const counted: number[] = [];
    const batch = await runQueryListOnce({
      root,
      settings,
      acquire: async (input) => {
        acquired++;
        expect(input.query).toBe('drainage');
        return {
          schemaVersion: 1,
          query: input.query,
          kind: 'unassessed-source-hits',
          modelCalls: 0,
          searches: 2,
          gaps: ['Fixture route limitation'],
          hits: [
            {
              provider: 'github',
              rank: 1,
              uri: 'https://github.com/example/drainage',
              evidenceUri: 'https://api.github.com/repos/example/drainage',
              title: 'A locator',
              summary: 'Unassessed description',
              popularity: {},
            },
          ],
        };
      },
      search: async (input, dependencies) => {
        const request = parseRequest(input);
        requests.push(request.query);
        counted.push(dependencies?.acquisitionHints?.searches ?? -1);
        expect(dependencies?.acquisitionHints?.hits[0]!.title).toBe('A locator');
        if (requests.length === 1) throw new Error('Fixture first-interest failure');
        return result(input);
      },
    });
    expect(acquired).toBe(1);
    expect(requests).toEqual(['wet soil drainage', 'drainage for indoor containers']);
    expect(counted).toEqual([2, 0]);
    expect(batch.jobs.map((job) => job.status)).toEqual(['failed', 'completed']);
    expect(batch.jobs.every((job) => !job.reusedFromJobId)).toBe(true);
    expect((await loadQueryBatch(batch.id, root)).acquisitionPlan).toEqual(batch.acquisitionPlan);
  });
});

it('rejects incompatible semantic acquisition scopes and honors explicit opt-out before any acquisition', async () => {
  await fixture(async (root) => {
    const settings = interests();
    settings.queries[1]!.query = 'container drainage';
    settings.acquisitionGroups = [
      {
        id: 'drainage',
        members: ['first', 'second'],
        query: 'drainage',
        reason: 'Native proposal',
        proposedBy: 'native',
      },
    ];
    settings.queries[1]!.supplementalSites = ['https://example.org/indoor'];
    let calls = 0;
    const acquire = async () => {
      throw new Error('acquisition_must_not_run');
    };
    const search = async (input: unknown) => {
      calls++;
      return result(input);
    };
    await expect(runQueryListOnce({ root, settings, search, acquire })).rejects.toThrow(
      'incompatible_acquisition_scopes',
    );
    expect(calls).toBe(0);
    settings.queries[1]!.shareAcquisition = false;
    expect(planQueryAcquisition(settings)).toMatchObject({ groups: [], optedOut: ['second'] });
    const batch = await runQueryListOnce({ root, settings, search, acquire });
    expect(calls).toBe(2);
    expect(batch.acquisitionPlan).toEqual([]);
  });
});
