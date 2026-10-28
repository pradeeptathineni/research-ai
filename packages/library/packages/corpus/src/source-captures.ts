import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { normalizeConsiderUrl } from '../../domain/src/url.js';
import { atomicJson, withWriter } from './search-store.js';
import { fetchEvidence } from './search-fetch.js';
import { materialOmissions } from './search-document.js';

const closed = { additionalProperties: false };
const sha = Type.String({ pattern: '^[a-f0-9]{64}$' });
const uuid = Type.String({ pattern: '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$' });
export const recordRefSchema = Type.Object(
  {
    owner: Type.Literal('signals-ai'),
    kind: Type.String({ minLength: 1, maxLength: 40 }),
    id: Type.String({ minLength: 1, maxLength: 200 }),
    revision: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
    digest: sha,
  },
  closed,
);
const captureSchema = Type.Object(
  {
    schema_version: Type.Literal('1.0'),
    id: uuid,
    source_id: Type.String({ pattern: '^source-[a-f0-9]{64}$' }),
    source_ref: recordRefSchema,
    source_uri: Type.String({ minLength: 1, maxLength: 2048 }),
    final_uri: Type.Union([Type.String({ minLength: 1, maxLength: 2048 }), Type.Null()]),
    captured_at: Type.String({ format: 'date-time' }),
    observed_at: Type.String({ format: 'date-time' }),
    publication_date: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    provenance: Type.Object(
      {
        kind: Type.Enum(['fetch', 'user-supplied']),
        transport_identity: Type.Enum(['https-tls', 'unverified']),
        freshness: Type.Enum(['observed-at-only', 'unverified']),
      },
      closed,
    ),
    text: Type.String({ minLength: 1, maxLength: 48000 }),
    text_sha256: sha,
    raw_digest: Type.Union([sha, Type.Null()]),
    normalizer: Type.String({ minLength: 1, maxLength: 80 }),
    scope: Type.Object(
      {
        capture: Type.Object(
          {
            mode: Type.Enum(['fetch', 'paste']),
            original_utf16_units: Type.Integer({ minimum: 1 }),
            retained_utf16_units: Type.Integer({ minimum: 1, maximum: 48000 }),
            omitted_utf16_units: Type.Integer({ minimum: 0 }),
            original_utf8_bytes: Type.Integer({ minimum: 1 }),
            retained_utf8_bytes: Type.Integer({ minimum: 1, maximum: 96000 }),
            omitted_utf8_bytes: Type.Integer({ minimum: 0 }),
          },
          closed,
        ),
        extraction: Type.Object(
          {
            kind: Type.Enum(['html-layout-v1', 'unmeasured', 'operator-text-v1']),
            extractor: Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()]),
            omissions: Type.Array(Type.String({ minLength: 1, maxLength: 800 }), {
              minItems: 1,
              maxItems: 8,
            }),
          },
          closed,
        ),
      },
      closed,
    ),
    qualification: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
      minItems: 1,
      maxItems: 8,
    }),
    supersedes: Type.Union([recordRefSchema, Type.Null()]),
  },
  closed,
);
const annotationSchema = Type.Object(
  {
    schema_version: Type.Literal('1.0'),
    id: uuid,
    capture_ref: recordRefSchema,
    anchor: Type.Object(
      {
        text_sha256: sha,
        start: Type.Integer({ minimum: 0 }),
        end: Type.Integer({ minimum: 1 }),
        quote: Type.String({ minLength: 1, maxLength: 4000 }),
      },
      closed,
    ),
    note: Type.String({ minLength: 1, maxLength: 4000 }),
    created_at: Type.String({ format: 'date-time' }),
    supersedes: Type.Union([recordRefSchema, Type.Null()]),
    qualification: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
      minItems: 1,
      maxItems: 4,
    }),
  },
  closed,
);
const storeSchema = Type.Object(
  {
    schema_version: Type.Literal('1.0'),
    captures: Type.Array(captureSchema, { maxItems: 100 }),
    annotations: Type.Array(annotationSchema, { maxItems: 1000 }),
  },
  closed,
);
export type RecordRef = Static<typeof recordRefSchema>;
type Capture = Static<typeof captureSchema>;
type Annotation = Static<typeof annotationSchema>;
type Store = Static<typeof storeSchema>;
export class SourceCaptureError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly reason: string,
  ) {
    super(code);
  }
}
const invalid = (
  reason = 'Supply the closed source-capture request shape and exact references.',
): never => {
  throw new SourceCaptureError(400, 'invalid_source_capture_request', reason);
};
const unavailable = (
  reason = 'Private source-capture storage is invalid or unavailable.',
): never => {
  throw new SourceCaptureError(503, 'source_capture_unavailable', reason);
};
const changed = (
  reason = 'The exact selected source or predecessor changed. Resolve it explicitly and retry.',
): never => {
  throw new SourceCaptureError(409, 'provider_record_changed', reason);
};
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const refOf = (kind: string, id: string, projection: object): RecordRef => {
  const hash = sha256(JSON.stringify(projection));
  return { owner: 'signals-ai', kind, id, revision: `sha256:${hash}`, digest: hash };
};
const sameRef = (left: RecordRef, right: RecordRef) =>
  left.owner === right.owner &&
  left.kind === right.kind &&
  left.id === right.id &&
  left.digest === right.digest &&
  left.revision === right.revision;
