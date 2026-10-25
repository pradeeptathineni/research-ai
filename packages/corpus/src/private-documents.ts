import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { lstat, open, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import type { FrozenSource } from '@pradeeptathineni/research-ai';
import { extractHtml } from './search-document.js';
import { atomicJson, withWriter } from './search-store.js';
import { isWellFormedUnicode, recordRefSchema, type RecordRef } from './source-captures.js';

const closed = { additionalProperties: false };
const sha = Type.String({ pattern: '^[a-f0-9]{64}$' });
const uuid = Type.String({ pattern: '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$' });
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_UNITS = 256_000;
const MAX_TEXT_BYTES = 768_000;
const MAX_PAGES = 256;
const MAX_OUTLINE_NODES = 200;
const MAX_OUTLINE_DEPTH = 16;
const MAX_OUTLINE_TITLE = 300;
const MAX_DOCUMENTS = 20;
const MAX_TOTAL_RAW_BYTES = 12 * 1024 * 1024;
const MAX_STORE_BYTES = 20 * 1024 * 1024;
export const PRIVATE_DOCUMENT_INPUT_LIMITS = Object.freeze({
  maxPages: MAX_PAGES,
  maxTextUnits: MAX_TEXT_UNITS,
  maxTextBytes: MAX_TEXT_BYTES,
});
const pageSchema = Type.Object(
  {
    number: Type.Integer({ minimum: 1, maximum: MAX_PAGES }),
    text: Type.String({ maxLength: MAX_TEXT_UNITS }),
    text_sha256: sha,
  },
  closed,
);
const documentSchema = Type.Object(
  {
    schema_version: Type.Literal('1.0'),
    id: uuid,
    name: Type.String({ minLength: 1, maxLength: 160 }),
    media_type: Type.Enum(['application/pdf', 'text/markdown', 'text/html', 'text/plain']),
    imported_at: Type.String({ format: 'date-time' }),
    raw_base64: Type.String({ minLength: 4, maxLength: Math.ceil(MAX_FILE_BYTES / 3) * 4 }),
    raw_sha256: sha,
    record_sha256: sha,
    extractor: Type.String({ minLength: 1, maxLength: 100 }),
    pages: Type.Array(pageSchema, { minItems: 1, maxItems: MAX_PAGES }),
    qualification: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
      minItems: 1,
      maxItems: 8,
    }),
  },
  closed,
);
const storeSchema = Type.Object(
  {
    schema_version: Type.Literal('1.0'),
    documents: Type.Array(documentSchema, { maxItems: MAX_DOCUMENTS }),
  },
  closed,
);
type PrivateDocumentRecord = Static<typeof documentSchema>;
type Store = Static<typeof storeSchema>;
export type PrivateDocumentInput = {
  name: string;
  media_type: 'application/pdf' | 'text/markdown' | 'text/html' | 'text/plain';
  bytes_base64: string;
};
type PrivateDocumentPage = { number: number; text: string; text_sha256: string };
export type PrivateDocument = Omit<PrivateDocumentRecord, 'raw_base64' | 'pages'> & {
  pages: PrivateDocumentPage[];
};
export type PrivateDocumentSummary = {
  ref: RecordRef;
  name: string;
  media_type: PrivateDocumentInput['media_type'];
  imported_at: string;
  page_count: number;
  raw_sha256: string;
  extractor: string;
  qualification: string[];
};
export type PrivateDocumentSelection = {
  sources: FrozenSource[];
  document_ref: RecordRef;
  pages: number[];
  qualification: string[];
};

