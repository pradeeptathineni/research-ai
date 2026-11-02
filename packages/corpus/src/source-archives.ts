import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { atomicJson, readPrivateJson, withWriter } from './search-store.js';
import {
  createSourceCapture,
  openSourceCapture,
  recordRefSchema,
  SourceCaptureError,
  type RecordRef,
  type SourceCaptureOptions,
  type SourceResolver,
} from './source-captures.js';

const closed = { additionalProperties: false };
const MAX_ARCHIVE_BYTES = 1_000_000;
const MAX_STORE_BYTES = 2_000_000;
const MAX_REQUESTS = 100;
const uuid = Type.String({ pattern: '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$' });
const sha = Type.String({ pattern: '^[a-f0-9]{64}$' });
const sourceRefSchema = Type.Union([
  Type.Object(
    {
      owner: Type.Literal('signals-ai'),
      kind: Type.Union([Type.Literal('entity'), Type.Literal('lead')]),
      id: Type.String({ minLength: 1, maxLength: 200 }),
      revision: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
      digest: sha,
    },
    closed,
  ),
  Type.Object(
    {
      owner: Type.Literal('signals-ai'),
      kind: Type.Literal('briefing-item'),
      id: Type.String({ minLength: 1, maxLength: 160, pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$' }),
      revision: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
    },
    closed,
  ),
  Type.Object(
    {
      owner: Type.Literal('signals-ai'),
      kind: Type.Literal('briefing-item'),
      id: Type.String({ minLength: 1, maxLength: 160, pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$' }),
      revision: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
      digest: sha,
    },
    closed,
  ),
]);
const predecessorRefSchema = Type.Object(
  {
    owner: Type.Literal('signals-ai'),
    kind: Type.Literal('source_capture'),
    id: uuid,
    revision: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
    digest: sha,
  },
  closed,
);
const archiveRequestSchema = Type.Object(
  {
    request_id: uuid,
    capture_request: Type.Object(
      {
        source_ref: sourceRefSchema,
        mode: Type.Literal('fetch'),
        supersedes: Type.Optional(predecessorRefSchema),
      },
      closed,
    ),
  },
  closed,
);
type ArchiveRequest = Static<typeof archiveRequestSchema>;

const manifestSchema = Type.Object(
  {
    schema_version: Type.Literal('source-archive-v1'),
    capture_ref: recordRefSchema,
    raw_digest: sha,
    sha256: sha,
    byte_count: Type.Integer({ minimum: 1, maximum: MAX_ARCHIVE_BYTES }),
  },
  closed,
);
export type SourceArchiveManifest = Static<typeof manifestSchema>;
type ArchiveManifest = SourceArchiveManifest;
const requestRowSchema = Type.Object(
  {
    request_id: uuid,
    request_digest: sha,
    state: Type.Enum(['pending', 'archived', 'capture-created-archive-unavailable', 'not-created']),
    created_at: Type.String({ format: 'date-time' }),
    capture_ref: Type.Union([recordRefSchema, Type.Null()]),
    raw_digest: Type.Union([sha, Type.Null()]),
    manifest: Type.Union([manifestSchema, Type.Null()]),
    archive_ref: Type.Union([recordRefSchema, Type.Null()]),
    bytes_base64: Type.Union([
      Type.String({ maxLength: Math.ceil((MAX_ARCHIVE_BYTES + 2) / 3) * 4 }),
      Type.Null(),
    ]),
    reason: Type.Union([Type.String({ maxLength: 1000 }), Type.Null()]),
  },
  closed,
);
const storeSchema = Type.Object(
  {
    schema_version: Type.Literal('source-archive-store-v1'),
    requests: Type.Array(requestRowSchema, { maxItems: MAX_REQUESTS }),
  },
  closed,
);
type RequestRow = Static<typeof requestRowSchema>;
type Store = Static<typeof storeSchema>;

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
const requestDigest = (request: ArchiveRequest) =>
  sha256(
    canonical({
      request_id: request.request_id,
      capture_request: {
        source_ref:
          normalizedRecordRef(request.capture_request.source_ref) ??
          request.capture_request.source_ref,
        mode: 'fetch',
        ...(request.capture_request.supersedes !== undefined
          ? { supersedes: request.capture_request.supersedes }
          : {}),
      },
    }),
  );
const archiveRef = (manifest: ArchiveManifest): RecordRef => {
  const digest = sha256(JSON.stringify(manifest));
  return {
    owner: 'signals-ai',
    kind: 'source-archive',
    id: manifest.capture_ref.id,
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
function normalizedRecordRef(value: unknown): RecordRef | null {
  if (Value.Check(recordRefSchema, value)) return value;
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).owner === 'signals-ai' &&
    (value as Record<string, unknown>).kind === 'briefing-item' &&
    typeof (value as Record<string, unknown>).id === 'string' &&
    typeof (value as Record<string, unknown>).revision === 'string'
  ) {
    const row = value as Record<string, unknown>;
    const revision = row.revision as string;
    const digest = typeof row.digest === 'string' ? row.digest : revision.slice('sha256:'.length);
    const normalized = { owner: 'signals-ai', kind: 'briefing-item', id: row.id, revision, digest };
    return Value.Check(recordRefSchema, normalized) ? normalized : null;
  }
  return null;
}
function isRequestCapture(
  capture: Awaited<ReturnType<typeof openSourceCapture>>['capture'],
  request: ArchiveRequest,
): boolean {
  const source = normalizedRecordRef(request.capture_request.source_ref);
  const predecessor = request.capture_request.supersedes;
  const expectedPredecessor = predecessor === undefined ? null : normalizedRecordRef(predecessor);
  return Boolean(
    source &&
    sameRef(capture.source_ref, source) &&
    ((predecessor === undefined && capture.supersedes === null) ||
      (expectedPredecessor &&
        capture.supersedes &&
        sameRef(capture.supersedes, expectedPredecessor))) &&
    capture.provenance.kind === 'fetch',
  );
}
function digestFromCapture(capture: Awaited<ReturnType<typeof openSourceCapture>>['capture']) {
  if (!Value.Check(sourceRefSchema, capture.source_ref))
    fail(
      503,
      'source_archive_unavailable',
      'Stored source capture has an unsupported exact source ref.',
    );
  const predecessor = capture.supersedes;
  if (predecessor && predecessor.kind !== 'source_capture')
    fail(
      503,
      'source_archive_unavailable',
      'Stored capture predecessor is not an exact source capture.',
    );
  return requestDigest({
    request_id: capture.id,
    capture_request: {
      source_ref: capture.source_ref as ArchiveRequest['capture_request']['source_ref'],
      mode: 'fetch',
      ...(predecessor
        ? {
            supersedes: {
              owner: 'signals-ai',
              kind: 'source_capture',
              id: predecessor.id,
              revision: predecessor.revision,
              digest: predecessor.digest,
            },
          }
        : {}),
    },
  });
}
const emptyStore = (): Store => ({ schema_version: 'source-archive-store-v1', requests: [] });
const archiveQualifications = [
  'Archive contains only response-body bytes surfaced by the existing guarded fetch; transfer/content decoding may already have occurred. It is not a full HTTP or TLS wire archive and omits headers, cookies, and redirect-chain bodies.',
  'Archived body bytes are opaque data. They are never executed or served as HTML.',
];

export class SourceArchiveError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly reason: string,
  ) {
    super(code);
  }
}
export type SourceArchiveCaptureOptions = Pick<
  SourceCaptureOptions,
  'fetcher' | 'readBriefingContext'
>;
export type SourceArchiveRequestState =
  'archived' | 'capture-created-archive-unavailable' | 'not-created' | 'unknown';
export type SourceArchiveRequestReceipt = {
  schema_version: 'source-archive-request-v1';
  request_id: string;
  state: SourceArchiveRequestState;
  capture_ref: RecordRef | null;
  raw_digest: string | null;
  archive_ref: RecordRef | null;
  reason: string | null;
  replayed: boolean;
  qualification: string[];
};
export type SourceArchiveReadResult =
  | {
      schema_version: 'source-archive-v1';
      state: 'available';
      capture_ref: RecordRef;
      raw_digest: string;
      archive_ref: RecordRef;
      byte_count: number;
      sha256: string;
      bytes_base64: string;
      reason: null;
      qualification: string[];
    }
  | {
      schema_version: 'source-archive-v1';
      state: 'unavailable';
      capture_ref: RecordRef;
      raw_digest: string | null;
      archive_ref: null;
      byte_count: null;
      sha256: null;
      reason: string;
      qualification: string[];
    };
const fail = (status: number, code: string, reason: string): never => {
  throw new SourceArchiveError(status, code, reason);
};
const invalid = (reason: string): never => fail(400, 'invalid_source_archive_request', reason);
const conflict = (reason: string): never => fail(409, 'source_archive_conflict', reason);

async function loadStore(root: string): Promise<Store> {
  const value = await readPrivateJson(root, 'source-archives.json', emptyStore(), MAX_STORE_BYTES);
  if (!Value.Check(storeSchema, value))
    fail(503, 'source_archive_unavailable', 'Private source-archive state is malformed.');
  const store = value as Store;
  if (
    new Set(store.requests.map((row) => row.request_id)).size !== store.requests.length ||
    store.requests.some((row) => {
      if (
        row.capture_ref &&
        (row.capture_ref.kind !== 'source_capture' ||
          row.capture_ref.id !== row.request_id ||
          row.capture_ref.revision !== `sha256:${row.capture_ref.digest}`)
      )
        return true;
      if (row.state === 'archived') {
        if (
          !row.capture_ref ||
          !row.raw_digest ||
          !row.manifest ||
          !row.archive_ref ||
          !row.bytes_base64 ||
          row.manifest.raw_digest !== row.raw_digest ||
          row.manifest.sha256 !== row.manifest.raw_digest ||
          !sameRef(row.manifest.capture_ref, row.capture_ref) ||
          !sameRef(row.archive_ref, archiveRef(row.manifest))
        )
          return true;
        const bytes = Buffer.from(row.bytes_base64, 'base64');
        return (
          bytes.length !== row.manifest.byte_count ||
          bytes.toString('base64') !== row.bytes_base64 ||
          sha256(bytes) !== row.manifest.sha256
        );
      }
      return (
        Boolean(row.manifest || row.archive_ref || row.bytes_base64) ||
        (!row.capture_ref && row.raw_digest !== null)
      );
    })
  )
    fail(
      503,
      'source_archive_unavailable',
      'Private source-archive state failed integrity checks.',
    );
  return store;
}

async function saveStore(root: string, store: Store): Promise<void> {
  const json = `${JSON.stringify(store, null, 2)}\n`;
  if (Buffer.byteLength(json) > MAX_STORE_BYTES)
    fail(
      413,
      'source_archive_store_limit',
      'Private archive capacity is full; no prior archive was removed.',
    );
  await atomicJson(resolve(root, '.signals/source-archives.json'), store);
}

function receipt(row: RequestRow, replayed: boolean): SourceArchiveRequestReceipt {
  const state = row.state === 'pending' ? 'unknown' : row.state;
  return {
    schema_version: 'source-archive-request-v1' as const,
    request_id: row.request_id,
    state,
    capture_ref: row.capture_ref,
    raw_digest: row.raw_digest,
    archive_ref: row.archive_ref,
    reason:
      row.state === 'pending'
        ? 'The admitted request has no confirmed durable result. Read this request ID and its exact capture; no retry or refetch was made.'
        : row.reason,
    replayed,
    qualification: [...archiveQualifications],
  };
}

async function updateRequest(root: string, requestId: string, update: (row: RequestRow) => void) {
  return withWriter(root, async () => {
    const store = await loadStore(root);
    const row = store.requests.find((candidate) => candidate.request_id === requestId);
    if (!row)
      return fail(404, 'source_archive_request_not_found', 'No archive request has that UUID.');
    update(row);
    await saveStore(root, store);
    return row;
  });
}

export async function readSourceArchiveRequest(
  root: string,
  requestId: string,
): Promise<SourceArchiveRequestReceipt> {
  if (!Value.Check(uuid, requestId)) invalid('Archive request identity must be a UUID.');
  const row = (await loadStore(root)).requests.find((item) => item.request_id === requestId);
  if (!row)
    return fail(404, 'source_archive_request_not_found', 'No archive request has that UUID.');
  if (row.state !== 'pending') return receipt(row, true);

  let captureRef: RecordRef | null = null;
  let rawDigest: string | null = null;
  try {
    const opened = await openSourceCapture(root, requestId);
    if (
      opened.capture.provenance.kind === 'fetch' &&
      digestFromCapture(opened.capture) === row.request_digest
    ) {
      captureRef = opened.ref;
      rawDigest = opened.capture.raw_digest;
    }
  } catch {
    // A durable pending request can have stopped before or during acquisition.
  }
  return {
    ...receipt({ ...row, capture_ref: captureRef, raw_digest: rawDigest }, true),
    state: 'unknown' as const,
    reason: captureRef
      ? 'The exact source capture exists, but no durable archive receipt is recorded. Read its archive by exact capture ref; no refetch was made.'
      : 'The request remains unresolved and no exact capture was found. No refetch was made.',
  };
}

export async function createSourceArchive(
  root: string,
  input: unknown,
  resolveSource: SourceResolver,
  options: SourceArchiveCaptureOptions = {},
): Promise<SourceArchiveRequestReceipt> {
  if (!Value.Check(archiveRequestSchema, input))
    invalid('Supply a closed request UUID and the existing exact fetch-capture request.');
  const request = input as ArchiveRequest;
  const meaning = requestDigest(request);
  const reserved = await withWriter(root, async () => {
    const store = await loadStore(root);
    const existing = store.requests.find((row) => row.request_id === request.request_id);
    if (existing) {
      if (existing.request_digest !== meaning)
        conflict('This request UUID already names a different exact capture selection.');
      return { created: false as const, row: existing };
    }
    let existingCapture: Awaited<ReturnType<typeof openSourceCapture>> | null = null;
    try {
      existingCapture = await openSourceCapture(root, request.request_id);
    } catch (error) {
      if (!(error instanceof SourceCaptureError) || error.status !== 404)
        fail(
          503,
          'source_archive_unavailable',
          'Existing capture identity could not be checked safely.',
        );
    }
    if (existingCapture)
      conflict('Request UUID already belongs to a retained capture; no fetch was made.');
    if (store.requests.length >= MAX_REQUESTS)
      fail(
        413,
        'source_archive_store_limit',
        'Archive request capacity is full; no history was removed.',
      );
    const row: RequestRow = {
      request_id: request.request_id,
      request_digest: meaning,
      state: 'pending',
      created_at: new Date().toISOString(),
      capture_ref: null,
      raw_digest: null,
      manifest: null,
      archive_ref: null,
      bytes_base64: null,
      reason: null,
    };
    store.requests.push(row);
    await saveStore(root, store);
    return { created: true as const, row };
  });
  if (!reserved.created) return readSourceArchiveRequest(root, request.request_id);

  const fetchedBody: { bytes: Buffer | null } = { bytes: null };
  let unavailableReason: string | null = null;
  let capture: Awaited<ReturnType<typeof createSourceCapture>>;
  try {
    capture = await createSourceCapture(root, request.capture_request, resolveSource, {
      ...options,
      captureId: request.request_id,
      includeBytes: true,
      beforeRetain: (fetched) => {
        if (!fetched.bytes?.length) {
          unavailableReason = 'The existing fetch returned no original body bytes.';
          return Promise.resolve();
        }
        if (fetched.bytes.length > MAX_ARCHIVE_BYTES) {
          unavailableReason = 'The original body exceeds the 1,000,000-byte archive limit.';
          return Promise.resolve();
        }
        if (sha256(fetched.bytes) !== fetched.digest) {
          unavailableReason = 'Raw body bytes do not match the existing fetch raw digest.';
          return Promise.resolve();
        }
        fetchedBody.bytes = Buffer.from(fetched.bytes);
        return Promise.resolve();
      },
    });
  } catch (error) {
    let found: Awaited<ReturnType<typeof openSourceCapture>> | null = null;
    try {
      found = await openSourceCapture(root, request.request_id);
    } catch {
      // The reserved request ID remains available for readback.
    }
    if (found && isRequestCapture(found.capture, request)) {
      const row = await updateRequest(root, request.request_id, (current) => {
        current.state = 'capture-created-archive-unavailable';
        current.capture_ref = found.ref;
        current.raw_digest = found.capture.raw_digest;
        current.reason =
          'The capture was retained, but archive creation did not complete. No refetch was made.';
      }).catch(() => null);
      return row
        ? receipt(row, false)
        : receipt(
            {
              ...reserved.row,
              state: 'pending',
              capture_ref: found.ref,
              raw_digest: found.capture.raw_digest,
            },
            false,
          );
    }
    const row = await updateRequest(root, request.request_id, (current) => {
      current.state = 'not-created';
      current.reason = found
        ? 'The reserved capture UUID belongs to a different exact capture request; no archive was attached.'
        : error instanceof SourceCaptureError
          ? error.reason
          : 'Capture creation failed before an exact capture was confirmed.';
    }).catch(() => null);
    if (row && error instanceof SourceCaptureError) throw error;
    return row ? receipt(row, false) : receipt({ ...reserved.row, state: 'pending' }, false);
  }

  const captureRef = capture.ref;
  const rawDigest = capture.capture.raw_digest;
  const rawBytes = fetchedBody.bytes;
  if (!rawBytes || !rawDigest || unavailableReason) {
    const row = await updateRequest(root, request.request_id, (current) => {
      current.state = 'capture-created-archive-unavailable';
      current.capture_ref = captureRef;
      current.raw_digest = rawDigest;
      current.reason =
        unavailableReason ?? 'The retained capture has no archiveable exact raw body digest.';
    }).catch(() => null);
    return row
      ? receipt(row, false)
      : receipt(
          {
            ...reserved.row,
            state: 'pending',
            capture_ref: captureRef,
            raw_digest: rawDigest,
            reason:
              'Capture is retained; archive receipt persistence is uncertain. Read by request and capture IDs; do not refetch.',
          },
          false,
        );
  }

  const manifest: ArchiveManifest = {
    schema_version: 'source-archive-v1',
    capture_ref: captureRef,
    raw_digest: rawDigest,
    sha256: sha256(rawBytes),
    byte_count: rawBytes.length,
  };
  const archive = archiveRef(manifest);
  try {
    const row = await updateRequest(root, request.request_id, (current) => {
      if (current.request_digest !== meaning)
        conflict('Reserved archive request identity changed during capture.');
      current.state = 'archived';
      current.capture_ref = captureRef;
      current.raw_digest = rawDigest;
      current.manifest = manifest;
      current.archive_ref = archive;
      current.bytes_base64 = rawBytes.toString('base64');
      current.reason = null;
    });
    return receipt(row, false);
  } catch (error) {
    const row = await updateRequest(root, request.request_id, (current) => {
      current.state = 'capture-created-archive-unavailable';
      current.capture_ref = captureRef;
      current.raw_digest = rawDigest;
      current.reason =
        error instanceof SourceArchiveError && error.code === 'source_archive_store_limit'
          ? 'The capture is retained, but the 2,000,000-byte private archive store is full; no prior archive was removed.'
          : 'The capture is retained, but private archive storage could not confirm the attachment. No refetch was made.';
    }).catch(() => null);
    return row
      ? receipt(row, false)
      : receipt(
          {
            ...reserved.row,
            state: 'pending',
            capture_ref: captureRef,
            raw_digest: rawDigest,
            reason:
              'Capture is retained; archive storage is unresolved. Read by request and capture IDs; do not refetch.',
          },
          false,
        );
  }
}

export async function readSourceArchive(
  root: string,
  captureRefValue: unknown,
): Promise<SourceArchiveReadResult> {
  if (!Value.Check(recordRefSchema, captureRefValue))
    invalid('Supply the complete exact source-capture RecordRef.');
  const captureRef = captureRefValue as RecordRef;
  if (captureRef.kind !== 'source_capture' || captureRef.revision !== `sha256:${captureRef.digest}`)
    invalid('Raw archive read requires an exact source-capture ref.');
  const capture = await openSourceCapture(root, captureRef.id);
  if (!sameRef(capture.ref, captureRef))
    fail(409, 'source_archive_capture_changed', 'The selected exact source capture changed.');
  const row = (await loadStore(root)).requests.find(
    (candidate) => candidate.request_id === captureRef.id && candidate.state === 'archived',
  );
  if (!row)
    return {
      schema_version: 'source-archive-v1' as const,
      state: 'unavailable' as const,
      capture_ref: captureRef,
      raw_digest: capture.capture.raw_digest,
      archive_ref: null,
      byte_count: null,
      sha256: null,
      reason:
        'No exact raw-response archive is retained for this capture; no bytes were fabricated.',
      qualification: [...archiveQualifications],
    };
  if (
    row.manifest === null ||
    row.archive_ref === null ||
    row.bytes_base64 === null ||
    row.capture_ref === null ||
    !sameRef(row.capture_ref, captureRef) ||
    row.raw_digest !== capture.capture.raw_digest ||
    !sameRef(row.manifest.capture_ref, captureRef) ||
    row.manifest.raw_digest !== capture.capture.raw_digest ||
    row.manifest.sha256 !== capture.capture.raw_digest ||
    capture.capture.provenance.kind !== 'fetch' ||
    row.request_digest !== digestFromCapture(capture.capture) ||
    !sameRef(row.archive_ref, archiveRef(row.manifest))
  )
    return fail(
      503,
      'source_archive_integrity_failed',
      'Archive manifest does not match the exact capture raw digest.',
    );
  const bytes = Buffer.from(row.bytes_base64, 'base64');
  if (
    bytes.length !== row.manifest.byte_count ||
    bytes.length > MAX_ARCHIVE_BYTES ||
    bytes.toString('base64') !== row.bytes_base64 ||
    sha256(bytes) !== row.manifest.sha256 ||
    row.manifest.sha256 !== row.manifest.raw_digest
  )
    fail(
      503,
      'source_archive_integrity_failed',
      'Exact raw archive failed byte-count or digest verification.',
    );
  return {
    schema_version: 'source-archive-v1' as const,
    state: 'available' as const,
    capture_ref: captureRef,
    raw_digest: row.manifest.raw_digest,
    archive_ref: row.archive_ref,
    byte_count: bytes.length,
    sha256: row.manifest.sha256,
    bytes_base64: row.bytes_base64,
    reason: null,
    qualification: [...archiveQualifications],
  };
}
