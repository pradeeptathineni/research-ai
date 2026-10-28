import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, expect, it } from 'vitest';
import { budgets, type SearchResult } from '../../domain/src/search-contract.js';
import { buildLibraryExploreSnapshot, normalizeLibraryObservationDate } from './library-explore.js';
import {
  exactOwnerRecord,
  providerLibrary,
  providerLibraryExplore,
} from './provider-capabilities.js';
import { planResearchRetention, retainResearchAnswer } from './research-answer.js';
import { saveQuery } from './research-store.js';
import { retainRun } from './search-store.js';
import { requestStore } from './search-request-store.js';
import { searchApi } from './search-api.js';

let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function treeDigest(directory: string): Promise<string> {
  const rows: [string, string][] = [];
  async function visit(path: string, relative: string) {
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = join(path, entry.name);
      const name = join(relative, entry.name);
      if (entry.isDirectory()) await visit(child, name);
      else
        rows.push([
          name,
          createHash('sha256')
            .update(await readFile(child))
            .digest('hex'),
        ]);
    }
  }
  await visit(directory, '');
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

async function answer(query: string, observedAt: string) {
  return retainResearchAnswer(
    root,
    {
      query,
      answer: `Authored synthetic Library exploration fixture for ${query}; no evidence claim is being tested.`,
      observedAt,
      provenance: {
        receipt: 'Authored synthetic fixture; not model output.',
        requestedModel: null,
        servedModel: null,
      },
    },
    [],
  );
}

async function savedAnswerFixture(query: string, observedAt: string) {
  const input = {
    query,
    answer: `Authored synthetic Library exploration fixture for ${query}; no evidence claim is being tested.`,
    observedAt,
    provenance: {
      receipt: 'Authored synthetic fixture; not model output.',
      requestedModel: null,
      servedModel: null,
    },
  };
  const runId = randomUUID();
  await saveQuery(
    { ...planResearchRetention(input), runId, selectedUris: [] },
    join(root, '.signals/queries'),
  );
  return { runId };
}

async function retainedRun(query: string, observedAt: string) {
  const runId = randomUUID();
  const text = `Authored synthetic retained-run fixture for ${query}; no evidence claim is being tested.`;
  const result: SearchResult = {
    schemaVersion: 2,
    runId,
    query,
    status: 'completed',
    brief: { format: 'markdown', text },
    answerReceipt: {
      observedAt,
      sha256: createHash('sha256').update(text).digest('hex'),
      state: 'unassessed',
      confidence: 'unknown',
      provenance: {
        receipt: 'Authored synthetic fixture; not model output.',
        requestedModel: null,
        servedModel: null,
      },
    },
    items: [],
    sources: [],
    coverage: [],
    gaps: ['Synthetic owner fixture; no research or evidence assessment was run.'],
    usage: {
      searches: 0,
      documents: 0,
      modelCalls: 0,
      elapsedMs: 0,
      cost: null,
      providerUsage: null,
    },
    counts: { leads: 0, distinct: 0, duplicates: 0, omitted: 0 },
    limits: budgets.quick,
  };
  await retainRun(result, root);
  return result;
}

it('normalizes only explicit-timezone dates and refuses malformed or ambiguous dates', () => {
  expect(normalizeLibraryObservationDate('2026-10-24T08:09:10Z')).toBe('2026-10-24T08:09:10.000Z');
  expect(normalizeLibraryObservationDate('2026-10-24T10:09:10+02:00')).toBe(
    '2026-10-24T08:09:10.000Z',
  );
  expect(normalizeLibraryObservationDate('2026-10-24T08:09:10')).toBeNull();
  expect(normalizeLibraryObservationDate('2026-02-30T08:09:10Z')).toBeNull();
  expect(normalizeLibraryObservationDate(null)).toBeNull();
});

it('refuses oversized complete datasets rather than returning a partial snapshot', () => {
  const filters = { q: '', kinds: ['answer'], project_ref: null };
  const record = (id: string, summary = 'synthetic') => ({
    ref: { owner: 'signals-ai', kind: 'answer', id, revision: null, digest: null },
    kind: 'answer',
    title: id,
    summary,
    updated_at: '2026-10-24T08:00:00Z',
    observed_at: '2026-10-24T08:00:00Z',
  });
  expect(() =>
    buildLibraryExploreSnapshot({
      identity: randomUUID(),
      epoch: randomUUID(),
      filters,
      records: Array.from({ length: 1001 }, (_, i) => record(`row-${i}`)),
      owner_coverage: [
        { owner: 'signals-ai', state: 'connected', observed_at: '2026-10-24T08:00:00Z' },
      ],
      kinds: ['answer'],
    }),
  ).toThrow(expect.objectContaining({ code: 'library_explore_too_large', status: 413 }));
  expect(() =>
    buildLibraryExploreSnapshot({
      identity: randomUUID(),
      epoch: randomUUID(),
      filters,
      records: Array.from({ length: 900 }, (_, i) => record(`row-${i}`, 'x'.repeat(5000))),
      owner_coverage: [
        { owner: 'signals-ai', state: 'connected', observed_at: '2026-10-24T08:00:00Z' },
      ],
      kinds: ['answer'],
    }),
  ).toThrow(expect.objectContaining({ code: 'library_explore_too_large', status: 413 }));
});

