import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, readdir, readFile, utimes } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseRequest, type SearchRequest } from '../../domain/src/search-contract.js';
import { Value } from 'typebox/value';
import { claimReceiptSchema } from '../../domain/src/claim-check.js';
import { signalSearch } from './signal-search.js';
import { digest, boundedTextReceipt } from './search-fetch.js';
import { loadRun, cleanRuns, atomicJson, retainRun } from './search-store.js';
import { claimReceiptReserve, validateClaimReceipt } from './search-claim.js';
import type { SearchRunner } from './search-runner.js';
import { extractHtml } from './search-document.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function area() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-direct-claim-')));
  roots.push(root);
  return root;
}
const input: SearchRequest = {
  query: 'What does this primary declaration establish?',
  context: 'Do not infer broader permission or effectiveness.',
  claimOrigin: 'request',
  claimText: 'Metadata reuse is permitted.',
  captureUrls: ['https://example.org/policy'],
  profile: 'quick',
  cache: 'private',
  save: 'never',
};
const text = 'Metadata reuse is permitted. Photographs need separate permission.';
const runner = (quote = 'Metadata reuse is permitted.') =>
  ({
    readiness: vi.fn(async () => ({
      available: true,
      broadSearch: false,
      runner: 'fixture',
      reason: 'No model.',
    })),
    discover: vi.fn(async () => ({
      searches: 0,
      usage: null,
      proposal: {
        verdict: 'supported',
        reason: 'Only the declared metadata scope.',
        nextCheck: 'Check item-specific rights separately.',
        findings: [
          {
            sourceIndex: 0,
            quote,
            status: 'supported',
            decisive: true,
            reason: 'Primary wording.',
          },
        ],
        gaps: [],
      },
    })),
  }) satisfies SearchRunner;
const fetch = async (uri: string) => ({
  uri,
  text,
  digest: digest(text),
  normalizer: 'text-v2' as const,
});

it('supplies excluded source-text scope before native review and retains it in private history and gaps', async () => {
  const root = await area();
  const raw =
    '<html><body><p>Metadata reuse is permitted.</p><div hidden>Except photographs with separate ownership.</div></body></html>';
  const material = extractHtml(raw, input.captureUrls![0]!);
  let reviewedTask = '';
  const result = await signalSearch(input, {
    root,
    fetch: async (uri) => ({
      uri,
      text: material.text,
      digest: digest(raw),
      normalizer: 'text-v3',
      material,
    }),
    claimRunner: (task) => {
      reviewedTask = task;
      return runner();
    },
  });
  expect(reviewedTask).toContain('not complete source coverage');
  expect(reviewedTask).toContain('Excluded DOM content: 43');
  expect(result.claimCheck?.selectedMaterial[0]).toMatchObject({
    state: 'usable',
    scope: 'complete-normalized-document',
    omissions: expect.arrayContaining([expect.stringContaining('not complete source coverage')]),
  });
  expect(result.gaps.join(' ')).toContain('not complete source coverage');
  expect(result.status).toBe('partial');
  expect(await loadRun(result.runId, root)).toEqual(result);
});

it('fits two HTML scope disclosures alongside the maximum native gaps without changing receipt bounds', async () => {
  const root = await area();
  const native: SearchRunner = runner();
  native.discover = vi.fn(async () => ({
    searches: 0,
    usage: null,
    proposal: {
      verdict: 'supported',
      reason: 'Scoped visible fact.',
      nextCheck: 'Check omitted conditions.',
      findings: [
        {
          sourceIndex: 0,
          quote: 'Metadata reuse is permitted.',
          status: 'supported',
          decisive: true,
          reason: 'Retained occurrence.',
        },
      ],
      gaps: Array.from({ length: 10 }, (_, index) => ({
        reason: `Unassessed scope ${index}.`,
        decisive: false,
      })),
    },
  }));
  const result = await signalSearch(
    { ...input, captureUrls: ['https://example.org/one', 'https://example.org/two'] },
    {
      root,
      fetch: async (uri) => {
        const raw =
          '<html><body><p>Metadata reuse is permitted.</p><p hidden>Except a separate object.</p></body></html>';
        const material = extractHtml(raw, uri);
        return { uri, text: material.text, digest: digest(raw), normalizer: 'text-v3', material };
      },
      runner: native,
    },
  );
  expect(result.claimCheck?.reviewState).toBe('completed');
  expect(result.claimCheck?.gaps).toHaveLength(12);
  expect(() => validateClaimReceipt(result)).not.toThrow();
  expect(await loadRun(result.runId, root)).toEqual(result);
});

