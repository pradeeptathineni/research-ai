import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { searchApi } from './search-api.js';
import { ClaimCheck } from '../../../apps/corpus/src/claim-check.js';
import { parseRequest, type SearchResult } from '../../domain/src/search-contract.js';
import {
  selectedPrimaryExample as fixture,
  prepareSelectedExample,
  reviewSelectedExample,
} from '../../../scripts/examples/selected-primary.js';
import { materialPreviewCli } from '../../../scripts/material-preview.js';
import { signalSearch } from './signal-search.js';
import { loadRun, retainRun, atomicJson } from './search-store.js';
import { validateClaimReceipt, claimReceiptReserve } from './search-claim.js';
import type * as RunnerModule from './search-runner.js';
import { selectedQuoteSpans, type SelectedPrimaryProducer } from './search-selected-source.js';

// Session-token discovery normally reports installed CLI readiness. This HTTP fixture is inert.
vi.mock('./search-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof RunnerModule>()),
  codexRunner: () => ({
    readiness: async () => ({
      available: false,
      broadSearch: false,
      runner: 'fixture',
      reason: 'No host probe.',
    }),
    discover: async () => {
      throw new Error('unexpected_native');
    },
  }),
}));

const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function area() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'selected-primary-')));
  roots.push(root);
  return root;
}
function scripted(
  quote = 'Only water cooling is approved.',
  status: 'supported' | 'uncertain' | 'contradicted' = 'supported',
) {
  return {
    readiness: vi.fn(async () => ({
      available: true,
      broadSearch: false,
      runner: 'scripted',
      reason: 'No model.',
    })),
    discover: vi.fn(async () => ({
      searches: 0,
      usage: null,
      proposal: {
        verdict: status,
        reason: 'Scoped scripted declaration only.',
        nextCheck: 'Inspect governing conditions outside these windows.',
        findings: [
          { sourceIndex: 0, quote, status, decisive: true, reason: 'Exact retained occurrence.' },
        ],
        gaps: [],
      },
    })),
  } satisfies RunnerModule.SearchRunner;
}
function selected(result: SearchResult) {
  const receipt = result.claimCheck;
  if (receipt?.version !== 4) throw new Error('not_v4');
  const source = receipt.selectedMaterial[0];
  if (source?.state !== 'usable' || source.scope !== 'selected-page-windows')
    throw new Error('not_selected');
  return { receipt, source };
}

it('runs the public example through the actual pages CLI, explicit host registration and cold private reader', async () => {
  const root = await area();
  await prepareSelectedExample(root);
  const [inputSha, sourceSha, textSha] = (await readFile(join(root, 'digests'), 'utf8'))
    .trim()
    .split(' ');
  const preview = materialPreviewCli([
    'pages',
    '--snapshot',
    join(root, 'extraction.json'),
    '--input-sha256',
    inputSha!,
    '--source-sha256',
    sourceSha!,
    '--text-sha256',
    textSha!,
    '--source-uri',
    'https://example.org/manual.pdf',
    '--claim',
    'Water cooling is approved.',
    '--anchors',
    '["Only water c"]',
  ]);
  expect(preview.code).toBe(0);
  await writeFile(join(root, 'packet.json'), preview.stdout, { flag: 'wx' });
  const memory = await reviewSelectedExample(root, 'memory');
  expect(memory.result.claimCheck?.historySaved).toBe(false);
  expect(await readdir(root)).not.toContain('history');
  const retained = await reviewSelectedExample(root, 'private');
  expect(retained.proof).toEqual({
    producerCalls: 1,
    readinessCalls: 1,
    scriptedReviews: 1,
    actualNativeCalls: 0,
  });
  expect(await loadRun(retained.result.runId, join(root, 'history'))).toEqual(retained.result);
  expect(selected(retained.result).source.packet.unreadPages).toEqual([3, 4]);
});

it('requires explicit origin, bounded semantic inputs and exactly one canonical target', () => {
  const { input } = fixture();
  expect(parseRequest(parseRequest(input))).toEqual(parseRequest(input));
  for (const override of [
    { selectedPacketDigest: undefined },
    { assessmentOf: '00000000-0000-0000-0000-000000000000' },
    { claimSources: [] },
    { parentSnapshotDigest: 'a'.repeat(64) },
    { claimCitations: [] },
    { sources: [] },
    { supplementalSites: [] },
    { method: 'answer-first' },
    { save: 'eligible' },
    { profile: 'wide' },
    { captureUrls: [input.captureUrls![0], 'https://example.org/other'] },
    { query: '🧪'.repeat(1001) },
    { context: '\ud800' },
    { claimText: '🧪'.repeat(801) },
  ])
    expect(() => parseRequest({ ...input, ...override })).toThrow();
  expect(() => parseRequest({ ...input, claimOrigin: 'request' })).toThrow(
    'unexpected_selected_primary_fields',
  );
});

