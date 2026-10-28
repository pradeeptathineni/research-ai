import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acceptDiscovery } from './signal-search.js';
import {
  decodeNativeResearch,
  nativeBriefSchema,
  nativePrompt,
} from '../../domain/src/search-native.js';
import { Value } from 'typebox/value';
import {
  assessEntity,
  filterSearchItems,
  personalSaveDecision,
  saveDecision,
} from '../../domain/src/search-score.js';
import { saveEntities, loadEntities, validateEntity, retainRun, loadRun } from './search-store.js';
import type { SignalJudgment } from '../../domain/src/search-assessment.js';
import { budgets, type SearchResult } from '../../domain/src/search-contract.js';

const date = '2026-10-10T12:00:00.000Z';
const quote = 'Inspectable work demonstrates the advertised capability.';
const fact = (signal: string, source = 0, independent = false) => ({
  signal,
  source,
  independent,
  origin: `origin-${source}`,
  status: 'supported',
  statement: quote,
  quote,
});
function native(version = 4) {
  const observations = [
    fact('defining/defines'),
    fact('maturity/documented'),
    fact('verification/worked-example'),
    fact('currentness/current'),
    fact('corroboration/applied', 1, true),
    fact('verification/independent-applied', 2, true),
  ];
  const judgment: SignalJudgment = {
    rubric: 'software-v1',
    rubricReason: 'Inspectable software tool.',
    dimensions: {
      basis: { level: 4, reason: 'Original defining identity.', observations: [0] },
      work: {
        level: 3,
        reason: 'Inspectable independently applied operation.',
        observations: [1, 2, 4, 5],
      },
      scrutiny: { level: 3, reason: 'Two distinct-origin applications.', observations: [4, 5] },
      applicability: { level: 3, reason: 'Current supported scope inspected.', observations: [3] },
    },
    contrary: 'inspected',
    status: 'inspected',
    gaps: [],
  };
  return {
    version,
    answer: 'Useful candidate with inspected evidence.',
    interpretation: {
      policy: 'query-relevance-v1',
      need: 'Inspect a useful tool.',
      constraints: [],
      resourceTypes: ['software'],
      timeWindow: null,
    },
    sources: [0, 1, 2].map((index) => ({
      uri: `https://source-${index}.example.org/resource`,
      title: `Source ${index}`,
      publisher: `Publisher ${index}`,
      origin: `origin-${index}`,
      family: 'primary',
      publishedAt: date,
    })),
    candidates: [
      {
        uri: 'https://source-0.example.org/tool',
        name: 'Useful tool',
        kind: 'software',
        identity: 'resolved',
        description: 'Tool with inspected supporting work.',
        capabilities: ['inspection'],
        observations,
        match: { level: 'direct', reason: 'Directly serves the need.', sources: [0] },
        relevance: {
          value: 100,
          reason: 'Addresses all inspected constraints.',
          sources: [0],
          constraints: [],
        },
        signalJudgment: judgment,
        limits: [],
      },
    ],
    coverage: [],
    gaps: [],
  };
}
const fetched = async (uri: string) => ({ uri, text: quote, digest: 'a'.repeat(64) });