it('requires explicit direct authority and rejects linked, historical and broader acquisition mixtures', () => {
  expect(parseRequest(input)).toMatchObject({ claimOrigin: 'request', profile: 'quick' });
  expect(parseRequest(parseRequest(input))).toEqual(parseRequest(input));
  for (const override of [
    { claimOrigin: undefined },
    { claimText: undefined },
    { assessmentOf: '00000000-0000-0000-0000-000000000000' },
    { claimSources: [] },
    { method: 'answer-first' },
    { profile: 'wide' },
    { profile: undefined },
    { save: 'eligible' },
    { review: true },
    { sources: [] },
    { supplementalSites: [] },
    { captureUrls: [] },
    { captureUrls: ['https://example.org/a', 'https://example.org/b', 'https://example.org/c'] },
    { captureUrls: ['https://user:secret@example.org/a'] },
    { captureUrls: ['http://127.0.0.1/a'] },
  ])
    expect(() => parseRequest({ ...input, ...override })).toThrow();
});

it('the CLI refuses offline routes even when only the direct-origin flag was supplied', () => {
  for (const flags of [['--schema'], ['--accept', '--claim', 'A proposition.']]) {
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url).pathname,
        new URL('../../../scripts/signal-search.ts', import.meta.url).pathname,
        '--claim-origin',
        'request',
        ...flags,
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
    expect(child.status).toBe(1);
    expect(JSON.parse(child.stdout)).toMatchObject({
      status: 'failed',
      code: 'claim_requires_check_route',
    });
  }
}, 15000);

it('checks a direct proposition without creating an answer, score or parent and retains negative history', async () => {
  const root = await area();
  const native = runner();
  let task = '';
  const result = await signalSearch(input, {
    root,
    fetch,
    claimRunner: (prompt) => {
      task = prompt;
      return native;
    },
  });
  expect(result.status).toBe('completed');
  expect(result.assessmentOf).toBeUndefined();
  expect(result.answerReceipt).toBeUndefined();
  expect(result.items).toEqual([]);
  expect(result.sources).toEqual([]);
  expect(result.claimCheck).toMatchObject({
    version: 2,
    origin: { kind: 'request' },
    verdict: 'supported',
    confidence: 'Unknown',
    historySaved: true,
  });
  expect(result.claimCheck).not.toHaveProperty('parentRunId');
  expect(task).toContain(text);
  expect(task).toContain(input.context!);
  expect(task).not.toContain('parentAnswerDigest');
  expect(native.discover).toHaveBeenCalledOnce();
  expect(await loadRun(result.runId, root)).toEqual(result);
  const path = join(root, '.signals/runs', `${result.runId}.json`);
  const before = await readFile(path);
  const old = new Date(Date.now() - 20 * 86400000);
  await utimes(path, old, old);
  await cleanRuns(root);
  expect(await readFile(path)).toEqual(before);
  const denied = await signalSearch(input, {
    root,
    runner: native,
    fetch: async () => {
      throw new Error('source_denied_403');
    },
  });
  expect(denied.claimCheck).toMatchObject({
    version: 2,
    verdict: null,
    reviewState: 'not-reviewed',
  });
  await utimes(join(root, '.signals/runs', `${denied.runId}.json`), old, old);
  await cleanRuns(root);
  expect((await loadRun(denied.runId, root)).claimCheck!.verdict).toBeNull();
});

it('replay binds the whole original request and rejects a forged parent, context or proposition', async () => {
  const root = await area();
  const result = await signalSearch(input, { root, fetch, runner: runner() });
  for (const mutate of [
    (copy: typeof result) => {
      copy.claimCheck!.originalContext += ' changed';
    },
    (copy: typeof result) => {
      copy.query = copy.claimCheck!.originalNeed = 'Changed need.';
    },
    (copy: typeof result) => {
      copy.claimCheck!.claimText = 'Different proposition.';
      copy.claimCheck!.claimDigest = digest(copy.claimCheck!.claimText);
    },
    (copy: typeof result) => {
      copy.assessmentOf = '00000000-0000-0000-0000-000000000000';
    },
  ]) {
    const copy = structuredClone(result);
    mutate(copy);
    expect(() => validateClaimReceipt(copy)).toThrow('invalid_claim_binding');
    await atomicJson(join(root, '.signals/runs', `${result.runId}.json`), copy);
    await expect(loadRun(result.runId, root)).rejects.toThrow('invalid_claim_binding');
  }
});

