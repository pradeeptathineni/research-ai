import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { FrozenSource } from '@pradeeptathineni/research-ai';
import { Type, type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { openPrivateDocument, PRIVATE_DOCUMENT_INPUT_LIMITS } from './private-documents.js';
import { atomicJson, readPrivateJson, withWriter } from './search-store.js';
import { isWellFormedUnicode, recordRefSchema, type RecordRef } from './source-captures.js';

const closed = { additionalProperties: false };
const uuid = Type.String({ pattern: '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$' });
const sha = Type.String({ pattern: '^[a-f0-9]{64}$' });
const MAX_RECORDS = 50;
const MAX_ANNOTATIONS = 50;
const MAX_STORE_BYTES = 40 * 1024 * 1024;
const annotationSchema = Type.Object(
  {
    id: uuid,
    page: Type.Integer({ minimum: 1, maximum: PRIVATE_DOCUMENT_INPUT_LIMITS.maxPages }),
    start: Type.Integer({ minimum: 0, maximum: PRIVATE_DOCUMENT_INPUT_LIMITS.maxTextUnits }),
    end: Type.Integer({ minimum: 1, maximum: PRIVATE_DOCUMENT_INPUT_LIMITS.maxTextUnits }),
    quote: Type.String({ minLength: 1, maxLength: 4000 }),
    page_sha256: sha,
    note: Type.String({ maxLength: 2000 }),
  },
  closed,
);
const readerSchema = Type.Object(
  {
    id: uuid,
    document_ref: recordRefSchema,
    raw_sha256: sha,
    created_page: Type.Integer({ minimum: 1, maximum: PRIVATE_DOCUMENT_INPUT_LIMITS.maxPages }),
    page: Type.Integer({ minimum: 1, maximum: PRIVATE_DOCUMENT_INPUT_LIMITS.maxPages }),
    annotations: Type.Array(annotationSchema, { maxItems: MAX_ANNOTATIONS }),
    revision: Type.Integer({ minimum: 1 }),
    digest: sha,
    updated_at: Type.String({ format: 'date-time' }),
  },
  closed,
);
type Annotation = Static<typeof annotationSchema>;
type Reader = Static<typeof readerSchema>;
type Store = { schema_version: '1.0'; readers: Reader[] };
const empty = (): Store => ({ schema_version: '1.0', readers: [] });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const digestOf = (reader: Omit<Reader, 'digest'> | Reader) => {
  const projection = { ...reader } as Record<string, unknown>;
  delete projection.digest;
  return hash(JSON.stringify(projection));
};
const sameRef = (a: RecordRef, b: RecordRef) =>
  a.owner === b.owner &&
  a.kind === b.kind &&
  a.id === b.id &&
  a.revision === b.revision &&
  a.digest === b.digest;

export class PrivateReaderError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly reason: string,
  ) {
    super(code);
  }
}
const fail = (status: number, code: string, reason: string): never => {
  throw new PrivateReaderError(status, code, reason);
};
const invalid = (reason: string): never => fail(400, 'invalid_private_reader_request', reason);
const changed = (): never =>
  fail(
    409,
    'private_reader_changed',
    'The saved reader or exact source changed. Reopen it before retrying.',
  );
