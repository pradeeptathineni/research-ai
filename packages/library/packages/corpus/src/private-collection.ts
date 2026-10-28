import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { FrozenSource } from '@pradeeptathineni/research-ai';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { bm25Scores } from './passage-rank.js';
import { openPrivateDocument } from './private-documents.js';
import { atomicJson, readPrivateJson, withWriter } from './search-store.js';
import { isWellFormedUnicode, recordRefSchema, type RecordRef } from './source-captures.js';

const closed = { additionalProperties: false };
const uuid = Type.String({ pattern: '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$' });
const sha = Type.String({ pattern: '^[a-f0-9]{64}$' });
const previewInput = Type.Object(
  {
    id: uuid,
    query: Type.String({ minLength: 1, maxLength: 2000 }),
    document_refs: Type.Array(recordRefSchema, { minItems: 1, maxItems: 20 }),
    max_candidates: Type.Optional(Type.Integer({ minimum: 1, maximum: 24 })),
  },
  closed,
);
const selectionInput = Type.Object(
  {
    query_id: uuid,
    preview_digest: sha,
    candidate_ids: Type.Array(sha, { minItems: 1, maxItems: 8, uniqueItems: true }),
  },
  closed,
);
const MAX_STORE_BYTES = 10 * 1024 * 1024;
const MAX_QUERIES = 50;
const WINDOW = 1000;
const STRIDE = 800;
const MAX_PASSAGES = 2500;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const jsonDigest = (value: unknown) => digest(JSON.stringify(value));
const sameRef = (left: RecordRef, right: RecordRef) =>
  left.owner === right.owner &&
  left.kind === right.kind &&
  left.id === right.id &&
  left.revision === right.revision &&
  left.digest === right.digest;

export class PrivateCollectionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly reason: string,
  ) {
    super(code);
  }
}
const fail = (status: number, code: string, reason: string): never => {
  throw new PrivateCollectionError(status, code, reason);
};
const invalid = (reason: string): never => fail(400, 'invalid_private_collection_request', reason);
const changed = (): never =>
  fail(
    409,
    'private_collection_changed',
    'The exact preview or source has changed. Reopen and inspect it again.',
  );
