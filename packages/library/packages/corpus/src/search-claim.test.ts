import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, readFile, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Value } from 'typebox/value';
import {
  claimReceiptSchema,
  type ClaimMaterial,
  type ClaimResponse,
} from '../../domain/src/claim-check.js';
import { budgets, type SearchResult, type Source } from '../../domain/src/search-contract.js';
import { signalSearch } from './signal-search.js';
import { digest, boundedTextReceipt, type fetchEvidence } from './search-fetch.js';
import { loadRun, retainRun, cleanRuns, atomicJson } from './search-store.js';
import {
  claimReceiptReserve,
  validateClaimResponse,
  validateClaimReceipt,
} from './search-claim.js';
import { RunnerFailure, type SearchRunner } from './search-runner.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const uris = ['https://example.org/policy', 'https://example.com/study'];
const text =
  'Metadata may be redistributed. The photograph has separate rights. Animal evidence does not establish human efficacy.';
const response = (verdict: ClaimResponse['verdict'] = 'supported'): ClaimResponse => ({
  verdict,
  reason: 'Scoped fixture judgment only.',
  nextCheck: 'Inspect item-specific rights and application evidence.',
  findings:
    verdict === 'uncertain'
      ? []
      : [
          {
            sourceIndex: 0,
            quote: 'Metadata may be redistributed.',
            status: verdict,
            decisive: true,
            reason: 'Literal policy scope.',
          },
        ],
  gaps: [],
});
const runner = (proposal: unknown) =>
  ({
    readiness: vi.fn(async () => ({
      available: true,
      broadSearch: false,
      runner: 'fixture',
      reason: 'scripted',
    })),
    discover: vi.fn(async () => ({ proposal, usage: null, searches: 0 })),
  }) satisfies SearchRunner;
async function fixture(query = 'Need exact rights/application scope; never upload originals.') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-claim-')));
  roots.push(root);
  const parent: SearchResult = {
    schemaVersion: 2,
    runId: randomUUID(),
    query,
    status: 'completed',
    brief: {
      format: 'markdown',
      text: 'Original unassessed narrative. [Policy](https://example.org/policy) [Study](https://example.com/study)',
    },
    answerReceipt: {
      observedAt: new Date().toISOString(),
      sha256: '',
      state: 'unassessed',
      confidence: 'unknown',
      context: 'Original manual context.',
      provenance: { receipt: 'scripted', requestedModel: null, servedModel: null },
    },
    provisionalLeads: uris.map((uri) => ({
      uri,
      name: 'Primary',
      description: 'Unassessed reference.',
      limits: [],
    })),
    items: [],
    sources: [],
    coverage: [],
    gaps: [],
    counts: { leads: 0, distinct: 0, duplicates: 0, omitted: 0 },
    usage: {
      searches: 0,
      documents: 0,
      elapsedMs: 0,
      modelCalls: 0,
      providerUsage: null,
      cost: null,
    },
    limits: budgets.quick,
  };
  parent.answerReceipt!.sha256 = digest(parent.brief!.text);
  await retainRun(parent, root);
  return {
    root,
    parent,
    request: {
      query: 'Caller label cannot replace the original need.',
      assessmentOf: parent.runId,
      captureUrls: uris,
      claimText: 'Metadata may be redistributed.',
      cache: 'private' as const,
      save: 'never' as const,
    },
  };
}
const fetch: typeof fetchEvidence = async (uri) => ({
  uri,
  text,
  digest: digest(text),
  normalizer: 'text-v2',
});
const material = (): ClaimMaterial[] =>
  uris.map((uri, sourceIndex) => ({
    sourceIndex,
    requestedUri: uri,
    state: 'usable',
    finalUri: uri,
    text,
    documentDigest: digest(text),
    snapshotDigest: digest(text),
    normalizer: 'text-v2',
    fetchedAt: new Date().toISOString(),
    scope: 'complete-normalized-document',
    omissions: [],
  }));

