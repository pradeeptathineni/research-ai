import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { atomicJson, readPrivateJson, withWriter } from './search-store.js';
import { boundedSourceTextDiff } from './source-change-reviews.js';
import {
  openSourceCapture,
  recordRefSchema,
  sourceCaptureScopeSchema,
  type RecordRef,
} from './source-captures.js';

const closed = { additionalProperties: false };
const MAX_WATCHES = 100;
const uuid = Type.String({ pattern: '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$' });
const digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const requestSchema = Type.Object(
  {
    request_id: uuid,
    label: Type.String({ minLength: 1, maxLength: 160 }),
    rationale: Type.String({ minLength: 1, maxLength: 1600 }),
    baseline_capture_ref: recordRefSchema,
    start_marker: Type.String({ minLength: 1, maxLength: 500 }),
    end_marker: Type.String({ minLength: 1, maxLength: 500 }),
    ignore_lines: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
      maxItems: 20,
      uniqueItems: true,
    }),
  },
  closed,
);
type Request = Static<typeof requestSchema>;
const coverageSchema = Type.Object(
  {
    text_sha256: digest,
    raw_digest: Type.Union([digest, Type.Null()]),
    scope: sourceCaptureScopeSchema,
  },
  closed,
);
const watchSchema = Type.Object(
  {
    schema_version: Type.Literal('source-watch-v1'),
    id: uuid,
    created_at: Type.String({ format: 'date-time' }),
    request_digest: digest,
    label: Type.String({ minLength: 1, maxLength: 160 }),
    rationale: Type.String({ minLength: 1, maxLength: 1600 }),
    source_id: Type.String({ pattern: '^source-[a-f0-9]{64}$' }),
    baseline_capture_ref: recordRefSchema,
    baseline_coverage: coverageSchema,
    start_marker: Type.String({ minLength: 1, maxLength: 500 }),
    end_marker: Type.String({ minLength: 1, maxLength: 500 }),
    ignore_lines: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
      maxItems: 20,
      uniqueItems: true,
    }),
    qualifications: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
      minItems: 1,
      maxItems: 8,
    }),
  },
  closed,
);
type Watch = Static<typeof watchSchema>;
const storeSchema = Type.Object(
  {
    schema_version: Type.Literal('source-watch-store-v1'),
    watches: Type.Array(watchSchema, { maxItems: MAX_WATCHES }),
  },
  closed,
);
type Store = Static<typeof storeSchema>;

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
const refOf = (watch: Watch): RecordRef => {
  const digest = sha256(JSON.stringify(watch));
  return {
    owner: 'signals-ai',
    kind: 'source-watch',
    id: watch.id,
    revision: `sha256:${digest}`,
    digest,
  };
};
const sameRef = (left: RecordRef, right: RecordRef) =>
  left.owner === right.owner &&
  left.kind === right.kind &&
  left.id === right.id &&
  left.revision === right.revision &&
  left.digest === right.digest;

export class SourceWatchError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly reason: string,
  ) {
    super(code);
  }
}

const fail = (status: number, code: string, reason: string): never => {
  throw new SourceWatchError(status, code, reason);
};
const invalid = (reason: string): never => fail(400, 'invalid_source_watch', reason);
const changed = (reason: string): never => fail(409, 'source_watch_changed', reason);
const emptyStore = (): Store => ({ schema_version: 'source-watch-store-v1', watches: [] });

async function loadStore(root: string): Promise<Store> {
  const parsed = await readPrivateJson(root, 'source-watches.json', emptyStore(), 2_000_000);
  if (!Value.Check(storeSchema, parsed))
    fail(
      503,
      'source_watch_unavailable',
      'Private source-watch state is malformed; no repair was attempted.',
    );
  const store = parsed as Store;
  if (
    new Set(store.watches.map(({ id }) => id)).size !== store.watches.length ||
    store.watches.some(
      (watch) =>
        watch.baseline_capture_ref.kind !== 'source_capture' ||
        watch.baseline_capture_ref.revision !== `sha256:${watch.baseline_capture_ref.digest}` ||
        watch.request_digest !==
          digestRequest({
            request_id: watch.id,
            label: watch.label,
            rationale: watch.rationale,
            baseline_capture_ref: watch.baseline_capture_ref,
            start_marker: watch.start_marker,
            end_marker: watch.end_marker,
            ignore_lines: watch.ignore_lines,
          }),
    )
  )
    fail(503, 'source_watch_unavailable', 'Private source-watch state failed identity checks.');
  return store;
}