const refBindsDigest = (ref: RecordRef) => ref.revision === `sha256:${ref.digest}`;
const exactRef = (value: unknown, kind: string | string[]) => {
  if (!Value.Check(recordRefSchema, value))
    invalid('An exact Signals RecordRef with matching digest and revision is required.');
  const ref = value as RecordRef;
  const accepted = Array.isArray(kind) ? kind : [kind];
  if (!accepted.includes(ref.kind) || ref.revision !== `sha256:${ref.digest}`)
    invalid('The reference kind or digest/revision binding is invalid.');
  return ref;
};
const isoDate = (value: unknown) => {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?(Z|[+-]\d\d:\d\d)$/.exec(
    value,
  );
  if (!match) return false;
  const [, year, month, day, hour, minute, second, zoneValue] = match;
  const zone = zoneValue!;
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    calendar.getUTCFullYear() !== Number(year) ||
    calendar.getUTCMonth() + 1 !== Number(month) ||
    calendar.getUTCDate() !== Number(day)
  )
    return false;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
  if (
    zone !== 'Z' &&
    (Number(zone.slice(1, 3)) > 14 ||
      Number(zone.slice(4, 6)) > 59 ||
      (Number(zone.slice(1, 3)) === 14 && Number(zone.slice(4, 6)) !== 0))
  )
    return false;
  return Number.isFinite(Date.parse(value));
};
export const isWellFormedUnicode = (value: string) => {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
};
function utf8(value: string) {
  if (!isWellFormedUnicode(value))
    invalid('Text must contain valid Unicode without unpaired surrogates.');
  return Buffer.from(value, 'utf8');
}
function prefix(value: string) {
  let text = '';
  let bytes = 0;
  for (const point of value) {
    const size = Buffer.byteLength(point);
    if (text.length + point.length > 48000 || bytes + size > 96000) break;
    text += point;
    bytes += size;
  }
  return text;
}
const initialStore = (): Store => ({ schema_version: '1.0', captures: [], annotations: [] });
async function loadStore(root: string): Promise<Store> {
  const folder = resolve(root, '.signals');
  const file = resolve(folder, 'source-captures.json');
  try {
    const dir = await lstat(folder);
    if (!dir.isDirectory() || dir.isSymbolicLink() || (await realpath(folder)) !== folder)
      unavailable();
    const before = await lstat(file);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size > 2_000_000 ||
      (await realpath(file)) !== file
    )
      unavailable();
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 2_000_000) unavailable();
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (bytes.length > 2_000_000 || !Buffer.from(bytes.toString('utf8')).equals(bytes))
      unavailable('Private capture state must be valid bounded UTF8 JSON.');
    const after = await lstat(file);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      unavailable(
        'Private capture state changed during validation. Retry after owner reconciliation.',
      );
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!Value.Check(storeSchema, value) || Buffer.byteLength(JSON.stringify(value)) > 2_000_000)
      unavailable('Private capture state has an unsupported shape or size.');
    validateClosure(value as Store);
    return value as Store;
  } catch (error) {
    if (error instanceof SourceCaptureError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return initialStore();
    return unavailable();
  }
}
function validateClosure(store: Store) {
  const captures = new Map<string, Capture>();
  const annotations = new Map<string, Annotation>();
  for (const capture of store.captures) {
    if (
      captures.has(capture.id) ||
      (capture.source_ref.kind !== 'entity' && capture.source_ref.kind !== 'lead') ||
      !refBindsDigest(capture.source_ref)
    )
      unavailable();
    if (
      !isWellFormedUnicode(capture.text) ||
      !capture.text.trim() ||
      capture.text_sha256 !== sha256(capture.text) ||
      capture.scope.capture.retained_utf16_units !== capture.text.length ||
      capture.scope.capture.retained_utf8_bytes !== Buffer.byteLength(capture.text) ||
      capture.scope.capture.original_utf16_units !==
        capture.scope.capture.retained_utf16_units + capture.scope.capture.omitted_utf16_units ||
      capture.scope.capture.original_utf8_bytes !==
        capture.scope.capture.retained_utf8_bytes + capture.scope.capture.omitted_utf8_bytes
    )
      unavailable();
    if (
      capture.source_id !==
      `source-${sha256(JSON.stringify([capture.source_ref.owner, capture.source_ref.kind, capture.source_ref.id, capture.source_uri]))}`
    )
      unavailable();
    try {
      normalizeConsiderUrl(capture.source_uri);
      if (capture.final_uri) normalizeConsiderUrl(capture.final_uri);
    } catch {
      unavailable();
    }
    if (capture.scope.capture.mode === 'paste') {
      if (
        capture.provenance.kind !== 'user-supplied' ||
        capture.provenance.transport_identity !== 'unverified' ||
        capture.provenance.freshness !== 'unverified' ||
        capture.final_uri !== null ||
        capture.raw_digest !== null ||
        capture.normalizer !== 'operator-text-v1' ||
        capture.publication_date !== null ||
        capture.scope.extraction.kind !== 'operator-text-v1' ||
        capture.scope.extraction.extractor !== null ||
        capture.scope.capture.omitted_utf16_units !== 0 ||
        capture.scope.capture.omitted_utf8_bytes !== 0
      )
        unavailable();
    } else if (
      capture.provenance.kind !== 'fetch' ||
      capture.provenance.transport_identity !== 'https-tls' ||
      capture.provenance.freshness !== 'observed-at-only' ||
      capture.final_uri === null ||
      capture.raw_digest === null ||
      !['text-v2', 'text-v3'].includes(capture.normalizer) ||
      capture.scope.extraction.kind === 'operator-text-v1'
    )
      unavailable();
    if (
      capture.supersedes &&
      (!Value.Check(recordRefSchema, capture.supersedes) ||
        capture.supersedes.kind !== 'source_capture')
    )
      unavailable();
    captures.set(capture.id, capture);
  }
  const supersededCaptures = new Set<string>();
  for (const capture of captures.values()) {
    if (capture.supersedes) {
      const previous = captures.get(capture.supersedes.id);
      if (!previous) return unavailable();
      if (
        previous.source_id !== capture.source_id ||
        !sameRef(capture.supersedes, refOf('source_capture', previous.id, previous)) ||
        supersededCaptures.has(previous.id)
      )
        unavailable();
      supersededCaptures.add(previous.id);
    }
  }
  const superseded = new Set<string>();
  for (const annotation of store.annotations) {
    if (
      annotations.has(annotation.id) ||
      annotation.anchor.text_sha256.length !== 64 ||
      !refBindsDigest(annotation.capture_ref) ||
      !isWellFormedUnicode(annotation.note) ||
      !annotation.note.trim() ||
      !isWellFormedUnicode(annotation.anchor.quote) ||
      !annotation.anchor.quote
    )
      unavailable();
    const capture = captures.get(annotation.capture_ref.id);
    if (
      !capture ||
      !sameRef(annotation.capture_ref, refOf('source_capture', capture.id, capture)) ||
      annotation.anchor.text_sha256 !== capture.text_sha256 ||
      annotation.anchor.start >= annotation.anchor.end ||
      annotation.anchor.end > capture.text.length ||
      capture.text.slice(annotation.anchor.start, annotation.anchor.end) !==
        annotation.anchor.quote ||
      splitSurrogate(capture.text, annotation.anchor.start) ||
      splitSurrogate(capture.text, annotation.anchor.end)
    )
      unavailable();
    annotations.set(annotation.id, annotation);
  }
  for (const annotation of annotations.values()) {
    if (annotation.supersedes) {
      const previous = annotations.get(annotation.supersedes.id);
      if (!previous) unavailable();
      const prior = previous!;
      if (
        !sameRef(annotation.supersedes, refOf('source_annotation', prior.id, prior)) ||
        !sameRef(prior.capture_ref, annotation.capture_ref) ||
        superseded.has(prior.id)
      )
        unavailable();
      superseded.add(prior.id);
    }
  }
}
function splitSurrogate(text: string, at: number) {
  return (
    at > 0 &&
    at < text.length &&
    text.charCodeAt(at - 1) >= 0xd800 &&
    text.charCodeAt(at - 1) <= 0xdbff &&
    text.charCodeAt(at) >= 0xdc00 &&
    text.charCodeAt(at) <= 0xdfff
  );
}
function captureEntries(store: Store, sourceId?: string) {
  return store.captures
    .filter((row) => sourceId === undefined || row.source_id === sourceId)
    .map((capture) => ({ ref: refOf('source_capture', capture.id, capture), capture }));
}
function annotationEntries(store: Store, captureId: string) {
  return store.annotations
    .filter((row) => row.capture_ref.id === captureId)
    .map((annotation) => ({
      ref: refOf('source_annotation', annotation.id, annotation),
      annotation,
    }));
}
function sourceCaptureUri(kind: 'entity' | 'lead', bytes: Buffer) {
  let record: unknown;
  try {
    record = JSON.parse(bytes.toString('utf8'));
  } catch {
    return invalid('The selected source record is not valid JSON.');
  }
  if (record === null || typeof record !== 'object')
    return invalid('The selected source record has no canonical URI.');
  const row = record as Record<string, unknown>;
  const entity = row.entity;
  const uri =
    kind === 'entity' && entity !== null && typeof entity === 'object'
      ? (entity as Record<string, unknown>).uri
      : kind === 'lead'
        ? row.uri
        : undefined;
  if (typeof uri !== 'string') return invalid('The selected source record has no canonical URI.');
  try {
    normalizeConsiderUrl(uri);
    return uri;
  } catch {
    return invalid('The selected source URI is not eligible for public HTTPS capture.');
  }
}
export type SourceResolver = (ref: RecordRef) => Promise<{ bytes: Buffer; ref: RecordRef }>;
export type SourceCaptureFetch = Awaited<ReturnType<typeof fetchEvidence>>;
export type SourceCaptureOptions = {
  captureId?: string;
  includeBytes?: boolean;
  fetcher?: typeof fetchEvidence;
  beforeRetain?: (fetched: SourceCaptureFetch) => Promise<void>;
};