it('memory and failed source review preserve no history and never bind caller text as evidence', async () => {
  const root = await area();
  const deniedNative = runner();
  const denied = await signalSearch(
    { ...input, cache: 'memory' },
    {
      root,
      runner: deniedNative,
      fetch: async () => {
        throw new Error('source_denied_403');
      },
    },
  );
  expect(denied.usage.modelCalls).toBe(0);
  expect(deniedNative.readiness).not.toHaveBeenCalled();
  expect(await readdir(root)).toEqual([]);
  const unbound = await signalSearch(
    { ...input, cache: 'memory' },
    {
      root,
      fetch,
      runner: runner(input.context),
    },
  );
  expect(unbound.claimCheck).toMatchObject({
    verdict: null,
    reviewState: 'incomplete',
    historySaved: false,
  });
  expect(unbound.gaps.join(' ')).toContain('unbound_claim_quote');
  expect(await readdir(root)).toEqual([]);
});

it('unsupported sources stay unreviewed with an honest handoff, exact code and no inference', async () => {
  const root = await area();
  const unsupported = async () => {
    throw new Error('unsupported_content');
  };
  for (const uri of ['https://example.org/guide.pdf', 'https://example.org/archive.zip']) {
    const native = runner();
    const result = await signalSearch(
      { ...input, captureUrls: [uri] },
      { root, runner: native, fetch: unsupported },
    );
    const receipt = result.claimCheck!;
    expect(receipt).toMatchObject({
      version: 2,
      claimText: input.claimText,
      reviewState: 'not-reviewed',
      verdict: null,
      confidence: 'Unknown',
      findings: [],
      historySaved: true,
      selectedMaterial: [{ state: 'failed', requestedUri: uri, reason: 'unsupported_content' }],
    });
    expect(receipt.nextCheck).toContain('unsupported_content');
    expect(receipt.nextCheck).toContain('unchecked');
    expect(receipt.nextCheck).toContain('material-preview list/select');
    expect(receipt.nextCheck).toContain('material-preview pages');
    expect(receipt.nextCheck).toContain('does not prove PDF identity');
    expect(receipt.nextCheck).toContain('Inspection is not a new check');
    expect(receipt.nextCheck).toContain('no converter here');
    expect(receipt.nextCheck).not.toMatch(/ready|verified|converted to/i);
    expect(result.assessmentOf).toBeUndefined();
    expect(result.answerReceipt).toBeUndefined();
    expect(result.items).toEqual([]);
    expect(result.usage.modelCalls).toBe(0);
    expect(native.readiness).not.toHaveBeenCalled();
    expect(native.discover).not.toHaveBeenCalled();
    // Private cold reopen: original proposition, URI and code are retained byte-for-byte.
    const path = join(root, '.signals/runs', `${result.runId}.json`);
    const before = await readFile(path);
    const reopened = await loadRun(result.runId, root);
    expect(reopened).toEqual(result);
    expect(reopened.claimCheck!.selectedMaterial[0]).toMatchObject({
      requestedUri: uri,
      reason: 'unsupported_content',
    });
    expect(await readFile(path)).toEqual(before);
  }
  const memoryRoot = await area();
  const memory = await signalSearch(
    { ...input, cache: 'memory', captureUrls: ['https://example.org/guide.pdf'] },
    { root: memoryRoot, runner: runner(), fetch: unsupported },
  );
  expect(memory.claimCheck).toMatchObject({ historySaved: false, verdict: null });
  expect(await readdir(memoryRoot)).toEqual([]);
});

it('denial and cancellation keep their original next check and never resubmit themselves', async () => {
  const root = await area();
  const denied = await signalSearch(input, {
    root,
    runner: runner(),
    fetch: async () => {
      throw new Error('source_denied_403');
    },
  });
  expect(denied.claimCheck).toMatchObject({
    selectedMaterial: [{ state: 'denied', reason: 'source_denied_403' }],
    nextCheck: 'Acquire explicitly selected primary material before reviewing the proposition.',
  });
  expect(denied.claimCheck!.nextCheck).not.toMatch(/bypass|page-selection/i);
  const controller = new AbortController();
  controller.abort();
  const acquire = vi.fn(fetch);
  const cancelled = await signalSearch(
    { ...input, cache: 'memory' },
    { root, signal: controller.signal, runner: runner(), fetch: acquire },
  );
  expect(cancelled.status).toBe('cancelled');
  expect(cancelled.claimCheck).toMatchObject({
    verdict: null,
    reviewState: 'not-reviewed',
    nextCheck: 'Acquire explicitly selected primary material before reviewing the proposition.',
  });
  expect(acquire).not.toHaveBeenCalled();
  const reopened = await loadRun(denied.runId, root);
  expect(reopened).toEqual(denied);
  expect(acquire).not.toHaveBeenCalled();
});

