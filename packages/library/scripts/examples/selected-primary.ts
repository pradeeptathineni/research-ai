import { createHash } from 'node:crypto';
import { realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Value } from 'typebox/value';
import {
  selectedCaptureSchema,
  type SelectedCapture,
} from '../../packages/domain/src/selected-source.js';
import type { SearchRequest } from '../../packages/domain/src/search-contract.js';
import { selectPagePreview } from '../../packages/corpus/src/search-material-preview.js';
import { signalSearch } from '../../packages/corpus/src/signal-search.js';
import type { SearchRunner } from '../../packages/corpus/src/search-runner.js';
import { readPreviewFile } from '../material-preview.js';

const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const selectedExampleQuery = 'Selected-source authored example: water cooling';

/** Authored bytes only: neither a real PDF, fetched publisher response nor parser output. */
export function selectedPrimaryExample(
  texts = [
    'Only water cooling is approved.',
    'Dry commissioning is prohibited.',
    'Local qualifier remains.',
    'Unread remote condition.',
  ],
  claim = 'Water cooling is approved.',
  warnings = ['Text layer only; no OCR or visual/table-completeness guarantee.'],
) {
  const documentBytes = Buffer.from('%PDF-authored-inert-public-fixture');
  const text = texts.join('\n\n');
  let end = 0;
  const pages = texts.map((value, index) => {
    const start = end + (index ? 2 : 0);
    end = start + value.length;
    return { page: index + 1, state: 'text', directImagePresent: false, start, end };
  });
  const extractionBytes = Buffer.from(
    JSON.stringify({
      parser: 'pypdf6.20.1',
      coordinateUnits: 'UTF16',
      sourceDigest: sha(documentBytes),
      textDigest: sha(text),
      text,
      status: 'text-layer',
      completeSourceCoverage: false,
      omissions: warnings,
      pages,
      resourceReadback: { addressSpace: [201326592, 201326592], cpu: [8, 8], uid: 65534 },
    }),
  );
  const uri = 'https://example.org/manual.pdf';
  const packet = selectPagePreview(extractionBytes, {
    expectedInputSha256: sha(extractionBytes),
    expectedSourceSha256: sha(documentBytes),
    expectedTextSha256: sha(text),
    sourceUri: uri,
    claim,
    anchors: [texts[0]!.slice(0, 12)],
  });
  const packetBytes = Buffer.from(`${JSON.stringify(packet)}\n`);
  const capture: SelectedCapture = {
    kind: 'retained-public-pdf-capture-v1',
    requestedUri: uri,
    finalUri: uri,
    fetchedAt: '2026-10-13T22:00:00.000Z',
    status: 200,
    bytes: documentBytes.length,
    documentDigest: sha(documentBytes),
    acquisitionReceiptDigest: 'a'.repeat(64),
    parser: 'pypdf6.20.1',
    // A schema pin in this authored fixture, NOT evidence that the worker ran.
    extractionWorkerDigest: 'db181d4f30169cc576fb4be26886c7e2dd064298c71ff95dcec5d3f88818be0e',
  };
  const input: SearchRequest = {
    query: 'Inspect this explicitly selected primary declaration.',
    context: 'No operational approval or whole-source conclusion.',
    claimOrigin: 'selected-primary',
    selectedPacketDigest: sha(packetBytes),
    claimText: claim,
    captureUrls: [uri],
    profile: 'quick',
    save: 'never',
    cache: 'private',
  };
  return { input, produced: { documentBytes, extractionBytes, packetBytes, capture }, packet };
}

/** Writes only new example inputs; never adopts, removes or overwrites existing evidence. */
export async function prepareSelectedExample(directory: string) {
  const root = await realpath(resolve(directory));
  const { produced, packet } = selectedPrimaryExample();
  const acquisition = Buffer.from(
    JSON.stringify({
      kind: 'authored-example-not-network-capture',
      uri: produced.capture.requestedUri,
      documentDigest: sha(produced.documentBytes),
      fetchedAt: produced.capture.fetchedAt,
    }) + '\n',
  );
  produced.capture.acquisitionReceiptDigest = sha(acquisition);
  for (const [name, bytes] of [
    ['source.pdf', produced.documentBytes],
    ['extraction.json', produced.extractionBytes],
    ['capture.json', JSON.stringify(produced.capture, null, 2) + '\n'],
    ['acquisition.json', acquisition],
    [
      'digests',
      `${sha(produced.extractionBytes)} ${sha(produced.documentBytes)} ${packet.fullTextDigest}\n`,
    ],
  ] as const)
    await writeFile(join(root, name), bytes, { flag: 'wx' });
  return root;
}