function validateStore(value: unknown): Store {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as Store).schema_version !== '1.0' ||
    !Array.isArray((value as Store).readers) ||
    (value as Store).readers.length > MAX_RECORDS ||
    !(value as Store).readers.every(
      (row) =>
        Value.Check(readerSchema, row) &&
        row.document_ref.owner === 'signals-ai' &&
        row.document_ref.kind === 'private_document' &&
        row.document_ref.revision === `sha256:${row.document_ref.digest}` &&
        row.digest === digestOf(row) &&
        new Set(row.annotations.map((item) => item.id)).size === row.annotations.length,
    )
  )
    fail(503, 'private_reader_unavailable', 'Private reader state has an invalid shape or digest.');
  return value as Store;
}
async function load(root: string): Promise<Store> {
  const value = await readPrivateJson(root, 'private-reader.json', empty(), MAX_STORE_BYTES);
  const store = validateStore(value);
  if (Buffer.byteLength(JSON.stringify(store, null, 2) + '\n') > MAX_STORE_BYTES)
    fail(503, 'private_reader_unavailable', 'Private reader state exceeds its size limit.');
  return store;
}
async function save(root: string, store: Store) {
  if (Buffer.byteLength(JSON.stringify(store, null, 2) + '\n') > MAX_STORE_BYTES)
    fail(
      409,
      'private_reader_capacity',
      'Private reader storage would exceed its 40 MiB bound; saved state was preserved.',
    );
  await atomicJson(resolve(root, '.signals/private-reader.json'), store);
}
function seal(value: Omit<Reader, 'digest'>): Reader {
  return { ...value, digest: digestOf(value) };
}
function codePointBoundary(text: string, offset: number) {
  return !(
    offset > 0 &&
    offset < text.length &&
    /[\uD800-\uDBFF]/u.test(text[offset - 1]!) &&
    /[\uDC00-\uDFFF]/u.test(text[offset]!)
  );
}
function annotationMatches(
  item: Annotation,
  doc: Awaited<ReturnType<typeof openPrivateDocument>>['document'],
) {
  const page = doc.pages[item.page - 1];
  return Boolean(
    page &&
    item.page_sha256 === page.text_sha256 &&
    isWellFormedUnicode(item.quote) &&
    Boolean(item.quote.trim()) &&
    isWellFormedUnicode(item.note) &&
    item.end > item.start &&
    codePointBoundary(page.text, item.start) &&
    codePointBoundary(page.text, item.end) &&
    page.text.slice(item.start, item.end) === item.quote,
  );
}
function validateAnnotations(
  reader: Reader,
  doc: Awaited<ReturnType<typeof openPrivateDocument>>['document'],
) {
  if (reader.annotations.some((item) => !annotationMatches(item, doc)))
    fail(
      503,
      'private_reader_unavailable',
      'A saved passage no longer matches its exact page offsets.',
    );
}
async function reopen(root: string, reader: Reader) {
  const { ref, document } = await openPrivateDocument(root, reader.document_ref.id);
  if (!sameRef(ref, reader.document_ref) || document.raw_sha256 !== reader.raw_sha256)
    return changed();
  if (!document.pages[reader.page - 1])
    fail(503, 'private_reader_unavailable', 'Saved page is outside the retained source.');
  validateAnnotations(reader, document);
  return { reader, document };
}
function requestShape(schema: TSchema, input: unknown, reason: string) {
  if (!Value.Check(schema, input)) invalid(reason);
}
const createSchema = Type.Object(
  {
    id: uuid,
    document_ref: recordRefSchema,
    raw_sha256: sha,
    page: Type.Integer({ minimum: 1, maximum: PRIVATE_DOCUMENT_INPUT_LIMITS.maxPages }),
  },
  closed,
);
const reviseSchema = Type.Object(
  {
    id: uuid,
    expected_revision: Type.Integer({ minimum: 1 }),
    expected_digest: sha,
    page: Type.Optional(
      Type.Integer({ minimum: 1, maximum: PRIVATE_DOCUMENT_INPUT_LIMITS.maxPages }),
    ),
    add_annotations: Type.Optional(Type.Array(annotationSchema, { maxItems: MAX_ANNOTATIONS })),
    remove_annotation_ids: Type.Optional(
      Type.Array(uuid, { maxItems: MAX_ANNOTATIONS, uniqueItems: true }),
    ),
  },
  closed,
);
const selectionSchema = Type.Object(
  {
    id: uuid,
    expected_revision: Type.Integer({ minimum: 1 }),
    expected_digest: sha,
    annotation_ids: Type.Array(uuid, { minItems: 1, maxItems: 8, uniqueItems: true }),
  },
  closed,
);

/** List only reader IDs and source/page/revision counts. */
export async function listPrivateReaders(root: string) {
  const store = await load(root);
  return {
    readers: store.readers.map(
      ({ id, document_ref, raw_sha256, page, revision, digest, updated_at, annotations }) => ({
        id,
        document_ref,
        raw_sha256,
        page,
        revision,
        digest,
        updated_at,
        annotation_count: annotations.length,
      }),
    ),
  };
}

/** Create idempotently or reopen the same reader ID and source. */
export async function createPrivateReader(root: string, input: unknown) {
  requestShape(createSchema, input, 'Create requires a UUID, exact document ref/hash and page.');
  const data = input as Static<typeof createSchema>;
  if (
    data.document_ref.owner !== 'signals-ai' ||
    data.document_ref.kind !== 'private_document' ||
    data.document_ref.revision !== `sha256:${data.document_ref.digest}`
  )
    invalid('Create requires an exact Signals private-document ref.');
  return withWriter(root, async () => {
    const store = await load(root);
    const existing = store.readers.find((row) => row.id === data.id);
    if (existing) {
      if (
        !sameRef(existing.document_ref, data.document_ref) ||
        existing.raw_sha256 !== data.raw_sha256 ||
        existing.created_page !== data.page
      )
        return changed();
      return reopen(root, existing);
    }
    const source = await openPrivateDocument(root, data.document_ref.id);
    if (!sameRef(source.ref, data.document_ref) || source.document.raw_sha256 !== data.raw_sha256)
      return changed();
    if (!source.document.pages[data.page - 1]) invalid('Requested page is outside this document.');
    if (store.readers.length >= MAX_RECORDS)
      fail(
        409,
        'private_reader_capacity',
        'Private reader capacity (50) is full; retained state was preserved.',
      );
    const now = new Date().toISOString();
    const reader = seal({
      id: data.id,
      document_ref: source.ref,
      raw_sha256: data.raw_sha256,
      created_page: data.page,
      page: data.page,
      annotations: [],
      revision: 1,
      updated_at: now,
    });
    store.readers.push(reader);
    await save(root, store);
    return { reader, document: source.document };
  });
}

