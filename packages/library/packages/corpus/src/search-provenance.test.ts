import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptDiscovery, observationIdentity } from './signal-search.js';
import { saveEntities, loadEntities, validateEntity } from './search-store.js';
import { assessEntity, saveDecision } from '../../domain/src/search-score.js';
import type { SignalJudgment } from '../../domain/src/search-assessment.js';

const date = '2026-10-12T12:00:00.000Z';
const statements = [
  'The parser reads JSON records in memory.',
  'The worked example parses a record and preserves all fields.',
  'Version two is supported under MIT terms and Python 3.11.',
  'Laboratory One replicated the operation and documented its limits.',
  'Laboratory Two independently repeated the operation on shared inputs.',
];
const attribution = [
  'The resource team developed the parser and its examples.',
  'Laboratory One conducted this independent parser experiment.',
  'Laboratory Two conducted a separate independent parser experiment.',
];
function fixture(version = 7) {
  const judgment: SignalJudgment = {
    rubric: 'software-v1',
    rubricReason: 'Synthetic inspected-origin assumptions, not semantic validation.',
    dimensions: {
      basis: { level: 4, reason: 'Identity.', observations: [0] },
      work: { level: 4, reason: 'Replicated operation.', observations: [1, 3, 4] },
      scrutiny: { level: 4, reason: 'Two inspected external efforts.', observations: [3, 4] },
      applicability: { level: 4, reason: 'Supported scope.', observations: [2] },
    },
    contrary: 'inspected',
    status: 'inspected',
    gaps: [],
    originInspections: attribution.map((quote, source) => ({
      source,
      quote,
      reason: source
        ? `Laboratory ${source} performed a distinct effort unrelated to the resource team or other experiment.`
        : 'The resource team generated this work.',
      relationship: source ? 'independent' : 'resource-own',
    })),
  };
  return {
    version,
    answer: 'Synthetic provenance policy fixture.',
    interpretation: {
      policy: 'query-relevance-v1',
      need: 'Inspect parser evidence.',
      constraints: [],
      resourceTypes: ['software'],
      timeWindow: null,
    },
    sources: attribution.map((_, index) => ({
      uri: `https://source-${index}.example.org/report`,
      title: `Source ${index}`,
      publisher: 'Shared journal venue',
      origin: `effort-${index}`,
      family: 'primary',
      publishedAt: date,
    })),
    candidates: [
      {
        uri: 'https://source-0.example.org/parser',
        name: 'Synthetic parser',
        kind: 'software',
        identity: 'resolved',
        description: 'Synthetic inspected evidence.',
        capabilities: ['parsing'],
        observations: statements.map((statement, index) => ({
          source: index < 3 ? 0 : index - 2,
          signal: [
            'defining/defines',
            'verification/worked-example',
            'currentness/current',
            'verification/replicated',
            'verification/replicated',
          ][index]!,
          statement,
          quote: statement,
          independent: index > 2,
          origin: `effort-${index < 3 ? 0 : index - 2}`,
          status: 'supported',
        })),
        signalJudgment: judgment,
        match: { level: 'direct', reason: 'Synthetic direct fit.', sources: [0] },
        relevance: { value: 100, reason: 'Synthetic fit.', sources: [0], constraints: [] },
        limits: [],
      },
    ],
    coverage: [],
    gaps: [],
  };
}
type Input = ReturnType<typeof fixture>;
function bodies(input: Input) {
  return new Map(
    input.sources.map((source, index) => [
      source.uri,
      [
        ...input.candidates[0]!.observations.filter((item) => item.source === index).map(
          (item) => item.quote,
        ),
        ...(input.candidates[0]!.signalJudgment.originInspections?.filter(
          (item) => item.source === index,
        ).map((item) => item.quote) ?? []),
      ].join('\n'),
    ]),
  );
}
async function accepted(input = fixture(), documents = bodies(input)) {
  const result = await acceptDiscovery(
    input,
    { query: 'Inspect parser evidence.', route: 'native', profile: 'wide' },
    {
      asOf: date,
      evidenceClass: 'fixture',
      fetch: async (uri) => {
        const text = documents.get(uri);
        if (text === undefined) throw new Error('fixture_unavailable');
        return { uri, text, digest: createHash('sha256').update(text).digest('hex') };
      },
    },
  );
  result.items.forEach((item) => validateEntity(item.entity));
  return result.items[0]!;
}
const value = (item: Awaited<ReturnType<typeof accepted>>) => ({
  score: item.entity.assessment.score,
  disposition: item.entity.assessment.disposition,
  dimensions: Object.fromEntries(
    Object.entries(item.entity.assessment.features).map(([key, feature]) => [
      key,
      [feature.value, feature.contribution, feature.state],
    ]),
  ),
});