type Candidate = {
  id: string;
  document_ref: RecordRef;
  name: string;
  imported_at: string;
  page: number;
  page_sha256: string;
  start: number;
  end: number;
  quote: string;
  score: number;
  qualification: string[];
};
type Preview = {
  id: string;
  meaning: { query: string; document_refs: RecordRef[]; max_candidates: number };
  preview_digest: string;
  state: 'matched' | 'no_match';
  candidates: Candidate[];
  created_at: string;
};
type Store = { schema_version: '1.0'; previews: Preview[] };
const empty = (): Store => ({ schema_version: '1.0', previews: [] });
async function load(root: string): Promise<Store> {
  const value = await readPrivateJson(root, 'private-collection.json', empty(), MAX_STORE_BYTES);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(503, 'private_collection_unavailable', 'Private collection state is invalid.');
  const store = value as Store;
  if (
    store.schema_version !== '1.0' ||
    !Array.isArray(store.previews) ||
    store.previews.length > MAX_QUERIES ||
    store.previews.some(
      (row) =>
        !row ||
        typeof row !== 'object' ||
        typeof row.id !== 'string' ||
        !Array.isArray(row.candidates) ||
        row.preview_digest !==
          jsonDigest({
            id: row.id,
            meaning: row.meaning,
            state: row.state,
            candidates: row.candidates,
            created_at: row.created_at,
          }),
    )
  )
    fail(
      503,
      'private_collection_unavailable',
      'Private collection state has an unsupported shape.',
    );
  return store;
}
function makeWindows(
  text: string,
  ref: RecordRef,
  doc: Awaited<ReturnType<typeof openPrivateDocument>>['document'],
  page: number,
) {
  const result: Omit<Candidate, 'score'>[] = [];
  const source = doc.pages[page - 1]!;
  for (let cursor = 0; cursor < text.length; cursor += STRIDE) {
    let start = cursor;
    let end = Math.min(text.length, cursor + WINDOW);
    if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start]!)) start--;
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end++;
    while (end > start && /\s/u.test(text[end - 1]!)) end--;
    while (start < end && /\s/u.test(text[start]!)) start++;
    const quote = text.slice(start, end);
    if (quote.trim()) {
      const id = jsonDigest([ref.digest, page, source.text_sha256, start, end]);
      result.push({
        id,
        document_ref: ref,
        name: doc.name,
        imported_at: doc.imported_at,
        page,
        page_sha256: source.text_sha256,
        start,
        end,
        quote,
        qualification: doc.qualification,
      });
    }
    if (end >= text.length) break;
  }
  return result;
}
/** Search every page of the explicitly named, integrity-bound private documents. */
export async function previewPrivateCollection(root: string, input: unknown) {
  if (!Value.Check(previewInput, input))
    invalid(
      'Preview requires an ID, query, 1–20 exact document refs and optional candidate limit.',
    );
  const request = input as {
    id: string;
    query: string;
    document_refs: RecordRef[];
    max_candidates?: number;
  };
  if (!isWellFormedUnicode(request.query) || !request.query.trim())
    invalid('Query must be nonempty well-formed Unicode.');
  if (
    request.document_refs.some(
      (ref) =>
        ref.kind !== 'private_document' ||
        ref.owner !== 'signals-ai' ||
        ref.revision !== `sha256:${ref.digest}`,
    ) ||
    new Set(request.document_refs.map((ref) => ref.id)).size !== request.document_refs.length
  )
    invalid('Document refs must be unique exact Signals private_document references.');
  const meaning = {
    query: request.query.trim(),
    document_refs: request.document_refs.map(({ owner, kind, id, revision, digest: hash }) => ({
      owner,
      kind,
      id,
      revision,
      digest: hash,
    })),
    max_candidates: request.max_candidates ?? 12,
  };
  return withWriter(root, async () => {
    const store = await load(root);
    const previous = store.previews.find((row) => row.id === request.id);
    if (previous && JSON.stringify(previous.meaning) !== JSON.stringify(meaning))
      fail(
        409,
        'private_collection_conflict',
        'This query ID is already bound to different query meaning.',
      );
    const docs = await Promise.all(
      meaning.document_refs.map(async (ref) => {
        const opened = await openPrivateDocument(root, ref.id);
        if (!sameRef(opened.ref, ref)) return changed();
        return { ref, document: opened.document };
      }),
    );
    if (previous) {
      await validatePreviewSources(
        root,
        previous,
        docs.map(({ ref }) => ref),
      );
      return previous;
    }
    const passages = docs.flatMap(({ ref, document }) =>
      document.pages.flatMap((page) => makeWindows(page.text, ref, document, page.number)),
    );
    if (passages.length > MAX_PASSAGES)
      fail(
        503,
        'private_collection_capacity',
        'The bounded complete-page passage limit was exceeded; no pages were silently skipped.',
      );
    const scores = bm25Scores(
      meaning.query,
      passages.map((row) => row.quote),
    );
    const ranked = passages
      .map((row, i) => ({ ...row, score: scores[i]! }))
      .filter((row) => row.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.document_ref.id.localeCompare(b.document_ref.id) ||
          a.page - b.page ||
          a.start - b.start,
      )
      .slice(0, meaning.max_candidates);
    const core = {
      id: request.id,
      meaning,
      state: ranked.length ? ('matched' as const) : ('no_match' as const),
      candidates: ranked,
      created_at: new Date().toISOString(),
    };
    const preview: Preview = { ...core, preview_digest: jsonDigest(core) };
    store.previews.push(preview);
    if (store.previews.length > MAX_QUERIES)
      fail(
        503,
        'private_collection_capacity',
        'The 50-preview collection is full; retained history was preserved.',
      );
    if (Buffer.byteLength(JSON.stringify(store)) > MAX_STORE_BYTES)
      fail(
        503,
        'private_collection_capacity',
        'Collection preview capacity would exceed 10 MiB; existing history was preserved.',
      );
    await atomicJson(resolve(root, '.signals/private-collection.json'), store);
    return preview;
  });
}
async function validatePreviewSources(
  root: string,
  preview: Preview,
  expectedRefs = preview.meaning.document_refs,
) {
  const unique = new Map(expectedRefs.map((ref) => [ref.id, ref]));
  for (const ref of unique.values()) {
    const opened = await openPrivateDocument(root, ref.id);
    if (!sameRef(opened.ref, ref)) return changed();
    for (const candidate of preview.candidates.filter((row) => row.document_ref.id === ref.id)) {
      const page = opened.document.pages[candidate.page - 1];
      if (
        !page ||
        page.text_sha256 !== candidate.page_sha256 ||
        page.text.slice(candidate.start, candidate.end) !== candidate.quote ||
        candidate.id !==
          jsonDigest([ref.digest, candidate.page, page.text_sha256, candidate.start, candidate.end])
      )
        return changed();
    }
  }
}
export async function listPrivateCollection(root: string) {
  const store = await load(root);
  return {
    previews: store.previews.map(
      ({ id, meaning, preview_digest, state, candidates, created_at }) => ({
        id,
        meaning,
        preview_digest,
        state,
        candidate_count: candidates.length,
        created_at,
      }),
    ),
  };
}
export async function openPrivateCollection(root: string, id: string): Promise<Preview> {
  if (!Value.Check(uuid, id)) invalid('Query identity must be a UUID.');
  const preview = (await load(root)).previews.find((row) => row.id === id);
  if (!preview)
    return fail(404, 'private_collection_not_found', 'No retained preview has that identity.');
  await validatePreviewSources(root, preview);
  return preview;
}
/** Freeze only user-selected ranked passages for the existing Research boundary. */
export async function selectPrivateCollection(root: string, input: unknown, origin: string) {
  if (!Value.Check(selectionInput, input))
    invalid('Selection requires query ID, preview digest and 1–8 unique candidate IDs.');
  if (
    !/^http:\/\/127\.0\.0\.1:(?:[1-9]\d{1,4})$/.test(origin) ||
    Number(origin.split(':').at(-1)) > 65535
  )
    invalid('Origin must be the validated Signals loopback HTTP origin.');
  const request = input as { query_id: string; preview_digest: string; candidate_ids: string[] };
  const preview = await openPrivateCollection(root, request.query_id);
  if (preview.preview_digest !== request.preview_digest) return changed();
  const selected = request.candidate_ids.map(
    (id) =>
      preview.candidates.find((candidate) => candidate.id === id) ??
      invalid('Every selected candidate must belong to this exact preview.'),
  );
  if (selected.reduce((sum, row) => sum + row.quote.length, 0) > 48000)
    invalid('Selected text exceeds Research 48,000 UTF16-unit limit; nothing was truncated.');
  const sources: FrozenSource[] = selected.map((row) => ({
    uri: `${origin}/signals-ai/__signals/api/private-documents/${row.document_ref.id}/pages/${row.page}#range=${row.start}-${row.end}&sha256=${row.page_sha256}`,
    text: row.quote,
    observedAt: row.imported_at,
    omissions: [
      ...row.qualification,
      'Only this exact selected passage is included; text outside selected ranked passages is omitted.',
    ],
  }));
  return {
    sources,
    manifest: selected.map((row, index) => ({
      source_index: index,
      document_ref: row.document_ref,
      name: row.name,
      imported_at: row.imported_at,
      page: row.page,
      page_sha256: row.page_sha256,
      start: row.start,
      end: row.end,
      quote_sha256: digest(row.quote),
      qualification: row.qualification,
    })),
    qualification: [
      'Lexical relevance only; ranking does not establish factual support.',
      'Private citation route is loopback-only and is not public verification.',
      'Imported time is an observation time, not a publication date.',
      'Only selected passages are frozen; omitted document and ranking scope may contain relevant contrary material.',
    ],
  };
}
