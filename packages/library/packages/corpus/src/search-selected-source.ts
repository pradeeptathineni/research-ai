import { Value } from 'typebox/value';
import { createHash } from 'node:crypto';
import {
  selectedCaptureSchema,
  selectedPacketSchema,
  selectedClaimMaterialSchema,
  type SelectedCapture,
  type SelectedPacket,
  type SelectedClaimMaterial,
  type SelectedFindingSpan,
} from '../../domain/src/selected-source.js';
import type { ClaimResponse } from '../../domain/src/claim-check.js';
import { normalizeConsiderUrl } from '../../domain/src/url.js';
import { digest } from './search-fetch.js';
import { selectPagePreview } from './search-material-preview.js';

/** Only the host installs this dependency. Requests never supply files or producer objects. */
export type SelectedPrimaryProducer = (
  uri: string,
  packetDigest: string,
  signal: AbortSignal,
) => Promise<{
  capture: SelectedCapture;
  documentBytes: Uint8Array;
  extractionBytes: Uint8Array;
  packetBytes: Uint8Array;
}>;
const byteDigest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const worker = 'db181d4f30169cc576fb4be26886c7e2dd064298c71ff95dcec5d3f88818be0e';
function fail(): never {
  throw new Error('invalid_selected_primary_material');
}
const canonical = (uri: string) => normalizeConsiderUrl(uri).normalizedUrl + new URL(uri).hash;
const packetBytes = (packet: SelectedPacket) => Buffer.from(`${JSON.stringify(packet)}\n`);
const coverage =
  'Selected PDF text-layer windows only. Unread or unextracted text/images may contain contrary conditions; absence here is not source-wide absence. Only the selected packet, not the full extraction archive, is supplied to the native reviewer.';
// Read the exact earlier prototype closure; new admission always emits storage-neutral coverage.
const legacyCoverage =
  'Selected PDF text-layer windows only. Unread or unextracted text/images may contain contrary conditions; absence here is not source-wide absence. Private history retains a separate full normalized extraction copy; the native reviewer receives only the selected packet.';

export const selectedRequestDigest = (
  query: string,
  context: string,
  claim: string,
  targets: string[],
  packet: string,
) =>
  digest(JSON.stringify(['selected-primary-request-v1', query, context, claim, targets, packet]));

function captureChecked(capture: unknown): SelectedCapture {
  if (!Value.Check(selectedCaptureSchema, capture)) fail();
  // TypeBox string limits count code points; the wire contract counts UTF16 units.
  for (const [key, value] of Object.entries(capture)) {
    if (
      typeof value === 'string' &&
      (!value.isWellFormed() || value.length > (key.endsWith('Uri') ? 2048 : 64))
    )
      fail();
  }
  if (
    JSON.stringify(capture).length > 16384 ||
    capture.extractionWorkerDigest !== worker ||
    !Number.isFinite(Date.parse(capture.fetchedAt)) ||
    (capture.publishedAt !== undefined && !Number.isFinite(Date.parse(capture.publishedAt)))
  )
    fail();
  for (const uri of [
    capture.requestedUri,
    capture.finalUri,
    ...(capture.followedFrom ? [capture.followedFrom.uri] : []),
  ])
    if (!uri.isWellFormed() || uri.length > 2048 || canonical(uri) !== uri) fail();
  if (capture.followedFrom && !Number.isFinite(Date.parse(capture.followedFrom.observedAt))) fail();
  return capture;
}

function checkedPacket(
  extraction: Uint8Array,
  bytes: Uint8Array,
  capture: SelectedCapture,
  claim: string,
  expected: string,
) {
  if (extraction.length > 250000 || bytes.length > 300000 || byteDigest(bytes) !== expected) fail();
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.length > 48000) fail();
  const packet: unknown = JSON.parse(text);
  if (
    !Value.Check(selectedPacketSchema, packet) ||
    packet.request.claim !== claim ||
    packet.sourceUriLabel !== capture.requestedUri ||
    packet.sourceDigest !== capture.documentDigest ||
    !packetBytes(packet).equals(Buffer.from(bytes))
  )
    fail();
  const replay = selectPagePreview(extraction, {
    expectedInputSha256: packet.inputSha256,
    expectedSourceSha256: capture.documentDigest,
    expectedTextSha256: packet.fullTextDigest,
    sourceUri: capture.requestedUri,
    claim,
    anchors: packet.request.anchors,
    contextPages: packet.request.contextPages,
  });
  if (!packetBytes(replay).equals(Buffer.from(bytes))) fail();
  return packet;
}

function display(packet: SelectedPacket) {
  let previous = 0;
  const parts: string[] = [];
  for (const window of packet.windows) {
    if (previous < window.start) parts.push(`[Unread source range ${previous}-${window.start}]`);
    parts.push(window.text);
    previous = window.end;
  }
  if (previous < packet.fullTextUnits)
    parts.push(`[Unread source range ${previous}-${packet.fullTextUnits}]`);
  const view = parts.join('\n\n');
  if (!view.isWellFormed() || view.length > 48000) fail();
  return view;
}
const lineage = (request: string, source: SelectedClaimMaterial, packet: string) =>
  digest(
    JSON.stringify([
      'selected-primary-material-v1',
      request,
      source.capture,
      source.archive.extractionDigest,
      packet,
      source.snapshotDigest,
    ]),
  );