export class PrivateDocumentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly reason: string,
  ) {
    super(code);
  }
}
const invalid = (reason: string): never => {
  throw new PrivateDocumentError(400, 'invalid_private_document', reason);
};
const unavailable = (reason: string): never => {
  throw new PrivateDocumentError(503, 'private_document_unavailable', reason);
};
const notFound = (): never => {
  throw new PrivateDocumentError(
    404,
    'private_document_not_found',
    'No retained document has that identity.',
  );
};
const changed = (): never => {
  throw new PrivateDocumentError(
    409,
    'provider_record_changed',
    'The exact private document changed. Reopen it and select again.',
  );
};
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const recordDigest = (record: object) => {
  const projection = { ...record } as Record<string, unknown>;
  delete projection.record_sha256;
  return sha256(JSON.stringify(projection));
};
const refOf = (id: string, record: PrivateDocumentRecord): RecordRef => {
  const digest = sha256(JSON.stringify(record));
  return {
    owner: 'signals-ai',
    kind: 'private_document',
    id,
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
function privateDocumentError(error: unknown): never {
  if (error instanceof PrivateDocumentError) throw error;
  return unavailable(
    'Private document state is invalid or unavailable. Inspect the owner store before retrying.',
  );
}
function validateDocument(record: PrivateDocumentRecord) {
  if (
    !Value.Check(uuid, record.id) ||
    !Value.Check(Type.String({ format: 'date-time' }), record.imported_at) ||
    record.record_sha256 !== recordDigest(record) ||
    record.pages.some(
      (page, index) =>
        page.number !== index + 1 ||
        !isWellFormedUnicode(page.text) ||
        Buffer.byteLength(page.text) > MAX_TEXT_BYTES ||
        page.text_sha256 !== sha256(page.text),
    )
  )
    unavailable('A retained page, date or document identity failed its integrity checks.');
  const raw = Buffer.from(record.raw_base64, 'base64');
  if (
    raw.length > MAX_FILE_BYTES ||
    raw.toString('base64') !== record.raw_base64 ||
    sha256(raw) !== record.raw_sha256 ||
    record.pages.reduce((sum, page) => sum + page.text.length, 0) > MAX_TEXT_UNITS ||
    record.pages.reduce((sum, page) => sum + Buffer.byteLength(page.text), 0) > MAX_TEXT_BYTES
  )
    unavailable('A retained document digest or extraction limit failed validation.');
}
function validateStore(store: Store) {
  const ids = new Set<string>();
  let totalBytes = 0;
  for (const record of store.documents) {
    if (ids.has(record.id)) unavailable('Private document identities must be unique.');
    ids.add(record.id);
    validateDocument(record);
    totalBytes += Buffer.byteLength(record.raw_base64, 'base64');
  }
  if (totalBytes > MAX_TOTAL_RAW_BYTES)
    unavailable('Private document storage exceeds its aggregate original-byte limit.');
}
const emptyStore = (): Store => ({ schema_version: '1.0', documents: [] });
async function loadStore(root: string): Promise<Store> {
  const folder = resolve(root, '.signals');
  const path = resolve(folder, 'private-documents.json');
  try {
    const directory = await lstat(folder);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      (await realpath(folder)) !== folder
    )
      unavailable('Private document directory must be a real local directory.');
    const before = await lstat(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size > MAX_STORE_BYTES ||
      (await realpath(path)) !== path
    )
      unavailable('Private document state must be a bounded regular file.');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_STORE_BYTES)
        unavailable('Private document state exceeds its size limit.');
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (bytes.length > MAX_STORE_BYTES || !Buffer.from(bytes.toString('utf8')).equals(bytes))
      unavailable('Private document state must be bounded UTF8 JSON.');
    const after = await lstat(path);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      unavailable(
        'Private document state changed during validation. Retry after owner reconciliation.',
      );
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (
      !Value.Check(storeSchema, value) ||
      Buffer.byteLength(JSON.stringify(value)) > MAX_STORE_BYTES
    )
      unavailable('Private document state has an unsupported shape or size.');
    validateStore(value as Store);
    return value as Store;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
    return privateDocumentError(error);
  }
}
function publicRecord(record: PrivateDocumentRecord): PrivateDocument {
  const document = { ...record };
  delete (document as Partial<PrivateDocumentRecord>).raw_base64;
  return document;
}
function summary(record: PrivateDocumentRecord): PrivateDocumentSummary {
  return {
    ref: refOf(record.id, record),
    name: record.name,
    media_type: record.media_type,
    imported_at: record.imported_at,
    page_count: record.pages.length,
    raw_sha256: record.raw_sha256,
    extractor: record.extractor,
    qualification: record.qualification,
  };
}
function safeName(value: string) {
  if (
    !isWellFormedUnicode(value) ||
    [...value].some((character) => {
      const unit = character.charCodeAt(0);
      return unit < 32 || unit === 127;
    })
  )
    invalid('Document name must be valid display text.');
  const name = value.replaceAll('\\', '/').split('/').at(-1)?.trim();
  if (!name) return invalid('Document name must include a display basename.');
  return [...name].slice(0, 160).join('');
}
function decodeInput(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    invalid('Use only name, media_type and canonical base64 bytes within the 4 MiB limit.');
  const fields = input as Record<string, unknown>;
  const expected = new Set(['name', 'media_type', 'bytes_base64']);
  if (
    Object.keys(fields).length !== expected.size ||
    Object.keys(fields).some((key) => !expected.has(key)) ||
    typeof fields.bytes_base64 !== 'string' ||
    fields.bytes_base64.length < 4 ||
    fields.bytes_base64.length > Math.ceil(MAX_FILE_BYTES / 3) * 4
  )
    invalid('Use only name, media_type and canonical base64 bytes within the 4 MiB limit.');
  const encoded = fields.bytes_base64;
  if (typeof encoded !== 'string') invalid('Document bytes must use canonical base64.');
  const base64 = encoded as string;
  if (base64.length % 4 !== 0) invalid('Document bytes must use canonical base64.');
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  if ((base64.length / 4) * 3 - padding > MAX_FILE_BYTES)
    invalid('Decoded document bytes exceed 4 MiB or are not canonical base64.');
  const shape = Type.Object(
    {
      name: Type.String({ minLength: 1, maxLength: 1024 }),
      media_type: Type.Enum(['application/pdf', 'text/markdown', 'text/html', 'text/plain']),
      bytes_base64: Type.String({ minLength: 4, maxLength: Math.ceil(MAX_FILE_BYTES / 3) * 4 }),
    },
    closed,
  );
  if (!Value.Check(shape, input))
    invalid('Use only name, media_type and canonical base64 bytes within the 4 MiB limit.');
  const data = input as PrivateDocumentInput;
  // Check canonical encoding by re-encoding the bounded decode; a large regex can overflow.
  const bytes = Buffer.from(data.bytes_base64, 'base64');
  if (bytes.length > MAX_FILE_BYTES || bytes.toString('base64') !== data.bytes_base64)
    invalid('Decoded document bytes exceed 4 MiB or are not canonical base64.');
  return { name: safeName(data.name), media_type: data.media_type, bytes };
}
const pythonHelper = fileURLToPath(
  new URL('../../../scripts/private-pdf-extract.py', import.meta.url),
);
async function extractPdf(bytes: Buffer, python: string) {
  return await new Promise<string[]>((resolveResult, reject) => {
    const child = spawn(python, ['-I', pythonHelper], { stdio: ['pipe', 'pipe', 'ignore'] });
    const output: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error, pages?: string[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolveResult(pages!);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(
        new PrivateDocumentError(
          422,
          'pdf_extraction_timeout',
          'PDF text extraction exceeded its 10 second limit.',
        ),
      );
    }, 10000);
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 5_000_000) {
        child.kill('SIGKILL');
        finish(
          new PrivateDocumentError(
            422,
            'pdf_extraction_limit',
            'PDF extraction output exceeded its 5 MB limit.',
          ),
        );
      } else output.push(chunk);
    });
    child.on('error', (error) => {
      finish(
        new PrivateDocumentError(
          503,
          'pdf_parser_unavailable',
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'Python is unavailable. Install pypdf 6.15.0 into the selected Python environment.'
            : 'PDF parser could not start.',
        ),
      );
    });
    child.on('close', (code) => {
      if (settled) return;
      try {
        const result: unknown = JSON.parse(Buffer.concat(output).toString('utf8'));
        if (
          !result ||
          typeof result !== 'object' ||
          (code === 0 &&
            (!Array.isArray((result as { pages?: unknown }).pages) ||
              typeof (result as { extractor?: unknown }).extractor !== 'string'))
        )
          throw new Error('invalid_pdf_helper_output');
        if (code !== 0) {
          const error = (result as { error?: unknown }).error;
          if (error === 'pdf_parser_unavailable' || error === 'pdf_parser_version_mismatch')
            return finish(
              new PrivateDocumentError(
                503,
                error,
                'Install exactly pypdf 6.15.0 in the selected Python environment; no automatic installation was attempted.',
              ),
            );
          const reasons: Record<string, string> = {
            pdf_encrypted:
              'Encrypted PDFs are refused, including files whose empty password might otherwise open them.',
            pdf_page_limit: 'PDF documents are limited to 256 pages.',
            pdf_text_limit:
              'Complete extracted text exceeds the 256,000 UTF16-unit or 768,000 UTF8-byte document limit.',
            pdf_too_large: 'PDF input exceeds the 4 MiB byte limit.',
            invalid_pdf_header: 'The supplied bytes do not have a PDF header.',
          };
          return finish(
            new PrivateDocumentError(
              422,
              typeof error === 'string' ? error : 'pdf_extraction_failed',
              reasons[String(error)] ??
                'PDF text extraction failed; malformed or unsupported files are refused.',
            ),
          );
        }
        const value = result as { pages: unknown[]; extractor: string };
        if (
          value.extractor !== 'pypdf-6.15.0' ||
          value.pages.length < 1 ||
          value.pages.length > MAX_PAGES ||
          value.pages.some((page) => typeof page !== 'string')
        )
          throw new Error('invalid_pdf_helper_output');
        finish(undefined, value.pages as string[]);
      } catch {
        finish(
          new PrivateDocumentError(
            422,
            'pdf_extraction_failed',
            'PDF text extraction returned an invalid bounded result.',
          ),
        );
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(bytes);
  });
}