describe('successor-only originating effort and duplicate support', () => {
  it.each(['        ', '\t\n\u00a0 \t\n\u00a0 ', 'reason-only'])(
    'rejects normalized blank attribution %j without inventing credit',
    async (blank) => {
      const input = fixture(),
        documents = bodies(input);
      const missing = structuredClone(input);
      delete missing.candidates[0]!.signalJudgment.originInspections;
      const baseline = await accepted(missing, documents);
      for (const inspection of input.candidates[0]!.signalJudgment.originInspections!.slice(1)) {
        if (blank !== 'reason-only') inspection.quote = blank;
        inspection.reason = ' \t\n\u00a0 ';
      }
      const item = await accepted(input, documents);
      expect(value(item)).toEqual(value(baseline));
      expect(saveDecision(item.entity, item.match).eligible).toBe(false);
      expect(item.entity.assessment.reasons?.join(' ')).toContain(
        'originating effort/relationship is unknown',
      );
    },
  );
  it('counts physically active primary excerpt projections in duplicate exclusions', async () => {
    const input = fixture();
    input.sources.pop();
    input.candidates[0]!.observations.pop();
    input.candidates[0]!.signalJudgment.originInspections!.pop();
    input.candidates[0]!.signalJudgment.dimensions.work.observations = [1, 3];
    input.candidates[0]!.signalJudgment.dimensions.scrutiny.observations = [3];
    const documents = bodies(input);
    documents.set(
      input.sources[0]!.uri,
      documents.get(input.sources[0]!.uri)! + '\n' + statements[3] + '\n' + attribution[1],
    );
    const baseline = await accepted(input, documents);
    expect(baseline.entity.assessment.score).toBe(88);
    const entity = structuredClone(baseline.entity),
      primary = entity.evidence.find((source) => source.uri === input.sources[0]!.uri)!;
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    const excerpt = statements[3]! + '\n' + attribution[1]!;
    const projection = {
      ...primary,
      title: 'Earlier primary projection',
      origin: 'claimed-copy-effort',
      fetchedAt: '2026-10-11T12:00:00.000Z',
      excerpt,
      excerptDigest: hash(excerpt),
    };
    projection.id =
      'evidence-' +
      hash(
        `${projection.uri}:${projection.digest}:${projection.excerptDigest}${projection.normalizer ? ':' + projection.normalizer : ''}`,
      ).slice(0, 24);
    const raw = {
      feature: 'verification' as const,
      indicator: 'replicated' as const,
      statement: statements[3]!,
      quote: statements[3]!,
      independent: true,
      origin: projection.origin,
      status: 'supported' as const,
      identityVersion: 2 as const,
    };
    const observation = {
      ...raw,
      ...observationIdentity(entity.id, projection.id, raw),
      supersedes: [],
      derivation: 'model-assessment' as const,
      evidenceId: projection.id,
      verified: true,
    };
    entity.evidence.push(projection);
    entity.observations.push(observation);
    entity.signalBasis!.originInspections!.push({
      source: projection.id,
      quote: attribution[1]!,
      reason: 'Synthetic assertion that this primary projection is external.',
      relationship: 'independent',
    });
    entity.signalBasis!.dimensions.work.observations.push(observation.id);
    entity.signalBasis!.dimensions.scrutiny.observations.push(observation.id);
    entity.assessment = assessEntity(entity, date, 'signal-strength-v10');
    validateEntity(entity);
    expect(entity.currentEvidence).not.toContain(projection.id);
    expect(entity.assessment.score).toBe(88);
    expect(entity.assessment.features.scrutiny?.contribution).toBe(12.5);
    expect(entity.assessment.reasons?.join(' ')).toContain(
      'Duplicated acquired material counts once',
    );
    expect(entity.evidence).toHaveLength(3);
    const reordered = structuredClone(entity);
    reordered.evidence.reverse();
    reordered.observations.reverse();
    expect(assessEntity(reordered, date, 'signal-strength-v10')).toEqual(entity.assessment);
  });
  it.each([
    [5, 5],
    [6, 6],
    [7, 5],
    [7, 6],
    [5, 3],
    [7, 3],
  ])(
    'preserves current admission history across brief %i to %i without changing numerical replay',
    async (from, to) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-cross-policy-hold-')));
      try {
        const input = fixture(from);
        input.sources.forEach((source, index) => {
          source.publisher = `Publisher ${index}`;
        });
        input.candidates[0]!.observations.push({
          ...input.candidates[0]!.observations[3]!,
          status: 'contradicted',
          statement: 'The advertised field-preserving operation is contradicted.',
          quote: 'The advertised field-preserving operation is contradicted.',
        });
        input.candidates[0]!.signalJudgment.dimensions.work.observations.push(5);
        const prior = await accepted(input);
        expect(saveDecision(prior.entity, prior.match, 0).eligible).toBe(false);
        await saveEntities([prior], 'manual', root, 'private', 75, true);
        const clean = fixture(to);
        clean.sources.forEach((source, index) => {
          source.publisher = `Publisher ${index}`;
        });
        const documents = bodies(clean);
        if (to === 3)
          delete (clean.candidates[0] as Partial<(typeof clean.candidates)[number]>).signalJudgment;
        const incoming = await accepted(clean, documents);
        const originalIncoming = structuredClone(incoming.entity);
        await saveEntities([incoming], 'refresh', root, 'private', 75, true);
        expect(incoming.entity).toEqual(originalIncoming);
        const entity = (await loadEntities(join(root, '.signals/corpus/entities')))[0]!.entity;
        validateEntity(entity);
        expect(entity.retainedDecisiveObservations).toContain(prior.entity.observations.at(-1)!.id);
        expect(saveDecision(entity, incoming.match, 0).reasons).toContain(
          'unresolved_decisive_evidence',
        );
        expect(entity.assessment).toEqual(assessEntity(entity, date, entity.assessment.policy));
        if (to !== 3) expect(entity.assessment.score).toBe(100);
        const automatic = await saveEntities([incoming], 'eligible', root, 'private', 75, true);
        expect(automatic.changed).toHaveLength(0);
        const refuted = structuredClone(input);
        refuted.version = to;
        refuted.candidates[0]!.observations.at(-1)!.status = 'supported';
        const refutationDocuments = bodies(refuted);
        if (to === 3)
          delete (refuted.candidates[0] as Partial<(typeof refuted.candidates)[number]>)
            .signalJudgment;
        const supported = await accepted(refuted, refutationDocuments);
        await saveEntities([supported], 'refresh', root, 'private', 75, true);
        const resolved = (await loadEntities(join(root, '.signals/corpus/entities')))[0]!.entity;
        validateEntity(resolved);
        expect(saveDecision(resolved, supported.match, 0).eligible).toBe(true);
        expect(
          resolved.observations.some((observation) => observation.status === 'contradicted'),
        ).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it('requires bound attribution and preserves historical v8/v9 arithmetic', async () => {
    expect((await accepted()).entity.assessment.score).toBe(100);
    for (const version of [5, 6]) {
      const input = fixture(version);
      delete input.candidates[0]!.signalJudgment.originInspections;
      expect((await accepted(input)).entity.assessment.score).toBe(63); // Historical publisher grouping.
    }
    const input = fixture();
    const documents = bodies(input);
    delete input.candidates[0]!.signalJudgment.originInspections;
    const item = await accepted(input, documents);
    expect(item.entity.assessment.disposition).toBe('provisional');
    expect(item.entity.assessment.features.scrutiny?.state).toBe('unknown');
    expect(saveDecision(item.entity, item.match).eligible).toBe(false);
  });
  it('does not manufacture worked examples from unsupported replication', async () => {
    const input = fixture();
    const documents = bodies(input);
    delete input.candidates[0]!.signalJudgment.originInspections;
    input.candidates[0]!.signalJudgment.dimensions.work.observations = [3, 4];
    const item = await accepted(input, documents);
    expect(item.entity.assessment.score).toBeNull();
    expect(item.entity.assessment.nextVerification).toContain('attribution');
  });
  it('retains exact copies without gaining support from relabeled payloads', async () => {
    const input = fixture();
    input.sources.pop();
    input.candidates[0]!.observations.pop();
    input.candidates[0]!.signalJudgment.originInspections!.pop();
    input.candidates[0]!.signalJudgment.dimensions.work.observations = [1, 3];
    input.candidates[0]!.signalJudgment.dimensions.scrutiny.observations = [3];
    const documents = bodies(input);
    const baseline = await accepted(input, documents);
    expect(baseline.entity.assessment.score).toBe(88);
    for (let copy = 0; copy < 8; copy++) {
      const source = input.sources.length;
      const uri = `https://copy-${copy}.example.org/report`;
      input.sources.push({
        ...input.sources[1]!,
        uri,
        publisher: `Outlet ${copy}`,
        origin: `relabeled-${copy}`,
      });
      input.candidates[0]!.observations.push({
        ...input.candidates[0]!.observations[3]!,
        source,
        origin: `relabeled-${copy}`,
      });
      const observation = input.candidates[0]!.observations.length - 1;
      input.candidates[0]!.signalJudgment.dimensions.work.observations.push(observation);
      input.candidates[0]!.signalJudgment.dimensions.scrutiny.observations.push(observation);
      input.candidates[0]!.signalJudgment.originInspections!.push({
        ...input.candidates[0]!.signalJudgment.originInspections![1]!,
        source,
      });
      documents.set(uri, documents.get(input.sources[1]!.uri)!);
    }
    const copies = await accepted(input, documents);
    expect(value(copies)).toEqual(value(baseline));
    expect(copies.entity.evidence).toHaveLength(10);
    expect(copies.entity.assessment.reasons?.join(' ')).toContain(
      'Duplicated acquired material counts once',
    );
    const reordered = structuredClone(copies.entity);
    reordered.evidence.reverse();
    reordered.observations.reverse();
    expect(assessEntity(reordered, date, 'signal-strength-v10')).toEqual(copies.entity.assessment);
  });
  it('excludes primary payload copies and handles near copies as one attributed effort', async () => {
    const input = fixture();
    const common = [...statements, ...attribution].join('\n');
    const copied = await accepted(
      input,
      new Map(input.sources.map((source) => [source.uri, common])),
    );
    expect(copied.entity.assessment.features.scrutiny?.contribution).toBe(0);
    expect(copied.entity.assessment.features.work?.contribution).toBe(12.5);
    input.sources[2]!.origin = input.sources[1]!.origin;
    const documents = bodies(input);
    documents.set(
      input.sources[2]!.uri,
      documents.get(input.sources[2]!.uri)! + '\nChanged footer.',
    );
    expect(
      (await accepted(input, documents)).entity.assessment.features.scrutiny?.contribution,
    ).toBe(12.5);
  });
  it.each(['arxiv.org', 'zenodo.org', 'medium.com', 'journal.example.org'])(
    'does not infer effort from venue %s',
    async (host) => {
      const input = fixture();
      input.sources.forEach((source, index) => {
        source.uri = `https://${host}/study-${index}`;
      });
      const item = await accepted(input);
      expect(item.entity.assessment.score).toBe(100);
      expect(item.entity.assessment.disposition).toBe('completed');
    },
  );
  it('withholds unsupported attribution, unknown effort and affiliated own-origin credit', async () => {
    for (const mutation of ['unmatched', 'unknown', 'missing-source', 'own'] as const) {
      const input = fixture();
      const documents = bodies(input);
      for (const inspection of input.candidates[0]!.signalJudgment.originInspections!.slice(1)) {
        if (mutation === 'unmatched')
          inspection.quote = 'This attribution does not occur in the fetched source.';
        if (mutation === 'unknown') input.sources[inspection.source]!.origin = 'unknown';
        if (mutation === 'missing-source') inspection.source = 59;
        if (mutation === 'own') inspection.relationship = 'resource-own';
      }
      const item = await accepted(input, documents);
      expect(item.entity.assessment.features.scrutiny?.contribution).toBe(0);
      expect(saveDecision(item.entity, item.match).eligible).toBe(false);
    }
  });
  it('does not mint another effort from a copied document within a multi-document effort', async () => {
    const input = fixture();
    input.sources[2]!.origin = input.sources[1]!.origin;
    const documents = bodies(input);
    const baseline = await accepted(input, documents);
    input.sources.push({
      ...input.sources[1]!,
      uri: 'https://copy.example.org/report',
      origin: 'invented-effort',
    });
    input.candidates[0]!.observations.push({
      ...input.candidates[0]!.observations[3]!,
      source: 3,
      origin: 'invented-effort',
    });
    input.candidates[0]!.signalJudgment.dimensions.work.observations.push(5);
    input.candidates[0]!.signalJudgment.dimensions.scrutiny.observations.push(5);
    input.candidates[0]!.signalJudgment.originInspections!.push({
      ...input.candidates[0]!.signalJudgment.originInspections![1]!,
      source: 3,
    });
    documents.set(input.sources[3]!.uri, documents.get(input.sources[1]!.uri)!);
    expect(value(await accepted(input, documents))).toEqual(value(baseline));
  });
  it('does not collapse separate inspected efforts merely because a short quote matches', async () => {
    const input = fixture();
    input.candidates[0]!.observations[4]!.statement =
      input.candidates[0]!.observations[3]!.statement;
    input.candidates[0]!.observations[4]!.quote = input.candidates[0]!.observations[3]!.quote;
    expect((await accepted(input)).entity.assessment.score).toBe(100);
  });
  it('retains critical bindings and exact adverse scope through validated refresh histories', async () => {
    for (const mutation of [
      'contradiction',
      'uncertain-work',
      'changed-scope',
      'changed-indicator',
    ] as const) {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-v10-negative-history-')));
      try {
        const input = fixture();
        const candidate = input.candidates[0]!;
        candidate.observations.push({
          ...candidate.observations[3]!,
          signal: mutation.startsWith('changed') ? 'risk/material' : 'verification/replicated',
          status: mutation === 'contradiction' ? 'contradicted' : 'uncertain',
          statement: 'The parser loses fields within its advertised scope.',
          quote: 'The parser loses fields within its advertised scope.',
        });
        candidate.signalJudgment.dimensions.work.observations.push(5);
        const held = await accepted(input);
        expect(held.entity.assessment.score).toBeNull();
        await saveEntities([held], 'manual', root, 'private', 75, true);
        const refresh = mutation.startsWith('changed') ? structuredClone(input) : fixture();
        if (mutation.startsWith('changed')) {
          refresh.candidates[0]!.observations[5]!.status = 'contradicted';
          if (mutation === 'changed-scope')
            refresh.candidates[0]!.observations[5]!.statement =
              'This only concerns a different unsupported legacy scope.';
          else refresh.candidates[0]!.observations[5]!.signal = 'risk/minor';
        }
        await saveEntities([await accepted(refresh)], 'manual', root, 'private', 75, true);
        const merged = (await loadEntities(join(root, '.signals/corpus/entities')))[0]!.entity;
        validateEntity(merged);
        expect(merged.assessment.score).toBeNull();
        expect(saveDecision(merged, held.match).eligible).toBe(false);
        expect(merged.signalBasis?.retainedDecisiveObservations).toContain(
          held.entity.observations.at(-1)!.id,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});