async function historicalFixture(
  parent: SearchResult,
  root: string,
  projected = true,
  normalizer: 'text-v2' | 'text-v3' = 'text-v2',
) {
  const source: Source = {
    id: '',
    uri: uris[0]!,
    title: 'Policy',
    publisher: 'Example',
    family: 'primary',
    origin: 'primary',
    publishedAt: null,
    digest: digest(text),
    ...(projected ? { excerptDigest: digest(text) } : {}),
    normalizer,
    fetchedAt: '2020-01-01T00:00:00Z',
    state: 'fetched',
    reason: 'scripted acquisition',
    excerpt: text,
  };
  source.id = `evidence-${digest(`${source.uri}:${source.digest}${source.excerptDigest ? `:${source.excerptDigest}` : ''}:${normalizer}`).slice(0, 24)}`;
  const origin: SearchResult = { ...parent, runId: randomUUID(), sources: [source] };
  delete origin.answerReceipt;
  delete origin.brief;
  await retainRun(origin, root);
  return { source, origin };
}

it('denied targets retain acquisition outcomes with no runner/readiness, scoring or public writes', async () => {
  const { root, parent, request } = await fixture();
  const native = runner(response());
  const before = await readFile(join(root, '.signals/runs', `${parent.runId}.json`));
  const result = await signalSearch(request, {
    root,
    runner: native,
    fetch: async () => {
      throw new Error('source_denied_403');
    },
  });
  expect(result.claimCheck).toMatchObject({
    reviewState: 'not-reviewed',
    verdict: null,
    confidence: 'Unknown',
    historySaved: true,
  });
  expect(result.claimCheck!.selectedMaterial.map((source) => source.state)).toEqual([
    'denied',
    'denied',
  ]);
  expect(native.readiness).not.toHaveBeenCalled();
  expect(native.discover).not.toHaveBeenCalled();
  expect(result.usage.modelCalls).toBe(0);
  expect(result.items).toEqual([]);
  expect(await readdir(root)).toEqual(['.signals']);
  expect(await loadRun(result.runId, root)).toMatchObject({ claimCheck: { verdict: null } });
  expect(await readFile(join(root, '.signals/runs', `${parent.runId}.json`))).toEqual(before);
});

it('uses original need/context, validates one native scoped response and exposes actual indexed primary input', async () => {
  const { root, parent, request } = await fixture();
  let task = '';
  const native = runner(response());
  const result = await signalSearch(request, {
    root,
    fetch,
    claimRunner: (prompt) => {
      task = prompt;
      return native;
    },
  });
  expect(result.status).toBe('completed');
  expect(result.query).toBe(parent.query);
  expect(task).toContain(parent.query);
  expect(task).toContain(parent.answerReceipt!.context!);
  expect(task).toContain(text);
  expect(task).not.toContain('unknown-name');
  expect(result.claimCheck).toMatchObject({
    verdict: 'supported',
    reviewState: 'completed',
    confidence: 'Unknown',
  });
  expect(result.usage.modelCalls).toBe(1);
  expect(native.discover).toHaveBeenCalledOnce();
  expect((await loadRun(result.runId, root)).claimCheck!.selectedMaterial).toEqual(
    result.claimCheck!.selectedMaterial,
  );
});

it('quote binding rejects narrative-only, cross-source, case-mismatched and over-budget quotes plus empty/contrary positive verdicts', () => {
  const sources = material();
  for (const quote of [
    'Original manual context.',
    'Original unassessed narrative.',
    'metadata may be redistributed.',
  ]) {
    const output = response();
    output.findings[0]!.quote = quote;
    expect(() => validateClaimResponse(sources, output)).toThrow('unbound_claim_quote');
  }
  const crossed = material();
  crossed[1] = {
    ...crossed[1]!,
    text: 'No relevant policy text.',
    snapshotDigest: digest('No relevant policy text.'),
  } as ClaimMaterial;
  const output = response();
  output.findings[0]!.sourceIndex = 1;
  expect(() => validateClaimResponse(crossed, output)).toThrow('unbound_claim_quote');
  expect(() => validateClaimResponse(sources, { ...response(), findings: [] })).toThrow(
    'claim_verdict_without_quote',
  );
  expect(() =>
    validateClaimResponse(sources, { ...response('contradicted'), findings: [] }),
  ).toThrow('claim_verdict_without_quote');
  expect(validateClaimResponse(sources, response('uncertain')).verdict).toBe('uncertain');
  const mixed = response();
  mixed.findings.push({ ...mixed.findings[0]!, status: 'contradicted' });
  expect(() => validateClaimResponse(sources, mixed)).toThrow('inconsistent_claim_verdict');
  expect(() =>
    validateClaimResponse(sources, {
      ...response(),
      gaps: [
        { reason: 'Selected source fabricated prefix cannot hide a returned gap.', decisive: true },
      ],
    }),
  ).toThrow('inconsistent_claim_verdict');
  const long = 'A '.repeat(26).trim();
  const oversize = material();
  oversize[0] = { ...oversize[0]!, text: long, snapshotDigest: digest(long) } as ClaimMaterial;
  const wordOutput = response();
  wordOutput.findings[0]!.quote = long;
  expect(() => validateClaimResponse(oversize, wordOutput)).toThrow('claim_quote_word_budget');
});