const pdfSectionsHelper = fileURLToPath(
  new URL('../../../scripts/private-pdf-sections.py', import.meta.url),
);
type PrivateDocumentSection = {
  id: string;
  parent_id: string | null;
  title: string;
  physical_start: number;
  physical_end: number;
};
type PdfOutline = {
  extractor: 'pypdf-6.15.0';
  outcome: 'available' | 'absent' | 'unavailable';
  nodes: PrivateDocumentSection[];
  omitted: number;
};
function outlineFailure(code: string): never {
  if (code === 'pdf_parser_unavailable' || code === 'pdf_parser_version_mismatch')
    throw new PrivateDocumentError(
      503,
      code,
      'Install exactly pypdf 6.15.0 in the selected Python environment; no automatic installation was attempted.',
    );
  if (code === 'pdf_encrypted')
    throw new PrivateDocumentError(
      422,
      code,
      'Encrypted PDFs are refused, including files whose empty password might otherwise open them.',
    );
  throw new PrivateDocumentError(
    422,
    code,
    'PDF outline inspection failed; malformed or unsupported files are refused.',
  );
}
async function extractPdfSections(bytes: Buffer, python: string): Promise<PdfOutline> {
  return await new Promise<PdfOutline>((resolveResult, reject) => {
    const child = spawn(python, ['-I', pdfSectionsHelper], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const output: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error, result?: PdfOutline) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolveResult(result!);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(
        new PrivateDocumentError(
          422,
          'pdf_outline_timeout',
          'PDF outline inspection exceeded its 10 second limit.',
        ),
      );
    }, 10000);
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 350_000) {
        child.kill('SIGKILL');
        finish(
          new PrivateDocumentError(
            422,
            'pdf_outline_limit',
            'PDF outline output exceeded its limit.',
          ),
        );
      } else output.push(chunk);
    });
    child.on('error', (error) => {
      finish(
        new PrivateDocumentError(
          503,
          'pdf_parser_unavailable',
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'Python is unavailable. Install pypdf 6.15.0 into the selected Python environment.'
            : 'PDF parser could not start.',
        ),
      );
    });
    child.on('close', (code) => {
      if (settled) return;
      try {
        const value: unknown = JSON.parse(Buffer.concat(output).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('invalid_pdf_outline_result');
        const result = value as Record<string, unknown>;
        if (code !== 0)
          return outlineFailure(
            typeof result.error === 'string' ? result.error : 'pdf_outline_failed',
          );
        const fields = ['extractor', 'outcome', 'nodes', 'omitted'];
        if (
          Object.keys(result).length !== fields.length ||
          fields.some((field) => !(field in result)) ||
          result.extractor !== 'pypdf-6.15.0' ||
          !['available', 'absent', 'unavailable'].includes(String(result.outcome)) ||
          !Array.isArray(result.nodes) ||
          result.nodes.length > MAX_OUTLINE_NODES ||
          !Number.isSafeInteger(result.omitted) ||
          (result.omitted as number) < 0
        )
          throw new Error('invalid_pdf_outline_result');
        const ids = new Set<string>();
        const depths = new Map<string, number>();
        const nodes = result.nodes.map((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item))
            throw new Error('invalid_pdf_outline_node');
          const node = item as Record<string, unknown>;
          if (
            Object.keys(node).length !== 5 ||
            typeof node.id !== 'string' ||
            !/^[a-f0-9]{64}$/.test(node.id) ||
            ids.has(node.id) ||
            !(
              node.parent_id === null ||
              (typeof node.parent_id === 'string' && ids.has(node.parent_id))
            ) ||
            (node.parent_id !== null &&
              (depths.get(node.parent_id) ?? MAX_OUTLINE_DEPTH) + 1 > MAX_OUTLINE_DEPTH) ||
            typeof node.title !== 'string' ||
            node.title.length < 1 ||
            node.title.length > MAX_OUTLINE_TITLE ||
            !Number.isSafeInteger(node.physical_start) ||
            !Number.isSafeInteger(node.physical_end) ||
            (node.physical_start as number) < 1 ||
            (node.physical_end as number) < (node.physical_start as number) ||
            (node.physical_end as number) > MAX_PAGES
          )
            throw new Error('invalid_pdf_outline_node');
          ids.add(node.id);
          depths.set(node.id, node.parent_id === null ? 1 : (depths.get(node.parent_id) ?? 0) + 1);
          return node as unknown as PrivateDocumentSection;
        });
        if (
          (result.outcome === 'available' && nodes.length === 0) ||
          (result.outcome === 'absent' && (nodes.length !== 0 || result.omitted !== 0)) ||
          (result.outcome === 'unavailable' && nodes.length !== 0)
        )
          throw new Error('invalid_pdf_outline_result');
        finish(undefined, {
          extractor: 'pypdf-6.15.0',
          outcome: result.outcome as PdfOutline['outcome'],
          nodes,
          omitted: result.omitted as number,
        });
      } catch (error) {
        if (error instanceof PrivateDocumentError) return finish(error);
        finish(
          new PrivateDocumentError(
            422,
            'pdf_outline_failed',
            'PDF outline inspection returned an invalid bounded result.',
          ),
        );
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(bytes);
  });
}

