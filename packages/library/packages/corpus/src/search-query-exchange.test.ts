import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadEntities } from './search-store.js';
import { searchEvidenceBundle } from './search-exchange.js';
import { budgets, type SearchResult } from '../../domain/src/search-contract.js';
it('exports relevance against source identity even when run indexes differ from the bundle source order', async () => {
  const [record] = await loadEntities();
  const source = record!.entity.evidence[0]!;
  const unused = { ...source, id: 'source-unused', uri: 'https://example.org/unused' };
  const result: SearchResult = {
    schemaVersion: 2,
    runId: randomUUID(),
    query: 'a need',
    status: 'completed',
    items: [
      {
        entity: record!.entity,
        match: { level: 'direct', reason: 'fixture', sources: [1] },
        relevance: { value: 75, reason: 'Source-based query fit', sources: [1], constraints: [] },
        eligible: false,
        reasons: [],
      },
    ],
    sources: [unused, source],
    coverage: [],
    gaps: [],
    counts: { leads: 1, distinct: 1, duplicates: 0, omitted: 0 },
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
  const bundle = searchEvidenceBundle(result, 'a'.repeat(40));
  expect(bundle.extensions!['signals-ai.query-assessment']).toMatchObject({
    items: [{ relevance: { source_ids: [source.id] } }],
  });
  expect(bundle.sources.some((row) => row.id === 'source-unused')).toBe(false);
});