it('default transport and disabled creation stop before producer, readiness, acquisition or private writes', async () => {
  const root = await area();
  const { input, produced } = fixture();
  const runner = scripted();
  const fetch = vi.fn();
  const producer = vi.fn(async () => produced);
  await expect(signalSearch(input, { root, runner, fetch })).rejects.toThrow(
    'selected_primary_producer_unavailable',
  );
  vi.stubEnv('SIGNALS_SELECTED_PRIMARY', '0');
  await expect(signalSearch(input, { root, runner, selectedPrimary: producer })).rejects.toThrow(
    'selected_primary_creation_disabled',
  );
  expect(producer).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(runner.readiness).not.toHaveBeenCalled();
  expect(await readdir(root)).toEqual([]);
});

it('default API handler cannot turn a caller digest into registered evidence or invoke inference', async () => {
  const root = await area();
  const { input } = fixture();
  const api = searchApi(root);
  async function request(route: string, body?: unknown, token?: string) {
    const incoming = Object.assign(
      Readable.from(body === undefined ? [] : [JSON.stringify(body)]),
      {
        url: '/signals-ai/__signals/api/' + route,
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          host: '127.0.0.1:9999',
          'content-type': 'application/json',
          'x-signals-token': token,
        },
      },
    ) as unknown as IncomingMessage;
    let status = 0,
      text = '';
    const outgoing = {
      writeHead(code: number) {
        status = code;
      },
      end(value: string) {
        text = value;
      },
    } as unknown as ServerResponse;
    expect(await api(incoming, outgoing)).toBe(true);
    return { status, text };
  }
  const session = await request('session');
  const { token } = JSON.parse(session.text);
  const response = await request('search', input, token);
  expect(response.status).toBe(400);
  expect(response.text).toContain('selected_primary_producer_unavailable');
  expect(await readdir(root)).toEqual([]);
});

it('passes only selected windows/coverage to the native stage, retains global coordinates and cold reopens without a producer', async () => {
  const root = await area();
  const { input, produced, packet } = fixture();
  let task = '';
  const result = await signalSearch(input, {
    root,
    selectedPrimary: async () => produced,
    claimRunner: (value) => {
      task = value;
      return scripted();
    },
  });
  const { receipt, source } = selected(result);
  expect(result.status).toBe('partial');
  expect(receipt.reviewState).toBe('completed');
  expect(receipt.confidence).toBe('Unknown');
  expect(task).toContain('unreadPages');
  expect(task).toContain('not source-wide absence');
  expect(task).not.toContain('extractionBase64');
  expect(task).not.toContain('Unread remote condition.');
  expect(source.packet).toEqual(packet);
  expect(receipt.findingSpans).toEqual([
    {
      findingIndex: 0,
      sourceIndex: 0,
      occurrences: [{ windowIndex: 0, start: 0, end: 31, startPage: 1, endPage: 1 }],
    },
  ]);
  vi.stubEnv('SIGNALS_SELECTED_PRIMARY', '0');
  expect(await loadRun(result.runId, root)).toEqual(result);
  const html = renderToStaticMarkup(createElement(ClaimCheck, { receipt }));
  expect(html).toContain('separate full normalized extraction copy');
  expect(html).toContain('Unread pages:');
  expect(html).toContain('Original UTF16/page bindings:');
});

it('memory mode creates no history, entities, temporary archive or peer output even when review succeeds', async () => {
  const root = await area();
  const { input, produced } = fixture();
  const result = await signalSearch(
    { ...input, cache: 'memory' },
    { root, selectedPrimary: async () => produced, runner: scripted() },
  );
  expect(result.claimCheck?.historySaved).toBe(false);
  expect(result.items).toEqual([]);
  expect(result.sources).toEqual([]);
  expect(result.persistence).toBeUndefined();
  expect(await readdir(root)).toEqual([]);
});

it('owns the admitted capture snapshot after the trusted producer returns', async () => {
  const { input, produced } = fixture();
  const runner = scripted();
  runner.readiness.mockImplementation(async () => {
    produced.capture.finalUri = 'https://example.org/later-mutation.pdf';
    return { available: true, broadSearch: false, runner: 'fixture', reason: 'No model.' };
  });
  const result = await signalSearch(
    { ...input, cache: 'memory' },
    { root: await area(), selectedPrimary: async () => produced, runner },
  );
  expect(selected(result).source.capture.finalUri).toBe(input.captureUrls![0]);
  expect(() => validateClaimReceipt(result)).not.toThrow();
});

