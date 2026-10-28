import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, readFile, readdir, utimes, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { budgets, parseRequest, type SearchResult } from '../../domain/src/search-contract.js';
import { signalSearch } from './signal-search.js';
import { digest } from './search-fetch.js';
import { loadRun, retainRun, atomicJson, cleanRuns } from './search-store.js';
import { partialNoteSelection } from './search-note.js';
import { validateClaimReceipt, claimReceiptReserve } from './search-claim.js';
import { extractHtml } from './search-document.js';
import type { SearchRunner } from './search-runner.js';

it('rejects caller context on retained-note requests and copied-note replay', async () => {
  const { root, input } = await setup();
  const acquire = vi.fn(async (target: string) => fetch(target));
  for (const context of ['', 'A different decision context.']) {
    expect(() => parseRequest({ ...input, context })).toThrow('invalid_partial_claim_request');
    await expect(signalSearch({ ...input, context }, { root, fetch: acquire })).rejects.toThrow(
      'invalid_partial_claim_request',
    );
  }
  expect(acquire).not.toHaveBeenCalled();
  const result = await signalSearch(input, { root, fetch, claimRunner: () => runner() });
  const changed = structuredClone(result);
  changed.runId = randomUUID();
  changed.claimCheck!.additionalContext = 'A different decision context.';
  expect(() => validateClaimReceipt(changed)).toThrow('invalid_partial_claim_closure');
  await expect(retainRun(changed, root)).rejects.toThrow('invalid_partial_claim_closure');
  await atomicJson(join(root, '.signals/runs', changed.runId + '.json'), changed);
  await expect(loadRun(changed.runId, root)).rejects.toThrow('invalid_partial_claim_closure');
  expect(await loadRun(result.runId, root)).toEqual(result);
});

it('rejects elevated completion on a copied-note result during validation and replay', async () => {
  const { root, input } = await setup();
  const result = await signalSearch(input, { root, fetch, claimRunner: () => runner() });
  expect(result.status).toBe('partial');
  const elevated = structuredClone(result);
  elevated.runId = randomUUID();
  elevated.status = 'completed';
  expect(() => validateClaimReceipt(elevated)).toThrow('invalid_claim_binding');
  await expect(retainRun(elevated, root)).rejects.toThrow('invalid_claim_binding');
  await atomicJson(join(root, '.signals/runs', elevated.runId + '.json'), elevated);
  await expect(loadRun(elevated.runId, root)).rejects.toThrow('invalid_claim_binding');
  expect(await loadRun(result.runId, root)).toEqual(result);
});

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});
const uri = 'https://example.org/primary';
const text =
  'The advertised reduction applies only to repetitive JSON. Dense prose may show no reduction.';
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-note-')));
  roots.push(root);
  const parent: SearchResult = {
    schemaVersion: 2,
    runId: randomUUID(),
    query: 'What does context compression preserve?',
    status: 'cancelled',
    brief: {
      format: 'markdown',
      text: `Provisional [primary declaration](${uri}). Preserve prerequisites; quality remains unresolved.`,
    },
    items: [],
    sources: [],
    coverage: [],
    gaps: ['cancelled'],
    counts: { leads: 0, distinct: 0, duplicates: 0, omitted: 0 },
    limits: budgets.quick,
    usage: {
      searches: 0,
      documents: 0,
      modelCalls: 0,
      elapsedMs: 0,
      providerUsage: null,
      cost: null,
    },
  };
  await retainRun(parent, root);
  const selection = partialNoteSelection(parent);
  const input = {
    query: parent.query,
    assessmentOf: parent.runId,
    claimText: 'The advertised reduction applies to repetitive JSON.',
    claimOrigin: 'retained-partial' as const,
    parentSnapshotDigest: selection.parentSnapshotDigest,
    claimCitations: [{ groupIndex: 0, occurrenceIndex: 0 }],
    captureUrls: [uri],
    profile: 'quick' as const,
    review: false,
    save: 'never' as const,
    cache: 'private' as const,
  };
  return { root, parent, selection, input };
}
const fetch = vi.fn(async (target: string) => ({
  uri: target,
  text,
  digest: digest(text),
  normalizer: 'text-v2' as const,
}));
const runner = (): SearchRunner => ({
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
      reason: 'Only the author declaration.',
      nextCheck: 'Evaluate the actual workflow separately.',
      findings: [
        {
          sourceIndex: 0,
          quote: 'The advertised reduction applies only to repetitive JSON.',
          status: 'supported',
          decisive: true,
          reason: 'Exact primary scope.',
        },
      ],
      gaps: [],
    },
  })),
});