/** Read bounded bookmark sections from the exact retained PDF without changing owner state. */
export async function privateDocumentSections(
  root: string,
  input: unknown,
  options: { python?: string } = {},
) {
  const shape = Type.Object({ document_ref: recordRefSchema, raw_sha256: sha }, closed);
  if (!Value.Check(shape, input))
    invalid('PDF sections require only an exact document ref and raw SHA-256.');
  const request = input as { document_ref: RecordRef; raw_sha256: string };
  const python = options.python ?? 'python3';
  if (
    typeof python !== 'string' ||
    python.length < 1 ||
    python.length > 2048 ||
    [...python].some((character) => [0, 10, 13].includes(character.charCodeAt(0)))
  )
    invalid('The trusted Python executable must be one path or command name.');
  const retained = await readPrivatePdfBytes(root, request);
  const parsed = await extractPdfSections(Buffer.from(retained.bytes_base64, 'base64'), python);
  return {
    document_ref: retained.document_ref,
    raw_sha256: retained.raw_sha256,
    ...parsed,
  };
}

function pagesFor(mediaType: PrivateDocumentInput['media_type'], bytes: Buffer, python: string) {
  if (mediaType === 'application/pdf') {
    if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-')))
      invalid('The selected media type requires a PDF header.');
    return extractPdf(bytes, python).then((pages) => ({ pages, extractor: 'pypdf-6.15.0' }));
  }
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return Promise.reject(
      new PrivateDocumentError(
        400,
        'invalid_private_document',
        'Text documents must be valid UTF8.',
      ),
    );
  }
  if (!isWellFormedUnicode(raw)) invalid('Text documents must contain well-formed Unicode.');
  const extractor =
    mediaType === 'text/html' ? 'readability-0.6.0+html-layout-v1' : 'operator-text-v1';
  const text = mediaType === 'text/html' ? extractHtml(raw, 'http://127.0.0.1/').text : raw;
  return Promise.resolve({ pages: [text], extractor });
}