it('direct receipt replay rejects historical lineage in usable and unavailable material', async () => {
  const root = await area();
  const result = await signalSearch(input, { root, fetch, runner: runner() });
  const original = result.claimCheck!.selectedMaterial[0]!;
  if (original.state !== 'usable' || original.scope !== 'complete-normalized-document')
    throw new Error('not_usable');
  const retainedFrom = {
    runId: randomUUID(),
    sourceId: `evidence-${digest(`${original.requestedUri}:${original.documentDigest}:${original.snapshotDigest}:${original.normalizer}`).slice(0, 24)}`,
  };
  for (const source of [
    { ...original, scope: 'retained-excerpt' as const, retainedFrom },
    { ...original, retainedFrom },
    {
      sourceIndex: 0,
      requestedUri: original.requestedUri,
      state: 'denied' as const,
      reason: 'source_denied_403',
      retainedFrom,
    },
  ]) {
    const copy = structuredClone(result);
    copy.claimCheck!.selectedMaterial = [source];
    expect(() => validateClaimReceipt(copy)).toThrow('invalid_direct_claim_material');
    await atomicJson(join(root, '.signals/runs', `${result.runId}.json`), copy);
    await expect(loadRun(result.runId, root)).rejects.toThrow('invalid_direct_claim_material');
  }
});

it('a deferred direct acquisition cannot launch after cancellation or late settlement', async () => {
  const root = await area();
  const controller = new AbortController();
  const native = runner();
  let settle!: (value: Awaited<ReturnType<typeof fetch>>) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = signalSearch(
    { ...input, cache: 'memory' },
    {
      root,
      signal: controller.signal,
      runner: native,
      fetch: async (uri) => {
        started();
        return new Promise((resolve) => {
          settle = resolve;
        }).then(() => fetch(uri));
      },
    },
  );
  await ready;
  controller.abort();
  expect((await pending).status).toBe('cancelled');
  settle(await fetch(input.captureUrls![0]!));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(native.discover).not.toHaveBeenCalled();
  expect(native.readiness).not.toHaveBeenCalled();
  expect(await readdir(root)).toEqual([]);
});

it('the admitted direct shape stays within its derived escaped serialization reserve', async () => {
  const root = await area();
  const result = await signalSearch(input, { root, fetch, runner: runner() });
  const receipt = result.claimCheck!;
  if (receipt.version !== 2) throw new Error('not_direct');
  receipt.originalNeed = result.query = '\0'.repeat(2000);
  receipt.originalContext = '\0'.repeat(4000);
  receipt.claimText = '\0'.repeat(1600);
  receipt.claimDigest = digest(receipt.claimText);
  result.assessmentTargets = [
    `https://example.org/${'a'.repeat(2028)}`,
    `https://example.com/${'b'.repeat(2028)}`,
  ];
  receipt.origin.requestDigest = digest(
    JSON.stringify([
      'direct-source-v1',
      result.query,
      receipt.originalContext,
      receipt.claimText,
      result.assessmentTargets,
    ]),
  );
  receipt.selectedMaterial = result.assessmentTargets.map((uri, sourceIndex) => ({
    sourceIndex,
    requestedUri: uri,
    finalUri: uri,
    state: 'usable',
    text: '\0'.repeat(24000),
    snapshotDigest: digest('\0'.repeat(24000)),
    documentDigest: 'a'.repeat(64),
    normalizer: 'text-v3',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    publishedAt: '2026-01-01T00:00:00.000Z',
    scope: 'complete-normalized-document',
    omissions: Array.from({ length: 10 }, () => '\0'.repeat(1200)),
  }));
  receipt.reviewState = 'incomplete';
  receipt.verdict = null;
  result.status = 'partial';
  receipt.reason = receipt.nextCheck = '\0'.repeat(1200);
  receipt.findings = Array.from({ length: 4 }, (_, index) => ({
    sourceIndex: index % 2,
    quote: '\0'.repeat(400),
    status: 'uncertain',
    decisive: false,
    reason: '\0'.repeat(1200),
  }));
  receipt.gaps = Array.from({ length: 12 }, () => ({ reason: '\0'.repeat(1200), decisive: false }));
  receipt.rejectedOutput = boundedTextReceipt('\0'.repeat(65536));
  expect(Value.Check(claimReceiptSchema, receipt)).toBe(true);
  expect(() => validateClaimReceipt(result)).not.toThrow();
  const bytes = Buffer.byteLength(`${JSON.stringify(receipt, null, 2)}\n`);
  expect(bytes).toBeLessThan(claimReceiptReserve());
  expect(Buffer.byteLength(`${JSON.stringify(result, null, 2)}\n`)).toBeLessThan(2000000);
  result.runId = randomUUID();
  await retainRun(result, root);
  expect(await loadRun(result.runId, root)).toEqual(result);
});