it('checks and exactly reopens a stopped parent without creating an answer or entity', async () => {
  const { root, parent, input } = await setup();
  const before = await readFile(join(root, '.signals/runs', parent.runId + '.json'));
  const result = await signalSearch(input, { root, fetch, claimRunner: () => runner() });
  expect(result.claimCheck).toMatchObject({
    version: 3,
    origin: { kind: 'retained-partial', parentRunId: parent.runId, parentStatus: 'cancelled' },
    verdict: 'supported',
    confidence: 'Unknown',
  });
  expect(result.claimCheck).toMatchObject({ origin: { contextState: 'missing' } });
  expect(result.items).toEqual([]);
  expect(result.answerReceipt).toBeUndefined();
  expect(await loadRun(result.runId, root)).toEqual(result);
  expect(await readFile(join(root, '.signals/runs', parent.runId + '.json'))).toEqual(before);
});

it('rejects stale tuple and uncited selection before acquisition', async () => {
  const { root, input } = await setup();
  const acquire = vi.fn(async (target: string) => fetch(target));
  await expect(
    signalSearch({ ...input, parentSnapshotDigest: '0'.repeat(64) }, { root, fetch: acquire }),
  ).rejects.toThrow('stale_partial_parent');
  await expect(
    signalSearch(
      { ...input, captureUrls: ['https://example.org/unrelated'] },
      { root, fetch: acquire },
    ),
  ).rejects.toThrow('partial_selection_not_cited');
  expect(acquire).not.toHaveBeenCalled();
});

it('enforces Unicode, canonical target, explicit-origin and historical-reference boundaries', async () => {
  const { input, parent } = await setup();
  expect(() => parseRequest({ ...input, claimText: '🧪'.repeat(801) })).toThrow(
    'invalid_partial_claim_request',
  );
  expect(() =>
    parseRequest({ ...input, captureUrls: ['https://example.org/' + '🧪'.repeat(200)] }),
  ).toThrow('invalid_partial_claim_target');
  expect(() => parseRequest({ ...input, claimSources: [] })).toThrow(
    'invalid_partial_claim_request',
  );
  expect(() => parseRequest({ ...input, claimOrigin: 'request' })).toThrow(
    'invalid_direct_claim_request',
  );
  expect(() => partialNoteSelection({ ...parent, status: 'completed' })).toThrow(
    'ineligible_partial_parent',
  );
  expect(() =>
    partialNoteSelection({
      ...parent,
      brief: { format: 'markdown', text: '`[not a citation](https://example.org/primary)`' },
    }),
  ).toThrow('partial_citation_selection_unavailable');
});

it('replay rejects parent corruption and selected occurrence tampering', async () => {
  const { root, parent, input } = await setup();
  const result = await signalSearch(input, { root, fetch, claimRunner: () => runner() });
  const mutated = structuredClone(result);
  if (mutated.claimCheck?.version !== 3) throw new Error('fixture_origin');
  mutated.claimCheck.origin.selectedCitations[0]!.start++;
  await atomicJson(join(root, '.signals/runs', result.runId + '.json'), mutated);
  await expect(loadRun(result.runId, root)).rejects.toThrow('invalid_partial_claim_closure');
  await atomicJson(join(root, '.signals/runs', result.runId + '.json'), result);
  await atomicJson(join(root, '.signals/runs', parent.runId + '.json'), {
    ...parent,
    brief: { format: 'markdown', text: parent.brief!.text + ' Changed.' },
  });
  await expect(loadRun(result.runId, root)).rejects.toThrow('invalid_partial_claim_parent');
});

it('denial produces no inference and memory child writes no history', async () => {
  const { root, parent, input } = await setup();
  const discover = vi.fn(async () => ({ searches: 0, usage: null, proposal: {} }));
  const review: SearchRunner = { ...runner(), discover };
  const before = await readdir(join(root, '.signals/runs'));
  const result = await signalSearch(
    { ...input, cache: 'memory' },
    {
      root,
      fetch: async () => {
        throw new Error('source_denied_403');
      },
      claimRunner: () => review,
    },
  );
  expect(result.claimCheck?.verdict).toBeNull();
  expect(result.usage.modelCalls).toBe(0);
  expect(discover).not.toHaveBeenCalled();
  expect(await readdir(join(root, '.signals/runs'))).toEqual(before);
  expect((await loadRun(parent.runId, root)).answerReceipt).toBeUndefined();
});

