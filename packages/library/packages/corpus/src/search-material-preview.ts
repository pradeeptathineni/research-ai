import { createHash } from 'node:crypto';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { normalizeConsiderUrl } from '../../domain/src/url.js';
import { cachedMaterial, materialOmissions, type DocumentMaterial } from './search-document.js';
import { digest } from './search-fetch.js';
import { validateLayoutProjection } from './search-html-layout.js';
import { selectedPacketSchema, type SelectedPacket } from '../../domain/src/selected-source.js';

/** Same UTF16 budget as whole-source claim material; previews never truncate to fit it. */
const previewRangeLimit = 48000;
export const previewSnapshotByteLimit = 16 * 1024 * 1024;
const snippetUnits = 160;

const coordinate =
  'Zero-based UTF16 code units in the exact normalized text; start inclusive, end exclusive.';
const notices = [
  'Preview artifact only: not a search result, evidence receipt, peer bundle, score, assessment or source-completeness verdict.',
  'The snapshot is caller-supplied and not independently authenticated. inputSha256 distinguishes input bytes only; a source URI label does not establish transport identity or freshness.',
  'Even the complete normalized text does not prove complete source coverage.',
  'Table spans refer to generated projections. Row/column labels and delimiters are generated, not raw-source verbatim quotations. Cell geometry is omitted.',
];

export interface PreviewSnapshot {
  material: DocumentMaterial;
  inputSha256: string;
  sourceUriLabel: string | null;
}

/** Validates caller bytes with the existing material readers; never renormalizes text. */
export function previewSnapshot(bytes: Uint8Array, sourceUri?: string): PreviewSnapshot {
  if (bytes.length > previewSnapshotByteLimit) throw new Error('preview_input_too_large');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('preview_malformed_material');
  }
  const material = cachedMaterial(value);
  if (!material) throw new Error('preview_malformed_material');
  if (!material.text.isWellFormed()) throw new Error('preview_invalid_unicode');
  // Historical material without a layout scope can still carry recognized table spans.
  validateLayoutProjection(material.text, material.sections);
  let sourceUriLabel: string | null = null;
  if (sourceUri !== undefined)
    try {
      normalizeConsiderUrl(sourceUri);
      sourceUriLabel = sourceUri;
    } catch {
      throw new Error('preview_invalid_source_uri');
    }
  return {
    material,
    inputSha256: createHash('sha256').update(bytes).digest('hex'),
    sourceUriLabel,
  };
}

const high = (code: number) => code >= 0xd800 && code <= 0xdbff;
const low = (code: number) => code >= 0xdc00 && code <= 0xdfff;
const splitsPair = (text: string, index: number) =>
  index > 0 &&
  index < text.length &&
  high(text.charCodeAt(index - 1)) &&
  low(text.charCodeAt(index));
const pairSafeEnd = (text: string, end: number) => (splitsPair(text, end) ? end - 1 : end);
const integer = (value: number, min: number, max: number, code: string) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(code);
  return value;
};

/** Original table spans overlapping a range; clipped or rebased geometry is never emitted. */
function tableOverlaps(material: DocumentMaterial, start: number, end: number) {
  return material.sections.flatMap((section) =>
    (section.provenance ?? []).flatMap((value) => {
      if (!value || typeof value !== 'object' || !('kind' in value)) return [];
      if (value.kind !== 'html-table-v1') return [];
      const table = value as unknown as { table: number; start: number; end: number };
      if (!(table.start < end && start < table.end)) return [];
      return [
        {
          locator: section.locator,
          table: table.table,
          tableStart: table.start,
          tableEnd: table.end,
          fullyWithinRange: start <= table.start && table.end <= end,
        },
      ];
    }),
  );
}

function header(snapshot: PreviewSnapshot) {
  const { material } = snapshot;
  return {
    kind: 'normalized-text-preview' as const,
    notices,
    coordinate,
    textSha256: digest(material.text),
    textLength: material.text.length,
    inputSha256: snapshot.inputSha256,
    sourceUriLabel: snapshot.sourceUriLabel,
    extractor: material.extractor,
    omissions: materialOmissions(material),
  };
}

/** Normalized text joins blocks and generated table projections with this separator. */
const blockGap = '\n\n';

/**
 * Window end that never exceeds the unit limit. Prefers the last blank-line separator when it
 * keeps at least half the limit, so a window does not open mid-block after a fixed-size cut.
 * Otherwise it is the plain pair-safe cut; no text is dropped or reordered either way.
 */