it('returns a complete actual-owner snapshot, stable selection and stale refusal without effects', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'signals-library-explore-')));
  const scope = await requestStore(root).initialize();
  const first = await answer('exploration-fixture-known-000', '2026-10-24T08:00:00Z');
  const unknown = await answer('exploration-fixture-ambiguous-date', '2026-10-24T08:09:10');
  for (let index = 2; index < 105; index++)
    await savedAnswerFixture(
      `exploration-fixture-${String(index).padStart(3, '0')}`,
      `2026-10-24T08:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}Z`,
    );

  const owned = {
    'x-signals-provider-version': '1.0',
    'x-signals-instance-id': scope.identity,
    'x-signals-owner-epoch': scope.epoch,
  };
  const filters = { q: 'exploration-fixture', kinds: ['imported_answer'], project_ref: null };
  const query = new URLSearchParams({ q: filters.q, kinds: filters.kinds[0]! }).toString();
  const direct = await providerLibraryExplore(
    root,
    `/provider/library-explore?${query}`,
    '1.0',
    scope.identity,
    scope.epoch,
  );
  expect(direct.items).toHaveLength(105);
  const nativeAnswerOnly = await providerLibraryExplore(
    root,
    `/provider/library-explore?${new URLSearchParams({ q: filters.q, kinds: 'answer' })}`,
    '1.0',
    scope.identity,
    scope.epoch,
  );
  expect(nativeAnswerOnly.items).toHaveLength(0);
  expect(direct.owner_coverage).toEqual(
    expect.arrayContaining([expect.objectContaining({ owner: 'signals-ai', state: 'connected' })]),
  );
  expect(direct.facets.kinds.find((facet) => facet.kind === 'imported_answer')).toMatchObject({
    count: 105,
    keys: expect.any(Array),
  });
  expect(direct.facets.dated_keys).toHaveLength(104);
  expect(direct.facets.undated_keys).toHaveLength(1);
  expect(direct.items.find((item) => item.record.ref.id === first.runId)?.observed_at).toBe(
    '2026-10-24T08:00:00.000Z',
  );
  const unknownItem = direct.items.find((item) => item.record.ref.id === unknown.runId)!;
  expect(unknownItem.observed_at).toBeNull();
  expect(unknownItem.record.updated_at).toBe('2026-10-24T08:09:10');
  const exact = await exactOwnerRecord(root, {
    owner: 'signals-ai',
    kind: 'imported_answer',
    id: first.runId,
    revision: null,
    digest: null,
  });
  expect(direct.items.find((item) => item.record.ref.id === first.runId)?.record.ref.digest).toBe(
    createHash('sha256').update(exact.bytes).digest('hex'),
  );

  const before = await treeDigest(join(root, '.signals'));
  let generationCalls = 0;
  const handler = searchApi(root, async () => {
    generationCalls++;
    throw new Error('Library exploration must not start research.');
  });
  const server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no_port');
  const base = `http://127.0.0.1:${address.port}/signals-ai/__signals/api/`;
  try {
    const session = (await (await fetch(base + 'session')).json()) as { token: string };
    const headers = { ...owned };
    const capabilitiesResponse = await fetch(base + 'provider/capabilities', { headers });
    expect(capabilitiesResponse.status).toBe(200);
    const capabilities = (await capabilitiesResponse.json()) as {
      capabilities: {
        contracts: { id: string; versions: string[] }[];
        operations: {
          name: string;
          target_kinds: string[];
          mutating: boolean;
          authority_required: boolean;
        }[];
      };
    };
    expect(capabilities.capabilities.contracts).toContainEqual({
      id: 'library-explore',
      versions: ['1.0'],
    });
    expect(capabilities.capabilities.operations).toContainEqual({
      name: 'library_explore',
      target_kinds: ['answer', 'research_note', 'imported_answer', 'entity', 'lead'],
      mutating: false,
      authority_required: false,
    });
    const readStarted = performance.now();
    const response = await fetch(base + `provider/library-explore?${query}`, { headers });
    expect(performance.now() - readStarted).toBeLessThan(4000);
    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as typeof direct;
    expect(snapshot.snapshot).toBe(direct.snapshot);
    expect(snapshot.items).toHaveLength(105);
    expect(snapshot.items[0]!.record.observed_at).toEqual(expect.any(String));

    const select = (keys: string[], extra: Record<string, unknown> = {}) =>
      fetch(base + 'provider/library-explore/select', {
        method: 'POST',
        headers: {
          ...headers,
          'x-signals-token': session.token,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ snapshot: snapshot.snapshot, filters, keys, ...extra }),
      });
    const choose = [snapshot.items[104]!.key, snapshot.items[0]!.key];
    const selectedResponse = await select(choose);
    expect(selectedResponse.status).toBe(200);
    const selected = (await selectedResponse.json()) as {
      schema_version: string;
      snapshot: string;
      keys: string[];
      records: { ref: { id: string } }[];
    };
    const ownerOrder = snapshot.items.filter((item) => choose.includes(item.key));
    expect(selected).toMatchObject({
      schema_version: 'signals-library-selection-v1',
      snapshot: snapshot.snapshot,
    });
    expect(selected.keys).toEqual(ownerOrder.map((item) => item.key));
    expect(selected.records.map((record) => record.ref.id)).toEqual(
      ownerOrder.map((item) => item.record.ref.id),
    );
    expect((await (await select([])).json()).keys).toEqual([]);

    expect((await select([choose[0]!, choose[0]!])).status).toBe(400);
    expect((await select(['f'.repeat(64)])).status).toBe(400);
    expect((await select(choose, { unexpected: true })).status).toBe(400);
    expect((await select(choose, { filters: { ...filters, q: 'another query' } })).status).toBe(
      409,
    );
    expect(
      (await fetch(base + `provider/library-explore?${query}&unknown=1`, { headers })).status,
    ).toBe(400);
    expect(
      (await fetch(base + `provider/library-explore?${query}&q=duplicate`, { headers })).status,
    ).toBe(400);
    expect(
      (await fetch(base + 'provider/library-explore?kinds=unsupported', { headers })).status,
    ).toBe(400);
    expect(
      (await fetch(base + 'provider/library-explore?project_ref=unsupported', { headers })).status,
    ).toBe(400);
    expect(
      (
        await fetch(base + `provider/library-explore?${query}`, {
          headers: { ...headers, 'x-signals-instance-id': randomUUID() },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await fetch(base + `provider/library-explore?${query}`, {
          headers: { ...headers, 'x-signals-owner-epoch': randomUUID() },
        })
      ).status,
    ).toBe(409);
    expect((await fetch(base + `provider/library-explore?${query}`)).status).toBe(428);
    expect(
      (
        await fetch(base + `provider/library-explore?${query}`, {
          headers: { ...headers, 'x-signals-provider-version': '2.0' },
        })
      ).status,
    ).toBe(426);
    const noToken = await fetch(base + 'provider/library-explore/select', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: '{malformed',
    });
    expect(noToken.status).toBe(403);

    expect(await treeDigest(join(root, '.signals'))).toBe(before);

    await savedAnswerFixture('exploration-fixture-added-after-snapshot', '2026-10-24T08:11:00Z');
    const stale = await select(choose);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'library_explore_snapshot_changed' });
    expect(generationCalls).toBe(0);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
  }
}, 30000);