/** This is the only source object passed to the native stage: no archive or duplicate display view. */
export function selectedNativeSource(source: SelectedClaimMaterial) {
  return {
    sourceIndex: source.sourceIndex,
    requestedUri: source.requestedUri,
    finalUri: source.finalUri,
    scope: source.scope,
    fetchedAt: source.fetchedAt,
    publishedAt: source.publishedAt,
    documentDigest: source.documentDigest,
    snapshotDigest: source.snapshotDigest,
    followedFrom: source.capture.followedFrom
      ? {
          uri: source.capture.followedFrom.uri,
          observedAt: source.capture.followedFrom.observedAt,
          role: 'contextual outlink, not claim parent',
        }
      : undefined,
    packet: source.packet,
    omissions: source.omissions,
  };
}

export function admitSelectedSource(
  produced: Awaited<ReturnType<SelectedPrimaryProducer>>,
  uri: string,
  claim: string,
  expected: string,
  requestDigest: string,
): SelectedClaimMaterial {
  const capture = structuredClone(captureChecked(produced.capture));
  if (
    capture.requestedUri !== uri ||
    produced.documentBytes.length !== capture.bytes ||
    capture.bytes > 20971520 ||
    !Buffer.from(produced.documentBytes.subarray(0, 5)).equals(Buffer.from('%PDF-')) ||
    byteDigest(produced.documentBytes) !== capture.documentDigest
  )
    fail();
  const packet = checkedPacket(
    produced.extractionBytes,
    produced.packetBytes,
    capture,
    claim,
    expected,
  );
  const text = display(packet);
  const source: SelectedClaimMaterial = {
    sourceIndex: 0,
    requestedUri: uri,
    state: 'usable',
    finalUri: capture.finalUri,
    text,
    snapshotDigest: digest(text),
    documentDigest: capture.documentDigest,
    normalizer: 'pdf-page-windows-v1',
    fetchedAt: capture.fetchedAt,
    ...(capture.publishedAt ? { publishedAt: capture.publishedAt } : {}),
    scope: 'selected-page-windows',
    omissions: [...packet.omissions, coverage],
    packet,
    capture,
    archive: {
      extractionBase64: Buffer.from(produced.extractionBytes).toString('base64'),
      extractionDigest: byteDigest(produced.extractionBytes),
    },
    lineageDigest: '',
  };
  source.lineageDigest = lineage(requestDigest, source, expected);
  validateSelectedSource(source, claim, expected, requestDigest);
  return source;
}

/** Deep replay uses only the copied projection. Never follow a stored URI, path or parent. */
export function validateSelectedSource(
  source: SelectedClaimMaterial,
  claim: string,
  expected: string,
  requestDigest: string,
) {
  if (!Value.Check(selectedClaimMaterialSchema, source)) fail();
  const capture = captureChecked(source.capture);
  const bytes = Buffer.from(source.archive.extractionBase64, 'base64');
  if (
    bytes.toString('base64') !== source.archive.extractionBase64 ||
    byteDigest(bytes) !== source.archive.extractionDigest
  )
    fail();
  const packet = checkedPacket(bytes, packetBytes(source.packet), capture, claim, expected);
  const retainedCoverage = source.omissions.at(-1);
  if (
    source.requestedUri !== capture.requestedUri ||
    source.finalUri !== capture.finalUri ||
    source.documentDigest !== capture.documentDigest ||
    source.fetchedAt !== capture.fetchedAt ||
    source.publishedAt !== capture.publishedAt ||
    source.text !== display(packet) ||
    digest(source.text) !== source.snapshotDigest ||
    ![coverage, legacyCoverage].includes(retainedCoverage ?? '') ||
    JSON.stringify(source.omissions) !== JSON.stringify([...packet.omissions, retainedCoverage]) ||
    source.lineageDigest !== lineage(requestDigest, source, expected) ||
    JSON.stringify(selectedNativeSource(source)).length > 48000
  )
    fail();
}

/** Exact, case-sensitive, single-window occurrences in original global UTF16 coordinates. */
export function selectedQuoteSpans(
  source: SelectedClaimMaterial,
  quote: string,
): SelectedFindingSpan['occurrences'] {
  if (!quote.isWellFormed() || quote.replace(/\s+/g, ' ').trim().length < 8 || quote.length > 400)
    return [];
  const occurrences: SelectedFindingSpan['occurrences'] = [];
  for (const [windowIndex, window] of source.packet.windows.entries()) {
    let offset = window.text.indexOf(quote);
    while (offset !== -1) {
      const start = window.start + offset;
      const end = start + quote.length;
      const pages = source.packet.selectedPages.filter(
        (page) => page.start < end && start < page.end,
      );
      if (!pages.length || occurrences.length === 64) return [];
      occurrences.push({
        windowIndex,
        start,
        end,
        startPage: pages[0]!.page,
        endPage: pages.at(-1)!.page,
      });
      offset = window.text.indexOf(quote, offset + 1);
    }
  }
  return occurrences;
}

export function selectedFindingSpans(
  material: SelectedClaimMaterial | undefined,
  findings: ClaimResponse['findings'],
): SelectedFindingSpan[] {
  return material
    ? findings.map((finding, findingIndex) => ({
        findingIndex,
        sourceIndex: 0,
        occurrences: selectedQuoteSpans(material, finding.quote),
      }))
    : [];
}