function windowEnd(text: string, start: number, units: number) {
  const hard = Math.min(start + units, text.length);
  if (hard === text.length) return hard;
  const gap = text.lastIndexOf(blockGap, hard - blockGap.length);
  const end = gap + blockGap.length;
  return gap >= start && end - start >= units / 2 ? end : pairSafeEnd(text, hard);
}
const atGap = (text: string, index: number) =>
  index === 0 ||
  index === text.length ||
  (index >= blockGap.length && text.slice(index - blockGap.length, index) === blockGap);

/** Unranked text-order windows from an explicit offset; navigation aids, not prose sections. */
export function listPreview(
  snapshot: PreviewSnapshot,
  options: { offset?: number; windowUnits?: number; windows?: number } = {},
) {
  const { text } = snapshot.material;
  const offset = integer(options.offset ?? 0, 0, text.length, 'preview_invalid_offset');
  if (splitsPair(text, offset)) throw new Error('preview_offset_splits_surrogate');
  const windowUnits = integer(
    options.windowUnits ?? 4000,
    2,
    previewRangeLimit,
    'preview_invalid_window',
  );
  const count = integer(options.windows ?? 20, 1, 100, 'preview_invalid_window_count');
  const windows = [];
  let start = offset;
  while (start < text.length && windows.length < count) {
    const end = windowEnd(text, start, windowUnits);
    const snippetEnd = pairSafeEnd(text, Math.min(start + snippetUnits, end));
    windows.push({
      start,
      end,
      units: end - start,
      snippet: text.slice(start, snippetEnd),
      snippetIsWholeWindow: snippetEnd === end,
      // Mechanical separator observations only; a gap is not a semantic section boundary.
      opensAtBlockGap: atGap(text, start),
      endsAtBlockGap: atGap(text, end),
    });
    start = end;
  }
  return {
    ...header(snapshot),
    navigation:
      'Mechanical windows in text order, unranked. Snippets are window openings, not semantic or complete prose sections. A window may end early at a blank-line separator (never beyond windowUnits, and only when that keeps at least half of windowUnits) so later windows open at a separator; separators are generated joins, not section verdicts. Windows end one unit early rather than split a surrogate pair.',
    page: {
      offset,
      end: start,
      windowUnits,
      windows,
      nextOffset: start < text.length ? start : null,
      remainingUnits: text.length - start,
    },
    tables: tableOverlaps(snapshot.material, offset, start),
  };
}

/** Exactly text.slice(start, end) after the caller's expected digest matches. */
export function selectPreview(
  snapshot: PreviewSnapshot,
  request: { expectedTextSha256: string; start: number; end: number },
) {
  const { text } = snapshot.material;
  const expected: unknown = request.expectedTextSha256;
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected))
    throw new Error('preview_invalid_digest');
  if (expected !== digest(text)) throw new Error('preview_stale_digest');
  const start = integer(request.start, 0, text.length, 'preview_invalid_range');
  const end = integer(request.end, 0, text.length, 'preview_invalid_range');
  if (start >= end) throw new Error('preview_invalid_range');
  if (end - start > previewRangeLimit) throw new Error('preview_range_over_budget');
  if (splitsPair(text, start) || splitsPair(text, end))
    throw new Error('preview_range_splits_surrogate');
  return {
    ...header(snapshot),
    selection: { start, end, units: end - start, text: text.slice(start, end) },
    outsideSelection: {
      note: 'Normalized text outside the selection is omitted from this preview.',
      before: { start: 0, end: start, units: start },
      after: { start: end, end: text.length, units: text.length - end },
    },
    tables: tableOverlaps(snapshot.material, start, end),
  };
}

