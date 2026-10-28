import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, readdir, rm, mkdir, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acceptDiscovery,
  signalSearch,
  observationIdentity,
  entityIdentity,
} from './signal-search.js';
import { assessEntity, filterSearchItems, saveDecision } from '../../domain/src/search-score.js';
import { type Proposal, parseRequest } from '../../domain/src/search-contract.js';
import {
  saveEntities as saveNativeEntities,
  loadEntities,
  validateEntity,
  withWriter,
  retainRun,
  loadRun,
  selectionHistory,
} from './search-store.js';
const saveEntities: typeof saveNativeEntities = (items, mode, root, destination, threshold) =>
  saveNativeEntities(items, mode, root, destination, threshold, true);
import { dueSlot, runDueOnce } from './search-scheduler.js';
import { defaultSettings, saveSettings, loadSettings } from './search-settings.js';
import { normalizeText, normalizeSpan, digest } from './search-fetch.js';
import { parseEvidenceBundle } from '../../domain/src/evidence-exchange.js';
import { RunnerFailure, type SearchRunner } from './search-runner.js';
import { searchEvidenceBundle } from './search-exchange.js';
import { checkPrimaryMaterial } from './search-reuse.js';
import { extractHtml } from './search-document.js';

const date = '2026-10-05T00:00:00.000Z';

it('keeps source exclusion scope in acquisition gaps and the frozen enrichment input', async () => {
  const input = proposal();
  const raw =
    '<html><body><p>portable research tool</p><div aria-hidden="true">Except under the excluded configuration.</div><script type="application/ld+json">{"restriction":"supporting condition required"}</script></body></html>';
  const material = extractHtml(raw, input.sources[0]!.uri);
  let seen: string[] | undefined;
  const result = await acceptDiscovery(
    input,
    { query: 'research', profile: 'quick' },
    {
      asOf: date,
      fetch: async (uri) => ({
        uri,
        text: material.text,
        digest: digest(raw),
        normalizer: 'text-v3',
        material,
      }),
      enrich: async (proposal, sources) => {
        seen = sources[0]!.omissions;
        return proposal;
      },
    },
  );
  expect(seen?.join(' ')).toContain('not complete source coverage');
  expect(seen?.join(' ')).toContain('Excluded inert JSON-script text');
  expect(result.gaps.join(' ')).toContain('not complete source coverage');
  expect(material.text).not.toContain('supporting condition');
});
function proposal(): Proposal {
  return {
    sources: [
      {
        uri: 'https://example.com/resource',
        title: 'Resource',
        publisher: 'Maintainer',
        family: 'primary',
        publishedAt: date,
        origin: 'maintainer',
      },
    ],
    candidates: [
      {
        uri: 'https://example.com/tool',
        name: 'Useful resource',
        kind: 'software',
        identity: 'resolved',
        aliases: [],
        description: 'A portable research tool.',
        facets: {
          domains: ['research'],
          capabilities: ['search'],
          interfaces: [],
          deliveryForms: [],
          platforms: [],
          licenses: [],
          tags: [],
        },
        observations: [
          {
            source: 0,
            feature: 'defining',
            indicator: 'defines',
            statement: 'Supports portable research.',
            quote: 'portable research tool',
            independent: false,
            origin: 'maintainer',
            status: 'supported',
          },
        ],
        match: { level: 'direct', reason: 'Addresses the need.', sources: [0] },
        limits: ['Use is unmeasured.'],
      },
    ],
    coverage: [
      { channel: 'open-web', state: 'searched', searches: 1, reason: 'Acquired a candidate.' },
    ],
    gaps: [],
  };
}
const fetch = async (uri: string) => ({
  uri,
  text: 'A portable research tool with worked examples, stable interface and supported maintenance.',
  digest: 'a'.repeat(64),
});
async function acquired(input = proposal()) {
  return acceptDiscovery(
    input,
    { query: 'Portable research', profile: 'quick' },
    { fetch, asOf: date },
  );
}
const runner = (value: unknown): SearchRunner => ({
  readiness: async () => ({
    available: true,
    broadSearch: true,
    runner: 'isolated test',
    reason: 'fixture',
  }),
  discover: async () => ({ proposal: value, usage: null, searches: 1 }),
});
it('replaces reviewed preliminary gaps while retaining actual fetch failures and acquisition evidence', async () => {
  const input = proposal();
  input.gaps = ['Current status has not been extracted.'];
  input.candidates[0]!.limits = ['Current status has not been extracted.'];
  input.sources.push({
    ...input.sources[0]!,
    uri: 'https://example.org/denied',
    title: 'Denied evidence',
  });
  const original = structuredClone(input);
  const result = await acceptDiscovery(
    input,
    { query: 'research', profile: 'quick' },
    {
      asOf: date,
      fetch: async (uri) => {
        if (uri.includes('example.org')) throw new Error('source_denied');
        return fetch(uri);
      },
      enrich: async (acquisition) => ({
        ...acquisition,
        candidates: acquisition.candidates.map((candidate) => ({
          ...candidate,
          limits: ['Independent deployment is unverified.'],
        })),
        gaps: [],
      }),
    },
  );
  expect(result.items[0]!.entity.limits).toEqual(['Independent deployment is unverified.']);
  expect(result.gaps).toEqual(['Denied evidence: source_denied']);
  expect(input).toEqual(original);
});