/** Import exact caller-supplied bytes into private state; parsing performs no model or network call. */
export async function importPrivateDocument(
  root: string,
  input: unknown,
  options: { python?: string } = {},
) {
  const data = decodeInput(input);
  const python = options.python ?? 'python3';
  if (
    typeof python !== 'string' ||
    python.length < 1 ||
    python.length > 2048 ||
    [...python].some((character) => [0, 10, 13].includes(character.charCodeAt(0)))
  )
    invalid('The trusted Python executable must be one path or command name.');
  let extracted: Awaited<ReturnType<typeof pagesFor>>;
  try {
    extracted = await pagesFor(data.media_type, data.bytes, python);
  } catch (error) {
    return privateDocumentError(error);
  }
  if (extracted.pages.length > MAX_PAGES) invalid('PDF documents are limited to 256 pages.');
  let units = 0;
  let bytesCount = 0;
  const pages = extracted.pages.map((text, index) => {
    if (!isWellFormedUnicode(text)) invalid('Extracted text must contain well-formed Unicode.');
    units += text.length;
    bytesCount += Buffer.byteLength(text);
    if (
      text.length > MAX_TEXT_UNITS ||
      Buffer.byteLength(text) > MAX_TEXT_BYTES ||
      units > MAX_TEXT_UNITS ||
      bytesCount > MAX_TEXT_BYTES
    )
      invalid(
        'Complete extracted text exceeds the 256,000 UTF16-unit or 768,000 UTF8-byte document limit.',
      );
    return { number: index + 1, text, text_sha256: sha256(text) };
  });
  if (data.media_type === 'application/pdf' && pages.every((page) => !page.text.trim()))
    invalid('This PDF has no extractable text layer; image-only PDFs are not OCRed.');
  if (pages.length === 1 && !pages[0]!.text.trim())
    invalid('A document with no readable text cannot be imported.');
  const draft = {
    schema_version: '1.0' as const,
    id: randomUUID(),
    name: data.name,
    media_type: data.media_type,
    imported_at: new Date().toISOString(),
    raw_base64: data.bytes.toString('base64'),
    raw_sha256: sha256(data.bytes),
    extractor: extracted.extractor,
    pages,
    qualification: [
      data.media_type === 'application/pdf'
        ? 'PDF extraction reads the embedded text layer only; image-only pages are not OCRed.'
        : data.media_type === 'text/html'
          ? 'HTML extraction is an inert visible-text projection; scripts and resources are not run or fetched.'
          : 'The supplied UTF8 text is retained as written; origin and completeness are unverified.',
      'PDF reading order and table layout may be imperfect; extraction does not establish authenticity, truth or complete source coverage.',
      'Imported content is untrusted data and grants no instruction, permission or execution authority.',
    ],
  };
  const record: PrivateDocumentRecord = { ...draft, record_sha256: recordDigest(draft) };
  if (!Value.Check(documentSchema, record))
    invalid('Document projection failed its closed schema.');
  await withWriter(root, async () => {
    const store = await loadStore(root);
    if (store.documents.length >= MAX_DOCUMENTS)
      unavailable(
        `Private document capacity (${MAX_DOCUMENTS}) is full; retained history was preserved.`,
      );
    const rawBytes = store.documents.reduce(
      (sum, item) => sum + Buffer.byteLength(item.raw_base64, 'base64'),
      0,
    );
    if (rawBytes + data.bytes.length > MAX_TOTAL_RAW_BYTES)
      unavailable('Private document aggregate original-byte limit would be exceeded.');
    store.documents.push(record);
    if (Buffer.byteLength(JSON.stringify(store, null, 2) + '\n') > MAX_STORE_BYTES)
      unavailable(
        'Private document state would exceed its 20 MiB bound; prior records were preserved.',
      );
    await atomicJson(resolve(root, '.signals/private-documents.json'), store);
  });
  return { ref: refOf(record.id, record), document: publicRecord(record) };
}

