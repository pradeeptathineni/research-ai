import { it, expect } from 'vitest';
import { mkdtemp, realpath, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signalSearch } from './signal-search.js';
import { answerFirstOperation, type SearchRunner } from './search-runner.js';
import { loadRun, retainRun, cleanRuns } from './search-store.js';
import { digest } from './search-fetch.js';
import { parseRequest } from '../../domain/src/search-contract.js';
import { checkSuggestions, offeredPayload } from '../../domain/src/search-suggestions.js';
import { normalizeConsiderUrl } from '../../domain/src/url.js';
import { searchEvidenceBundle } from './search-exchange.js';

const uri = 'https://example.com/science#methods';
const answer = `Original Ω answer\r\n\r\n[Methods](${uri}). Unknown deployment constraints.`;
const offered = [
  {
    claim: 'This method has independently demonstrated repeatability.',
    basis: 'The answer leaves verification open.',
    why: 'A decision requires repeatable results.',
    urls: [uri],
  },
  {
    claim: 'The stated method requires no external service.',
    basis: 'Deployment constraints are unknown.',
    why: 'Service dependence could preclude use.',
    urls: [uri],
  },
];
const runner = (suggestions: unknown): SearchRunner => ({
  readiness: async () => ({
    available: true,
    broadSearch: true,
    runner: 'fixture',
    reason: 'No model.',
  }),
  discover: async () => ({ proposal: { answer, suggestions }, usage: null, searches: 0 }),
});
const request = {
  query: 'A cross-domain public need',
  method: 'answer-first' as const,
  suggestChecks: true,
  save: 'never' as const,
  cache: 'private' as const,
};
async function root() {
  return realpath(await mkdtemp(join(tmpdir(), 'signals-suggestions-')));
}

it('ordinary answer stays plain while opt-in uses one structured answer session', () => {
  const plain = answerFirstOperation({ ...request, suggestChecks: false });
  expect(plain).toMatchObject({ naturalAnswer: true });
  expect(plain.task).not.toContain('unverified suggestions');
  const assisted = answerFirstOperation(request);
  expect(assisted).toHaveProperty('schema');
  expect(assisted).not.toHaveProperty('naturalAnswer');
  expect(assisted.task).toContain('Do not perform the checks');
  for (const invalid of [
    { ...request, method: 'native' },
    { ...request, save: 'eligible' },
    { ...request, assessmentOf: 'a'.repeat(36) },
    { query: 'x', suggestionIndex: 0 },
    { query: 'x', offeredDigest: 'a'.repeat(64) },
  ])
    expect(() => parseRequest(invalid)).toThrow();
});

it('malformed, unsafe, uncited and oversized suggestions retain exact answer with explicit fallback', async () => {
  const area = await root();
  try {
    for (const invalid of [
      undefined,
      null,
      {},
      [...offered, ...offered],
      [{ ...offered[0], urls: ['https://localhost/private'] }],
      [{ ...offered[0], urls: ['https://example.com/uncited'] }],
      [{ ...offered[0], basis: 'x'.repeat(401) }],
      [{ ...offered[0], why: '🧪'.repeat(201) }],
      [{ ...offered[0], basis: '🧪'.repeat(201) }],
      [{ ...offered[0], claim: '🧪'.repeat(801) }],
      [{ ...offered[0], claim: ' ' }],
      [{ ...offered[0], confidence: 100 }],
    ]) {
      const result = await signalSearch(request, { root: area, runner: runner(invalid) });
      expect(result.brief?.text).toBe(answer);
      expect(result.answerReceipt?.sha256).toBe(digest(answer));
      expect(result.checkSuggestions).toBeUndefined();
      expect(result.gaps.join(' ')).toContain('manual selection');
      expect((await loadRun(result.runId, area)).brief?.text).toBe(answer);
    }
  } finally {
    await rm(area, { recursive: true, force: true });
  }
});

it('empty offers are valid abstention and memory discovery is never silently retained', async () => {
  const area = await root();
  try {
    const result = await signalSearch(
      { ...request, cache: 'memory' },
      { root: area, runner: runner([]) },
    );
    expect(result.checkSuggestions?.offered).toEqual([]);
    expect(await readdir(area)).toEqual([]);
    await expect(loadRun(result.runId, area)).rejects.toThrow('unknown_retained_run');
    const memory = await signalSearch(
      { ...request, cache: 'memory' },
      { root: area, runner: runner(offered) },
    );
    await expect(
      signalSearch(
        {
          query: 'x',
          assessmentOf: memory.runId,
          claimText: offered[0]!.claim,
          captureUrls: [uri],
          suggestionIndex: 0,
          offeredDigest: memory.checkSuggestions!.offeredDigest,
        },
        {
          root: area,
          fetch: () => {
            throw new Error('must_not_fetch');
          },
        },
      ),
    ).rejects.toThrow('unknown_retained_run');
    expect(await readdir(area)).toEqual([]);
  } finally {
    await rm(area, { recursive: true, force: true });
  }
});