it('rejects source, worker, dates, extraction, packet and raw-byte mismatches before readiness without fallback', async () => {
  const { input, produced } = fixture();
  const mutations: ((copy: typeof produced) => void)[] = [
    (copy) => {
      copy.documentBytes = Buffer.from('%PDF-different');
    },
    (copy) => {
      copy.capture.extractionWorkerDigest = 'b'.repeat(64);
    },
    (copy) => {
      copy.capture.fetchedAt = 'not a date';
    },
    (copy) => {
      copy.capture.requestedUri = 'https://example.org/other.pdf';
    },
    (copy) => {
      copy.extractionBytes = Buffer.concat([copy.extractionBytes, Buffer.from(' ')]);
    },
    (copy) => {
      copy.extractionBytes = Buffer.alloc(250001);
    },
    (copy) => {
      const packet = JSON.parse(copy.packetBytes.toString());
      packet.windows[0].text = 'rewritten';
      copy.packetBytes = Buffer.from(`${JSON.stringify(packet)}\n`);
    },
    (copy) => {
      copy.packetBytes = Buffer.concat([copy.packetBytes, Buffer.from(' ')]);
    },
  ];
  for (const mutate of mutations) {
    const copy = {
      capture: structuredClone(produced.capture),
      documentBytes: Buffer.from(produced.documentBytes),
      extractionBytes: Buffer.from(produced.extractionBytes),
      packetBytes: Buffer.from(produced.packetBytes),
    };
    mutate(copy);
    const runner = scripted();
    const root = await area();
    const result = await signalSearch(
      { ...input, cache: 'memory' },
      { root, selectedPrimary: async () => copy, runner },
    );
    expect(result.claimCheck?.selectedMaterial[0]?.state).toBe('failed');
    expect(result.usage.modelCalls).toBe(0);
    expect(runner.readiness).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  }
});

it('deep replay rejects changed ledger/coverage/context/status and recomputed shallow digests before writes', async () => {
  const root = await area();
  const { input, produced } = fixture();
  const result = await signalSearch(input, {
    root,
    selectedPrimary: async () => produced,
    runner: scripted(),
  });
  const mutations: ((copy: SearchResult) => void)[] = [
    (copy) => {
      selected(copy).source.packet.windows[0]!.start++;
    },
    (copy) => {
      selected(copy).source.packet.unreadPages = [];
    },
    (copy) => {
      selected(copy).source.packet.selectedPages[0]!.end--;
    },
    (copy) => {
      selected(copy).receipt.originalContext += 'new context';
    },
    (copy) => {
      copy.status = 'completed';
    },
    (copy) => {
      selected(copy).receipt.findingSpans[0]!.occurrences[0]!.end++;
    },
    (copy) => {
      const { source } = selected(copy);
      source.text += ' invented';
      source.snapshotDigest = sha(source.text);
    },
    (copy) => {
      const { source } = selected(copy);
      const extraction = JSON.parse(
        Buffer.from(source.archive.extractionBase64, 'base64').toString(),
      );
      extraction.pages[0].end--;
      const bytes = Buffer.from(JSON.stringify(extraction));
      source.archive.extractionBase64 = bytes.toString('base64');
      source.archive.extractionDigest = sha(bytes);
      source.packet.inputSha256 = sha(bytes);
    },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(result);
    mutate(copy);
    const { source, receipt } = selected(copy);
    expect(() => validateClaimReceipt(copy)).toThrow();
    receipt.origin.selectedPacketDigest = sha(`${JSON.stringify(source.packet)}\n`);
    receipt.origin.requestDigest = sha(
      JSON.stringify([
        'selected-primary-request-v1',
        receipt.originalNeed,
        receipt.originalContext,
        receipt.claimText,
        copy.assessmentTargets,
        receipt.origin.selectedPacketDigest,
      ]),
    );
    source.lineageDigest = sha(
      JSON.stringify([
        'selected-primary-material-v1',
        receipt.origin.requestDigest,
        source.capture,
        source.archive.extractionDigest,
        receipt.origin.selectedPacketDigest,
        source.snapshotDigest,
      ]),
    );
    // Context is allowed only if its full request tuple is deliberately re-authored; hashes are not signatures.
    if (receipt.originalContext !== result.claimCheck!.originalContext) {
      expect(() => validateClaimReceipt(copy)).not.toThrow();
      continue;
    }
    expect(() => validateClaimReceipt(copy)).toThrow();
    await expect(retainRun(copy, root)).rejects.toThrow();
    await atomicJson(join(root, '.signals/runs', `${result.runId}.json`), copy);
    await expect(loadRun(result.runId, root)).rejects.toThrow();
  }
});