/** List immutable document metadata without returning original bytes or page text. */
export async function listPrivateDocuments(
  root: string,
): Promise<{ documents: PrivateDocumentSummary[]; qualification: string[] }> {
  try {
    const store = await loadStore(root);
    return {
      documents: store.documents
        .map(summary)
        .sort((left, right) => left.imported_at.localeCompare(right.imported_at)),
      qualification: [
        'Listing is private retained history and performs no extraction or model call.',
      ],
    };
  } catch (error) {
    return privateDocumentError(error);
  }
}

/** Reopen one complete, integrity-checked page record without exposing the source bytes. */
export async function openPrivateDocument(root: string, id: string) {
  if (!Value.Check(uuid, id)) invalid('Document identity must be a UUID.');
  try {
    const store = await loadStore(root);
    const record = store.documents.find((row) => row.id === id);
    if (!record) return notFound();
    return { ref: refOf(record.id, record), document: publicRecord(record) };
  } catch (error) {
    return privateDocumentError(error);
  }
}

/** Return original bytes only after the caller's full owner ref and digest still match. */
export async function readPrivatePdfBytes(root: string, input: unknown) {
  const shape = Type.Object({ document_ref: recordRefSchema, raw_sha256: sha }, closed);
  if (!Value.Check(shape, input))
    invalid('PDF byte reads require only a complete document ref and exact raw SHA-256.');
  const request = input as { document_ref: RecordRef; raw_sha256: string };
  if (
    request.document_ref.owner !== 'signals-ai' ||
    request.document_ref.kind !== 'private_document' ||
    request.document_ref.revision !== `sha256:${request.document_ref.digest}`
  )
    invalid('PDF byte reads require an exact Signals private-document ref.');
  try {
    const store = await loadStore(root);
    const record = store.documents.find((row) => row.id === request.document_ref.id);
    if (!record) return notFound();
    if (
      !sameRef(refOf(record.id, record), request.document_ref) ||
      record.raw_sha256 !== request.raw_sha256
    )
      return changed();
    if (record.media_type !== 'application/pdf')
      invalid('Original bytes are available through this operation only for PDFs.');
    return {
      document_ref: refOf(record.id, record),
      raw_sha256: record.raw_sha256,
      page_count: record.pages.length,
      media_type: 'application/pdf' as const,
      bytes_base64: record.raw_base64,
    };
  } catch (error) {
    return privateDocumentError(error);
  }
}