it('exact UTF16 text boundaries remain valid with supplementary Unicode', async () => {
  const area = await root();
  try {
    const boundary = [
      { ...offered[0]!, claim: '🧪'.repeat(800), basis: '🧪'.repeat(200), why: '🧪'.repeat(200) },
    ];
    const parent = await signalSearch(request, { root: area, runner: runner(boundary) });
    expect(parent.checkSuggestions?.offered).toEqual(boundary);
    expect((await loadRun(parent.runId, area)).checkSuggestions?.offered).toEqual(boundary);
  } finally {
    await rm(area, { recursive: true, force: true });
  }
});

it('edited selections retain offered order and actual claim while invalid index/digest fails before acquisition', async () => {
  const area = await root();
  try {
    const parent = await signalSearch(request, { root: area, runner: runner(offered) });
    const file = join(area, '.signals/runs', `${parent.runId}.json`);
    const before = await readFile(file, 'utf8');
    let acquisitions = 0;
    const selected = {
      query: 'Caller label',
      assessmentOf: parent.runId,
      claimText: 'Edited decisive proposition.',
      captureUrls: [uri],
      suggestionIndex: 0,
      offeredDigest: parent.checkSuggestions!.offeredDigest,
      cache: 'private' as const,
    };
    const fetch = async () => {
      acquisitions++;
      throw new Error('source_denied_403');
    };
    await expect(
      signalSearch({ ...selected, suggestionIndex: 2 }, { root: area, fetch }),
    ).rejects.toThrow('unknown_check_suggestion');
    await expect(
      signalSearch({ ...selected, offeredDigest: '0'.repeat(64) }, { root: area, fetch }),
    ).rejects.toThrow('unknown_check_suggestion');
    await expect(
      signalSearch({ ...selected, claimText: '🧪'.repeat(801) }, { root: area, fetch }),
    ).rejects.toThrow('invalid_claim_request');
    expect(acquisitions).toBe(0);
    const checked = await signalSearch(selected, { root: area, fetch });
    expect(acquisitions).toBe(1);
    expect(checked.claimCheck?.claimText).toBe(selected.claimText);
    expect(checked.suggestionIndex).toBe(0);
    expect(checked.claimCheck?.verdict).toBeNull();
    expect(checked.usage.modelCalls).toBe(0);
    expect(await readFile(file, 'utf8')).toBe(before);
    expect((await loadRun(checked.runId, area)).suggestionDigest).toBe(checked.suggestionDigest);
    await expect(retainRun({ ...checked, suggestionIndex: 1 }, area)).rejects.toThrow(
      'invalid_suggestion_digest',
    );
    await cleanRuns(area, 0);
    expect((await loadRun(parent.runId, area)).brief?.text).toBe(answer);
    expect((await loadRun(checked.runId, area)).claimCheck?.claimText).toBe(selected.claimText);
  } finally {
    await rm(area, { recursive: true, force: true });
  }
});

it('replay rejects answer, ordered-offer and citation tampering without changing old absent-field readers', async () => {
  const area = await root();
  try {
    const parent = await signalSearch(request, { root: area, runner: runner(offered) });
    const file = join(area, '.signals/runs', `${parent.runId}.json`);
    const before = await readFile(file, 'utf8');
    for (const mutation of [
      { ...parent.checkSuggestions!, answerDigest: '0'.repeat(64) },
      { ...parent.checkSuggestions!, offered: [...offered].reverse() },
      {
        ...parent.checkSuggestions!,
        offered: [{ ...offered[0]!, urls: ['https://example.com/uncited'] }],
      },
    ]) {
      await writeFile(file, JSON.stringify({ ...parent, checkSuggestions: mutation }));
      await expect(loadRun(parent.runId, area)).rejects.toThrow();
    }
    await writeFile(file, before);
    const old = await signalSearch(
      { ...request, suggestChecks: false },
      { root: area, runner: runner(offered) },
    );
    expect((await loadRun(old.runId, area)).checkSuggestions).toBeUndefined();
  } finally {
    await rm(area, { recursive: true, force: true });
  }
});

it('matches canonical own citations while preserving offered strings and rejecting uncited aliases', () => {
  const canonical = 'https://github.com/owner/repo?a=1&b=2#methods';
  const raw = 'https://GITHUB.com:443/owner/repo/?b=2&utm_source=ignored&a=1#methods';
  const admit = (urls: string[], citations = [canonical]) => {
    const values = [{ ...offered[0]!, urls }];
    return checkSuggestions(
      {
        version: 1,
        state: 'unverified',
        answerDigest: digest(answer),
        offered: values,
        offeredDigest: digest(offeredPayload(values)),
      },
      digest(answer),
      citations,
    );
  };
  expect(admit([raw]).offered[0]?.urls).toEqual([raw]);
  for (const destination of [
    'https://www.github.com/owner/repo?a=1&b=2#methods',
    'https://github.com/owner/repo.git?a=1&b=2#methods',
    'https://github.com/owner/repo?a=1&b=3#methods',
    'https://github.com/owner/repo?a=1&b=2#results',
    'https://example.com/redirect-destination',
  ])
    expect(() => admit([destination])).toThrow('check_suggestion_not_cited');
  expect(() => admit([canonical, raw])).toThrow('duplicate_check_suggestion_url');
  const unicode = `https://example.com/${'🧪'.repeat(200)}`;
  const expanded = normalizeConsiderUrl(unicode).normalizedUrl;
  expect(unicode.length).toBeLessThan(2048);
  expect(expanded.length).toBeGreaterThan(2048);
  expect(() => admit([unicode], [expanded])).toThrow('invalid_check_suggestion_url');
});