const sha = Type.String({ pattern: '^[a-f0-9]{64}$' });
const pageExtraction = Type.Object(
  {
    parser: Type.Literal('pypdf6.20.1'),
    coordinateUnits: Type.Literal('UTF16'),
    sourceDigest: sha,
    textDigest: sha,
    text: Type.String({ maxLength: 100000 }),
    status: Type.Literal('text-layer'),
    completeSourceCoverage: Type.Literal(false),
    omissions: Type.Array(Type.String({ minLength: 1, maxLength: 1200 }), {
      minItems: 1,
      maxItems: 10,
    }),
    pages: Type.Array(
      Type.Object(
        {
          page: Type.Integer({ minimum: 1, maximum: 100 }),
          state: Type.Literal('text'),
          directImagePresent: Type.Boolean(),
          start: Type.Integer({ minimum: 0, maximum: 100000 }),
          end: Type.Integer({ minimum: 0, maximum: 100000 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 100 },
    ),
    resourceReadback: Type.Object(
      {
        addressSpace: Type.Tuple([Type.Integer(), Type.Integer()]),
        cpu: Type.Tuple([Type.Integer(), Type.Integer()]),
        uid: Type.Integer(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export interface PageSelectionRequest {
  expectedInputSha256: string;
  expectedSourceSha256: string;
  expectedTextSha256: string;
  sourceUri: string;
  claim: string;
  anchors: string[];
  contextPages?: number[];
}

/** Offline derived view only. Caller identity hashes are not source authentication. */
export function selectPagePreview(
  bytes: Uint8Array,
  request: PageSelectionRequest,
): SelectedPacket {
  if (bytes.length > 1000000) throw new Error('selection_input_over_budget');
  const inputSha256 = createHash('sha256').update(bytes).digest('hex');
  for (const hash of [
    request.expectedInputSha256,
    request.expectedSourceSha256,
    request.expectedTextSha256,
  ])
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))
      throw new Error('selection_invalid_digest');
  if (inputSha256 !== request.expectedInputSha256) throw new Error('selection_stale_input');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('selection_invalid_extraction');
  }
  if (!Value.Check(pageExtraction, value)) throw new Error('selection_invalid_extraction');
  const { text, pages } = value;
  if (!text.isWellFormed() || text.length > 100000)
    throw new Error('selection_invalid_unicode_or_length');
  if (value.omissions.some((item) => !item.isWellFormed() || item.length > 1200))
    throw new Error('selection_invalid_omissions');
  if (
    value.sourceDigest !== request.expectedSourceSha256 ||
    value.textDigest !== request.expectedTextSha256 ||
    digest(text) !== value.textDigest
  )
    throw new Error('selection_stale_source_or_text');
  let previous = 0;
  for (const [index, page] of pages.entries()) {
    if (
      page.page !== index + 1 ||
      page.start !== previous + (index ? 2 : 0) ||
      page.end <= page.start ||
      page.end > text.length ||
      splitsPair(text, page.start) ||
      splitsPair(text, page.end) ||
      (index && text.slice(previous, page.start) !== '\n\n') ||
      !text.slice(page.start, page.end).trim()
    )
      throw new Error('selection_invalid_page_ledger');
    previous = page.end;
  }
  if (previous !== text.length) throw new Error('selection_invalid_page_ledger');
  if (
    typeof request.claim !== 'string' ||
    !request.claim.trim() ||
    !request.claim.isWellFormed() ||
    request.claim.length > 1600 ||
    !Array.isArray(request.anchors) ||
    request.anchors.length < 1 ||
    request.anchors.length > 8 ||
    request.anchors.some(
      (anchor) =>
        typeof anchor !== 'string' ||
        !anchor.trim() ||
        !anchor.isWellFormed() ||
        anchor.length < 2 ||
        anchor.length > 128,
    )
  )
    throw new Error('selection_invalid_claim_or_anchors');
  const escape = (anchor: string) => anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [index, anchor] of request.anchors.entries())
    if (
      request.anchors.slice(0, index).some((previous) => {
        const match = new RegExp(escape(previous), 'iu').exec(anchor);
        return match?.index === 0 && match[0].length === anchor.length;
      })
    )
      throw new Error('selection_duplicate_anchor');
  const contextPages = request.contextPages ?? [];
  if (
    !Array.isArray(contextPages) ||
    contextPages.length > 100 ||
    new Set(contextPages).size !== contextPages.length ||
    contextPages.some((page) => !Number.isSafeInteger(page) || page < 1 || page > pages.length)
  )
    throw new Error('selection_invalid_context_pages');
  if (typeof request.sourceUri !== 'string' || request.sourceUri.length > 2048)
    throw new Error('selection_invalid_source_uri');
  try {
    const canonical =
      normalizeConsiderUrl(request.sourceUri).normalizedUrl + new URL(request.sourceUri).hash;
    if (canonical.length > 2048) throw new Error('source_uri_over_budget');
  } catch {
    throw new Error('selection_invalid_source_uri');
  }
  const material = {
    text,
    title: 'Caller-supplied PDF text-layer projection',
    author: null,
    publishedAt: null,
    links: [],
    sections: [],
    extractor: value.parser,
  };
  const snapshot = previewSnapshot(Buffer.from(JSON.stringify(material)), request.sourceUri);
  const selected = new Set<number>();
  const include = (index: number) => {
    for (let next = Math.max(0, index - 1); next <= Math.min(pages.length - 1, index + 1); next++)
      selected.add(next);
  };
  contextPages.forEach((page) => include(page - 1));
  const occurrences: { anchorIndex: number; start: number; end: number; pages: number[] }[] = [];
  for (const [anchorIndex, anchor] of request.anchors.entries()) {
    const escaped = escape(anchor);
    // A lookahead retains overlapping matches; iu works on original UTF16 offsets.
    const matcher = new RegExp(`(?=(${escaped}))`, 'giu');
    let found = false;
    for (const match of text.matchAll(matcher)) {
      found = true;
      if (occurrences.length === 128) throw new Error('selection_occurrence_overflow');
      const start = match.index;
      const end = start + match[1]!.length;
      const hitPages = pages.filter((page) => page.start < end && start < page.end);
      if (!hitPages.length) throw new Error('selection_anchor_only_in_separator');
      hitPages.forEach((page) => include(page.page - 1));
      occurrences.push({ anchorIndex, start, end, pages: hitPages.map((page) => page.page) });
    }
    if (!found) throw new Error(`selection_anchor_unmatched:${anchorIndex}`);
  }
  const windows: { start: number; end: number; pages: number[]; text: string }[] = [];
  for (const index of [...selected].sort((a, b) => a - b)) {
    const page = pages[index]!;
    const last = windows.at(-1);
    if (last && last.pages.at(-1) === page.page - 1) {
      last.end = page.end;
      last.pages.push(page.page);
    } else windows.push({ start: page.start, end: page.end, pages: [page.page], text: '' });
  }
  const unreadRanges = [];
  previous = 0;
  for (const window of windows) {
    window.text = selectPreview(snapshot, {
      expectedTextSha256: value.textDigest,
      start: window.start,
      end: window.end,
    }).selection.text;
    if (window.start > previous) unreadRanges.push({ start: previous, end: window.start });
    previous = window.end;
  }
  if (previous < text.length) unreadRanges.push({ start: previous, end: text.length });
  const packet: SelectedPacket = {
    kind: 'offline-page-window-selection' as const,
    algorithm: 'literal-all-hits-adjacent-page-v1',
    sourceUriLabel: snapshot.sourceUriLabel,
    inputSha256,
    sourceDigest: value.sourceDigest,
    fullTextDigest: value.textDigest,
    fullTextUnits: text.length,
    projection: {
      parser: value.parser,
      coordinateUnits: value.coordinateUnits,
      pageSeparator: '\n\n',
    },
    coordinate,
    request: { claim: request.claim, anchors: request.anchors, contextPages, adjacentPages: 1 },
    occurrences,
    windows,
    selectedPages: pages.filter((page) => selected.has(page.page - 1)),
    unreadPages: pages.filter((page) => !selected.has(page.page - 1)).map((page) => page.page),
    unreadRanges,
    selectedUnits: windows.reduce((sum, window) => sum + window.text.length, 0),
    completeSourceCoverage: false,
    confidence: 'Unknown' as const,
    semanticReview: 'not-performed' as const,
    limits: { maxOccurrences: 128, emittedUTF16: 48000, emittedUTF8Bytes: 300000 },
    omissions: [
      ...value.omissions,
      'Derived navigation/evidence-selection view, not a complete document, claim receipt, assessment, Signal or execution authority. Caller hashes/URI labels do not authenticate transport, freshness or source truth.',
      'All literal hits were selected, not all relevant evidence. Unselected and unextracted material may contain decisive contrary facts; absence here does not establish source-wide absence.',
      'Whole pages and one adjacent page on each side preserve only local context, not complete prose sections or all global conditions. Optional context pages were supplied by the caller.',
      'Literal iu matching does not repair line wrapping, hyphenation, Unicode normalization, ligatures or full case-fold equivalents. Unmatched anchors refuse selection, not the proposition.',
    ],
  };
  // Count exactly what the CLI emits, including JSON escapes and its final newline.
  const output = `${JSON.stringify(packet)}\n`;
  if (packet.selectedUnits > 48000 || output.length > 48000 || Buffer.byteLength(output) > 300000)
    throw new Error('selection_packet_over_budget');
  if (!Value.Check(selectedPacketSchema, packet)) throw new Error('selection_invalid_packet');
  return packet;
}