it('unbound whitespace, across-gap/generated text and occurrence overflow cannot become accepted source quotes', async () => {
  const { input, produced } = fixture();
  const root = await area();
  const result = await signalSearch(
    { ...input, cache: 'memory' },
    {
      root,
      selectedPrimary: async () => produced,
      runner: scripted('Only  water cooling is approved.'),
    },
  );
  expect(result.claimCheck?.reviewState).toBe('incomplete');
  expect(result.claimCheck?.findings).toEqual([]);
  const good = await signalSearch(
    { ...input, cache: 'memory' },
    { root, selectedPrimary: async () => produced, runner: scripted() },
  );
  const { source } = selected(good);
  expect(selectedQuoteSpans(source, '[Unread source range')).toEqual([]);
  expect(selectedQuoteSpans(source, '\ud800invalid')).toEqual([]);
  const repeated = structuredClone(source);
  repeated.packet.windows[0]!.text = 'repeat quote. '.repeat(65);
  expect(selectedQuoteSpans(repeated, 'repeat quote.')).toEqual([]);
});

it.each(['uncertain', 'contradicted'] as const)(
  'keeps %s as a scoped result without whole-source promotion',
  async (status) => {
    const { input, produced } = fixture();
    const result = await signalSearch(
      { ...input, cache: 'memory' },
      {
        root: await area(),
        selectedPrimary: async () => produced,
        runner: scripted('Only water cooling is approved.', status),
      },
    );
    expect(result.status).toBe('partial');
    expect(result.claimCheck?.verdict).toBe(status);
    expect(result.items).toEqual([]);
    expect(() => validateClaimReceipt(result)).not.toThrow();
  },
);

it('does not start late inference after producer cancellation and preserves an independent stopped receipt', async () => {
  const root = await area();
  const { input, produced } = fixture();
  const controller = new AbortController();
  const runner = scripted();
  const producer: SelectedPrimaryProducer = async () => {
    controller.abort();
    return produced;
  };
  const result = await signalSearch(input, {
    root,
    selectedPrimary: producer,
    runner,
    signal: controller.signal,
  });
  expect(result.status).toBe('cancelled');
  expect(result.usage.modelCalls).toBe(0);
  expect(runner.readiness).not.toHaveBeenCalled();
  expect(await loadRun(result.runId, root)).toEqual(result);
});

it('keeps unrelated literal cooling, retention and revision predicates generic, and proves conservative v4 reserve below 2MiB', async () => {
  for (const [text, claim] of [
    ['Only water cooling is approved.', 'Water cooling is approved.'],
    [
      'RetainExceptOnCreate deletes the initial rollback resource.',
      'Initial rollback deletes this resource.',
    ],
    ['Revision B does not apply to earlier installations.', 'Revision B is not retroactive.'],
  ]) {
    const { input, produced } = fixture(
      [text!, 'Adjacent exception retained.', 'Remote unread.'],
      claim,
    );
    const result = await signalSearch(
      { ...input, cache: 'memory' },
      { root: await area(), selectedPrimary: async () => produced, runner: scripted(text) },
    );
    expect(result.claimCheck?.reviewState).toBe('completed');
    expect(() => validateClaimReceipt(result)).not.toThrow();
  }
  expect(claimReceiptReserve(false, true) + 20000).toBeLessThan(2000000);
});

it.each([6, 7, 10])(
  'preserves %i extraction warnings plus selector and host scope warnings',
  async (count) => {
    const warnings = Array.from(
      { length: count },
      (_, index) => `Authored extraction limitation ${index}.`,
    );
    const { input, produced, packet } = fixture(undefined, undefined, warnings);
    expect(packet.omissions).toHaveLength(count + 4);
    const root = await area();
    const runner = scripted();
    let nativeTask = '';
    const result = await signalSearch(input, {
      root,
      selectedPrimary: async () => produced,
      claimRunner: (task) => {
        nativeTask = task;
        return runner;
      },
    });
    const { receipt, source } = selected(result);
    expect(receipt.reviewState).toBe('completed');
    expect(source.omissions.slice(0, count + 4)).toEqual(packet.omissions);
    expect(source.omissions).toHaveLength(count + 5);
    for (const warning of source.omissions) expect(nativeTask).toContain(warning);
    expect(await loadRun(result.runId, root)).toEqual(result);
  },
);