it('memory mode preserves file bytes and creates no cache/history while still returning proof', async () => {
  const { root, parent, request } = await fixture();
  const path = join(root, '.signals/runs', `${parent.runId}.json`);
  const before = await readFile(path);
  const result = await signalSearch(
    { ...request, cache: 'memory' },
    { root, fetch, runner: runner(response()) },
  );
  expect(result.claimCheck!.historySaved).toBe(false);
  expect(await readdir(join(root, '.signals'))).toEqual(['runs']);
  expect(await readdir(join(root, '.signals/runs'))).toEqual([`${parent.runId}.json`]);
  expect(await readFile(path)).toEqual(before);
});

it('mixed usable/denied and whole-document omission cannot produce supported; truncated/empty sources never invoke native', async () => {
  const { root, request } = await fixture();
  const native = runner(response());
  const mixed = await signalSearch(request, {
    root,
    runner: native,
    fetch: async (uri) => {
      if (uri === uris[1]) throw new Error('source_denied_403');
      return fetch(uri);
    },
  });
  expect(mixed.claimCheck).toMatchObject({ reviewState: 'incomplete', verdict: null });
  expect(mixed.claimCheck!.gaps[0]!.decisive).toBe(true);
  const omitted = await signalSearch(
    { ...request, cache: 'memory' },
    {
      root,
      runner: runner(response('uncertain')),
      fetch: async (uri) => ({
        uri,
        text: text.repeat(230),
        digest: digest(text.repeat(230)),
        normalizer: 'text-v2',
      }),
    },
  );
  expect(omitted.claimCheck!.selectedMaterial.map((source) => source.state)).toEqual([
    'usable',
    'omitted',
  ]);
  expect(omitted.claimCheck!.verdict).toBe('uncertain');
  for (const unusable of [
    { text: '', truncated: false },
    { text, truncated: true },
    { text, identityUnverified: true },
  ]) {
    const unused = runner(response());
    const result = await signalSearch(
      { ...request, cache: 'memory' },
      {
        root,
        runner: unused,
        fetch: async (uri) => ({
          uri,
          ...unusable,
          digest: digest(unusable.text),
          normalizer: 'text-v2',
        }),
      },
    );
    expect(result.usage.modelCalls).toBe(0);
    expect(unused.discover).not.toHaveBeenCalled();
  }
});