describe('v9 decisive holds and current automatic admission', () => {
  const accept = (input = native(6), denied = false) =>
    acceptDiscovery(
      input,
      { query: 'Inspect a useful tool.', route: 'native', profile: 'wide' },
      {
        asOf: date,
        fetch: async (uri) => {
          if (denied && uri.includes('adverse')) throw new Error('fixture_denied');
          return {
            uri,
            text: `${quote} ${uri}`,
            digest: uri.includes('adverse')
              ? 'b'.repeat(64)
              : uri.includes('source-1')
                ? 'c'.repeat(64)
                : uri.includes('source-2')
                  ? 'd'.repeat(64)
                  : 'a'.repeat(64),
          };
        },
      },
    );
  function adverse(version = 6, status = 'supported') {
    const input = native(version);
    input.sources.push({
      ...input.sources[1]!,
      uri: 'https://adverse.example.org/report',
      publisher: 'Adverse',
      origin: 'adverse',
    });
    input.candidates[0]!.observations.push({ ...fact('risk/material', 3, true), status });
    return input;
  }
  it('holds inaccessible, uncertain and inactive retained adverse evidence without rewriting v8', async () => {
    const historic = (await accept(adverse(5), true)).items[0]!;
    expect(historic.entity.assessment.score).toBe(81);
    expect(saveDecision(historic.entity, historic.match).eligible).toBe(false);
    for (const [input, denied] of [
      [adverse(), true],
      [adverse(6, 'uncertain'), false],
    ] as const) {
      const item = (await accept(input, denied)).items[0]!;
      expect(item.entity.assessment).toMatchObject({
        policy: 'signal-strength-v9',
        score: null,
        disposition: 'not-scoreable',
      });
      expect(item.entity.assessment.nextVerification).toContain('adverse');
      validateEntity(item.entity);
    }
    const item = (await accept(adverse())).items[0]!;
    const evidenceId = item.entity.observations.find((o) => o.feature === 'risk')!.evidenceId;
    item.entity.currentEvidence = item.entity.currentEvidence!.filter((id) => id !== evidenceId);
    expect(assessEntity(item.entity, date, 'signal-strength-v9').score).toBeNull();
  });
  it('holds decisive bound work contradictions while allowing explicitly refuted adverse claims', async () => {
    const input = adverse();
    input.candidates[0]!.observations.at(-1)!.signal = 'verification/worked-example';
    input.candidates[0]!.observations.at(-1)!.status = 'contradicted';
    input.candidates[0]!.signalJudgment.dimensions.work.observations.push(6);
    const item = (await accept(input)).items[0]!;
    expect(item.entity.assessment.score).toBeNull();
    expect(item.entity.assessment.reasons?.join(' ')).toContain('work evidence is contradicted');
    const unavailable = (await accept(input, true)).items[0]!;
    expect(unavailable.entity.assessment.score).toBeNull();
    expect(unavailable.entity.assessment.reasons?.join(' ')).toContain(
      'contradiction is unverified',
    );
    input.candidates[0]!.observations.at(-1)!.status = 'uncertain';
    expect((await accept(input)).items[0]!.entity.assessment.score).toBeNull();
    const refuted = (await accept(adverse(6, 'contradicted'))).items[0]!;
    expect(refuted.entity.assessment.score).toBe(81);
    expect(saveDecision(refuted.entity, refuted.match).eligible).toBe(true);
  });
  it('requires verified available successors to retire an adverse hold', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-v9-adverse-history-')));
    try {
      const prior = (await accept(adverse(6, 'uncertain'))).items[0]!;
      await saveEntities([prior], 'manual', root, 'private', 75, true);
      const unavailable = (await accept(adverse(6, 'contradicted'), true)).items[0]!;
      await saveEntities([unavailable], 'manual', root, 'private', 75, true);
      const held = (await loadEntities(join(root, '.signals/corpus/entities')))[0]!.entity;
      validateEntity(held);
      expect(held.assessment.score).toBeNull();
      const differentSource = adverse(6, 'contradicted');
      differentSource.sources[3]!.uri = 'https://different.example.org/report';
      await saveEntities(
        (await accept(differentSource)).items,
        'manual',
        root,
        'private',
        75,
        true,
      );
      expect(
        (await loadEntities(join(root, '.signals/corpus/entities')))[0]!.entity.assessment.score,
      ).toBeNull();
      const refuted = (await accept(adverse(6, 'contradicted'))).items[0]!;
      await saveEntities([refuted], 'manual', root, 'private', 75, true);
      const resolved = (await loadEntities(join(root, '.signals/corpus/entities')))[0]!.entity;
      validateEntity(resolved);
      expect(resolved.assessment.score).toBe(81);
      expect(resolved.observations.some((item) => item.supersedes.length > 0)).toBe(true);
      expect(resolved.observations.some((item) => item.status === 'uncertain')).toBe(true);
      expect(assessEntity(resolved, date, 'signal-strength-v9')).toEqual(resolved.assessment);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('retains historical zero-dimension scores but blocks compensating automatic admission', async () => {
    for (const name of ['basis', 'work', 'applicability'] as const) {
      const input = native(5);
      input.candidates[0]!.signalJudgment.dimensions[name].level = 0;
      const item = (await accept(input)).items[0]!;
      const historical = structuredClone(item.entity.assessment);
      expect(saveDecision(item.entity, item.match, 0).reasons).toContain(
        'essential_dimension_has_no_positive_support',
      );
      expect(personalSaveDecision(item.entity, item.match, item.relevance, 0).eligible).toBe(false);
      expect(item.entity.assessment).toEqual(historical);
    }
    const input = native(6);
    input.candidates[0]!.signalJudgment.gaps.push({
      decisive: false,
      reason: 'Secondary gap.',
      nextVerification: 'Check later.',
    });
    const item = (await accept(input)).items[0]!;
    expect(saveDecision(item.entity, item.match).reasons).toContain('assessment_incomplete');
  });
});
const scopeText = [
  'The library performs bounded parsing.',
  'The worked example returns a parsed object.',
  'Redistribution is allowed under the MIT license; version 2 supports Python 3.11.',
];
function inspectedScope(version: number) {
  const input = native(version);
  const candidate = input.candidates[0]!;
  candidate.observations = [
    'defining/defines',
    'verification/worked-example',
    'verification/inspectable',
  ].map((signal, index) => ({
    ...fact(signal),
    statement: scopeText[index]!,
    quote: scopeText[index]!,
  }));
  candidate.signalJudgment.dimensions = {
    basis: { level: 2, reason: 'Original defined scope.', observations: [0] },
    work: { level: 2, reason: 'Concrete worked example.', observations: [1] },
    scrutiny: { level: null, reason: 'Independent use not inspected.', observations: [] },
    applicability: {
      level: 1,
      reason: 'Inspected licence and version prerequisites.',
      observations: [2],
    },
  };
  return input;
}
const acceptScope = (input = inspectedScope(5)) =>
  acceptDiscovery(
    input,
    { query: 'Inspect a useful tool.', route: 'native', profile: 'wide' },
    {
      asOf: date,
      fetch: async (uri) => ({ uri, text: scopeText.join(' '), digest: 'b'.repeat(64) }),
    },
  );
async function accept(input = native()) {
  return acceptDiscovery(
    input,
    { query: 'Inspect a useful tool.', route: 'native', profile: 'wide' },
    { asOf: date, fetch: fetched },
  );
}

describe('native successor assessment and historical capacity', () => {
  it.each([
    {
      name: 'optional conflict',
      value: 75,
      optional: 'conflicts',
      required: 'satisfied',
      expected: 75,
    },
    {
      name: 'optional unknown',
      value: 100,
      optional: 'unknown',
      required: 'satisfied',
      expected: 100,
    },
    {
      name: 'optional conflict with unknown relevance',
      value: null,
      optional: 'conflicts',
      required: 'satisfied',
      expected: null,
    },
    {
      name: 'required conflict',
      value: 75,
      optional: 'satisfied',
      required: 'conflicts',
      expected: 0,
    },
    {
      name: 'required satisfied',
      value: 100,
      optional: 'satisfied',
      required: 'satisfied',
      expected: 100,
    },
    {
      name: 'required unknown',
      value: 100,
      optional: 'satisfied',
      required: 'unknown',
      expected: 50,
    },
    {
      name: 'required without evidence',
      value: 100,
      optional: 'satisfied',
      required: 'satisfied',
      evidence: false,
      expected: 50,
    },
    {
      name: 'required omitted',
      value: 100,
      optional: 'satisfied',
      required: 'satisfied',
      omitted: true,
      expected: 50,
    },
  ])('preserves native preference judgment and mandatory safeguards: $name', async (row) => {
    const input = native(5);
    const required = {
      text: 'Required capability',
      state: row.required,
      sources: row.evidence === false ? [] : [0],
    };
    const result = await acceptDiscovery(
      {
        ...input,
        interpretation: {
          ...input.interpretation,
          constraints: [
            { text: 'Required capability', required: true },
            { text: 'Preferred interface', required: false },
          ],
        },
        candidates: input.candidates.map((candidate) => ({
          ...candidate,
          relevance: {
            ...candidate.relevance,
            value: row.value,
            constraints: [
              ...(row.omitted ? [] : [required]),
              { text: 'Preferred interface', state: row.optional, sources: [0] },
            ],
          },
        })),
      },
      { query: 'Inspect a useful tool.', route: 'native', profile: 'wide' },
      { asOf: date, fetch: fetched },
    );
    const item = result.items[0]!;
    expect(item.relevance?.value).toBe(row.expected);
    expect(item.entity.assessment.score).toBe(81);
    expect(personalSaveDecision(item.entity, item.match, item.relevance).eligible).toBe(
      row.expected !== null && row.expected >= 75,
    );
    if (row.name === 'optional conflict') {
      const topicOnly = {
        ...item,
        entity: { ...item.entity, id: 'topic-only' },
        relevance: { ...item.relevance!, value: 25 as const },
      };
      expect(filterSearchItems([topicOnly, item])[0]?.entity.id).toBe(item.entity.id);
    }
  });
  it.each([
    { scope: 'overall', expected: null },
    { scope: 'required', expected: 50 },
  ])('preserves unavailable-source safeguards for $scope evidence', async ({ scope, expected }) => {
    const input = native(5);
    const unavailable = 'https://unavailable.example.org/evidence';
    const attempted: string[] = [];
    const result = await acceptDiscovery(
      {
        ...input,
        sources: [...input.sources, { ...input.sources[0]!, uri: unavailable }],
        interpretation: {
          ...input.interpretation,
          constraints: [{ text: 'Required capability', required: true }],
        },
        candidates: input.candidates.map((candidate) => ({
          ...candidate,
          relevance: {
            ...candidate.relevance,
            sources: scope === 'overall' ? [3] : [0],
            constraints: [
              {
                text: 'Required capability',
                state: 'satisfied',
                sources: scope === 'required' ? [3] : [0],
              },
            ],
          },
        })),
      },
      { query: 'Inspect a useful tool.', route: 'native', profile: 'wide' },
      {
        asOf: date,
        fetch: async (uri) => {
          attempted.push(uri);
          if (uri === unavailable) throw new Error('Fixture source unavailable');
          return fetched(uri);
        },
      },
    );
    expect(result.items[0]?.relevance?.value).toBe(expected);
    expect(result.items[0]?.entity.assessment.score).toBe(81);
    expect(attempted).toContain(unavailable);
    expect(result.sources.find((source) => source.uri === unavailable)?.reason).not.toBe(
      'native_inspection_deferred',
    );
  });
  it.each(['overall', 'required'])(
    'fetches accessible relevance-only $scope evidence before judging it',
    async (scope) => {
      const input = native(5);
      const accessible = 'https://accessible.example.org/evidence';
      const attempted: string[] = [];
      const result = await acceptDiscovery(
        {
          ...input,
          sources: [...input.sources, { ...input.sources[0]!, uri: accessible }],
          interpretation: {
            ...input.interpretation,
            constraints: [{ text: 'Required capability', required: true }],
          },
          candidates: input.candidates.map((candidate) => ({
            ...candidate,
            relevance: {
              ...candidate.relevance,
              sources: scope === 'overall' ? [3] : [0],
              constraints: [
                {
                  text: 'Required capability',
                  state: 'satisfied',
                  sources: scope === 'required' ? [3] : [0],
                },
              ],
            },
          })),
        },
        { query: 'Inspect a useful tool.', route: 'native', profile: 'wide' },
        {
          asOf: date,
          fetch: async (uri) => {
            attempted.push(uri);
            return fetched(uri);
          },
        },
      );
      expect(attempted).toContain(accessible);
      expect(result.sources.find((source) => source.uri === accessible)?.state).toBe('fetched');
      expect(result.items[0]?.relevance?.value).toBe(100);
      expect(result.items[0]?.entity.assessment.score).toBe(81);
    },
  );
  it('keeps relevance-only inspection within the existing document cap', async () => {
    const input = native(5);
    const extra = Array.from({ length: budgets.quick.documents + 1 }, (_, index) => ({
      ...input.sources[0]!,
      uri: `https://constraint-${index}.example.org/evidence`,
    }));
    const attempted: string[] = [];
    const result = await acceptDiscovery(
      {
        ...input,
        sources: [...input.sources, ...extra],
        interpretation: {
          ...input.interpretation,
          constraints: [{ text: 'Required capability', required: true }],
        },
        candidates: input.candidates.map((candidate) => ({
          ...candidate,
          relevance: {
            ...candidate.relevance,
            constraints: [
              {
                text: 'Required capability',
                state: 'satisfied',
                sources: extra.map((_, index) => index + 3),
              },
            ],
          },
        })),
      },
      { query: 'Inspect a useful tool.', route: 'native', profile: 'quick' },
      {
        asOf: date,
        fetch: async (uri) => {
          attempted.push(uri);
          return fetched(uri);
        },
      },
    );
    expect(attempted).toHaveLength(budgets.quick.documents);
    expect(
      result.sources.some((source) => source.reason === 'document_inspection_budget_exhausted'),
    ).toBe(true);
    expect(result.items[0]?.relevance?.value).toBe(50);
    expect(result.items[0]?.entity.assessment.score).toBe(81);
  });
  it('advertises brief v7 in both the machine schema and native guidance', () => {
    expect(Value.Check(nativeBriefSchema, native(7))).toBe(true);
    expect(Value.Check(nativeBriefSchema, native(5))).toBe(false);
    expect(Value.Check(nativeBriefSchema, native(4))).toBe(false);
    const prompt = nativePrompt({ query: 'Inspect a useful tool.' }, budgets.wide);
    expect(prompt).toContain('Return version 7');
    expect(prompt).toContain('belong to query relevance or contextual usefulness');
  });
  it('keeps identical brief-v4 evidence null under v7 and grants only limited v8 applicability', async () => {
    const historical = (await acceptScope(inspectedScope(4))).items[0]!;
    const current = (await acceptScope()).items[0]!;
    expect(historical.entity.observations.every((item) => item.verified)).toBe(true);
    expect(historical.entity.assessment).toMatchObject({
      policy: 'signal-strength-v7',
      score: null,
      disposition: 'not-scoreable',
    });
    expect(historical.entity.assessment.features.applicability).toMatchObject({
      contribution: 0,
      state: 'unknown',
    });
    expect(current.entity.assessment).toMatchObject({
      policy: 'signal-strength-v8',
      score: 31,
      disposition: 'provisional',
    });
    expect(current.entity.assessment.features.applicability).toMatchObject({
      contribution: 6.25,
      state: 'observed',
    });
    expect(current.entity.assessment.features.scrutiny?.contribution).toBe(0);
    expect(personalSaveDecision(current.entity, current.match, current.relevance).eligible).toBe(
      false,
    );
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-policy-replay-')));
    try {
      for (const item of [historical, current]) {
        expect(validateEntity(item.entity)).toEqual(item.entity);
        const result = await acceptScope(inspectedScope(item === historical ? 4 : 5));
        const stored: SearchResult = {
          ...result,
          schemaVersion: 2,
          runId: randomUUID(),
          query: 'Inspect a useful tool.',
          status: 'completed',
          limits: budgets.wide,
          usage: {
            searches: 0,
            documents: 3,
            elapsedMs: 0,
            modelCalls: 0,
            providerUsage: null,
            cost: null,
          },
        };
        await retainRun(stored, root);
        expect((await loadRun(stored.runId, root)).items[0]?.entity.assessment).toEqual(
          item.entity.assessment,
        );
        await saveEntities([item], 'manual', root, 'private', 75, true);
        expect(
          (await loadEntities(join(root, '.signals/corpus/entities')))[0]?.entity.assessment,
        ).toEqual(item.entity.assessment);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('preserves legacy proposal dispatch and accepts explicit v8 without manufacturing maximum credit', async () => {
    const proposal = decodeNativeResearch(inspectedScope(4)).proposal;
    delete proposal.assessmentPolicy;
    const dependencies = {
      asOf: date,
      fetch: async (uri: string) => ({ uri, text: scopeText.join(' '), digest: 'b'.repeat(64) }),
    };
    const request = {
      query: 'Inspect a useful tool.',
      route: 'native' as const,
      profile: 'wide' as const,
    };
    expect(
      (await acceptDiscovery(proposal, request, dependencies)).items[0]?.entity.assessment.policy,
    ).toBe('signal-strength-v7');
    proposal.assessmentPolicy = 'signal-strength-v8';
    proposal.candidates[0]!.signalJudgment!.dimensions.applicability.level = 4;
    const item = (await acceptDiscovery(proposal, request, dependencies)).items[0]!;
    expect(item.entity.assessment.features.applicability?.contribution).toBe(6.25);
    expect(item.entity.assessment.score).toBe(31);
  });
  it('holds missing, unverified, unknown and invalid-date applicability in v8', async () => {
    for (const mode of ['missing', 'unverified', 'unknown', 'future', 'stale', 'wrong-class']) {
      const item = (await acceptScope()).items[0]!;
      const observation = item.entity.observations.find(
        (entry) => entry.statement === scopeText[2],
      )!;
      if (mode === 'missing') item.entity.signalBasis!.dimensions.applicability.observations = [];
      if (mode === 'unverified') observation.verified = false;
      if (mode === 'unknown') observation.indicator = 'unknown';
      if (mode === 'wrong-class') observation.indicator = 'worked-example';
      if (mode === 'future' || mode === 'stale') {
        const source = item.entity.evidence.find((entry) => entry.id === observation.evidenceId)!;
        source.fetchedAt =
          mode === 'future' ? '2027-10-10T00:00:00.000Z' : '2024-10-10T00:00:00.000Z';
        item.entity.currentChecks![source.uri] = source.fetchedAt;
      }
      const assessment = assessEntity(item.entity, date, 'signal-strength-v8');
      expect(assessment.score, mode).toBeNull();
      expect(assessment.features.applicability?.contribution, mode).toBe(0);
    }
    for (const name of ['basis', 'work'] as const) {
      const item = (await acceptScope()).items[0]!;
      item.entity.signalBasis!.dimensions[name].observations = [];
      expect(assessEntity(item.entity, date, 'signal-strength-v8').score).toBeNull();
    }
  });
  it('retains v8 completed admission and material-failure ceilings', async () => {
    const item = (await accept(native(5))).items[0]!;
    expect(item.entity.assessment).toMatchObject({
      policy: 'signal-strength-v8',
      score: 81,
      disposition: 'completed',
    });
    expect(personalSaveDecision(item.entity, item.match, item.relevance).eligible).toBe(true);
    const input = native(5);
    input.candidates[0]!.observations.push(fact('risk/material', 2, true));
    const adverse = (await accept(input)).items[0]!;
    expect(adverse.entity.assessment.features.work?.contribution).toBe(6.25);
    expect(adverse.entity.assessment.features.applicability?.contribution).toBe(0);
    expect(personalSaveDecision(adverse.entity, adverse.match, adverse.relevance).eligible).toBe(
      false,
    );
  });
  it('accepts a justified high v7 through the ordinary native decoder and preserves replay', async () => {
    const result = await accept();
    const item = result.items[0]!;
    expect(item.entity.assessment).toMatchObject({
      policy: 'signal-strength-v7',
      rubric: 'software-v1',
      score: 81,
      disposition: 'completed',
    });
    expect(item.relevance?.value).toBe(100);
    expect(personalSaveDecision(item.entity, item.match, item.relevance).eligible).toBe(true);
    expect(validateEntity(item.entity)).toEqual(item.entity);
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-successor-')));
    try {
      await saveEntities([item], 'manual', root, 'private', 75, true);
      expect(
        (await loadEntities(join(root, '.signals/corpus/entities')))[0]?.entity.assessment,
      ).toEqual(item.entity.assessment);
      const stored: SearchResult = {
        ...result,
        schemaVersion: 2,
        runId: randomUUID(),
        query: 'Inspect a useful tool.',
        status: 'completed',
        usage: {
          searches: 0,
          documents: 3,
          elapsedMs: 0,
          modelCalls: 0,
          providerUsage: null,
          cost: null,
        },
        limits: budgets.wide,
      };
      await retainRun(stored, root);
      const replay = await loadRun(stored.runId, root);
      expect(replay.interpretation).toEqual(result.interpretation);
      expect(replay.items[0]?.relevance).toEqual(item.relevance);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('retains the seventh adverse and defining observations in v3 and holds exhausted v4 material', async () => {
    const old = native(3);
    old.candidates[0]!.observations.push(fact('risk/decisive', 1, true));
    expect(decodeNativeResearch(old).proposal.candidates[0]?.observations).toHaveLength(7);
    expect((await accept(old)).items[0]!.entity.assessment.score).toBeLessThan(81);
    old.candidates[0]!.observations = [
      ...Array.from({ length: 6 }, () => fact('maturity/documented')),
      fact('defining/defines'),
    ];
    delete (old.candidates[0] as { signalJudgment?: SignalJudgment }).signalJudgment;
    expect((await accept(old)).items[0]!.entity.assessment.score).not.toBeNull();
    const exceeded = native();
    exceeded.candidates[0]!.observations.push(
      ...Array.from({ length: 24 }, () => fact('maturity/documented')),
      fact('risk/decisive', 1, true),
    );
    const result = await accept(exceeded);
    expect(result.items[0]?.entity.observations.some((item) => item.feature === 'risk')).toBe(true);
    expect(result.gaps.join(' ')).toContain('deferred');
    expect(result.items[0]?.entity.assessment.score).toBeNull();
  });
  it('removes the old ordinary v6 ceiling without lowering its admission threshold or changing replay', async () => {
    const input = native(3);
    delete (input.candidates[0] as { signalJudgment?: SignalJudgment }).signalJudgment;
    input.sources.push({
      ...input.sources[2]!,
      uri: 'https://fourth.example.org/resource',
      publisher: 'Fourth publisher',
      origin: 'fourth',
    });
    input.candidates[0]!.observations = [
      fact('defining/defines'),
      ...['track-record', 'stable-interface', 'supported-or-complete', 'documented'].map(
        (indicator) => fact(`maturity/${indicator}`),
      ),
      ...[1, 2, 3].flatMap((source) => [
        fact('corroboration/applied', source, true),
        fact('adoption/broad', source, true),
      ]),
      fact('verification/replicated', 1, true),
      fact('authority/recognized'),
      fact('currentness/current'),
    ];
    const item = (await accept(input)).items[0]!;
    expect(item.entity.assessment.policy).toBe('signal-strength-v6');
    expect(item.entity.assessment.score).toBeGreaterThanOrEqual(75);
    expect(item.eligible).toBe(true);
    for (const policy of [
      'signal-strength-v0',
      'signal-strength-v1',
      'signal-strength-v2',
      'signal-strength-v3',
      'signal-strength-v4',
      'signal-strength-v5',
      'signal-strength-v6',
    ] as const)
      expect(assessEntity(item.entity, date, policy).score).toBe(
        ['signal-strength-v0', 'signal-strength-v1', 'signal-strength-v2'].includes(policy)
          ? 58
          : 88,
      );
  });
  it('distinguishes unknown decisive support, nondecisive uncertainty and established low quality', async () => {
    const unknown = native();
    unknown.candidates[0]!.signalJudgment.dimensions.work.level = null;
    expect((await accept(unknown)).items[0]?.entity.assessment).toMatchObject({
      score: null,
      disposition: 'not-scoreable',
    });
    const provisional = native();
    provisional.candidates[0]!.signalJudgment.dimensions.scrutiny.level = null;
    const item = (await accept(provisional)).items[0]!;
    expect(item.entity.assessment).toMatchObject({ score: 63, disposition: 'provisional' });
    expect(personalSaveDecision(item.entity, item.match, item.relevance).eligible).toBe(false);
    const weak = native();
    weak.candidates[0]!.observations.push(fact('risk/material', 1, true));
    expect((await accept(weak)).items[0]?.entity.assessment).toMatchObject({
      score: 50,
      disposition: 'completed',
    });
  });
  it('does not credit adverse scrutiny, correlated creators or manipulated attention', async () => {
    const adverse = native();
    adverse.candidates[0]!.observations[4] = fact('risk/material', 1, true);
    adverse.candidates[0]!.observations[5] = fact('risk/material', 2, true);
    expect(
      (await accept(adverse)).items[0]?.entity.assessment.features.scrutiny?.contribution,
    ).toBe(0);
    const mirrors = native();
    mirrors.sources[1]!.publisher = mirrors.sources[0]!.publisher;
    mirrors.sources[2]!.origin = mirrors.sources[1]!.origin;
    expect(
      (await accept(mirrors)).items[0]?.entity.assessment.features.scrutiny?.contribution,
    ).toBe(0);
    const attention = native();
    const popularity = {
      ...fact('adoption/attention'),
      quote: 'Measured 10000 stars demonstrate public attention.',
      statement: 'Measured stars.',
      attention: { metric: 'stars' as const, value: 10000 },
    };
    attention.candidates[0]!.observations[4] = popularity;
    attention.candidates[0]!.observations[5] = popularity;
    const result = await acceptDiscovery(
      attention,
      { query: 'A useful tool', route: 'native' },
      {
        asOf: date,
        fetch: async (uri) => ({
          uri,
          text: `${quote} ${popularity.quote}`,
          digest: 'a'.repeat(64),
        }),
      },
    );
    expect(result.items[0]?.entity.assessment.features.scrutiny?.contribution).toBe(5);
    popularity.attention.value = 100000;
    expect(decodeNativeResearch(attention).proposal.gaps.join(' ')).toContain('unbound attention');
  });
  it('uses standards 40/20/10/30, stable relevance ties and holds stale decisive status', async () => {
    const standard = native();
    standard.candidates[0]!.kind = 'standard';
    standard.candidates[0]!.signalJudgment.rubric = 'standard-v1';
    standard.candidates[0]!.signalJudgment.dimensions.scrutiny.level = null;
    standard.candidates[0]!.signalJudgment.dimensions.work.level = 2;
    standard.candidates[0]!.signalJudgment.dimensions.applicability.level = 4;
    standard.candidates[0]!.observations.push(fact('authority/formal-current'));
    standard.candidates[0]!.signalJudgment.dimensions.basis.observations = [0, 6];
    standard.candidates[0]!.signalJudgment.dimensions.applicability.observations = [3, 6];
    expect((await accept(standard)).items[0]?.entity.assessment.score).toBe(80);
    const a = (await accept()).items[0]!;
    const b = structuredClone(a);
    a.entity.id = 'z';
    b.entity.id = 'a';
    b.entity.assessment.score = null;
    expect(filterSearchItems([a, b])[0]?.entity.id).toBe('a');
    expect(
      assessEntity(
        (await accept()).items[0]!.entity,
        '2028-10-10T00:00:00.000Z',
        'signal-strength-v7',
      ).score,
    ).toBeNull();
  });
  it.each([4, 5])(
    'brief %i rejects ordinal promotion and requires official standard status',
    async (version) => {
      const promoted = native(version);
      promoted.candidates[0]!.observations[2] = fact('verification/inspectable');
      promoted.candidates[0]!.observations[3] = fact('authority/secondary');
      promoted.candidates[0]!.signalJudgment.dimensions.work = {
        level: 4,
        reason: 'Unsupported maximum.',
        observations: [2],
      };
      promoted.candidates[0]!.signalJudgment.dimensions.applicability.level = 4;
      const item = (await accept(promoted)).items[0]!;
      expect(item.entity.assessment.features.work?.contribution).toBe(6.25);
      expect(item.entity.assessment.features.applicability?.contribution).toBe(6.25);
      const standard = native(version);
      standard.candidates[0]!.kind = 'standard';
      standard.candidates[0]!.signalJudgment.rubric = 'standard-v1';
      standard.candidates[0]!.signalJudgment.dimensions.applicability.observations = [2];
      standard.candidates[0]!.observations[2] = fact('verification/inspectable');
      const official = (await accept(standard)).items[0]!;
      expect(official.entity.assessment.features.basis?.contribution).toBe(10);
      expect(official.entity.assessment.score).toBeNull();
      expect(official.entity.assessment.reasons?.join(' ')).toContain('issuer');
      expect(official.entity.assessment.features.applicability?.contribution).toBe(0);
      expect(official.entity.assessment.reasons?.join(' ')).toContain('official standard status');
    },
  );
  it.each([4, 5])(
    'brief %i removes invalid-date scrutiny credit and preserves provisional status',
    async (version) => {
      for (const invalidDate of ['2027-10-10T00:00:00.000Z', '2024-10-10T00:00:00.000Z']) {
        const item = (await accept(native(version))).items[0]!;
        const scrutiny = item.entity.signalBasis!.dimensions.scrutiny.observations;
        for (const source of item.entity.evidence)
          if (
            item.entity.observations.some(
              (observation) =>
                scrutiny.includes(observation.id) && observation.evidenceId === source.id,
            )
          ) {
            source.fetchedAt = invalidDate;
            item.entity.currentChecks![source.uri] = invalidDate;
          }
        // Keep work's valid creator example separate from invalid independent material.
        item.entity.signalBasis!.dimensions.work.observations =
          item.entity.signalBasis!.dimensions.work.observations.filter(
            (id) => !scrutiny.includes(id),
          );
        const assessment = assessEntity(item.entity, date, item.entity.assessment.policy);
        expect(assessment.features.scrutiny?.contribution).toBe(0);
        expect(assessment.disposition).toBe('provisional');
        expect(assessment.nextVerification).toContain('current');
      }
    },
  );
  it.each([4, 5])(
    'brief %i holds stale adverse evidence omitted by dimension references',
    async (version) => {
      const input = native(version);
      input.sources.push({
        ...input.sources[2]!,
        uri: 'https://adverse.example.net/material',
        publisher: 'Adverse inspector',
        origin: 'adverse',
      });
      input.candidates[0]!.observations.push(fact('risk/decisive', 3, true));
      const item = (await accept(input)).items[0]!;
      const risk = item.entity.observations.find((entry) => entry.feature === 'risk')!;
      const source = item.entity.evidence.find((entry) => entry.id === risk.evidenceId)!;
      source.fetchedAt = '2024-10-10T00:00:00.000Z';
      item.entity.currentChecks![source.uri] = source.fetchedAt;
      item.entity.assessment = assessEntity(item.entity, date, item.entity.assessment.policy);
      expect(item.entity.assessment.score).toBeNull();
      expect(item.entity.assessment.reasons?.join(' ')).toContain('adverse evidence');
      expect(personalSaveDecision(item.entity, item.match, item.relevance).eligible).toBe(false);
    },
  );
  it('bounds total native observations at 240 while preserving late defining/adverse material and omission holds', async () => {
    const input = native();
    const candidate = input.candidates[0]!;
    candidate.observations.push(...Array.from({ length: 18 }, () => fact('maturity/documented')));
    input.candidates = Array.from({ length: 12 }, (_, index) => ({
      ...structuredClone(candidate),
      name: `Candidate ${index}`,
      uri: `https://source-0.example.org/tool-${index}`,
    }));
    input.candidates[11]!.observations[23] = fact('risk/decisive', 2, true);
    const decoded = decodeNativeResearch(input);
    expect(decoded.proposal.candidates.flatMap((item) => item.observations)).toHaveLength(240);
    expect(
      decoded.proposal.candidates[11]?.observations.some((item) => item.feature === 'defining'),
    ).toBe(true);
    expect(
      decoded.proposal.candidates[11]?.observations.some((item) => item.feature === 'risk'),
    ).toBe(true);
    expect(
      decoded.proposal.candidates.reduce(
        (sum, item) => sum + (item.inspection?.deferredObservations ?? 0),
        0,
      ),
    ).toBe(48);
    const result = await accept(input);
    expect(
      result.items
        .filter((item) => item.entity.inspection?.state === 'deferred')
        .every((item) => item.entity.assessment.score === null && !item.eligible),
    ).toBe(true);
  });
});