function digestRequest(request: Request): string {
  return sha256(canonical(request));
}

function occurrence(value: string, marker: string): number {
  const index = value.indexOf(marker);
  return index >= 0 && value.indexOf(marker, index + 1) < 0 ? index : -1;
}

type ExtractedSection = {
  text: string;
  text_sha256: string;
  line_map: Array<{ line_number: number; line_sha256: string }>;
  omitted_line_map_lines: number;
  ignored_line_count: number;
};
function extractSection(
  text: string,
  watch: Pick<Watch, 'start_marker' | 'end_marker' | 'ignore_lines'>,
): ExtractedSection | null {
  const start = occurrence(text, watch.start_marker);
  const end = occurrence(text, watch.end_marker);
  if (start < 0 || end < 0 || end <= start + watch.start_marker.length) return null;
  const sectionStart = start + watch.start_marker.length;
  const section = text.slice(sectionStart, end);
  const sourceLines = text.split('\n');
  const firstLineNumber = text.slice(0, sectionStart).split('\n').length;
  const ignore = new Set(watch.ignore_lines);
  const line_map: ExtractedSection['line_map'] = [];
  const selectedLines: string[] = [];
  let ignored_line_count = 0;
  section.split('\n').forEach((line, index) => {
    if (ignore.has(line)) {
      ignored_line_count++;
      return;
    }
    selectedLines.push(line);
    if (line_map.length < 40) {
      const lineNumber = firstLineNumber + index;
      line_map.push({
        line_number: lineNumber,
        line_sha256: sha256(sourceLines[lineNumber - 1] ?? ''),
      });
    }
  });
  const selected = selectedLines.join('\n');
  return {
    text: selected,
    text_sha256: sha256(selected),
    line_map,
    omitted_line_map_lines: Math.max(0, selectedLines.length - line_map.length),
    ignored_line_count,
  };
}

function captureCoverage(capture: Awaited<ReturnType<typeof openSourceCapture>>['capture']) {
  return {
    text_sha256: capture.text_sha256,
    raw_digest: capture.raw_digest,
    scope: capture.scope,
  };
}

function watchRef(watch: Watch): RecordRef {
  return refOf(watch);
}

export async function createSourceWatch(root: string, input: unknown) {
  if (!Value.Check(requestSchema, input))
    invalid(
      'Supply a closed source-watch request with exact capture reference and literal markers.',
    );
  const request = input as Request;
  if (
    request.baseline_capture_ref.kind !== 'source_capture' ||
    request.baseline_capture_ref.revision !== `sha256:${request.baseline_capture_ref.digest}`
  )
    invalid('The baseline must be an exact source-capture reference.');
  if (request.start_marker === request.end_marker)
    invalid('Start and end markers must be distinct literal strings.');
  const requestDigest = digestRequest(request);
  const existing = (await loadStore(root)).watches.find((row) => row.id === request.request_id);
  if (existing) {
    if (existing.request_digest !== requestDigest)
      changed('This request UUID already names a different immutable source watch.');
    return { ref: watchRef(existing), watch: existing, replayed: true };
  }
  const baseline = await openSourceCapture(root, request.baseline_capture_ref.id);
  if (!sameRef(baseline.ref, request.baseline_capture_ref))
    changed('The exact baseline capture reference changed.');
  if (!extractSection(baseline.capture.text, request))
    invalid(
      'Each literal marker must occur exactly once, with the end marker after the start marker.',
    );
  const watch: Watch = {
    schema_version: 'source-watch-v1',
    id: request.request_id,
    created_at: new Date().toISOString(),
    request_digest: requestDigest,
    label: request.label,
    rationale: request.rationale,
    source_id: baseline.capture.source_id,
    baseline_capture_ref: baseline.ref,
    baseline_coverage: captureCoverage(baseline.capture),
    start_marker: request.start_marker,
    end_marker: request.end_marker,
    ignore_lines: request.ignore_lines,
    qualifications: [
      'A Source Watch tracks only literal selected text; a textual difference does not establish semantic meaning or importance.',
      'Capture and extraction omissions remain in coverage; this watch does not improve source completeness or currentness.',
    ],
  };
  return withWriter(root, async () => {
    const store = await loadStore(root);
    const replay = store.watches.find((row) => row.id === watch.id);
    if (replay) {
      if (replay.request_digest !== requestDigest)
        changed('This request UUID already names a different immutable source watch.');
      return { ref: watchRef(replay), watch: replay, replayed: true };
    }
    if (store.watches.length >= MAX_WATCHES)
      fail(503, 'source_watch_limit', 'Source-watch capacity is full; no record was removed.');
    const next = { ...store, watches: [...store.watches, watch] };
    if (Buffer.byteLength(JSON.stringify(next, null, 2) + '\n') > 2_000_000)
      fail(
        503,
        'source_watch_limit',
        'Source-watch state would exceed its existing private size limit.',
      );
    await atomicJson(resolve(root, '.signals/source-watches.json'), next);
    return { ref: watchRef(watch), watch, replayed: false };
  });
}