it.each(['resolve', 'reject'])(
  'aborts deferred acquisition (%s), retains acquired text and never launches later inference or mutates saved bytes',
  async (late) => {
    const { root, request } = await fixture();
    const controller = new AbortController();
    const native = runner(response());
    let resolve!: (value: Awaited<ReturnType<typeof fetch>>) => void;
    let reject!: (reason: Error) => void;
    const deferred = new Promise<Awaited<ReturnType<typeof fetch>>>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    let acquired!: () => void;
    const firstAcquired = new Promise<void>((done) => {
      acquired = done;
    });
    const operation = signalSearch(request, {
      root,
      runner: native,
      signal: controller.signal,
      fetch: async (uri) => {
        if (uri !== uris[0]) return deferred;
        const document = await fetch(uri);
        acquired();
        return document;
      },
    });
    // Establish acquired material before cancellation; elapsed wall time is not that premise.
    await firstAcquired;
    await new Promise((done) => setImmediate(done));
    controller.abort();
    const result = await operation;
    expect(result.status).toBe('cancelled');
    expect(result.claimCheck!.selectedMaterial.map((source) => source.state)).toEqual([
      'usable',
      'cancelled',
    ]);
    const path = join(root, '.signals/runs', `${result.runId}.json`);
    const before = await readFile(path);
    if (late === 'resolve') resolve(await fetch(uris[1]!));
    else reject(new Error('late source failure'));
    await new Promise((done) => setTimeout(done, 5));
    expect(native.discover).not.toHaveBeenCalled();
    expect(native.readiness).not.toHaveBeenCalled();
    expect(await readFile(path)).toEqual(before);
    expect((await loadRun(result.runId, root)).claimCheck!.abortOrigin).toBe('external');
  },
);

it('retains a self-contained trusted historical excerpt after origin TTL, parent and linked negative successor stay exact', async () => {
  const { root, parent, request } = await fixture();
  const { source, origin } = await historicalFixture(parent, root);
  const result = await signalSearch(
    {
      ...request,
      captureUrls: [uris[0]!],
      claimSources: [{ sourceIndex: 0, runId: origin.runId, sourceId: source.id }],
    },
    {
      root,
      fetch: async () => {
        throw new Error('must_not_fetch');
      },
      runner: runner(response('contradicted')),
    },
  );
  expect(result.claimCheck!.selectedMaterial[0]).toMatchObject({
    scope: 'retained-excerpt',
    fetchedAt: source.fetchedAt,
    documentDigest: source.digest,
  });
  const old = new Date('2000-01-01');
  for (const id of [origin.runId, parent.runId, result.runId])
    await utimes(join(root, '.signals/runs', `${id}.json`), old, old);
  await cleanRuns(root);
  await expect(loadRun(origin.runId, root)).rejects.toThrow('unknown_retained_run');
  expect((await loadRun(result.runId, root)).claimCheck!.verdict).toBe('contradicted');
  expect((await loadRun(parent.runId, root)).brief).toEqual(parent.brief);
});

it('unverified historical identity remains unusable and cannot launch inference', async () => {
  const { root, parent, request } = await fixture();
  const { source, origin } = await historicalFixture(parent, root);
  source.reason = 'provider_final_identity_unverified';
  await atomicJson(join(root, '.signals/runs', `${origin.runId}.json`), origin);
  const native = runner(response());
  const result = await signalSearch(
    {
      ...request,
      captureUrls: [uris[0]!],
      claimSources: [{ sourceIndex: 0, runId: origin.runId, sourceId: source.id }],
    },
    { root, runner: native, fetch: vi.fn(fetch) },
  );
  expect(result.claimCheck!.selectedMaterial[0]).toMatchObject({ state: 'omitted' });
  expect(result.usage.modelCalls).toBe(0);
  expect(native.readiness).not.toHaveBeenCalled();
  expect(native.discover).not.toHaveBeenCalled();
  expect((await loadRun(result.runId, root)).claimCheck!.verdict).toBeNull();
});

it.each([
  [false, 'text-v2'],
  [true, 'text-v2'],
  [false, 'text-v3'],
  [true, 'text-v3'],
] as const)(
  'replay rebinds historical document lineage for projected=%s, normalizer=%s, without requiring the origin',
  async (projected, normalizer) => {
    const { root, parent, request } = await fixture();
    const { source, origin } = await historicalFixture(parent, root, projected, normalizer);
    const result = await signalSearch(
      {
        ...request,
        captureUrls: [uris[0]!],
        claimSources: [{ sourceIndex: 0, runId: origin.runId, sourceId: source.id }],
      },
      { root, runner: runner(response('uncertain')) },
    );
    await rm(join(root, '.signals/runs', `${origin.runId}.json`));
    expect((await loadRun(result.runId, root)).claimCheck!.selectedMaterial[0]).toMatchObject({
      documentDigest: source.digest,
      normalizer,
    });
    const selected = result.claimCheck!.selectedMaterial[0];
    if (selected?.state !== 'usable') throw new Error('expected_historical_material');
    selected.documentDigest = 'a'.repeat(64);
    await atomicJson(join(root, '.signals/runs', `${result.runId}.json`), result);
    await expect(loadRun(result.runId, root)).rejects.toThrow('invalid_historical_claim_identity');
  },
);

