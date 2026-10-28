import { it, expect } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptDiscovery } from './signal-search.js';
import { contextualize, entityDelta } from '../../domain/src/search-priority.js';
import { loadPersonal, updatePersonal } from './search-personal.js';
import { updateInbox, loadInbox } from './search-inbox.js';
import { searchEvidenceBundle } from './search-exchange.js';
import { parseContextualExchange } from './search-context-exchange.js';
import { randomUUID } from 'node:crypto';
import { budgets, type SearchResult } from '../../domain/src/search-contract.js';
import { filterSearchItems, saveDecision } from '../../domain/src/search-score.js';
import type { Proposal } from '../../domain/src/search-contract.js';

async function pool() {
  const sources = [
    {
      uri: 'https://example.com/evidence',
      title: 'Original',
      publisher: 'Origin',
      family: 'primary' as const,
      publishedAt: null,
      origin: 'original',
    },
  ];
  const facets = {
    domains: [],
    capabilities: [],
    interfaces: [],
    deliveryForms: [],
    platforms: [],
    licenses: [],
    tags: [],
  };
  const candidates = ['https://example.com/niche', 'https://example.com/famous'].map(
    (uri, index) => ({
      uri,
      name: index ? 'Famous irrelevant tool' : 'Obscure useful tool',
      kind: 'software' as const,
      identity: 'resolved' as const,
      aliases: [],
      description: 'Inspectable resource',
      facets,
      observations: [
        {
          source: 0,
          feature: 'defining',
          indicator: 'defines' as const,
          statement: 'Provides source tracing',
          quote: 'Provides source tracing',
          independent: false,
          origin: 'original',
          status: 'supported' as const,
        },
      ],
      match: {
        level: index ? ('out-of-scope' as const) : ('direct' as const),
        reason: index ? 'Requires incompatible cloud setup' : 'Fits portable sources',
        sources: [0],
      },
      limits: [],
      priority: {
        applicability: index ? ('incompatible' as const) : ('direct' as const),
        value: index ? ('low' as const) : ('high' as const),
        action: index ? ('reject' as const) : ('study' as const),
        reason: index
          ? 'Conflicts with local data requirement'
          : 'Inspect its source tracing as a small local component',
        constraints: [],
        sources: [0],
      },
    }),
  );
  const proposal: Proposal = { sources, candidates, coverage: [], gaps: [] };
  return (
    await acceptDiscovery(
      proposal,
      { query: 'portable source traces' },
      { fetch: async (uri) => ({ uri, text: 'Provides source tracing', digest: 'a'.repeat(64) }) },
    )
  ).items;
}
it('ranks the same frozen pool by contextual value without changing strength, eligibility or personal novelty', async () => {
  const original = await pool();
  const snapshots = original.map((i) => JSON.stringify(i.entity.assessment));
  original[1]!.entity.assessment.score = 99;
  const items = filterSearchItems(contextualize(original, new Set()), { sort: 'priority' });
  expect(items[0]!.entity.name).toBe('Obscure useful tool');
  expect(items[0]!.priority?.novelty).toBe('new-to-corpus');
  expect(items[0]!.priority?.personalNovelty).toBe('unknown');
  expect(items[0]!.eligible).toBe(false);
  expect(JSON.stringify(items[0]!.entity.assessment)).toBe(snapshots[0]);
  expect(contextualize(original, new Set([original[0]!.entity.id]))[0]!.priority?.novelty).toBe(
    'known-in-corpus',
  );
});
it('orders equal contextual priority by query relevance, not intrinsic strength or pool shape', async () => {
  const [base] = contextualize(await pool(), new Set());
  const twin = (id: string, level: 'direct' | 'related', strength: number) => {
    const item = structuredClone(base!);
    item.entity.id = id;
    item.match = { ...item.match, level };
    item.entity.assessment.score = strength;
    return item;
  };
  const strong = twin('a-strong-related', 'related', 95),
    relevant = twin('b-weak-direct', 'direct', 40);
  expect(strong.priority?.score).toBe(relevant.priority?.score);
  const order = (items: (typeof strong)[]) =>
    filterSearchItems(items, { sort: 'priority' }).map((item) => item.entity.id);
  expect(order([strong, relevant])).toEqual(['b-weak-direct', 'a-strong-related']);
  // A differently-assessed, muted neighbour must not flip the tie between the two.
  const neighbour = twin('c-muted-dataset', 'direct', 10);
  neighbour.entity.kind = 'dataset';
  neighbour.priority = { ...neighbour.priority!, feedback: 'mute' };
  expect(order([neighbour, strong, relevant])).toEqual([
    'b-weak-direct',
    'a-strong-related',
    'c-muted-dataset',
  ]);
  // Strength remains an explicit, separate order.
  expect(filterSearchItems([relevant, strong], { sort: 'score' })[0]).toBe(strong);
});
it('hosted reader identity uncertainty blocks automatic admission without changing intrinsic strength', async () => {
  const item = (await pool())[0]!;
  const strength = structuredClone(item.entity.assessment);
  expect(saveDecision(item.entity, item.match, 0).eligible).toBe(true);
  item.entity.evidence[0]!.reason = 'provider_final_identity_unverified';
  expect(saveDecision(item.entity, item.match, 0).reasons).toContain('source_identity_unverified');
  expect(item.entity.assessment).toEqual(strength);
});
it('keeps user notes/feedback private and ignores fetch timestamps when detecting entity changes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'priority-test-')));
  try {
    const items = await pool();
    const id = items[0]!.entity.id;
    await updatePersonal(root, id, {
      note: 'My own edited annotation',
      feedback: 'mute',
      novelty: 'known',
      seenAt: new Date().toISOString(),
    });
    const personal = await loadPersonal(root);
    expect(personal[id]?.note).toBe('My own edited annotation');
    const result: SearchResult = {
      schemaVersion: 2,
      runId: randomUUID(),
      query: 'portable sources',
      status: 'completed',
      items: contextualize(items, new Set(), personal),
      sources: items[0]!.entity.evidence,
      coverage: [],
      gaps: [],
      usage: {
        searches: 0,
        documents: 1,
        elapsedMs: 0,
        modelCalls: 0,
        providerUsage: null,
        cost: null,
      },
      counts: { leads: 2, distinct: 2, duplicates: 0, omitted: 0 },
      limits: budgets.quick,
    };
    await updateInbox(root, result, [id]);
    await updateInbox(root, result, [id]);
    expect(await loadInbox(root)).toHaveLength(1);
    const exchange = searchEvidenceBundle(result, 'a'.repeat(40));
    const extension = exchange.extensions!['signals-ai.contextual-priority'];
    expect(parseContextualExchange(extension)).toEqual(extension);
    expect(JSON.stringify(exchange)).not.toContain('My own edited annotation');
    const uncertain = structuredClone(result);
    for (const item of uncertain.items)
      for (const observation of item.entity.observations) observation.status = 'uncertain';
    expect(
      searchEvidenceBundle(uncertain, 'b'.repeat(40)).extensions!['signals.recommendations'],
    ).toMatchObject({ items: [] });
    expect(() => parseContextualExchange({ ...(extension as object), schema_version: 2 })).toThrow(
      'unsupported_or_invalid_contextual_exchange',
    );
    const ranked = filterSearchItems(contextualize(items, new Set(), personal), {
      sort: 'priority',
    });
    expect(ranked.at(-1)!.entity.id).toBe(id);
    const after = structuredClone(items[0]!.entity);
    after.assessment.asOf = new Date().toISOString();
    after.evidence[0]!.fetchedAt = new Date().toISOString();
    expect(entityDelta(items[0]!.entity, after)).toBe('unchanged');
    after.facets.licenses = ['AGPL-3.0'];
    expect(entityDelta(items[0]!.entity, after)).toBe('supported-description-or-status-changed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