it('retains bounded parsed-field rejection diagnostics, never source evidence or implicit memory history', async () => {
  const area = await root();
  try {
    const rejected = [{ ...offered[0]!, why: '\u0000🧪'.repeat(9000) }];
    const raw = JSON.stringify(rejected);
    const parent = await signalSearch(request, { root: area, runner: runner(rejected) });
    const receipt = parent.rejectedCheckSuggestions!;
    expect(receipt).toMatchObject({
      scope: 'parsed-final-suggestions',
      presence: 'serializable',
      answerDigest: digest(answer),
      diagnostic: {
        captureComplete: true,
        capturedDigest: digest(raw),
        capturedBytes: Buffer.byteLength(raw),
      },
    });
    expect(Buffer.byteLength(receipt.diagnostic!.text)).toBeLessThanOrEqual(32768);
    expect(receipt.diagnostic!.text).not.toContain('�');
    expect(receipt.diagnostic!.omittedBytes).toBe(
      Buffer.byteLength(raw) - Buffer.byteLength(receipt.diagnostic!.text),
    );
    expect((await loadRun(parent.runId, area)).rejectedCheckSuggestions).toEqual(receipt);
    expect(Buffer.byteLength(JSON.stringify(parent, null, 2))).toBeLessThan(2000000);
    expect(JSON.stringify(searchEvidenceBundle(parent, 'a'.repeat(40)))).not.toContain(
      'parsed-final-suggestions',
    );
    const file = join(area, '.signals/runs', `${parent.runId}.json`);
    for (const mutation of [
      { ...receipt, answerDigest: '0'.repeat(64) },
      { ...receipt, scope: 'runner-stdout' },
      { ...receipt, presence: 'missing' },
      { ...receipt, diagnostic: { ...receipt.diagnostic!, capturedBytes: 1 } },
      { ...receipt, diagnostic: { ...receipt.diagnostic!, captureComplete: false } },
      { ...receipt, diagnostic: { ...receipt.diagnostic!, captureScope: 'runner-stdout' } },
      { ...receipt, diagnostic: { ...receipt.diagnostic!, unrecognized: true } },
    ]) {
      await writeFile(file, JSON.stringify({ ...parent, rejectedCheckSuggestions: mutation }));
      await expect(loadRun(parent.runId, area)).rejects.toThrow('invalid_suggestion_rejection');
    }
    const complete = await signalSearch(request, { root: area, runner: runner(null) });
    const accepted = await signalSearch(request, { root: area, runner: runner(offered) });
    await expect(
      retainRun({ ...accepted, rejectedCheckSuggestions: complete.rejectedCheckSuggestions }, area),
    ).rejects.toThrow('invalid_suggestion_rejection');
    await expect(
      retainRun(
        {
          ...complete,
          rejectedCheckSuggestions: {
            ...complete.rejectedCheckSuggestions!,
            diagnostic: {
              ...complete.rejectedCheckSuggestions!.diagnostic!,
              capturedDigest: '0'.repeat(64),
            },
          },
        },
        area,
      ),
    ).rejects.toThrow('invalid_suggestion_rejection');
    const circular: unknown[] = [];
    circular.push(circular);
    const memoryArea = await root();
    try {
      const missing = await signalSearch(
        { ...request, cache: 'memory' },
        {
          root: memoryArea,
          runner: {
            ...runner([]),
            discover: async () => ({ proposal: { answer }, usage: null, searches: 0 }),
          },
        },
      );
      expect(missing.rejectedCheckSuggestions).toMatchObject({
        presence: 'missing',
        scope: 'parsed-final-suggestions',
      });
      expect(missing.rejectedCheckSuggestions?.diagnostic).toBeUndefined();
      for (const values of [undefined, circular]) {
        const memory = await signalSearch(
          { ...request, cache: 'memory' },
          { root: memoryArea, runner: runner(values) },
        );
        expect(memory.brief?.text).toBe(answer);
        expect(memory.rejectedCheckSuggestions?.presence).toBe('nonserializable');
        expect(memory.rejectedCheckSuggestions?.diagnostic).toBeUndefined();
      }
      expect(await readdir(memoryArea)).toEqual([]);
    } finally {
      await rm(memoryArea, { recursive: true, force: true });
    }
  } finally {
    await rm(area, { recursive: true, force: true });
  }
});