/** Explicit synthetic host registration; the public request cannot supply this producer. */
export async function reviewSelectedExample(directory: string, cache: 'memory' | 'private') {
  const root = await realpath(resolve(directory));
  const documentBytes = readPreviewFile(join(root, 'source.pdf'), 20971520);
  const extractionBytes = readPreviewFile(join(root, 'extraction.json'), 250000);
  const packetBytes = readPreviewFile(join(root, 'packet.json'), 300000);
  const metadata: unknown = JSON.parse(
    readPreviewFile(join(root, 'capture.json'), 16384).toString(),
  );
  if (!Value.Check(selectedCaptureSchema, metadata)) throw new Error('example_capture_invalid');
  const capture = metadata;
  if (
    sha(readPreviewFile(join(root, 'acquisition.json'), 16384)) !== capture.acquisitionReceiptDigest
  )
    throw new Error('example_capture_receipt_changed');
  const disclosure =
    cache === 'private'
      ? 'Private creation retains a separate bounded FULL normalized extraction copy for replay; only selected windows go to the reviewer. Raw PDF bytes are not copied.'
      : 'Memory creation writes no product history or source cache.';
  process.stderr.write(
    `Authored synthetic example; no PDF parser, publisher fetch, login or native model. ${disclosure}\n`,
  );
  let producerCalls = 0,
    readinessCalls = 0,
    scriptedReviews = 0;
  const runner: SearchRunner = {
    readiness: () => {
      readinessCalls++;
      return Promise.resolve({
        available: true,
        broadSearch: false,
        runner: 'authored-example',
        reason: 'Scripted; no host probe.',
      });
    },
    discover: () => {
      scriptedReviews++;
      return Promise.resolve({
        searches: 0,
        usage: null,
        proposal: {
          verdict: 'supported',
          reason: 'Authored scripted fixture, not a real source judgment.',
          nextCheck:
            'Unread material, actual source truth and operational applicability are unassessed.',
          findings: [
            {
              sourceIndex: 0,
              quote: 'Only water cooling is approved.',
              status: 'supported',
              decisive: true,
              reason: 'Authored fixture occurrence only.',
            },
          ],
          gaps: [],
        },
      });
    },
  };
  const result = await signalSearch(
    {
      query: selectedExampleQuery,
      context: `Authored synthetic fixture. ${disclosure}`,
      claimOrigin: 'selected-primary',
      selectedPacketDigest: sha(packetBytes),
      claimText: 'Water cooling is approved.',
      captureUrls: [capture.requestedUri],
      profile: 'quick',
      save: 'never',
      cache,
    },
    {
      root: join(root, 'history'),
      claimRunner: () => runner,
      selectedPrimary: (uri, digest, signal) => {
        signal.throwIfAborted();
        if (++producerCalls !== 1 || uri !== capture.requestedUri || digest !== sha(packetBytes))
          throw new Error('example_selection_changed');
        return Promise.resolve({ capture, documentBytes, extractionBytes, packetBytes });
      },
    },
  );
  return {
    result,
    proof: { producerCalls, readinessCalls, scriptedReviews, actualNativeCalls: 0 },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, directory, storage, consent, ...extra] = process.argv.slice(2);
  if (command === 'prepare' && directory && storage === undefined) {
    console.log(await prepareSelectedExample(directory));
  } else if (
    command === 'review' &&
    directory &&
    !extra.length &&
    ((storage === 'memory' && consent === undefined) ||
      (storage === 'private' && consent === '--retain-extraction-copy'))
  ) {
    const { result, proof } = await reviewSelectedExample(directory, storage);
    console.log(
      JSON.stringify(
        {
          runId: result.runId,
          status: result.status,
          reviewState: result.claimCheck?.reviewState,
          historySaved: result.claimCheck?.historySaved,
          historyRoot:
            storage === 'private' ? join(await realpath(resolve(directory)), 'history') : null,
          ...proof,
        },
        null,
        2,
      ),
    );
  } else
    throw new Error(
      'Use prepare DIRECTORY, or review DIRECTORY memory|private [--retain-extraction-copy].',
    );
}