export async function validateSourceCaptureSelection(
  root: string,
  sourceValue: unknown,
  supersedesValue: unknown,
  resolveSource: SourceResolver,
) {
  const sourceRef = exactRef(sourceValue, ['entity', 'lead']);
  const current = await resolveSource(sourceRef);
  if (!sameRef(current.ref, sourceRef))
    changed('The selected source changed. Resolve its current exact reference before capturing.');
  const uri = sourceCaptureUri(sourceRef.kind as 'entity' | 'lead', current.bytes);
  let supersedes: RecordRef | undefined;
  if (supersedesValue !== undefined) {
    supersedes = exactRef(supersedesValue, 'source_capture');
    const previous = await openSourceCapture(root, supersedes.id);
    const sourceId = `source-${sha256(JSON.stringify([sourceRef.owner, sourceRef.kind, sourceRef.id, uri]))}`;
    if (previous.capture.source_id !== sourceId || !sameRef(previous.ref, supersedes))
      changed('Superseded capture must be an exact capture for the same selected source.');
  }
  return { sourceRef, uri, supersedes };
}

export async function createSourceCapture(
  root: string,
  input: unknown,
  resolveSource: SourceResolver,
  options: SourceCaptureOptions = {},
) {
  const shape = Type.Object(
    {
      source_ref: Type.Unknown(),
      mode: Type.Enum(['fetch', 'paste']),
      text: Type.Optional(Type.String()),
      observed_at: Type.Optional(Type.String()),
      supersedes: Type.Optional(Type.Unknown()),
    },
    closed,
  );
  if (!Value.Check(shape, input)) invalid();
  const data = input as {
    source_ref: unknown;
    mode: 'fetch' | 'paste';
    text?: string;
    observed_at?: string;
    supersedes?: unknown;
  };
  const sourceRef = exactRef(data.source_ref, ['entity', 'lead']);
  if (
    data.mode === 'fetch'
      ? data.text !== undefined || data.observed_at !== undefined
      : data.text === undefined || !isoDate(data.observed_at)
  )
    invalid(
      'Fetch refuses supplied text/date; paste requires exact text and an ISO observation time.',
    );
  if (options.captureId !== undefined && !Value.Check(uuid, options.captureId))
    invalid('Reserved capture identity must be a UUID.');
  const selection = await validateSourceCaptureSelection(
    root,
    sourceRef,
    data.supersedes,
    resolveSource,
  );
  const uri = selection.uri;
  let text: string,
    rawDigest: string | null,
    finalUri: string | null,
    normalizer: string,
    publicationDate: string | null,
    extraction: Capture['scope']['extraction'],
    provenance: Capture['provenance'];
  if (data.mode === 'fetch') {
    let fetched: Awaited<ReturnType<typeof fetchEvidence>>;
    try {
      fetched = await (options.fetcher ?? fetchEvidence)(
        uri,
        undefined,
        0,
        false,
        options.includeBytes ? { includeBytes: true } : {},
      );
    } catch {
      return unavailable(
        'Source acquisition failed or was denied. Retry only after inspecting the selected source; the last capture is unchanged.',
      );
    }
    if (options.beforeRetain) await options.beforeRetain(fetched);
    text = fetched.text;
    rawDigest = fetched.digest;
    finalUri = fetched.uri;
    normalizer = fetched.normalizer ?? 'text-v2';
    publicationDate =
      fetched.material?.publishedAt && Number.isFinite(Date.parse(fetched.material.publishedAt))
        ? new Date(fetched.material.publishedAt).toISOString()
        : null;
    const html = fetched.material?.extractor === 'readability-0.6.0+html-layout-v1';
    extraction = {
      kind: html ? 'html-layout-v1' : 'unmeasured',
      extractor: fetched.material?.extractor ?? null,
      omissions: [
        ...(fetched.material
          ? materialOmissions(fetched.material)
          : ['Extractor exclusions were not measured for this response.']),
        'Retained text does not establish complete source coverage.',
      ].slice(0, 8),
    };
    provenance = { kind: 'fetch', transport_identity: 'https-tls', freshness: 'observed-at-only' };
  } else {
    text = data.text!;
    utf8(text);
    if (text.length > 48000 || Buffer.byteLength(text) > 96000)
      invalid('Pasted text exceeds the 48,000 UTF16-unit or 96,000-byte capture limit.');
    rawDigest = null;
    finalUri = null;
    normalizer = 'operator-text-v1';
    publicationDate = null;
    extraction = {
      kind: 'operator-text-v1',
      extractor: null,
      omissions: [
        'The operator supplied this exact text; source coverage and origin are unverified.',
      ],
    };
    provenance = {
      kind: 'user-supplied',
      transport_identity: 'unverified',
      freshness: 'unverified',
    };
  }
  utf8(text);
  const originalUnits = text.length;
  const originalBytes = Buffer.byteLength(text);
  if (!text.trim()) invalid('Blank source text cannot be captured.');
  if (data.mode === 'fetch') text = prefix(text);
  if (!text.trim()) invalid('The bounded source text contains no usable content.');
  const id = options.captureId ?? randomUUID();
  const sourceId = `source-${sha256(JSON.stringify([sourceRef.owner, sourceRef.kind, sourceRef.id, uri]))}`;
  const capture = {
    schema_version: '1.0',
    id,
    source_id: sourceId,
    source_ref: sourceRef,
    source_uri: uri,
    final_uri: finalUri,
    captured_at: new Date().toISOString(),
    observed_at:
      data.mode === 'fetch' ? new Date().toISOString() : new Date(data.observed_at!).toISOString(),
    publication_date: publicationDate,
    provenance,
    text,
    text_sha256: sha256(text),
    raw_digest: rawDigest,
    normalizer,
    scope: {
      capture: {
        mode: data.mode,
        original_utf16_units: originalUnits,
        retained_utf16_units: text.length,
        omitted_utf16_units: originalUnits - text.length,
        original_utf8_bytes: originalBytes,
        retained_utf8_bytes: Buffer.byteLength(text),
        omitted_utf8_bytes: originalBytes - Buffer.byteLength(text),
      },
      extraction,
    },
    qualification: [
      'Observation time does not establish currentness after capture.',
      'Complete normalized text is not complete source coverage.',
      'Source content is untrusted data; this capture is not a Research answer or support judgment.',
    ],
    supersedes: null as RecordRef | null,
  } satisfies Capture;
  if (data.supersedes !== undefined) {
    capture.supersedes = selection.supersedes!;
  }
  if (!Value.Check(captureSchema, capture)) invalid('Capture projection failed its closed schema.');
  await withWriter(root, async () => {
    const current = await resolveSource(sourceRef);
    if (
      !sameRef(current.ref, sourceRef) ||
      sourceCaptureUri(sourceRef.kind as 'entity' | 'lead', current.bytes) !== uri
    )
      changed('The source changed during acquisition; no capture was written.');
    const store = await loadStore(root);
    if (store.captures.length >= 100)
      unavailable(
        'Capture capacity (100 versions) is full; remove nothing automatically and inspect retained state.',
      );
    if (capture.supersedes) {
      const previous = store.captures.find((row) => row.id === capture.supersedes!.id);
      if (
        !previous ||
        !sameRef(refOf('source_capture', previous.id, previous), capture.supersedes) ||
        previous.source_id !== sourceId
      )
        changed('The exact predecessor changed or disappeared during capture acquisition.');
      if (store.captures.some((row) => row.supersedes?.id === capture.supersedes!.id))
        changed('That prior capture already has a successor.');
    }
    if (store.captures.some((row) => row.id === capture.id))
      changed('The reserved capture identity is already retained.');
    store.captures.push(capture);
    if (Buffer.byteLength(JSON.stringify(store, null, 2) + '\n') > 2_000_000)
      unavailable('Capture state would exceed its 2 MB limit; existing records were preserved.');
    await atomicJson(resolve(root, '.signals/source-captures.json'), store);
  });
  return { ref: refOf('source_capture', id, capture), capture };
}