export async function readSourceWatch(
  root: string,
  id: string,
): Promise<{ ref: RecordRef; watch: Watch; cold_read: true }> {
  if (!Value.Check(uuid, id)) invalid('Source-watch identity must be a UUID.');
  const watch = (await loadStore(root)).watches.find((row) => row.id === id);
  if (!watch) return fail(404, 'source_watch_not_found', 'No retained source watch has that UUID.');
  return { ref: watchRef(watch), watch, cold_read: true };
}

export async function listSourceWatches(root: string) {
  const store = await loadStore(root);
  return {
    schema_version: 'source-watch-list-v1',
    watches: store.watches.map((watch) => ({ watch, ref: watchRef(watch) })),
  };
}

type CaptureRef = RecordRef;
type CaptureCoverage = ReturnType<typeof captureCoverage>;
type SourceWatchCheckUnresolved = {
  schema_version: 'source-watch-check-v1';
  status: 'unresolved';
  comparison_scope: 'selected-retained-text-only';
  watch_ref: RecordRef;
  baseline_capture_ref: CaptureRef | null;
  new_capture_ref: CaptureRef;
  baseline_coverage: CaptureCoverage | null;
  new_coverage: CaptureCoverage | null;
  reason: string;
  qualification: string[];
};
type SourceWatchCheckResolved = {
  schema_version: 'source-watch-check-v1';
  status: 'changed' | 'unchanged';
  comparison_scope: 'selected-retained-text-only';
  watch_ref: RecordRef;
  baseline_capture_ref: CaptureRef;
  new_capture_ref: CaptureRef;
  baseline_coverage: CaptureCoverage;
  new_coverage: CaptureCoverage;
  baseline_section: ExtractedSection;
  new_section: ExtractedSection;
  diff_line_coordinates: 'filtered-section-lines';
  ignored_counts: { baseline: number; next: number };
  diff: ReturnType<typeof boundedSourceTextDiff>;
  qualification: string[];
};
export type SourceWatchCheck = SourceWatchCheckUnresolved | SourceWatchCheckResolved;
function unresolved(
  watchRefValue: RecordRef,
  newCaptureRef: CaptureRef,
  reason: string,
  baselineCaptureRef?: CaptureRef,
  baselineCoverage?: ReturnType<typeof captureCoverage>,
  newCoverage?: CaptureCoverage,
): SourceWatchCheckUnresolved {
  return {
    schema_version: 'source-watch-check-v1',
    status: 'unresolved' as const,
    comparison_scope: 'selected-retained-text-only' as const,
    watch_ref: watchRefValue,
    baseline_capture_ref: baselineCaptureRef ?? null,
    new_capture_ref: newCaptureRef,
    baseline_coverage: baselineCoverage ?? null,
    new_coverage: newCoverage ?? null,
    reason,
    qualification: [
      'Unresolved means the selected source text or lineage could not be compared; no quiet unchanged result was inferred.',
      'Each capture reports its retained capture and extraction scope; omitted text is not compared.',
    ],
  };
}