/** Reopen a reader only while the original document and all exact passage bindings remain valid. */
export async function openPrivateReader(root: string, id: string) {
  if (!Value.Check(uuid, id)) invalid('Reader identity must be a UUID.');
  const reader = (await load(root)).readers.find((row) => row.id === id);
  if (!reader) return fail(404, 'private_reader_not_found', 'No reader record has that identity.');
  return reopen(root, reader);
}

/** Change page and add/remove immutable annotations with a revision/digest compare-and-swap. */
export async function revisePrivateReader(root: string, input: unknown) {
  requestShape(reviseSchema, input, 'Revision requires the exact current revision and digest.');
  const data = input as Static<typeof reviseSchema>;
  if (
    data.page === undefined &&
    !data.add_annotations?.length &&
    !data.remove_annotation_ids?.length
  )
    invalid('Revision must change the page or add/remove at least one annotation.');
  return withWriter(root, async () => {
    const store = await load(root);
    const index = store.readers.findIndex((row) => row.id === data.id);
    if (index < 0) fail(404, 'private_reader_not_found', 'No reader record has that identity.');
    const current = store.readers[index];
    if (!current)
      throw new PrivateReaderError(
        404,
        'private_reader_not_found',
        'No reader record has that identity.',
      );
    await reopen(root, current);
    if (current.revision !== data.expected_revision || current.digest !== data.expected_digest)
      return changed();
    const { document } = await reopen(root, current);
    const page = data.page ?? current.page;
    if (!document.pages[page - 1]) invalid('Requested page is outside this document.');
    const removed = new Set(data.remove_annotation_ids ?? []);
    if ([...removed].some((id) => !current.annotations.some((item) => item.id === id)))
      invalid('Removal must name retained annotation IDs.');
    const retained = current.annotations.filter((item) => !removed.has(item.id));
    const additions = data.add_annotations ?? [];
    if (retained.length + additions.length > MAX_ANNOTATIONS)
      fail(
        409,
        'private_reader_capacity',
        'Annotation capacity (50) is full; saved reader was preserved.',
      );
    const ids = new Set(current.annotations.map((item) => item.id));
    for (const item of additions) {
      if (ids.has(item.id)) invalid('Annotation IDs must be new and unique.');
      if (!annotationMatches(item, document))
        invalid('Added annotation must match an exact well-formed page range.');
      ids.add(item.id);
    }
    const next: Reader = seal({
      ...current,
      page,
      annotations: [...retained, ...additions],
      revision: current.revision + 1,
      updated_at: new Date().toISOString(),
    });
    store.readers[index] = next;
    await save(root, store);
    return { reader: next, document };
  });
}

/** Freeze only explicit, exact annotation bodies for the existing source-only research path. */
export async function selectPrivateReaderAnnotations(
  root: string,
  input: unknown,
  origin: string,
): Promise<{ sources: FrozenSource[]; manifest: object }> {
  requestShape(
    selectionSchema,
    input,
    'Selection requires a reader CAS identity and 1–8 annotation IDs.',
  );
  if (
    !/^http:\/\/127\.0\.0\.1:(?:[1-9]\d{1,4})$/.test(origin) ||
    Number(origin.split(':').at(-1)) > 65535
  )
    invalid('Selection origin must be the exact validated loopback HTTP origin.');
  const data = input as Static<typeof selectionSchema>;
  const { reader, document } = await openPrivateReader(root, data.id);
  if (reader.revision !== data.expected_revision || reader.digest !== data.expected_digest)
    return changed();
  const chosen = data.annotation_ids.map((id) => {
    const item = reader.annotations.find((row) => row.id === id);
    if (!item) invalid('Selection IDs must name retained annotations.');
    return item!;
  });
  const units = chosen.reduce((sum, item) => sum + item.quote.length, 0);
  if (units > PRIVATE_DOCUMENT_INPUT_LIMITS.maxTextUnits)
    invalid('Selected passages exceed the 256,000 UTF-16-unit source limit.');
  const sources = chosen.map((item) => ({
    uri: `${origin}/signals-ai/__signals/api/private-documents/${reader.document_ref.id}/pages/${item.page}#range=${item.start}-${item.end}&sha256=${item.page_sha256}&annotation=${item.id}`,
    text: item.quote,
    observedAt: document.imported_at,
    omissions: document.qualification.slice(0, 8).map((entry) => entry.slice(0, 500)),
  }));
  return {
    sources,
    manifest: {
      schema_version: '1.0',
      reader_id: reader.id,
      reader_revision: reader.revision,
      reader_digest: reader.digest,
      document_ref: reader.document_ref,
      raw_sha256: reader.raw_sha256,
      selections: chosen.map(({ id, page, start, end, quote, page_sha256 }) => ({
        annotation_id: id,
        page,
        start,
        end,
        quote,
        page_sha256,
      })),
      qualification: [
        'Only explicitly selected user annotations are frozen; Signals makes no truth, authenticity or acceptance claim.',
        'Offsets address extracted pypdf UTF-16 page text and do not identify PDF viewer glyph coordinates.',
        ...document.qualification,
      ].slice(0, 8),
    },
  };
}