it('keeps maximum retained warning units inside the unchanged packet and private-record bounds', async () => {
  const warnings = Array.from(
    { length: 10 },
    (_, index) => String(index) + 'A'.repeat(1197) + '🧊',
  );
  const { input, produced, packet } = fixture(undefined, undefined, warnings);
  expect(produced.packetBytes.toString().length).toBeLessThanOrEqual(48000);
  expect(produced.packetBytes.length).toBeLessThanOrEqual(300000);
  const root = await area();
  const result = await signalSearch(input, {
    root,
    selectedPrimary: async () => produced,
    runner: scripted(),
  });
  expect(packet.omissions).toHaveLength(14);
  expect(selected(result).source.omissions).toHaveLength(15);
  const size = Buffer.byteLength(`${JSON.stringify(result, null, 2)}\n`);
  expect(size).toBeLessThan(claimReceiptReserve(false, true));
  expect(size).toBeLessThan(2000000);
  expect(await loadRun(result.runId, root)).toEqual(result);
});

it('still rejects a one-unit ASCII anchor on deep replay before readiness', async () => {
  const { input, produced, packet } = fixture();
  packet.request.anchors = ['O'];
  produced.packetBytes = Buffer.from(`${JSON.stringify(packet)}\n`);
  input.selectedPacketDigest = sha(produced.packetBytes);
  const runner = scripted();
  const root = await area();
  const result = await signalSearch(
    { ...input, cache: 'memory' },
    { root, selectedPrimary: async () => produced, runner },
  );
  expect(result.claimCheck?.selectedMaterial[0]?.state).toBe('failed');
  expect(runner.readiness).not.toHaveBeenCalled();
  expect(await readdir(root)).toEqual([]);
});

it.each(['A'.repeat(1200), 'A'.repeat(1180) + '🧊'])(
  'leads bounded well-formed summaries with mandatory coverage while preserving a long warning (%#)',
  async (warning) => {
    const { input, produced } = fixture(undefined, undefined, [warning]);
    const result = await signalSearch(
      { ...input, cache: 'memory' },
      { root: await area(), selectedPrimary: async () => produced, runner: scripted() },
    );
    const { receipt, source } = selected(result);
    expect(source.omissions[0]).toBe(warning);
    const summary = receipt.gaps[0]!.reason;
    expect(summary).toContain('absence here is not source-wide absence');
    expect(summary.length).toBeLessThanOrEqual(1200);
    expect(summary.isWellFormed()).toBe(true);
    expect(summary).toContain('full warnings');
    expect(result.gaps.every((gap) => gap.isWellFormed())).toBe(true);
  },
);

it('memory source/result scope never attributes an unsaved normalized copy to private history', async () => {
  const { input, produced } = fixture();
  const root = await area();
  const result = await signalSearch(
    { ...input, cache: 'memory' },
    { root, selectedPrimary: async () => produced, runner: scripted() },
  );
  const { receipt, source } = selected(result);
  expect(source.omissions.join(' ')).not.toMatch(/Private history (?:retains|includes)/i);
  expect(result.gaps.join(' ')).not.toMatch(/Private history (?:retains|includes)/i);
  expect(receipt.historySaved).toBe(false);
  const html = renderToStaticMarkup(createElement(ClaimCheck, { receipt }));
  expect(html).toContain('Not saved to history.');
  expect(html).not.toContain('Saved privately with a separate');
  expect(await readdir(root)).toEqual([]);
});

it('reopens the exact known prototype host scope while rejecting arbitrary host prose', async () => {
  const root = await area();
  const { input, produced } = fixture();
  const result = await signalSearch(input, {
    root,
    selectedPrimary: async () => produced,
    runner: scripted(),
  });
  const legacy = structuredClone(result);
  const source = selected(legacy).source;
  source.omissions[source.omissions.length - 1] =
    'Selected PDF text-layer windows only. Unread or unextracted text/images may contain contrary conditions; absence here is not source-wide absence. Private history retains a separate full normalized extraction copy; the native reviewer receives only the selected packet.';
  expect(() => validateClaimReceipt(legacy)).not.toThrow();
  await atomicJson(join(root, '.signals/runs', `${result.runId}.json`), legacy);
  expect(await loadRun(result.runId, root)).toEqual(legacy);
  source.omissions[source.omissions.length - 1] += ' Arbitrary replacement.';
  expect(() => validateClaimReceipt(legacy)).toThrow();
});