it('expired parents disappear while independently readable copied-note children remain', async () => {
  const { root, parent, input } = await setup();
  const result = await signalSearch(input, { root, fetch, claimRunner: () => runner() });
  const old = new Date(Date.now() - 10 * 86400000);
  await utimes(join(root, '.signals/runs', parent.runId + '.json'), old, old);
  await cleanRuns(root);
  expect(await loadRun(result.runId, root)).toEqual(result);
  await expect(access(join(root, '.signals/runs', parent.runId + '.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('fresh-only v3 material and closed origin reject replay additions', async () => {
  const { root, input } = await setup();
  const result = await signalSearch(input, { root, fetch, claimRunner: () => runner() });
  const malicious = structuredClone(result);
  Object.assign(malicious.claimCheck!.selectedMaterial[0]!, {
    retainedFrom: { runId: randomUUID(), sourceId: 'evidence-' + '0'.repeat(24) },
  });
  expect(() => validateClaimReceipt(malicious)).toThrow('invalid_direct_claim_material');
  const extra = structuredClone(result);
  if (extra.claimCheck?.version !== 3) throw new Error('fixture_origin');
  Object.assign(extra.claimCheck.origin, { extra: true });
  expect(() => validateClaimReceipt(extra)).toThrow('invalid_claim_receipt');
  expect(Buffer.byteLength(JSON.stringify(result)) + claimReceiptReserve()).toBeLessThan(2000000);
});

it('the actual maximally escaped v3 shape stays within the receipt reserve', async () => {
  const { root, input } = await setup();
  const result = await signalSearch(input, { root, fetch, claimRunner: () => runner() });
  const maximal = structuredClone(result);
  if (maximal.claimCheck?.version !== 3) throw new Error('fixture_origin');
  const receipt = maximal.claimCheck;
  const escaped = '\u0000';
  const longUri = 'https://example.org/' + 'a'.repeat(2028);
  receipt.originalNeed = escaped.repeat(2000);
  receipt.claimText = escaped.repeat(1600);
  receipt.additionalContext = escaped.repeat(4000);
  receipt.origin.selectedCitations = [0, 1].map((sourceIndex) => ({
    sourceIndex,
    groupIndex: sourceIndex,
    occurrenceIndex: 0,
    literal: escaped.repeat(4302),
    uri: longUri,
    start: 0,
    end: 24000,
  }));
  receipt.origin.fullBrief = escaped.repeat(24000);
  const source = receipt.selectedMaterial[0]!;
  if (source.state !== 'usable') throw new Error('fixture_material');
  receipt.selectedMaterial = [0, 1].map((sourceIndex) => ({
    ...source,
    sourceIndex,
    requestedUri: longUri,
    finalUri: longUri,
    text: escaped.repeat(24000),
    omissions: Array.from({ length: 10 }, () => escaped.repeat(1200)),
  }));
  receipt.reason = escaped.repeat(1200);
  receipt.nextCheck = escaped.repeat(1200);
  receipt.gaps = Array.from({ length: 12 }, () => ({
    decisive: true,
    reason: escaped.repeat(1200),
  }));
  receipt.findings = Array.from({ length: 4 }, () => ({
    sourceIndex: 1,
    quote: escaped.repeat(400),
    reason: escaped.repeat(1200),
    status: 'uncertain',
    decisive: true,
  }));
  receipt.rejectedOutput = {
    text: escaped.repeat(32768),
    capturedDigest: '0'.repeat(64),
    capturedBytes: 32768,
    omittedBytes: 0,
    captureComplete: true,
  };
  const actualBytes = Buffer.byteLength(JSON.stringify(maximal, null, 2) + '\n');
  expect(actualBytes).toBeLessThan(claimReceiptReserve(true));
  expect(actualBytes).toBeLessThan(2000000);
});

it('independently recomputes the exact parent and edited-selection tuples', async () => {
  const { root, parent, input } = await setup();
  const note = parent.brief!.text;
  const literal = `[primary declaration](${uri})`;
  const start = note.indexOf(literal),
    end = start + literal.length;
  const ledger = [[0, uri, [[start, end, literal, uri]]]];
  const parentHash = digest(
    JSON.stringify([
      'retained-partial-parent-v1',
      parent.runId,
      'cancelled',
      parent.query,
      'missing',
      '',
      note,
      ledger,
    ]),
  );
  expect(input.parentSnapshotDigest).toBe(parentHash);
  const child = await signalSearch(input, { root, fetch, claimRunner: () => runner() });
  if (child.claimCheck?.version !== 3) throw new Error('fixture_origin');
  expect(child.claimCheck.origin.lineageDigest).toBe(
    digest(
      JSON.stringify([
        'retained-partial-check-v1',
        parentHash,
        [[0, 0, 0, start, end, literal, uri]],
        input.claimText,
        [uri],
      ]),
    ),
  );
  expect(child.claimCheck.origin.fullBrief).toBe(note);
  const reordered = structuredClone(child);
  if (reordered.claimCheck?.version !== 3) throw new Error('fixture_origin');
  reordered.claimCheck.origin.selectedCitations = reordered.claimCheck.origin.selectedCitations.map(
    (ref) => ({
      uri: ref.uri,
      literal: ref.literal,
      end: ref.end,
      start: ref.start,
      occurrenceIndex: ref.occurrenceIndex,
      groupIndex: ref.groupIndex,
      sourceIndex: ref.sourceIndex,
    }),
  );
  expect(() => validateClaimReceipt(reordered)).not.toThrow();
  for (const mutate of [
    (p: SearchResult) => {
      p.status = 'failed';
    },
    (p: SearchResult) => {
      p.query += ' Changed need.';
    },
    (p: SearchResult) => {
      p.brief!.text += ' Changed notes.';
    },
  ]) {
    const changed = structuredClone(parent);
    mutate(changed);
    await atomicJson(join(root, '.signals/runs', parent.runId + '.json'), changed);
    const acquire = vi.fn(async (target: string) => fetch(target));
    await expect(signalSearch(input, { root, fetch: acquire })).rejects.toThrow(
      'stale_partial_parent',
    );
    expect(acquire).not.toHaveBeenCalled();
  }
});

it('recognizes the original second occurrence and excludes code, images and escaped links', async () => {
  const { root, parent, input } = await setup();
  const target = 'https://example.org/primary?q=%C3%A9#terms';
  const changed = {
    ...parent,
    runId: randomUUID(),
    brief: {
      format: 'markdown' as const,
      text: `😀e\u0301 [first](${target}) then [second](${target})`,
    },
  };
  await retainRun(changed, root);
  const selection = partialNoteSelection(changed);
  const result = await signalSearch(
    {
      ...input,
      assessmentOf: changed.runId,
      parentSnapshotDigest: selection.parentSnapshotDigest,
      captureUrls: [target],
      claimCitations: [{ groupIndex: 0, occurrenceIndex: 1 }],
    },
    { root, fetch, claimRunner: () => runner() },
  );
  if (result.claimCheck?.version !== 3) throw new Error('fixture_origin');
  const ref = result.claimCheck.origin.selectedCitations[0]!;
  expect(ref.literal).toBe(`[second](${target})`);
  expect(changed.brief.text.slice(ref.start, ref.end)).toBe(ref.literal);
  expect(ref.uri).toBe(target);
  for (const body of [
    `\`[code](${uri})\``,
    `\n\`\`\`\n[code](${uri})\n\`\`\``,
    `    [code](${uri})`,
    `![image](${uri})`,
    `\\[escaped](${uri})`,
    `Just a substring ${uri}`,
  ])
    expect(() =>
      partialNoteSelection({ ...parent, brief: { format: 'markdown', text: body } }),
    ).toThrow('partial_citation_selection_unavailable');
  for (const refs of [
    [{ groupIndex: 1, occurrenceIndex: 0 }],
    [{ groupIndex: 0, occurrenceIndex: 2 }],
  ]) {
    const acquire = vi.fn(async (target: string) => fetch(target));
    await expect(
      signalSearch({ ...input, claimCitations: refs }, { root, fetch: acquire }),
    ).rejects.toThrow('partial_selection_not_cited');
    expect(acquire).not.toHaveBeenCalled();
  }
});

it('retains only self-contained copies and still reads them when new creation is disabled', async () => {
  const { root, parent, input } = await setup();
  const first = await signalSearch(input, { root, fetch, claimRunner: () => runner() });
  const second = await signalSearch(input, { root, fetch, claimRunner: () => runner() });
  await rm(join(root, '.signals/runs', parent.runId + '.json'));
  expect(await loadRun(first.runId, root)).toEqual(first);
  expect(await loadRun(second.runId, root)).toEqual(second);
  await expect(access(join(root, '.signals/runs', parent.runId + '.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await rm(join(root, '.signals/runs', first.runId + '.json'));
  expect(await loadRun(second.runId, root)).toEqual(second);
  vi.stubEnv('SIGNALS_PARTIAL_CHECKS', '0');
  expect(await loadRun(second.runId, root)).toEqual(second);
  await retainRun(parent, root);
  const acquire = vi.fn(async (target: string) => fetch(target));
  await expect(signalSearch(input, { root, fetch: acquire })).rejects.toThrow(
    'partial_checks_disabled',
  );
  expect(acquire).not.toHaveBeenCalled();
});

it('keeps the full copied note and citation ledger out of inference and rejects malformed new Unicode', async () => {
  const { root, parent, input } = await setup();
  let task = '';
  const result = await signalSearch(input, {
    root,
    fetch,
    claimRunner: (data) => {
      task = data;
      return runner();
    },
  });
  expect(task).toContain(input.claimText);
  expect(task).toContain(parent.query);
  expect(task).not.toContain(parent.brief!.text);
  expect(task).not.toContain('selectedCitations');
  expect(task).not.toContain('fullBrief');
  expect(() => parseRequest({ ...input, claimText: '\ud800' })).toThrow(
    'invalid_partial_claim_request',
  );
  const malformed = structuredClone(result);
  if (malformed.claimCheck?.version !== 3) throw new Error('fixture_origin');
  malformed.claimCheck.origin.fullBrief += '\ud800';
  expect(() => validateClaimReceipt(malformed)).toThrow();
  const a = { ...parent, brief: { format: 'markdown' as const, text: parent.brief!.text + 'é' } };
  const b = {
    ...parent,
    brief: { format: 'markdown' as const, text: parent.brief!.text + 'e\u0301' },
  };
  expect(partialNoteSelection(a).parentSnapshotDigest).not.toBe(
    partialNoteSelection(b).parentSnapshotDigest,
  );
});

it('retains and reopens an actually valid maximally escaped copied-note receipt below its reserve', async () => {
  const { root, parent, input } = await setup();
  const nul = '\u0000';
  const targets = ['1', '2'].map((tail) => 'https://example.org/' + 'a'.repeat(2027) + tail);
  expect(targets.map((target) => target.length)).toEqual([2048, 2048]);
  const links = targets
    .map((target) => `[${nul.repeat(200)}](${target} "${nul.repeat(2045)}")`)
    .join('\n');
  const fullBrief = links + nul.repeat(24000 - links.length);
  const original = {
    ...parent,
    runId: randomUUID(),
    query: nul.repeat(2000),
    brief: { format: 'markdown' as const, text: fullBrief },
  };
  await retainRun(original, root);
  const selection = partialNoteSelection(original);
  const proposal = {
    verdict: 'uncertain',
    reason: nul.repeat(1200),
    nextCheck: nul.repeat(1200),
    findings: Array.from({ length: 4 }, (_, index) => ({
      sourceIndex: index % 2,
      quote: nul.repeat(400),
      status: 'uncertain',
      decisive: false,
      reason: nul.repeat(1200),
    })),
    gaps: Array.from({ length: 10 }, () => ({ decisive: false, reason: nul.repeat(1200) })),
  };
  const review = runner();
  review.discover = vi.fn(async () => ({ searches: 0, usage: null, proposal }));
  const result = await signalSearch(
    {
      ...input,
      query: original.query,
      assessmentOf: original.runId,
      claimText: nul.repeat(1600),
      parentSnapshotDigest: selection.parentSnapshotDigest,
      captureUrls: targets,
      claimCitations: [
        { groupIndex: 0, occurrenceIndex: 0 },
        { groupIndex: 1, occurrenceIndex: 0 },
      ],
    },
    {
      root,
      fetch: async (target) => ({
        uri: target,
        text: nul.repeat(24000),
        digest: digest(nul.repeat(24000)),
        normalizer: 'text-v2',
      }),
      claimRunner: () => review,
    },
  );
  const maximal = structuredClone(result);
  maximal.runId = randomUUID();
  if (maximal.claimCheck?.version !== 3) throw new Error('fixture_origin');
  for (const source of maximal.claimCheck.selectedMaterial)
    if (source.state === 'usable')
      source.omissions = Array.from({ length: 10 }, () => nul.repeat(1200));
  maximal.claimCheck.rejectedOutput = {
    text: nul.repeat(32768),
    capturedDigest: digest(nul.repeat(32768)),
    capturedBytes: 32768,
    omittedBytes: 0,
    captureComplete: true,
  };
  expect(() => validateClaimReceipt(maximal)).not.toThrow();
  const bytes = Buffer.byteLength(JSON.stringify(maximal, null, 2) + '\n');
  expect(bytes).toBeLessThan(claimReceiptReserve(true));
  expect(bytes).toBeLessThan(2000000);
  console.info(
    JSON.stringify({
      proof: 'valid_maximal_serialized_v3',
      bytes,
      reserve: claimReceiptReserve(true),
      finalByteLimit: 2000000,
      fullBriefUnits: fullBrief.length,
      targetUnits: targets.map((target) => target.length),
      literalUnits: maximal.claimCheck.origin.selectedCitations.map((ref) => ref.literal.length),
    }),
  );
  await retainRun(maximal, root);
  expect(await loadRun(maximal.runId, root)).toEqual(maximal);
  const path = join(root, '.signals/runs', maximal.runId + '.json');
  const before = await readFile(path);
  await retainRun(maximal, root);
  expect(await readFile(path)).toEqual(before);
  // A valid large closure is distinct from the earlier size-only mutated shape.
  const oversized = structuredClone(maximal);
  oversized.runId = randomUUID();
  oversized.gaps = [nul.repeat(2000000)];
  await expect(retainRun(oversized, root)).rejects.toThrow('run_snapshot_size');
  await expect(
    access(join(root, '.signals/runs', oversized.runId + '.json')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
}, 15000);

it('keeps two HTML scope omissions and ten native gaps without using a thirteenth receipt gap', async () => {
  const { root, parent, input } = await setup();
  const second = 'https://example.org/second';
  const original = {
    ...parent,
    runId: randomUUID(),
    brief: { format: 'markdown' as const, text: parent.brief!.text + ` [second](${second})` },
  };
  await retainRun(original, root);
  const selection = partialNoteSelection(original);
  let prompt = '';
  const review = runner();
  review.discover = vi.fn(async () => ({
    searches: 0,
    usage: null,
    proposal: {
      verdict: 'supported',
      reason: 'Visible declaration only.',
      nextCheck: 'Check omitted qualifiers independently.',
      findings: [
        {
          sourceIndex: 0,
          quote: 'Metadata reuse is permitted.',
          status: 'supported',
          decisive: true,
          reason: 'Exact fixture wording.',
        },
      ],
      gaps: Array.from({ length: 10 }, (_, index) => ({
        decisive: false,
        reason: `Unresolved source detail ${index}.`,
      })),
    },
  }));
  const result = await signalSearch(
    {
      ...input,
      assessmentOf: original.runId,
      parentSnapshotDigest: selection.parentSnapshotDigest,
      captureUrls: [uri, second],
      claimCitations: [
        { groupIndex: 0, occurrenceIndex: 0 },
        { groupIndex: 1, occurrenceIndex: 0 },
      ],
      claimText: 'Metadata reuse is permitted.',
    },
    {
      root,
      fetch: async (target) => {
        const raw =
          '<html><body><p>Metadata reuse is permitted.</p><p hidden>Separate item rights are unknown.</p></body></html>';
        const material = extractHtml(raw, target);
        return {
          uri: target,
          text: material.text,
          digest: digest(raw),
          normalizer: 'text-v3',
          material,
        };
      },
      claimRunner: (task) => {
        prompt = task;
        return review;
      },
    },
  );
  expect(result.claimCheck?.reviewState).toBe('completed');
  expect(result.claimCheck?.gaps).toHaveLength(12);
  expect(result.gaps.join(' ')).toContain('original context was not retained');
  expect(prompt).toContain('original context was not retained');
  expect(prompt).not.toContain(original.brief.text);
  expect(result.status).toBe('partial');
  expect(await loadRun(result.runId, root)).toEqual(result);
});