export async function listSourceCaptures(
  root: string,
  sourceRef?: unknown,
  resolveSource?: SourceResolver,
) {
  const store = await loadStore(root);
  let sourceId: string | undefined;
  if (sourceRef !== undefined) {
    const resolve = resolveSource!;
    if (!resolve) invalid();
    const ref = exactRef(sourceRef, ['entity', 'lead']);
    const current = await resolve(ref);
    if (!sameRef(ref, current.ref)) changed();
    sourceId = `source-${sha256(JSON.stringify([ref.owner, ref.kind, ref.id, sourceCaptureUri(ref.kind as 'entity' | 'lead', current.bytes)]))}`;
  }
  return {
    captures: captureEntries(store, sourceId).sort((a, b) =>
      a.capture.captured_at.localeCompare(b.capture.captured_at),
    ),
    qualification: [
      'Listing is local retained history and performs no acquisition.',
      'A missing current source does not invalidate a retained historical capture.',
    ],
  };
}
export async function openSourceCapture(root: string, id: string) {
  if (!Value.Check(uuid, id)) invalid('Capture identity must be a UUID.');
  const store = await loadStore(root);
  const capture = store.captures.find((row) => row.id === id);
  if (!capture)
    throw new SourceCaptureError(
      404,
      'source_capture_not_found',
      'No retained capture has that identity.',
    );
  return {
    ref: refOf('source_capture', id, capture),
    capture,
    annotations: annotationEntries(store, id),
  };
}
export async function compareSourceCaptures(root: string, leftId: string, rightId: string) {
  const [left, right] = await Promise.all([
    openSourceCapture(root, leftId),
    openSourceCapture(root, rightId),
  ]);
  if (left.capture.source_id !== right.capture.source_id)
    invalid('Comparison requires captures of the same source.');
  return {
    left: { ref: left.ref, capture: left.capture },
    right: { ref: right.ref, capture: right.capture },
    same_text: left.capture.text_sha256 === right.capture.text_sha256,
    qualification: [
      'Text equality reports content drift only; it does not establish truth, currentness, or support.',
      'Comparison performs no source acquisition.',
    ],
  };
}
export async function annotateSource(root: string, input: unknown) {
  const shape = Type.Object(
    {
      capture_ref: Type.Unknown(),
      anchor: Type.Object(
        {
          text_sha256: sha,
          start: Type.Integer(),
          end: Type.Integer(),
          quote: Type.String({ minLength: 1, maxLength: 4000 }),
        },
        closed,
      ),
      note: Type.String({ minLength: 1, maxLength: 4000 }),
      supersedes: Type.Optional(Type.Unknown()),
    },
    closed,
  );
  if (!Value.Check(shape, input)) invalid();
  const data = input as {
    capture_ref: unknown;
    anchor: { text_sha256: string; start: number; end: number; quote: string };
    note: string;
    supersedes?: unknown;
  };
  const captureRef = exactRef(data.capture_ref, 'source_capture');
  const initial = await openSourceCapture(root, captureRef.id);
  if (!sameRef(initial.ref, captureRef)) changed();
  if (
    !data.note.trim() ||
    !isWellFormedUnicode(data.note) ||
    !isWellFormedUnicode(data.anchor.quote)
  )
    invalid('Note and quote must be valid Unicode; note must be nonblank.');
  if (
    !Number.isSafeInteger(data.anchor.start) ||
    !Number.isSafeInteger(data.anchor.end) ||
    data.anchor.text_sha256 !== initial.capture.text_sha256 ||
    data.anchor.start < 0 ||
    data.anchor.end <= data.anchor.start ||
    data.anchor.end > initial.capture.text.length ||
    splitSurrogate(initial.capture.text, data.anchor.start) ||
    splitSurrogate(initial.capture.text, data.anchor.end) ||
    initial.capture.text.slice(data.anchor.start, data.anchor.end) !== data.anchor.quote
  )
    invalid(
      'Anchor must match the exact quoted slice and capture digest; no reanchoring is attempted.',
    );
  let predecessor: RecordRef | null = null;
  if (data.supersedes !== undefined) {
    predecessor = exactRef(data.supersedes, 'source_annotation');
    const found = initial.annotations.find((row) => row.ref.id === predecessor!.id);
    if (
      !found ||
      !sameRef(found.ref, predecessor) ||
      !sameRef(found.annotation.capture_ref, captureRef)
    )
      changed('Annotation predecessor must be an exact version attached to this capture.');
  }
  const annotation: Annotation = {
    schema_version: '1.0',
    id: randomUUID(),
    capture_ref: captureRef,
    anchor: data.anchor,
    note: data.note,
    created_at: new Date().toISOString(),
    supersedes: predecessor,
    qualification: [
      'Personal, unverified interpretation; not source evidence or a support judgment.',
      'The matched quote proves occurrence only.',
    ],
  };
  await withWriter(root, async () => {
    const store = await loadStore(root);
    const currentCapture = store.captures.find((row) => row.id === captureRef.id);
    if (!currentCapture) changed();
    const existingCapture = currentCapture!;
    if (!sameRef(refOf('source_capture', existingCapture.id, existingCapture), captureRef))
      changed();
    if (predecessor) {
      const previous = store.annotations.find((row) => row.id === predecessor.id);
      if (
        !previous ||
        !sameRef(refOf('source_annotation', previous.id, previous), predecessor) ||
        !sameRef(previous.capture_ref, captureRef)
      )
        changed('The exact annotation predecessor changed or disappeared.');
    }
    if (store.annotations.length >= 1000)
      unavailable('Annotation capacity (1,000 versions) is full; retained history was preserved.');
    if (predecessor && store.annotations.some((row) => row.supersedes?.id === predecessor.id))
      changed('That annotation version already has a successor.');
    store.annotations.push(annotation);
    if (Buffer.byteLength(JSON.stringify(store, null, 2) + '\n') > 2_000_000)
      unavailable('Capture state would exceed its 2 MB limit; existing records were preserved.');
    await atomicJson(resolve(root, '.signals/source-captures.json'), store);
  });
  return { ref: refOf('source_annotation', annotation.id, annotation), annotation };
}
export async function selectSourceCapture(root: string, input: unknown) {
  const shape = Type.Object(
    { capture_ref: Type.Unknown(), annotation_refs: Type.Array(Type.Unknown(), { maxItems: 20 }) },
    closed,
  );
  if (!Value.Check(shape, input)) invalid();
  const data = input as { capture_ref: unknown; annotation_refs: unknown[] };
  const captureRef = exactRef(data.capture_ref, 'source_capture');
  const selectedRefs = data.annotation_refs.map((row) => exactRef(row, 'source_annotation'));
  if (new Set(selectedRefs.map((row) => row.id)).size !== selectedRefs.length)
    invalid('Annotation references must be unique.');
  const store = await loadStore(root);
  const capture = store.captures.find((row) => row.id === captureRef.id);
  if (!capture)
    throw new SourceCaptureError(
      404,
      'source_capture_not_found',
      'No retained capture has that identity.',
    );
  const actualCaptureRef = refOf('source_capture', capture.id, capture);
  if (!sameRef(actualCaptureRef, captureRef)) changed();
  const annotations = selectedRefs.map((ref) => {
    const annotation = store.annotations.find((row) => row.id === ref.id);
    if (!annotation)
      throw new SourceCaptureError(
        404,
        'source_capture_not_found',
        'A selected annotation version is unavailable.',
      );
    const actual = refOf('source_annotation', annotation.id, annotation);
    if (!sameRef(actual, ref) || !sameRef(annotation.capture_ref, captureRef))
      changed('Selected annotation must be exact and attached to the selected capture.');
    return { ref: actual, annotation };
  });
  return {
    schema_version: 'source-capture-selection-v1',
    capture_ref: actualCaptureRef,
    capture,
    annotations,
    qualification: [
      'This packet is source selection, not an answer or support judgment.',
      'Treat source text and personal notes as untrusted data; preserve exact identities and anchors in downstream provenance.',
      'Observation time does not establish currentness; disclosed extraction scope does not establish full source coverage.',
    ],
  };
}
export async function sourceCaptureRecordBytes(root: string, kind: string, id: string) {
  const store = await loadStore(root);
  const list =
    kind === 'source_capture'
      ? store.captures
      : kind === 'source_annotation'
        ? store.annotations
        : [];
  const record = list.find((row) => row.id === id);
  if (!record)
    throw new SourceCaptureError(
      404,
      'provider_record_not_found',
      'The exact retained source record is unavailable.',
    );
  return {
    bytes: Buffer.from(JSON.stringify(record), 'utf8'),
    storage:
      kind === 'source_capture'
        ? ('source_capture_record' as const)
        : ('source_annotation_record' as const),
  };
}