describe('live search contract and evidence policy', () => {
  it('bounds the complete extraction payload and retains beginning/end coverage even with dense source anchors', async () => {
    const input = proposal();
    input.sources = Array.from({ length: 60 }, (_, index) => ({
      ...input.sources[0]!,
      uri: `https://example.com/source-${index}`,
    }));
    input.candidates[0]!.observations = input.sources.map((_, source) => ({
      ...input.candidates[0]!.observations[0]!,
      source,
    }));
    let captured: { text: string }[] = [];
    await acceptDiscovery(
      input,
      { query: 'research', profile: 'wide' },
      {
        asOf: date,
        fetch: async (uri) => ({
          ...(await fetch(uri)),
          text: `head sentinel ${'padding '.repeat(4000)} portable research tool ${'padding '.repeat(4000)} tail sentinel`,
        }),
        enrich: async (proposal, material) => {
          captured = material;
          return proposal;
        },
      },
    );
    expect(captured).toHaveLength(60);
    expect(captured.reduce((sum, source) => sum + source.text.length, 0)).toBeLessThanOrEqual(
      48000,
    );
    expect(
      captured.every(
        (source) => source.text.includes('head sentinel') && source.text.includes('tail sentinel'),
      ),
    ).toBe(true);
  });
  it('isolates repeated candidate identities without losing review of other candidates', async () => {
    const input = proposal();
    input.candidates.push({
      ...structuredClone(input.candidates[0]!),
      name: 'Different lead',
      kind: 'practice',
      uri: 'https://example.com/tool/',
    });
    input.candidates.push({
      ...structuredClone(input.candidates[0]!),
      uri: 'https://example.com/unique',
      name: 'Unique tool',
    });
    const before = JSON.stringify(input);
    let reviewed: string[] = [];
    const result = await acceptDiscovery(
      input,
      { query: 'research' },
      {
        fetch,
        asOf: date,
        enrich: async (selected) => {
          reviewed = selected.candidates.map((candidate) => candidate.name);
          return selected;
        },
      },
    );
    expect(reviewed).toEqual(['Unique tool']);
    expect(JSON.stringify(input)).toBe(before);
    const ambiguous = result.items.find((item) => item.entity.identity === 'ambiguous')!;
    expect(ambiguous.entity.observations).toEqual([]);
    expect(ambiguous.entity.assessment.score).toBeNull();
    expect(ambiguous.eligible).toBe(false);
    expect(
      result.items.find((item) => item.entity.name === 'Unique tool')!.entity.observations.length,
    ).toBeGreaterThan(0);
    input.candidates.pop();
    const onlyAmbiguous = await acceptDiscovery(
      input,
      { query: 'research' },
      {
        fetch,
        asOf: date,
        enrich: async () => {
          throw new Error('ambiguous_group_must_not_invoke_review');
        },
      },
    );
    expect(
      onlyAmbiguous.gaps.some((gap) => gap.includes('ambiguous_group_must_not_invoke_review')),
    ).toBe(false);
    expect(onlyAmbiguous.items[0]!.entity.assessment.score).toBeNull();
  });
  it('retains a rejected explicit reassessment and its usage without erasing original verified observations', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-extraction-receipt-')));
    const raw = {
      candidates: [{ uri: 'https://example.com/changed-identity', observations: [] }],
      gaps: [],
    };
    try {
      const result = await signalSearch(
        { query: 'research', cache: 'private', save: 'never', review: true },
        {
          root,
          fetch,
          runner: {
            ...runner(proposal()),
            enrich: async (_proposal, _material, _request, _signal, _progress, receipt) => {
              await receipt?.(raw, { output_tokens: 123 });
              throw new Error('extraction_identity_change');
            },
          },
        },
      );
      expect(
        JSON.parse(
          await readFile(join(root, '.signals/extractions', `${result.runId}.json`), 'utf8'),
        ),
      ).toEqual({ proposal: raw, usage: { output_tokens: 123 } });
      expect(result.items[0]!.entity.observations[0]!.verified).toBe(true);
      expect(result.gaps).toContain('Grounded extraction unavailable: extraction_identity_change');
      expect(result.usage.providerUsage).toEqual({
        discovery: null,
        extraction: { output_tokens: 123 },
      });
      expect(await loadEntities(join(root, 'signals/entities'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('uses fixed capped attention anchors and rejects counts absent from their evidence without changing old policy replay', async () => {
    const measured = async (count: number) => {
      const input = proposal();
      input.candidates[0]!.observations.push({
        ...input.candidates[0]!.observations[0]!,
        feature: 'adoption',
        indicator: 'attention',
        quote: `Repository has ${count} stars`,
        attention: { metric: 'stars', value: count },
      });
      return (
        await acceptDiscovery(
          input,
          { query: 'research' },
          {
            asOf: date,
            fetch: async (uri) => ({
              ...(await fetch(uri)),
              text: `A portable research tool. Repository has ${count} stars`,
            }),
          },
        )
      ).items[0]!.entity;
    };
    const zero = await measured(0),
      low = await measured(10),
      high = await measured(10000),
      huge = await measured(1000000);
    expect(zero.assessment.features.adoption!.value).toBe(0);
    expect(low.assessment.features.adoption!.value).toBeLessThan(
      high.assessment.features.adoption!.value,
    );
    expect(high.assessment.features.adoption!.contribution).toBe(5);
    expect(huge.assessment.features.adoption!.contribution).toBe(5);
    expect(assessEntity(low, date, 'signal-strength-v3').features.adoption!.contribution).toBe(5);
    expect(high.assessment.score).toBeLessThan(75);
    validateEntity(low);
    low.observations.find((item) => item.attention)!.attention!.value = 1000000;
    expect(() => validateEntity(low)).toThrow('unbound_attention_count');
    const unbound = proposal();
    unbound.candidates[0]!.observations[0]!.attention = { metric: 'stars', value: 10000 };
    await expect(acquired(unbound)).rejects.toThrow('unbound_attention_count');
  });
  it('decodes legacy spans with their original cleanup while requiring literal spans in text-v2', async () => {
    const item = (await acquired()).items[0]!;
    const observation = item.entity.observations[0]!;
    delete observation.identityVersion;
    observation.quote = 'portable <legacy> research tool';
    Object.assign(
      observation,
      observationIdentity(item.entity.id, observation.evidenceId, observation),
    );
    item.entity.assessment = assessEntity(item.entity, date);
    expect(() => validateEntity(item.entity)).not.toThrow();
    const input = proposal();
    const literal = (
      await acceptDiscovery(
        input,
        { query: 'research' },
        {
          asOf: date,
          fetch: async (uri) => ({ ...(await fetch(uri)), normalizer: 'text-v2' }),
        },
      )
    ).items[0]!.entity;
    literal.observations[0]!.quote = observation.quote;
    delete literal.observations[0]!.identityVersion;
    Object.assign(
      literal.observations[0]!,
      observationIdentity(
        literal.id,
        literal.observations[0]!.evidenceId,
        literal.observations[0]!,
      ),
    );
    expect(() => validateEntity(literal)).toThrow('forged_span_verification');
  });
  it('does not carry legacy stripped-JSON credit into a corrected literal representation with the same raw digest', async () => {
    const input = proposal();
    const defines = { ...input.candidates[0]!.observations[0]!, quote: 'We do recommend this' };
    input.candidates[0]!.observations = [
      defines,
      { ...defines, feature: 'adoption', indicator: 'attention' },
    ];
    const old = (
      await acceptDiscovery(
        input,
        { query: 'recommendation' },
        {
          fetch: async (uri) => ({
            uri,
            digest: 'a'.repeat(64),
            text: '{"description":"We do recommend this"}',
          }),
          asOf: date,
        },
      )
    ).items[0]!;
    expect(old.entity.assessment.score).toBe(5);
    input.candidates[0]!.observations = [{ ...defines, quote: 'We do <not> recommend this' }];
    const current = (
      await acceptDiscovery(
        input,
        { query: 'recommendation' },
        {
          fetch: async (uri) => ({
            uri,
            digest: 'a'.repeat(64),
            normalizer: 'text-v2',
            text: '{"description":"We do <not> recommend this"}',
          }),
          asOf: date,
        },
      )
    ).items[0]!;
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-literal-projection-')));
    try {
      await saveEntities([old], 'manual', root);
      await saveEntities([current], 'refresh', root);
      const entity = (await loadEntities(join(root, 'signals/entities')))[0]!.entity;
      expect(entity.assessment.score).toBe(0);
      expect(entity.observations).toHaveLength(3);
      expect(assessEntity(entity, date, 'signal-strength-v2').score).toBe(5);
      await saveEntities([old], 'manual', root);
      const reopened = (await loadEntities(join(root, 'signals/entities')))[0]!.entity;
      expect(reopened.currentEvidence).toEqual(current.entity.currentEvidence);
      expect(reopened.assessment.score).toBe(0);
      expect(reopened.evidence).toEqual(entity.evidence);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('preserves observed acquisition usage on a failed runner without inventing provider token counts', async () => {
    const result = await signalSearch(
      { query: 'Portable research' },
      {
        runner: {
          ...runner(proposal()),
          discover: async () => {
            throw new RunnerFailure('budget_exhausted', 9, { provider: null });
          },
        },
      },
    );
    expect(result.status).toBe('failed');
    expect(result.usage.searches).toBe(9);
    expect(result.usage.providerUsage).toEqual({ provider: null });
    expect(result.usage.cost).toBeNull();
  });
  it('exports actual native results through the frozen namespaced consumer contract without translating scores into confidence', async () => {
    const result = await signalSearch(
      { query: 'Portable research' },
      { runner: runner(proposal()), fetch },
    );
    const bundle = searchEvidenceBundle(result, 'a'.repeat(40));
    expect(bundle.mode).toBe('fixture');
    expect(bundle.extensions!['signals.acquisition']).toEqual({ fixture: true });
    const bytes = JSON.stringify(bundle);
    expect(() => parseEvidenceBundle(bytes, digest(bytes))).toThrow(
      'Fixtures cannot enter real evidence admission',
    );
    expect(bundle.candidates[0]!.signal!.evidence_confidence).toBe('unknown');
    expect(bundle.extensions).toHaveProperty('signals-ai.native-assessments');
    expect(bundle.sources[0]!.observed_at).toBe(date);
    for (const item of result.items) item.entity.acquisition = 'configured-live';
    const live = searchEvidenceBundle(result, 'b'.repeat(40));
    expect(live.mode).toBe('model-led');
    expect(live.extensions!['signals-ai.source-dates']).toEqual(
      bundle.extensions!['signals-ai.source-dates'],
    );
  });
  it('assesses after real fetch receipts and replays an early historical cutoff without rewriting evidence', async () => {
    const result = await signalSearch(
      { query: 'Portable research' },
      {
        runner: runner(proposal()),
        fetch: async (uri) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { ...(await fetch(uri)), fetchedAt: new Date().toISOString() };
        },
      },
    );
    const entity = result.items[0]!.entity;
    expect(Date.parse(entity.assessment.asOf)).toBeGreaterThanOrEqual(
      Date.parse(entity.evidence[0]!.fetchedAt),
    );
    validateEntity(entity);
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-cutoff-')));
    try {
      const late = '2026-10-05T01:00:00.000Z';
      entity.evidence[0]!.fetchedAt = late;
      entity.currentChecks = { [entity.evidence[0]!.uri]: late };
      entity.assessment.asOf = date;
      await retainRun(result, root);
      const path = join(root, '.signals/runs', `${result.runId}.json`);
      const original = await readFile(path, 'utf8');
      expect((await loadRun(result.runId, root)).items[0]!.entity.assessment.asOf).toBe(late);
      expect(await readFile(path, 'utf8')).toBe(original);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('preserves literal negation in JSON evidence instead of stripping it as HTML', async () => {
    const raw = '{"description":"We do <not> recommend this"}';
    expect(normalizeSpan(raw)).toContain('<not>');
    const input = proposal();
    input.candidates[0]!.observations[0]!.quote = 'We do recommend this';
    const result = await acceptDiscovery(
      input,
      { query: 'recommendation' },
      {
        fetch: async (uri) => ({ uri, digest: 'b'.repeat(64), text: normalizeSpan(raw) }),
        asOf: date,
      },
    );
    expect(result.items[0]!.entity.observations[0]!.verified).toBe(false);
  });
  it('counts independent original third-party evidence while excluding own-origin relabeling and replaying old policies', async () => {
    const input = proposal();
    input.sources.push({
      ...input.sources[0]!,
      uri: 'https://independent.example.org/study',
      publisher: 'Independent researcher',
      origin: 'Independent study',
    });
    input.candidates[0]!.observations.push({
      ...input.candidates[0]!.observations[0]!,
      source: 1,
      feature: 'corroboration',
      indicator: 'applied',
      independent: true,
    });
    const entity = (await acquired(input)).items[0]!.entity;
    expect(entity.assessment.features.corroboration!.value).toBeGreaterThan(0);
    expect(assessEntity(entity, date, 'signal-strength-v2').features.corroboration!.value).toBe(0);
    input.sources[1]!.uri = 'https://example.com/another-path';
    const own = (await acquired(input)).items[0]!.entity;
    expect(own.assessment.features.corroboration!.value).toBe(0);
    input.sources[1]!.uri = 'https://docs.example.com/study';
    expect((await acquired(input)).items[0]!.entity.assessment.features.corroboration!.value).toBe(
      0,
    );
    input.candidates[0]!.uri = 'https://arxiv.org/abs/1234.001';
    input.sources[1]!.uri = 'https://arxiv.org/abs/1234.002';
    expect(
      (await acquired(input)).items[0]!.entity.assessment.features.corroboration!.value,
    ).toBeGreaterThan(0);
    input.candidates[0]!.uri = 'https://news.ycombinator.com/item?id=1';
    input.sources[1]!.uri = 'https://news.ycombinator.com/item?id=2';
    expect(
      (await acquired(input)).items[0]!.entity.assessment.features.corroboration!.value,
    ).toBeGreaterThan(0);
  });
  it('does not load a corpus or create files in no-save memory mode; binds fetched spans', async () => {
    const result = await signalSearch(
      { query: 'Portable research', save: 'never', cache: 'memory' },
      { runner: runner(proposal()), fetch },
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.entity.assessment.score).toBe(0);
    expect(result.items[0]!.entity.observations[0]!.verified).toBe(true);
    expect(result.coverage).toHaveLength(12);
    expect(result.sources[0]!.digest).toBe('a'.repeat(64));
  });
  it('rejects malformed output, arbitrary normalized scores, references and feature indicators', async () => {
    expect(
      (await signalSearch({ query: 'x' }, { runner: runner({ candidates: [] }) })).gaps,
    ).toContain('invalid_model_output');
    const bad = proposal();
    bad.candidates[0]!.observations[0]!.source = 8;
    await expect(acquired(bad)).rejects.toThrow('invalid_evidence_binding');
    const score = proposal();
    Object.assign(score.candidates[0]!, { score: 100 });
    await expect(acquired(score)).rejects.toThrow('invalid_model_output');
  });
  it('preserves no-defining-evidence candidates and source failures as inspectable unknowns', async () => {
    const input = proposal();
    input.candidates[0]!.observations[0]!.quote = 'invented support';
    const result = await acquired(input);
    expect(result.items[0]!.entity.assessment.score).toBeNull();
    expect(result.items[0]!.eligible).toBe(false);
    const failed = await acceptDiscovery(
      proposal(),
      { query: 'x' },
      {
        fetch: async () => {
          throw new Error('source_denied_403');
        },
        asOf: date,
      },
    );
    expect(failed.items).toHaveLength(1);
    expect(failed.sources[0]!.state).toBe('denied');
    expect(failed.gaps).toContain('Resource: source_denied_403');
  });
  it('deduplicates mirrors, keeps relevance separate, and allows contrary evidence to reduce strength', async () => {
    const input = proposal();
    input.sources[0]!.uri = 'https://independent.example.org/report';
    input.sources[0]!.family = 'practitioners';
    input.sources.push({
      ...input.sources[0]!,
      uri: 'https://another.example.net/report',
      publisher: 'Mirror',
    });
    input.candidates[0]!.observations.push({
      ...input.candidates[0]!.observations[0]!,
      feature: 'corroboration',
      indicator: 'applied',
      independent: true,
    });
    const one = (await acquired(input)).items[0]!.entity;
    input.candidates[0]!.observations.push({ ...input.candidates[0]!.observations[1]!, source: 1 });
    const mirrored = (await acquired(input)).items[0]!.entity;
    expect(mirrored.assessment.features.corroboration!.value).toBe(
      one.assessment.features.corroboration!.value,
    );
    expect(assessEntity(mirrored, date)).toEqual(mirrored.assessment);
    input.candidates[0]!.observations.push({
      ...input.candidates[0]!.observations[0]!,
      feature: 'risk',
      indicator: 'material',
    });
    const negative = (await acquired(input)).items[0]!.entity;
    expect(negative.assessment.score!).toBeLessThan(mirrored.assessment.score!);
    expect(
      saveDecision(negative, { level: 'out-of-scope', reason: 'Irrelevant', sources: [] }, 0)
        .eligible,
    ).toBe(false);
    const direct = {
      entity: one,
      match: { level: 'direct' as const, reason: 'exact', sources: [] },
      eligible: false,
      reasons: [],
    };
    const irrelevant = {
      ...direct,
      entity: { ...one, id: 'other', assessment: { ...one.assessment, score: 100 } },
      match: { ...direct.match, level: 'out-of-scope' as const },
    };
    expect(filterSearchItems([irrelevant, direct])[0]).toBe(direct);
  });
  it('does not turn attention or missingness into perfect scores; currentness uses source dates', async () => {
    const input = proposal();
    input.candidates[0]!.observations.push(
      { ...input.candidates[0]!.observations[0]!, feature: 'adoption', indicator: 'broad' },
      { ...input.candidates[0]!.observations[0]!, feature: 'currentness', indicator: 'current' },
    );
    input.sources[0]!.publishedAt = '2018-01-01T00:00:00.000Z';
    const entity = (await acquired(input)).items[0]!.entity;
    expect(entity.assessment.features.adoption!.value).toBe(0.25);
    expect(entity.assessment.features.currentness!.value).toBe(0.5);
    expect(entity.assessment.missing.length).toBeGreaterThan(0);
    expect(entity.assessment.score).toBeLessThan(100);
  });
  it('honors cancellation and rejects a private source before fetching', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      (
        await signalSearch(
          { query: 'x' },
          { runner: runner(proposal()), signal: controller.signal, fetch },
        )
      ).status,
    ).toBe('cancelled');
    const input = proposal();
    input.sources[0]!.uri = 'https://127.0.0.1/';
    const result = await acquired(input);
    expect(result.sources[0]!.state).toBe('denied');
    expect(result.items[0]!.entity.assessment.score).toBeNull();
    expect(normalizeText('<script>danger()</script><p>safe &amp; text</p>')).toBe('safe & text');
    expect(normalizeText('&#x110000; &#128038;')).toBe('\uFFFD \u{1F426}');
  });
  it('keeps unknown indicators missing and accepts current formal status without pointless standard churn', async () => {
    const input = proposal();
    input.candidates[0]!.kind = 'standard';
    input.sources[0]!.publishedAt = '2010-01-01T00:00:00.000Z';
    input.candidates[0]!.observations.push(
      { ...input.candidates[0]!.observations[0]!, feature: 'currentness', indicator: 'current' },
      {
        ...input.candidates[0]!.observations[0]!,
        feature: 'authority',
        indicator: 'formal-current',
      },
      {
        ...input.candidates[0]!.observations[0]!,
        feature: 'adoption',
        indicator: 'unknown',
        independent: true,
      },
    );
    const entity = (await acquired(input)).items[0]!.entity;
    expect(entity.assessment.features.currentness!.value).toBe(1);
    expect(entity.assessment.features.adoption!.state).toBe('not-applicable');
    expect(entity.assessment.missing).not.toContain('adoption');
    expect(assessEntity(entity, date, 'signal-strength-v0').missing).toContain('adoption');
    expect(assessEntity(entity, date, 'signal-strength-v0').features.authority!.contribution).toBe(
      10,
    );
    const aged = assessEntity(entity, '2050-10-05T00:00:00.000Z');
    expect(aged.features.currentness!.value).toBe(0.5);
    expect(aged.features.authority!.value).toBe(0.75);
    expect(aged.score).toBeLessThan(entity.assessment.score!);
    expect(
      assessEntity(entity, '2050-10-05T00:00:00.000Z', 'signal-strength-v0').features.currentness!
        .value,
    ).toBe(1);
  });
  it('preserves original v0 snapshot semantics while v1 selects the current snapshot', async () => {
    const input = proposal();
    input.candidates[0]!.observations.push({
      ...input.candidates[0]!.observations[0]!,
      feature: 'maturity',
      indicator: 'documented',
    });
    const entity = (await acquired(input)).items[0]!.entity;
    const oldSource = structuredClone(entity.evidence[0]!);
    oldSource.id = 'historical-snapshot';
    oldSource.digest = 'b'.repeat(64);
    oldSource.fetchedAt = '2020-01-01T00:00:00.000Z';
    entity.evidence.push(oldSource);
    entity.observations.push({
      ...entity.observations[0]!,
      id: 'historical-observation',
      evidenceId: oldSource.id,
      feature: 'maturity',
      indicator: 'supported-or-complete',
    });
    expect(assessEntity(entity, date, 'signal-strength-v0').features.maturity!.value).toBe(0.5);
    expect(assessEntity(entity, date).features.maturity!.value).toBe(0.25);
  });
  it('credits sourced popularity without converting an origin counter into independent use', async () => {
    const input = proposal();
    input.candidates[0]!.observations.push({
      ...input.candidates[0]!.observations[0]!,
      feature: 'adoption',
      indicator: 'attention',
      statement: 'The origin lists 100000 stars.',
      quote: 'Star 100000',
      independent: false,
    });
    const result = await acceptDiscovery(
      input,
      { query: 'research' },
      {
        asOf: date,
        fetch: async (uri) => ({
          uri,
          digest: 'a'.repeat(64),
          text: 'A portable research tool. Star 100000.',
        }),
      },
    );
    const entity = result.items[0]!.entity;
    expect(entity.assessment.features.adoption!.contribution).toBe(5);
    expect(entity.assessment.features.corroboration!.value).toBe(0);
    expect(entity.assessment.score).toBe(5);
  });
  it('normalizes supplemental scopes, rejects URL parameters and enforces the effective limit before saving', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-sites-')));
    try {
      expect(
        parseRequest({
          query: 'research',
          supplementalSites: ['https://www.reddit.com/r/codex/', 'https://www.reddit.com/r/codex'],
        }).supplementalSites,
      ).toEqual(['https://www.reddit.com/r/codex']);
      expect(() =>
        parseRequest({
          query: 'research',
          supplementalSites: ['https://example.org/?utm_source=tracking'],
        }),
      ).toThrow('invalid_supplemental_site');
      const settings = {
        ...structuredClone(defaultSettings),
        queries: [
          {
            id: 'interest',
            query: 'research',
            enabled: true,
            everyDays: 7,
            offsetMinutes: 0,
            concepts: [],
            supplementalSites: ['https://www.reddit.com/r/codex/'],
          },
        ],
      };
      await saveSettings(settings, root);
      expect((await loadSettings(root)).queries[0]!.supplementalSites).toEqual([
        'https://www.reddit.com/r/codex',
      ]);
      settings.queries[0]!.supplementalSites = Array.from(
        { length: 16 },
        (_, i) => `https://scope${i}.example`,
      );
      await expect(saveSettings(settings, root)).rejects.toThrow('invalid_request');
      expect((await loadSettings(root)).queries[0]!.supplementalSites).toEqual([
        'https://www.reddit.com/r/codex',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('records chosen-query provenance privately even when canonical evidence is unchanged', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-selections-')));
    try {
      const item = (await acquired()).items[0]!;
      const provenance = {
        runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        query: 'private interest',
        kind: 'query-discovery' as const,
        queryId: 'interest',
        concepts: ['context.skills'],
      };
      await saveNativeEntities([item], 'manual', root, 'private', 75, true, provenance);
      await saveNativeEntities([item], 'manual', root, 'private', 75, true, provenance);
      expect(await selectionHistory(root)).toHaveLength(1);
      await saveNativeEntities([item], 'manual', root, 'private', 75, true, {
        ...provenance,
        runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        query: 'another interest',
      });
      expect(await selectionHistory(root)).toHaveLength(2);
      expect(await readdir(root)).toEqual(['.signals']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('replays the same policy and thresholds over a fixed fully observed artificial resource', async () => {
    const input = proposal();
    input.sources = Array.from({ length: 8 }, (_, index) => ({
      ...input.sources[0]!,
      uri: `https://publisher${index}.example.org/report`,
      publisher: `Independent publisher ${index}`,
      origin: `work-${index}`,
      family: 'practitioners' as const,
    }));
    const base = input.candidates[0]!.observations[0]!;
    input.candidates[0]!.observations.push(
      ...input.sources.map((_, source) => ({
        ...base,
        source,
        feature: 'corroboration',
        indicator: 'applied' as const,
        independent: true,
      })),
      ...input.sources.map((_, source) => ({
        ...base,
        source,
        feature: 'adoption',
        indicator: 'broad' as const,
        independent: true,
      })),
      ...(['track-record', 'stable-interface', 'supported-or-complete', 'documented'] as const).map(
        (indicator) => ({ ...base, feature: 'maturity', indicator }),
      ),
      { ...base, feature: 'currentness', indicator: 'current' },
      { ...base, feature: 'authority', indicator: 'formal-current' },
      { ...base, feature: 'verification', indicator: 'replicated' },
    );
    const item = (await acquired(input)).items[0]!;
    expect(item.entity.acquisition).toBe('fixture');
    expect(item.entity.assessment.score).toBe(98);
    expect(
      [65, 75, 85].map((threshold) => saveDecision(item.entity, item.match, threshold).eligible),
    ).toEqual([true, true, true]);
    const weaker = structuredClone(item.entity);
    weaker.observations = weaker.observations.filter(
      (observation) => !['adoption', 'maturity'].includes(observation.feature),
    );
    weaker.assessment = assessEntity(weaker, date);
    expect(weaker.assessment.score).toBe(58);
    expect(
      [65, 75, 85].map((threshold) => saveDecision(weaker, item.match, threshold).eligible),
    ).toEqual([false, false, false]);
    const middle = structuredClone(item.entity);
    middle.observations = middle.observations.filter(
      (observation) => !['adoption', 'authority'].includes(observation.feature),
    );
    middle.assessment = assessEntity(middle, date);
    expect(middle.assessment.score).toBe(68);
    expect(
      [65, 75, 85].map((threshold) => saveDecision(middle, item.match, threshold).eligible),
    ).toEqual([true, false, false]);
    const risk = proposal().candidates[0]!.observations[0]!;
    input.candidates[0]!.observations.push({ ...risk, feature: 'risk', indicator: 'material' });
    const challenged = (await acquired(input)).items[0]!;
    expect(challenged.entity.assessment.score).toBe(83);
    expect(
      [65, 75, 85].map(
        (threshold) => saveDecision(challenged.entity, item.match, threshold).eligible,
      ),
    ).toEqual([true, true, false]);
    expect(saveDecision(item.entity, { ...item.match, level: 'out-of-scope' }, 65).eligible).toBe(
      false,
    );
  });
});
describe('canonical saving and scheduling', () => {
  it('validates publication bytes only for selected writes, preserving the privacy guard', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-unselected-private-')));
    try {
      const input = proposal();
      input.candidates[0]!.uri = 'https://example.com/safe';
      input.candidates[0]!.observations.push({
        ...input.candidates[0]!.observations[0]!,
        feature: 'maturity',
        indicator: 'documented',
      });
      const safe = (await acquired(input)).items[0]!;
      const unselected = (await acquired()).items[0]!;
      unselected.entity.description =
        'git clone https://x-access-token:INSTALLATION_TOKEN@github.com/example/repository';
      const result = await saveEntities([safe, unselected], 'eligible', root, 'public', 4);
      expect(result.changed).toEqual([safe.entity.id]);
      expect(result.skipped).toEqual([unselected.entity.id]);
      expect(
        (await loadEntities(join(root, 'signals/entities'))).map((record) => record.entity.id),
      ).toEqual([safe.entity.id]);
      await expect(saveEntities([unselected], 'manual', root)).rejects.toThrow(
        'private_entity_bytes',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('rejects a selection receipt without its discovery kind before writing the ledger', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-selection-kind-')));
    try {
      const malformed = {
        runId: '11111111-1111-4111-8111-111111111111',
        query: 'question',
      } as NonNullable<Parameters<typeof saveNativeEntities>[6]>;
      await expect(
        saveNativeEntities([], 'eligible', root, 'public', 75, false, malformed),
      ).rejects.toThrow('invalid_selection_provenance');
      await expect(readFile(join(root, '.signals/selections.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('separates checked issuer-declared currentness from formal authority and preserves older policy', async () => {
    const input = proposal();
    input.sources[0]!.publishedAt = null;
    input.candidates[0]!.kind = 'standard';
    const base = input.candidates[0]!.observations[0]!;
    input.candidates[0]!.observations.push(
      { ...base, feature: 'currentness', indicator: 'current' },
      { ...base, feature: 'authority', indicator: 'primary' },
    );
    const entity = (await acquired(input)).items[0]!.entity;
    expect(entity.assessment.features.currentness!.value).toBe(1);
    expect(entity.assessment.features.authority!.value).toBe(0.5);
    const historical = structuredClone(entity);
    historical.assessment = assessEntity(historical, date, 'signal-strength-v5');
    expect(historical.assessment.features.currentness!.value).toBe(0.5);
    expect(() => validateEntity(historical)).not.toThrow();

    const status = entity.observations.find((item) => item.feature === 'currentness')!;
    const issuer = entity.observations.find((item) => item.feature === 'authority')!;
    for (const check of ['2025-10-04T00:00:00.000Z', '2026-10-06T00:00:00.000Z']) {
      const changed = structuredClone(entity);
      changed.currentChecks = { [changed.evidence[0]!.uri]: check };
      expect(assessEntity(changed, date).features.currentness!.value).toBe(0.5);
    }
    const secondary = structuredClone(entity);
    secondary.observations.find((item) => item.id === issuer.id)!.indicator = 'secondary';
    expect(assessEntity(secondary, date).features.currentness!.value).toBe(0.5);
    const unrelated = structuredClone(entity);
    unrelated.observations.find((item) => item.id === issuer.id)!.evidenceId = 'unrelated';
    expect(assessEntity(unrelated, date).features.currentness!.value).toBe(0.5);
    const disputed = structuredClone(entity);
    disputed.observations.find((item) => item.id === issuer.id)!.status = 'contradicted';
    expect(assessEntity(disputed, date).features.currentness!.value).toBe(0.5);
    const oldEdition = structuredClone(entity);
    oldEdition.observations.find((item) => item.id === status.id)!.indicator = 'stale';
    expect(assessEntity(oldEdition, date).features.currentness!.value).toBe(0.25);
    const noStatus = structuredClone(entity);
    noStatus.observations = noStatus.observations.filter((item) => item.id !== status.id);
    expect(assessEntity(noStatus, date).features.currentness!.value).toBe(0);
    const inactive = structuredClone(entity);
    inactive.currentEvidence = [];
    expect(assessEntity(inactive, date).features.currentness!.value).toBe(0);
  });
  it('does not earn full dated-currentness credit from a future publication while preserving v4 replay', async () => {
    const input = proposal();
    input.candidates[0]!.observations.push({
      ...input.candidates[0]!.observations[0]!,
      feature: 'currentness',
      indicator: 'current',
      statement: 'The source describes supported maintenance.',
      quote: 'supported maintenance',
    });
    const entity = (await acquired(input)).items[0]!.entity;
    entity.evidence[0]!.publishedAt = '2027-10-05T00:00:00.000Z';
    entity.assessment = assessEntity(entity, date);
    expect(entity.assessment.features.currentness!.value).toBe(0.5);
    expect(assessEntity(entity, date, 'signal-strength-v4').features.currentness!.value).toBe(1);
    expect(() => validateEntity(entity)).not.toThrow();
    const historical = structuredClone(entity);
    historical.assessment = assessEntity(historical, date, 'signal-strength-v4');
    expect(() => validateEntity(historical)).not.toThrow();
  });
  it('does not resurrect a withdrawn judgment when an old proposal gains an unrelated excerpt', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-projection-replay-')));
    try {
      const input = proposal();
      input.candidates[0]!.observations.push({
        ...input.candidates[0]!.observations[0]!,
        feature: 'maturity',
        indicator: 'documented',
        quote: 'worked examples',
      });
      const original = (await acquired(input)).items[0]!;
      await saveEntities([original], 'manual', root);
      input.candidates[0]!.observations[1]!.status = 'uncertain';
      await saveEntities((await acquired(input)).items, 'refresh', root);
      input.candidates[0]!.observations[1]!.status = 'supported';
      input.candidates[0]!.observations.push({
        ...input.candidates[0]!.observations[0]!,
        quote: 'stable interface',
      });
      const replay = (await acquired(input)).items[0]!;
      expect(replay.entity.assessment.score).toBe(5);
      await saveEntities([replay], 'refresh', root);
      const entity = (await loadEntities(join(root, 'signals/entities')))[0]!.entity;
      expect(entity.assessment.score).toBe(0);
      expect(
        entity.evidence.find((source) => source.id === original.entity.evidence[0]!.id),
      ).toEqual(original.entity.evidence[0]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('renews an expired formal-status check while preserving the immutable first fetch and ordinary no-churn', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-status-renewal-')));
    try {
      const input = proposal();
      input.candidates[0]!.kind = 'standard';
      input.sources[0]!.publishedAt = '2010-01-01T00:00:00.000Z';
      const base = input.candidates[0]!.observations[0]!;
      input.candidates[0]!.observations.push(
        ...[
          ['authority', 'formal-current'],
          ['currentness', 'current'],
          ['maturity', 'documented'],
          ['maturity', 'supported-or-complete'],
          ['verification', 'inspectable'],
        ].map(([feature, indicator]) => ({
          ...base,
          feature: feature!,
          indicator: indicator as typeof base.indicator,
        })),
      );
      const first = (await acquired(input)).items[0]!;
      expect(first.entity.assessment.score).toBe(75);
      await saveEntities([first], 'manual', root);
      const review = async (asOf: string) =>
        acceptDiscovery(
          input,
          { query: 'standard' },
          {
            asOf,
            fetch: async (uri) => ({ ...(await fetch(uri)), fetchedAt: asOf }),
          },
        );
      expect(
        (await saveEntities((await review('2026-11-05T00:00:00.000Z')).items, 'refresh', root))
          .changed,
      ).toEqual([]);
      expect(
        (await saveEntities((await review('2027-11-05T00:00:00.000Z')).items, 'refresh', root))
          .changed,
      ).toHaveLength(1);
      const renewed = (await loadEntities(join(root, 'signals/entities')))[0]!.entity;
      expect(renewed.assessment.score).toBe(75);
      expect(renewed.evidence).toEqual(first.entity.evidence);
      expect(renewed.currentChecks![input.sources[0]!.uri]).toBe('2027-11-05T00:00:00.000Z');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('adds a new verified span over unchanged raw evidence without rewriting the earlier projection', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-new-span-')));
    try {
      const input = proposal();
      input.candidates[0]!.observations.push({
        ...input.candidates[0]!.observations[0]!,
        feature: 'maturity',
        indicator: 'documented',
        quote: 'worked examples',
      });
      const original = (await acquired(input)).items[0]!;
      await saveEntities([original], 'manual', root);
      const oldSource = structuredClone(original.entity.evidence[0]!);
      input.candidates[0]!.observations.push({
        ...input.candidates[0]!.observations[0]!,
        feature: 'maturity',
        indicator: 'stable-interface',
        quote: 'stable interface',
      });
      const updated = (await acquired(input)).items[0]!;
      await saveEntities([updated], 'refresh', root);
      const entity = (await loadEntities(join(root, 'signals/entities')))[0]!.entity;
      expect(entity.evidence.find((source) => source.id === oldSource.id)).toEqual(oldSource);
      expect(entity.evidence).toHaveLength(2);
      expect(entity.currentEvidence).toEqual(updated.entity.currentEvidence);
      expect(entity.assessment.features.maturity!.value).toBe(0.5);
      expect((await saveEntities([updated], 'refresh', root)).changed).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('selects changed snapshots and A-B-A reversions without rewriting evidence; saves negative refreshes', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-revisions-')));
    try {
      const input = proposal();
      const definition = input.candidates[0]!.observations[0]!;
      input.candidates[0]!.observations.push(
        { ...definition, feature: 'maturity', indicator: 'documented' },
        { ...definition, feature: 'maturity', indicator: 'supported-or-complete' },
      );
      const snapshot = async (value: Proposal, revision: string, asOf: string) =>
        (
          await acceptDiscovery(
            value,
            { query: 'research' },
            {
              asOf,
              fetch: async (uri) => ({ ...(await fetch(uri)), digest: revision.repeat(64) }),
            },
          )
        ).items[0]!;
      const original = await snapshot(input, 'a', date);
      await saveEntities([original], 'manual', root);
      const revisedInput = structuredClone(input);
      revisedInput.candidates[0]!.observations.pop();
      const revised = await snapshot(revisedInput, 'b', '2026-10-06T00:00:00.000Z');
      await saveEntities([revised], 'refresh', root);
      let record = (await loadEntities(join(root, 'signals/entities')))[0]!;
      expect(record.entity.assessment.score).toBe(5);
      expect(record.entity.evidence).toHaveLength(2);
      const reverted = await snapshot(input, 'a', '2026-10-07T00:00:00.000Z');
      await saveEntities([reverted], 'refresh', root);
      record = (await loadEntities(join(root, 'signals/entities')))[0]!;
      expect(record.entity.assessment.score).toBe(10);
      await saveEntities([revised], 'manual', root);
      record = (await loadEntities(join(root, 'signals/entities')))[0]!;
      expect(record.entity.currentEvidence).toEqual(reverted.entity.currentEvidence);
      expect(record.entity.assessment.score).toBe(10);
      expect(
        record.entity.evidence.find((source) => source.id === original.entity.evidence[0]!.id),
      ).toEqual(original.entity.evidence[0]);
      expect((await saveEntities([reverted], 'refresh', root)).changed).toEqual([]);
      const contradicted = structuredClone(input);
      contradicted.candidates[0]!.observations[0]!.status = 'contradicted';
      const negative = await snapshot(contradicted, 'c', '2026-10-08T00:00:00.000Z');
      expect(negative.entity.assessment.score).toBeNull();
      expect((await saveEntities([negative], 'refresh', root)).changed).toHaveLength(1);
      record = (await loadEntities(join(root, 'signals/entities')))[0]!;
      expect(record.entity.assessment.score).toBeNull();
      expect(record.entity.evidence).toHaveLength(3);
      const tied = structuredClone(record.entity);
      delete tied.currentEvidence;
      tied.evidence.forEach((source) => {
        source.fetchedAt = date;
      });
      expect(assessEntity(tied, date).score).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each(['public', 'private'] as const)(
    'does not complete a %s refresh without its target or update another saved entity',
    async (destination) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-refresh-target-')));
      try {
        const first = (await acquired()).items[0]!;
        const otherInput = proposal();
        otherInput.candidates[0]!.uri = 'https://example.com/other';
        const other = (await acquired(otherInput)).items[0]!;
        await saveEntities([first, other], 'manual', root, destination);
        const directory = join(
          root,
          destination === 'public' ? 'signals/entities' : '.signals/corpus/entities',
        );
        const before = await loadEntities(directory);
        const returned = [first, other].sort((a, b) => a.entity.id.localeCompare(b.entity.id))[1]!;
        const settings = {
          ...structuredClone(defaultSettings),
          destination,
          corpusDiscovery: true,
          batchSize: 1,
        };
        const result = await runDueOnce({
          root,
          now: Date.parse(date),
          settings,
          check: (entity, options) =>
            checkPrimaryMaterial(entity, {
              ...options,
              fetch: async (uri) => ({ ...(await fetch(uri)), digest: 'b'.repeat(64) }),
            }),
          search: async () => ({
            ...(await signalSearch({ query: 'refresh' }, { runner: runner(proposal()), fetch })),
            items: [returned],
          }),
        });
        expect(result.jobs[0]!.status).toBe('failed');
        expect(result.jobs[0]!.reason).toBe('refresh_target_missing');
        expect(await loadEntities(directory)).toEqual(before);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it('reopens immutable history using the selected cutoff', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-history-cutoff-')));
    try {
      const input = proposal();
      input.candidates[0]!.observations.push({
        ...input.candidates[0]!.observations[0]!,
        feature: 'maturity',
        indicator: 'documented',
      });
      const result = await signalSearch(
        { query: 'research', threshold: 4 },
        { runner: runner(input), fetch },
      );
      await retainRun(result, root);
      const path = join(root, '.signals/runs', `${result.runId}.json`);
      const bytes = await readFile(path, 'utf8');
      expect((await loadRun(result.runId, root, 4)).items[0]!.eligible).toBe(true);
      expect((await loadRun(result.runId, root, 75)).items[0]!.eligible).toBe(false);
      expect(await readFile(path, 'utf8')).toBe(bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('reopens private history without allowing its private bytes into the corpus', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-private-history-')));
    try {
      const result = await signalSearch(
        { query: 'private history' },
        { runner: runner(proposal()), fetch },
      );
      result.items[0]!.entity.description = 'Public documentation example: token=PLACEHOLDER';
      await retainRun(result, root);
      const path = join(root, '.signals/runs', `${result.runId}.json`);
      const bytes = await readFile(path, 'utf8');
      const reopened = await loadRun(result.runId, root);
      expect(reopened.items[0]!.entity.description).toContain('token=PLACEHOLDER');
      expect(await readFile(path, 'utf8')).toBe(bytes);
      await expect(saveEntities(reopened.items, 'manual', root)).rejects.toThrow(
        'private_entity_bytes',
      );
      const tampered = structuredClone(result);
      tampered.runId = 'a0000000-0000-4000-8000-000000000001';
      tampered.items[0]!.entity.id = entityIdentity('https://example.com/different');
      await retainRun(tampered, root);
      await expect(loadRun(tampered.runId, root)).rejects.toThrow('invalid_entity_identity');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('manually saves low scores, preserves identity on retyping and rejects private/tampered bytes', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-store-')));
    try {
      const item = (await acquired()).items[0]!;
      await expect(saveNativeEntities([item], 'manual', root)).rejects.toThrow(
        'fixture_cannot_enter_corpus',
      );
      expect((await saveEntities([item], 'eligible', root)).changed).toHaveLength(0);
      expect((await saveEntities([item], 'manual', root)).changed).toHaveLength(1);
      expect((await saveEntities([item], 'manual', root)).changed).toHaveLength(0);
      const retyped = structuredClone(item);
      retyped.entity.kind = 'practice';
      retyped.entity.assessment = assessEntity(retyped.entity, date);
      expect((await saveEntities([retyped], 'manual', root)).changed).toHaveLength(1);
      expect(await readdir(join(root, 'signals/entities'))).toHaveLength(1);
      const privateItem = structuredClone(item);
      privateItem.entity.description = '/Users/private/person/secret';
      expect(() => validateEntity(privateItem.entity)).toThrow('private_entity_bytes');
      const tampered = structuredClone(item);
      tampered.entity.assessment.score = 100;
      expect(() => validateEntity(tampered.entity)).toThrow('score_tampering');
      await expect(withWriter(root, () => withWriter(root, async () => 1))).rejects.toThrow(
        'writer_busy',
      );
      expect((await loadEntities(join(root, 'signals/entities')))[0]!.entity.id).toBe(
        item.entity.id,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('denies symlink corpus storage and keeps retained files untouched', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-symlink-')));
    try {
      await mkdir(join(root, 'signals'));
      await mkdir(join(root, 'private'));
      await symlink(join(root, 'private'), join(root, 'signals/entities'));
      await expect(saveEntities((await acquired()).items, 'manual', root)).rejects.toThrow(
        'symlink_storage',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('coalesces missed slots, completes after saves, and invokes no inference on a repeated slot', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-due-')));
    try {
      let calls = 0;
      const result = await signalSearch({ query: 'x' }, { runner: runner(proposal()), fetch });
      const settings = {
        ...structuredClone(defaultSettings),
        queryDiscovery: true,
        profile: 'quick' as const,
        queries: [
          {
            id: 'interest',
            query: 'research',
            enabled: true,
            everyDays: 7,
            offsetMinutes: 11,
            concepts: [],
          },
        ],
      };
      const search = async () => {
        calls++;
        return result;
      };
      const now = Date.parse(date);
      expect(dueSlot(now, 7, 11)).toBeLessThanOrEqual(now);
      const first = await runDueOnce({ root, now, settings, search });
      expect(first.jobs[0]!.status).toBe('completed');
      expect((await runDueOnce({ root, now: now + 3600000, settings, search })).jobs).toHaveLength(
        0,
      );
      expect(calls).toBe(1);
      const scoped = { ...settings, supplementalSites: ['https://www.reddit.com/r/codex'] };
      expect((await runDueOnce({ root, now, settings: scoped, search })).jobs).toHaveLength(1);
      expect(calls).toBe(2);
      const toggled = {
        ...settings,
        retentionDays: 14,
        batchSize: 2,
        publication: 'reviewed-push' as const,
      };
      expect(
        (await runDueOnce({ root, now: now + 3600000, settings: toggled, search })).jobs,
      ).toHaveLength(0);
      expect(calls).toBe(2);
      const state = JSON.parse(
        await readFile(join(root, '.signals/discovery-state.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(Object.keys(state)).toHaveLength(2);
      expect((await runDueOnce({ root, settings: defaultSettings, search })).enabled).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('refreshes saved entities even below threshold without deleting their observations', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-refresh-')));
    try {
      const item = (await acquired()).items[0]!;
      await saveEntities([item], 'manual', root);
      const changed = structuredClone(item);
      changed.entity.limits.push('New bounded limitation.');
      const risk = {
        ...changed.entity.observations[0]!,
        feature: 'risk',
        indicator: 'bounded' as const,
        statement: 'A substantiated bounded limitation.',
      };
      Object.assign(risk, observationIdentity(item.entity.id, risk.evidenceId, risk));
      changed.entity.observations.push(risk);
      changed.entity.assessment = assessEntity(changed.entity, date);
      expect((await saveEntities([changed], 'refresh', root)).changed).toHaveLength(1);
      expect(
        (await loadEntities(join(root, 'signals/entities')))[0]!.entity.observations,
      ).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('withdraws revised judgments without rewriting evidence or replaying older credit', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-successor-')));
    try {
      const input = proposal();
      input.candidates[0]!.observations.push({
        ...input.candidates[0]!.observations[0]!,
        feature: 'authority',
        indicator: 'formal-current',
      });
      const original = (await acquired(input)).items[0]!;
      await saveEntities([original], 'manual', root);
      input.candidates[0]!.observations[1]!.status = 'uncertain';
      const revised = (await acquired(input)).items[0]!;
      await saveEntities([revised], 'refresh', root);
      let record = (await loadEntities(join(root, 'signals/entities')))[0]!;
      expect(record.entity.assessment.score).toBe(0);
      expect(record.entity.observations).toHaveLength(3);
      expect(record.entity.observations.some((item) => item.supersedes.length)).toBe(true);
      await saveEntities([original], 'refresh', root);
      record = (await loadEntities(join(root, 'signals/entities')))[0]!;
      expect(record.entity.assessment.score).toBe(0);
      expect(record.entity.evidence).toEqual(original.entity.evidence);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('retains a narrowed claim as an immutable successor and rejects replay of its older wording', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-claim-correction-')));
    try {
      const input = proposal();
      input.candidates[0]!.observations[0]!.statement = 'Supports every research workflow.';
      const original = (await acquired(input)).items[0]!;
      await saveEntities([original], 'manual', root);
      input.candidates[0]!.observations[0]!.statement = 'Describes a portable research tool.';
      const corrected = (await acquired(input)).items[0]!;
      await saveEntities([corrected], 'refresh', root);
      let record = (await loadEntities(join(root, 'signals/entities')))[0]!;
      expect(record.entity.observations).toHaveLength(2);
      const successor = record.entity.observations.find((item) => item.supersedes.length)!;
      expect(successor.statement).toBe('Describes a portable research tool.');
      expect(successor.supersedes).toEqual([original.entity.observations[0]!.id]);
      expect(record.entity.evidence).toEqual(original.entity.evidence);
      expect((await saveEntities([corrected], 'refresh', root)).changed).toHaveLength(0);
      await saveEntities([original], 'refresh', root);
      record = (await loadEntities(join(root, 'signals/entities')))[0]!;
      expect(record.entity.observations).toHaveLength(2);
      expect(record.entity.observations.find((item) => item.supersedes.length)!.statement).toBe(
        successor.statement,
      );
      const tampered = structuredClone(corrected.entity);
      tampered.observations[0]!.statement = 'A different unbound claim.';
      expect(() => validateEntity(tampered)).toThrow('forged_observation_identity');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('does not trust eligible flags, contradictory risk or arbitrary repeated publisher labels', async () => {
    const input = proposal();
    input.sources[0]!.uri = 'https://independent.example.org/report';
    input.sources[0]!.family = 'practitioners';
    input.sources.push({
      ...input.sources[0]!,
      uri: 'https://independent.example.net/other',
      origin: 'another label',
    });
    input.candidates[0]!.observations.push(
      ...[0, 1].map((source) => ({
        ...input.candidates[0]!.observations[0]!,
        source,
        feature: 'corroboration',
        indicator: 'applied' as const,
        independent: true,
      })),
    );
    input.candidates[0]!.observations.push({
      ...input.candidates[0]!.observations[0]!,
      feature: 'risk',
      indicator: 'decisive',
      status: 'contradicted',
    });
    const item = (await acquired(input)).items[0]!;
    expect(item.entity.assessment.risk).toBe(0);
    expect(item.entity.assessment.features.corroboration!.value).toBeCloseTo(1 - Math.exp(-1 / 3));
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-eligible-')));
    try {
      item.eligible = true;
      expect((await saveEntities([item], 'eligible', root)).changed).toHaveLength(0);
      const forged = structuredClone(item.entity);
      forged.evidence[0]!.excerpt = '';
      expect(() => validateEntity(forged)).toThrow('forged_evidence_identity');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    expect(entityIdentity('https://github.com/org/monorepo')).not.toBe(
      entityIdentity('https://github.com/org/monorepo/tree/main/other-product'),
    );
    expect(entityIdentity('https://example.org/practices#first')).not.toBe(
      entityIdentity('https://example.org/practices#second'),
    );
  });
});