export async function checkSourceWatch(
  root: string,
  watchRefValue: unknown,
  newCaptureRefValue: unknown,
): Promise<SourceWatchCheck> {
  if (
    !Value.Check(recordRefSchema, watchRefValue) ||
    !Value.Check(recordRefSchema, newCaptureRefValue)
  )
    invalid('Supply exact Source Watch and source capture references.');
  const selectedWatchRef = watchRefValue as RecordRef;
  const selectedNewRef = newCaptureRefValue as RecordRef;
  if (selectedWatchRef.kind !== 'source-watch' || selectedNewRef.kind !== 'source_capture')
    invalid('Check requires one exact Source Watch ref and one exact new capture ref.');
  const stored = await readSourceWatch(root, selectedWatchRef.id);
  if (!sameRef(stored.ref, selectedWatchRef))
    return unresolved(
      selectedWatchRef,
      selectedNewRef,
      'The selected Source Watch reference changed.',
      stored.watch.baseline_capture_ref,
      stored.watch.baseline_coverage,
    );
  const watch = stored.watch;
  let baseline: Awaited<ReturnType<typeof openSourceCapture>>;
  let next: Awaited<ReturnType<typeof openSourceCapture>>;
  try {
    [baseline, next] = await Promise.all([
      openSourceCapture(root, watch.baseline_capture_ref.id),
      openSourceCapture(root, selectedNewRef.id),
    ]);
  } catch {
    return unresolved(
      selectedWatchRef,
      selectedNewRef,
      'A retained baseline or new capture could not be reopened.',
      watch.baseline_capture_ref,
      watch.baseline_coverage,
    );
  }
  if (!sameRef(baseline.ref, watch.baseline_capture_ref))
    return unresolved(
      selectedWatchRef,
      selectedNewRef,
      'The exact baseline capture changed.',
      watch.baseline_capture_ref,
      watch.baseline_coverage,
    );
  if (!sameRef(next.ref, selectedNewRef))
    return unresolved(
      selectedWatchRef,
      selectedNewRef,
      'The exact new capture reference changed.',
      watch.baseline_capture_ref,
      watch.baseline_coverage,
    );
  if (baseline.capture.source_id !== watch.source_id || next.capture.source_id !== watch.source_id)
    return unresolved(
      selectedWatchRef,
      selectedNewRef,
      'The baseline and new capture do not share the watched source identity.',
      watch.baseline_capture_ref,
      captureCoverage(baseline.capture),
      captureCoverage(next.capture),
    );

  let cursor = next;
  let descendant = false;
  for (let depth = 0; depth <= 100; depth++) {
    if (cursor.capture.id === baseline.capture.id) {
      descendant = sameRef(cursor.ref, baseline.ref) && cursor.capture.id !== next.capture.id;
      break;
    }
    const predecessor = cursor.capture.supersedes;
    if (!predecessor) break;
    let prior: Awaited<ReturnType<typeof openSourceCapture>>;
    try {
      prior = await openSourceCapture(root, predecessor.id);
    } catch {
      break;
    }
    if (
      prior.capture.source_id !== watch.source_id ||
      !sameRef(prior.ref, predecessor) ||
      prior.capture.id === cursor.capture.id
    )
      break;
    cursor = prior;
  }
  if (!descendant)
    return unresolved(
      selectedWatchRef,
      selectedNewRef,
      'The new capture is not a verified same-source descendant of the baseline within 100 versions.',
      baseline.ref,
      captureCoverage(baseline.capture),
      captureCoverage(next.capture),
    );

  const before = extractSection(baseline.capture.text, watch);
  const after = extractSection(next.capture.text, watch);
  if (!before || !after)
    return unresolved(
      selectedWatchRef,
      selectedNewRef,
      'A literal section marker is missing or ambiguous in retained capture text.',
      baseline.ref,
      captureCoverage(baseline.capture),
      captureCoverage(next.capture),
    );
  const diff = boundedSourceTextDiff(before.text, after.text);
  return {
    schema_version: 'source-watch-check-v1',
    status: diff.state,
    comparison_scope: 'selected-retained-text-only' as const,
    watch_ref: selectedWatchRef,
    baseline_capture_ref: baseline.ref,
    new_capture_ref: next.ref,
    baseline_coverage: captureCoverage(baseline.capture),
    new_coverage: captureCoverage(next.capture),
    baseline_section: before,
    new_section: after,
    diff_line_coordinates: 'filtered-section-lines' as const,
    ignored_counts: {
      baseline: before.ignored_line_count,
      next: after.ignored_line_count,
    },
    diff,
    qualification: [
      'State reports changed or unchanged selected text only; it does not judge semantic importance, truth, relevance, or currentness.',
      'Capture and extraction omissions remain explicit in each coverage object.',
      'Diff line references use filtered-section coordinates; section line maps carry original capture line numbers and full-line hashes.',
    ],
  };
}
