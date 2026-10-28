import { expect, it } from 'vitest';
import {
  frozenFollowupMaterial,
  frozenLibraryMaterial,
  validateRetainedAnswer,
  parseFollowupRequestV2,
  savedResearchMaterialV2,
  followupChildV2,
  validateFollowupChild,
} from './search-followup.js';
import { digest } from './search-fetch.js';
import { loadEntities } from './search-store.js';
import { projectNativeLibrary } from '../../domain/src/library-search.js';
import type { SearchResult } from '../../domain/src/search-contract.js';

const result = {
  brief: { format: 'markdown', text: 'Retained hypothetical exercise; it was not executed.' },
  gaps: ['Runtime not tested.', 'excluded resource access was denied.'],
  items: ['selected', 'excluded'].map((id) => ({
    entity: {
      id,
      name: id,
      uri: `https://example.org/${id}`,
      description: `${id} description`,
      facets: { capabilities: ['inspectable learning'] },
      limits: [`${id} unexecuted`],
      evidence: [],
      observations: [],
      assessment: { policy: 'signal-strength-v6' },
    },
  })),
} as unknown as SearchResult;

it('keeps prior hypothetical synthesis distinct from verified observations', () => {
  const frozen = frozenFollowupMaterial(result, []);
  expect(frozen.priorSynthesis).toContain('it was not executed');
  expect(frozen.material).toEqual([]);
  expect(frozen.gaps).toEqual(expect.arrayContaining(result.gaps));
  expect(frozen.gaps.join(' ')).toContain(
    'source dates, currentness and contradictions have not been renewed',
  );
});

it('never adds unselected records or their prior synthesis to a scoped follow-up', () => {
  const frozen = frozenFollowupMaterial(result, ['selected']);
  expect(frozen.priorSynthesis).toBeUndefined();
  expect(JSON.stringify(frozen)).not.toContain('excluded');
  expect(frozen.context[0]?.limits).toEqual(['selected unexecuted']);
});

it('keeps identical observation identities distinct across selected public and private records', async () => {
  const [record] = await loadEntities();
  const publicFinding = projectNativeLibrary(record!, 'public');
  const privateFinding = projectNativeLibrary(record!, 'private');
  const frozen = frozenLibraryMaterial([publicFinding, privateFinding]);
  expect(frozen.material.length).toBeGreaterThan(0);
  expect(new Set(frozen.material.map((row) => row.observationId)).size).toBe(
    frozen.material.length,
  );
  expect(frozen.material.some((row) => row.entityId === publicFinding.key)).toBe(true);
  expect(frozen.material.some((row) => row.entityId === privateFinding.key)).toBe(true);
  expect(frozen.material.every((row) => row.observationId.startsWith(row.entityId + ':'))).toBe(
    true,
  );
});

it('accepts qualified retained citations and rejects ambiguous or forged source references', () => {
  const original = 'observation-0123456789abcdef01234567';
  const qualified = `native:private:entity-123:${original}`;
  const material = [{ observationId: qualified }];
  expect(() =>
    validateRetainedAnswer(material, {
      answer: `Supported [${qualified}]`,
      observations: [qualified],
    }),
  ).not.toThrow();
  expect(() =>
    validateRetainedAnswer(material, {
      answer: `Ambiguous [${original}]`,
      observations: [qualified],
    }),
  ).toThrow('unbound_followup_output');
  expect(() =>
    validateRetainedAnswer(material, {
      answer: '',
      observations: [`native:public:entity-123:${original}`],
    }),
  ).toThrow('unbound_followup_output');
});

it('copies and validates a v2 child scope without relying on its parents at reopening', () => {
  const refs = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'].map(
    (id) => ({
      owner: 'signals-ai' as const,
      kind: 'answer' as const,
      id,
      digest: 'a'.repeat(64),
      revision: 'sha256:' + 'a'.repeat(64),
    }),
  );
  const request = parseFollowupRequestV2({
    schema_version: '2.0',
    request_id: 'unit',
    idempotency_key: 'unit',
    parent_refs: refs,
    question: '  What remains unknown?  ',
    scope: 'saved-context-only',
    retention: 'private',
    authority_ref: {
      owner: 'signals-ai',
      kind: 'authority',
      id: 'unit',
      revision: null,
      digest: null,
    },
  });
  expect(request.question).toBe('What remains unknown?');
  const parents = refs.map((ref, index) => ({
    ref,
    run: {
      ...result,
      runId: ref.id,
      query: `Saved ${index}`,
      status: 'completed' as const,
      items: [],
    },
  }));
  const selected = savedResearchMaterialV2(parents, request.question);
  const child = followupChildV2({
    runId: '10000000-0000-4000-8000-000000000003',
    parents,
    question: request.question,
    ...selected,
    requestDigest: 'b'.repeat(64),
    requestedModel: null,
    elapsedMs: 0,
    answer: {
      mode: 'frozen-evidence-model',
      answer: 'An authored hypothetical answer, not executed.',
      statements: [],
      gaps: selected.frozen.gaps,
      usage: null,
    },
  });
  expect(() => validateFollowupChild(child)).not.toThrow();
  if (child.followupOf?.version !== 2) throw new Error('missing_v2_child');
  expect(child.followupOf.selection.question_sha256).toBe(digest(request.question));
  for (const modify of [
    (copy: typeof child) => {
      if (copy.followupOf?.version === 2)
        copy.followupOf.selection.question_sha256 = '0'.repeat(64);
    },
    (copy: typeof child) => {
      if (copy.followupOf?.version === 2)
        copy.followupOf.parents[1]!.ref = copy.followupOf.parents[0]!.ref;
    },
    (copy: typeof child) => {
      if (copy.followupOf?.version === 2) copy.followupOf.selection.per_parent[0]!.kept = 1;
    },
    (copy: typeof child) => {
      if (copy.followupOf?.version === 2) copy.followupOf.cited = ['observation-' + 'f'.repeat(24)];
    },
  ]) {
    const copy = structuredClone(child);
    modify(copy);
    expect(() => validateFollowupChild(copy)).toThrow(/followup/);
  }
  const oversized = parents.map((parent) => ({
    ...parent,
    run: { ...parent.run, brief: { format: 'markdown' as const, text: 'x'.repeat(60000) } },
  }));
  expect(() => savedResearchMaterialV2(oversized, request.question)).toThrow(
    'followup_synthesis_budget_exceeded',
  );
});