it('proves escaped receipt reserve and UTF8 diagnostic bounds; replay rejects tampering, old runs stay readable', async () => {
  const { root, request } = await fixture();
  const result = await signalSearch(request, {
    root,
    fetch,
    runner: runner(response('uncertain')),
  });
  const max = structuredClone(result.claimCheck!);
  max.selectedMaterial = material().map(
    (source) =>
      ({
        ...source,
        text: '\0'.repeat(24000),
        snapshotDigest: digest('\0'.repeat(24000)),
        omissions: Array.from({ length: 10 }, () => '\0'.repeat(1200)),
      }) as ClaimMaterial,
  );
  max.findings = Array.from({ length: 4 }, () => ({
    sourceIndex: 0,
    quote: '\0'.repeat(400),
    status: 'uncertain' as const,
    decisive: false,
    reason: '\0'.repeat(1200),
  }));
  max.gaps = Array.from({ length: 12 }, () => ({ reason: '\0'.repeat(1200), decisive: false }));
  max.reason = max.nextCheck = '\0'.repeat(1200);
  max.rejectedOutput = boundedTextReceipt('\0'.repeat(65536));
  expect(Value.Check(claimReceiptSchema, max)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(max, null, 2))).toBeLessThan(claimReceiptReserve());
  expect(Buffer.byteLength(JSON.stringify(max, null, 2))).toBeGreaterThan(512000);
  const unicode = boundedTextReceipt('🧪'.repeat(10000));
  expect(Buffer.byteLength(unicode.text)).toBeLessThanOrEqual(32768);
  expect(unicode.text).not.toContain('\uFFFD');
  const forged = structuredClone(result);
  (
    forged.claimCheck!.selectedMaterial[0] as Extract<ClaimMaterial, { state: 'usable' }>
  ).snapshotDigest = 'a'.repeat(64);
  expect(() => validateClaimReceipt(forged)).toThrow('invalid_claim_snapshot');
  await atomicJson(join(root, '.signals/runs', `${result.runId}.json`), forged);
  await expect(loadRun(result.runId, root)).rejects.toThrow('invalid_claim_snapshot');
});

it('oversized parent need fails before acquisition and reports unsaved when the exact result cannot fit', async () => {
  const { root, request } = await fixture('Q'.repeat(1100000));
  const acquisition = vi.fn(fetch);
  const result = await signalSearch(request, {
    root,
    fetch: acquisition,
    runner: runner(response()),
  });
  expect(acquisition).not.toHaveBeenCalled();
  expect(result.usage.modelCalls).toBe(0);
  expect(result.status).toBe('failed');
  expect(result.claimCheck!.historySaved).toBe(false);
  expect(result.gaps.join(' ')).toContain('Not saved to history');
});

it('preserves a reported native deadline as cancelled/incomplete with captured primary material', async () => {
  const { root, request } = await fixture();
  const native: SearchRunner = {
    readiness: async () => ({
      available: true,
      broadSearch: false,
      runner: 'fixture',
      reason: 'scripted',
    }),
    discover: async () => {
      throw new RunnerFailure('cancelled', 0, {
        provider: null,
        termination: { trigger: 'native_deadline', signal: 'SIGKILL', exitCode: null },
      });
    },
  };
  const result = await signalSearch(request, { root, fetch, runner: native });
  expect(result.status).toBe('cancelled');
  expect(result.claimCheck).toMatchObject({
    reviewState: 'incomplete',
    verdict: null,
    abortOrigin: 'native',
  });
  expect(result.claimCheck!.selectedMaterial.every((source) => source.state === 'usable')).toBe(
    true,
  );
  expect((await loadRun(result.runId, root)).claimCheck!.abortOrigin).toBe('native');
});