/** Freeze exact selected pages for the existing Research source-only boundary. */
export async function selectPrivateDocument(
  root: string,
  input: unknown,
  origin: string,
): Promise<PrivateDocumentSelection> {
  const shape = Type.Object(
    {
      document_ref: Type.Unknown(),
      pages: Type.Array(Type.Integer({ minimum: 1, maximum: MAX_PAGES }), {
        minItems: 1,
        maxItems: 8,
        uniqueItems: true,
      }),
    },
    closed,
  );
  if (!Value.Check(shape, input))
    invalid('Selection requires one exact document ref and 1–8 unique positive page numbers.');
  if (
    !/^http:\/\/127\.0\.0\.1:(?:[1-9]\d{1,4})$/.test(origin) ||
    Number(origin.split(':').at(-1)) > 65535
  )
    invalid('Selection origin must be the exact validated loopback HTTP origin.');
  const data = input as { document_ref: unknown; pages: number[] };
  if (
    !Value.Check(recordRefSchema, data.document_ref) ||
    data.document_ref.kind !== 'private_document' ||
    data.document_ref.owner !== 'signals-ai' ||
    data.document_ref.revision !== `sha256:${data.document_ref.digest}`
  )
    invalid('Selection requires an exact private_document RecordRef.');
  const requestedRef = data.document_ref as RecordRef;
  try {
    const store = await loadStore(root);
    const record = store.documents.find((row) => row.id === requestedRef.id);
    if (!record) return notFound();
    const actualRef = refOf(record.id, record);
    if (!sameRef(actualRef, requestedRef)) return changed();
    const selected = data.pages.map((number) => {
      const page = record.pages[number - 1];
      if (!page) return invalid(`Page ${number} is outside this document.`);
      if (!page.text.trim())
        invalid(`Page ${number} has no extracted text and cannot be sent to frozen Research.`);
      return page;
    });
    if (selected.reduce((sum, page) => sum + page.text.length, 0) > MAX_TEXT_UNITS)
      invalid('Selected pages exceed the 256,000 UTF16-unit frozen-source limit.');
    return {
      sources: selected.map((page) => ({
        uri: `${origin}/signals-ai/__signals/api/private-documents/${record.id}/pages/${page.number}`,
        text: page.text,
        observedAt: record.imported_at,
        omissions: record.qualification.slice(0, 8).map((entry) => entry.slice(0, 500)),
      })),
      document_ref: actualRef,
      pages: [...data.pages],
      qualification: [
        'This is explicit local page selection for frozen Research; Signals performs no interpretation or source verification.',
        'The citation is a private loopback page route; its port may change and it is not a public verification claim.',
        ...record.qualification,
      ].slice(0, 8),
    };
  } catch (error) {
    return privateDocumentError(error);
  }
}