it('keeps the existing paginated Library query and snapshot cursor contract intact', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'signals-library-page-')));
  const scope = await requestStore(root).initialize();
  await retainedRun('library-page-fixture-first', '2026-10-24T08:00:00Z');
  await retainedRun('library-page-fixture-second', '2026-10-24T08:01:00Z');
  const page = await providerLibrary(
    root,
    '/provider/library?q=library-page-fixture&limit=1',
    '1.0',
    scope.identity,
    scope.epoch,
  );
  expect(page.records).toHaveLength(1);
  expect(page.next_cursor).toEqual(expect.any(String));
  const second = await providerLibrary(
    root,
    `/provider/library?q=library-page-fixture&limit=1&cursor=${encodeURIComponent(page.next_cursor!)}`,
    '1.0',
    scope.identity,
    scope.epoch,
  );
  expect(second.records).toHaveLength(1);
  await retainedRun('library-page-fixture-third', '2026-10-24T08:02:00Z');
  await expect(
    providerLibrary(
      root,
      `/provider/library?q=library-page-fixture&limit=1&cursor=${encodeURIComponent(page.next_cursor!)}`,
      '1.0',
      scope.identity,
      scope.epoch,
    ),
  ).rejects.toMatchObject({ status: 409, code: 'library_cursor_changed' });
});

it('preserves exact imported-answer identity in the existing paginated Library route', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'signals-library-explore-legacy-')));
  const scope = await requestStore(root).initialize();
  const imported = await answer('legacy-imported-fixture-unique-000', '2026-10-24T08:00:00Z');
  const exact = await exactOwnerRecord(root, {
    owner: 'signals-ai',
    kind: 'imported_answer',
    id: imported.runId,
    revision: null,
    digest: null,
  });
  const page = await providerLibrary(
    root,
    `/provider/library?${new URLSearchParams({ q: 'legacy-imported-fixture-unique-000', kinds: 'imported_answer' })}`,
    '1.0',
    scope.identity,
    scope.epoch,
  );
  expect(page.records).toHaveLength(1);
  expect(page.records[0]?.ref).toMatchObject({
    kind: 'imported_answer',
    id: imported.runId,
    digest: createHash('sha256').update(exact.bytes).digest('hex'),
  });
});
