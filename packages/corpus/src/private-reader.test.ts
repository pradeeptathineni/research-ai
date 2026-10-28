import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { researchQuestion } from '@pradeeptathineni/research-ai';
import {
  correctPrivateDocument,
  importPrivateDocument,
  listPrivateDocuments,
  openPrivateDocument,
  previewPrivateDocumentCorrection,
  readPrivatePdfBytes,
} from './private-documents.js';
import {
  createPrivateReader,
  openPrivateReader,
  revisePrivateReader,
  selectPrivateReaderAnnotations,
} from './private-reader.js';
import { searchApi } from './search-api.js';

const roots: string[] = [];
const servers: Server[] = [];
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function root() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'signals-private-reader-')));
  roots.push(path);
  return path;
}
function pdf(texts: string[]) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${texts.map((_, index) => `${index * 2 + 3} 0 R`).join(' ')}] /Count ${texts.length} >>`,
    ...texts.flatMap((text, index) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${texts.length * 2 + 3} 0 R >> >> /Contents ${index * 2 + 4} 0 R >>`,
      `<< /Length ${Buffer.byteLength(`BT /F1 18 Tf 72 720 Td (${text}) Tj ET`)} >>\nstream\nBT /F1 18 Tf 72 720 Td (${text}) Tj ET\nendstream`,
    ]),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
async function owner(rootPath: string) {
  const handler = searchApi(rootPath);
  const server = createServer((request, response) => {
    void handler(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected_loopback_address');
  const base = `http://127.0.0.1:${address.port}/signals-ai/__signals/api/`;
  const session = (await (await fetch(new URL('session', base))).json()) as { token: string };
  const scopeResponse = await fetch(new URL('request-scope', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signals-token': session.token },
    body: '{}',
  });
  const scope = (await scopeResponse.json()) as { identity: string; epoch: string };
  const headers = {
    'content-type': 'application/json',
    'x-signals-token': session.token,
    'x-signals-provider-version': '1.0',
    'x-signals-instance-id': scope.identity,
    'x-signals-owner-epoch': scope.epoch,
  };
  return { base, headers, scope, server };
}
async function stop(server: Server) {
  if (server.listening)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
}
afterEach(async () => {
  for (const server of servers.splice(0))
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

it('serves original bytes only for an exact PDF ref and freezes selected exact annotations', async () => {
  const workspace = await root();
  const bytes = pdf(['Page one: decoy', 'Page two: selected retention passage and canary nearby.']);
  const imported = await importPrivateDocument(workspace, {
    name: 'source.pdf',
    media_type: 'application/pdf',
    bytes_base64: bytes.toString('base64'),
  });
  let api = await owner(workspace);
  const post = (route: string, body: unknown) =>
    fetch(new URL(route, api.base), {
      method: 'POST',
      headers: api.headers,
      body: JSON.stringify(body),
    });
  const bytesRequest = { document_ref: imported.ref, raw_sha256: imported.document.raw_sha256 };
  const byteResponse = await post('private-reader/bytes', bytesRequest);
  expect(byteResponse.status).toBe(200);
  expect(byteResponse.headers.get('cache-control')).toContain('no-store');
  expect(byteResponse.headers.get('pragma')).toBe('no-cache');
  const byteReply = (await byteResponse.json()) as {
    bytes_base64: string;
    raw_sha256: string;
    page_count: number;
  };
  expect(Buffer.from(byteReply.bytes_base64, 'base64')).toEqual(bytes);
  expect(byteReply.raw_sha256).toBe(sha(bytes));
  expect(byteReply.page_count).toBe(2);
  expect((await listPrivateDocuments(workspace)).documents[0]).not.toHaveProperty('raw_base64');
  const unknownField = await post('private-reader/bytes', {
    ...bytesRequest,
    client_path: '/private/file.pdf',
  });
  expect(unknownField.status).toBe(400);
  expect(JSON.stringify(await unknownField.json())).not.toContain('bytes_base64');
  const publicOpen = await fetch(new URL(`private-documents/${imported.document.id}`, api.base), {
    headers: api.headers,
  });
  expect(publicOpen.status).toBe(200);
  expect(JSON.stringify(await publicOpen.json())).not.toContain('raw_base64');
  const textDoc = await importPrivateDocument(workspace, {
    name: 'ordinary.txt',
    media_type: 'text/plain',
    bytes_base64: Buffer.from('not a PDF').toString('base64'),
  });
  const wrongType = await post('private-reader/bytes', {
    document_ref: textDoc.ref,
    raw_sha256: textDoc.document.raw_sha256,
  });
  expect(wrongType.status).toBe(400);
  expect(JSON.stringify(await wrongType.json())).not.toContain('bytes_base64');
  await expect(
    readPrivatePdfBytes(workspace, { ...bytesRequest, raw_sha256: '0'.repeat(64) }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    readPrivatePdfBytes(workspace, { ...bytesRequest, surprise: 'path' }),
  ).rejects.toMatchObject({ status: 400 });

  const readerId = 'd22db7a3-56e4-48d0-85f1-ef1e15a6b2ea';
  const createResponse = await post('private-reader', {
    id: readerId,
    document_ref: imported.ref,
    raw_sha256: imported.document.raw_sha256,
    page: 2,
  });
  expect(createResponse.status).toBe(201);
  const created = (await createResponse.json()) as Awaited<ReturnType<typeof createPrivateReader>>;
  const retryResponse = await post('private-reader', {
    id: readerId,
    document_ref: imported.ref,
    raw_sha256: imported.document.raw_sha256,
    page: 2,
  });
  const retry = (await retryResponse.json()) as Awaited<ReturnType<typeof createPrivateReader>>;
  expect(retry.reader.digest).toBe(created.reader.digest);
  const page = created.document.pages[1]!;
  const quote = 'selected retention passage';
  const start = page.text.indexOf(quote);
  const reviseResponse = await post('private-reader/revise', {
    id: readerId,
    expected_revision: created.reader.revision,
    expected_digest: created.reader.digest,
    add_annotations: [
      {
        id: '632db7a3-56e4-48d0-85f1-ef1e15a6b2ea',
        page: 2,
        start,
        end: start + quote.length,
        quote,
        page_sha256: page.text_sha256,
        note: 'Review this clause',
      },
      {
        id: '732db7a3-56e4-48d0-85f1-ef1e15a6b2ea',
        page: 2,
        start: page.text.indexOf('canary'),
        end: page.text.indexOf('canary') + 6,
        quote: 'canary',
        page_sha256: page.text_sha256,
        note: 'Unselected private canary',
      },
    ],
  });
  expect(reviseResponse.status).toBe(200);
  const revised = (await reviseResponse.json()) as Awaited<ReturnType<typeof revisePrivateReader>>;
  expect(revised.reader.page).toBe(2);
  const reopenedResponse = await fetch(new URL(`private-reader/${readerId}`, api.base), {
    headers: api.headers,
  });
  const reopened = (await reopenedResponse.json()) as Awaited<ReturnType<typeof openPrivateReader>>;
  expect(reopened.reader.annotations[0]?.note).toBe('Review this clause');
  const staleCas = await post('private-reader/revise', {
    id: readerId,
    expected_revision: created.reader.revision,
    expected_digest: created.reader.digest,
    page: 1,
  });
  expect(staleCas.status).toBe(409);
  const selectedResponse = await post('private-reader/selection', {
    id: readerId,
    expected_revision: revised.reader.revision,
    expected_digest: revised.reader.digest,
    annotation_ids: ['632db7a3-56e4-48d0-85f1-ef1e15a6b2ea'],
  });
  expect(selectedResponse.status).toBe(200);
  const selected = (await selectedResponse.json()) as Awaited<
    ReturnType<typeof selectPrivateReaderAnnotations>
  >;
  expect(selected.sources).toHaveLength(1);
  expect(selected.sources[0]?.text).toBe(quote);
  expect(JSON.stringify(selected)).not.toContain('Unselected private canary');
  expect(selected.manifest).toMatchObject({
    raw_sha256: imported.document.raw_sha256,
    selections: [{ page: 2, start, end: start + quote.length, quote }],
  });
  expect(selected.sources[0]?.uri).toContain('range=');
  const movedResponse = await post('private-reader/revise', {
    id: readerId,
    expected_revision: revised.reader.revision,
    expected_digest: revised.reader.digest,
    page: 1,
  });
  const moved = (await movedResponse.json()) as Awaited<ReturnType<typeof revisePrivateReader>>;
  expect(moved.reader.page).toBe(1);
  const reopenedRetryResponse = await post('private-reader', {
    id: readerId,
    document_ref: imported.ref,
    raw_sha256: imported.document.raw_sha256,
    page: 2,
  });
  const reopenedRetry = (await reopenedRetryResponse.json()) as Awaited<
    ReturnType<typeof createPrivateReader>
  >;
  expect(reopenedRetry.reader.page).toBe(1);
  const changedCreate = await post('private-reader', {
    id: readerId,
    document_ref: imported.ref,
    raw_sha256: imported.document.raw_sha256,
    page: 1,
  });
  expect(changedCreate.status).toBe(409);

  const wrongHash = await post('private-reader/bytes', {
    ...bytesRequest,
    raw_sha256: '0'.repeat(64),
  });
  expect(wrongHash.status).toBe(409);
  const wrongRef = await post('private-reader/bytes', {
    document_ref: {
      ...imported.ref,
      digest: '0'.repeat(64),
      revision: `sha256:${'0'.repeat(64)}`,
    },
    raw_sha256: imported.document.raw_sha256,
  });
  expect(wrongRef.status).toBe(409);
  const noToken = await fetch(new URL('private-reader/bytes', api.base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bytesRequest),
  });
  expect(noToken.status).toBe(403);
  const wrongOrigin = await fetch(new URL('private-reader/bytes', api.base), {
    method: 'POST',
    headers: { ...api.headers, origin: 'http://evil.example' },
    body: JSON.stringify(bytesRequest),
  });
  expect(wrongOrigin.status).toBe(403);
  const wrongEpoch = await fetch(new URL('private-reader/bytes', api.base), {
    method: 'POST',
    headers: { ...api.headers, 'x-signals-owner-epoch': 'stale' },
    body: JSON.stringify(bytesRequest),
  });
  expect(wrongEpoch.status).toBe(409);
  expect(api.scope.epoch).not.toBe('stale');
  await stop(api.server);
  api = await owner(workspace);
  const afterRestart = await fetch(new URL(`private-reader/${readerId}`, api.base), {
    headers: api.headers,
  });
  expect(afterRestart.status).toBe(200);
  const restored = (await afterRestart.json()) as Awaited<ReturnType<typeof openPrivateReader>>;
  expect(restored.reader.page).toBe(1);
  expect(restored.reader.annotations[0]?.quote).toBe(quote);
  expect(restored.reader.annotations[0]?.note).toBe('Review this clause');
});

it('creates, annotates and reopens an exact page 61 reader record', async () => {
  const workspace = await root();
  const texts = Array.from({ length: 64 }, (_, index) => `Page ${index + 1}: retained text`);
  const bytes = pdf(texts);
  const imported = await importPrivateDocument(workspace, {
    name: 'sixty-four-pages.pdf',
    media_type: 'application/pdf',
    bytes_base64: bytes.toString('base64'),
  });
  const readerId = 'a72db7a3-56e4-48d0-85f1-ef1e15a6b2ea';
  const created = await createPrivateReader(workspace, {
    id: readerId,
    document_ref: imported.ref,
    raw_sha256: imported.document.raw_sha256,
    page: 61,
  });
  expect(created.reader.page).toBe(61);
  expect(created.document.pages[60]!.text).toContain('Page 61: retained text');
  const quote = 'Page 61: retained text';
  const updated = await revisePrivateReader(workspace, {
    id: readerId,
    expected_revision: created.reader.revision,
    expected_digest: created.reader.digest,
    add_annotations: [
      {
        id: 'b82db7a3-56e4-48d0-85f1-ef1e15a6b2ea',
        page: 61,
        start: 0,
        end: quote.length,
        quote,
        page_sha256: created.document.pages[60]!.text_sha256,
        note: 'Retained late-page citation',
      },
    ],
  });
  const reopened = await openPrivateReader(workspace, readerId);
  expect(reopened.reader).toEqual(updated.reader);
  expect(reopened.reader.annotations[0]).toMatchObject({ page: 61, quote });
});

it('refuses non-PDF bytes and code-point-splitting offsets', async () => {
  const workspace = await root();
  const textDoc = await importPrivateDocument(workspace, {
    name: 'ordinary.txt',
    media_type: 'text/plain',
    bytes_base64: Buffer.from('not a PDF').toString('base64'),
  });
  await expect(
    readPrivatePdfBytes(workspace, {
      document_ref: textDoc.ref,
      raw_sha256: textDoc.document.raw_sha256,
    }),
  ).rejects.toMatchObject({ status: 400 });

  const pdfDoc = await importPrivateDocument(workspace, {
    name: 'unicode.pdf',
    media_type: 'application/pdf',
    bytes_base64: pdf(['Page one', 'Unicode page']).toString('base64'),
  });
  const storePath = join(workspace, '.signals/private-documents.json');
  const store = JSON.parse(await readFile(storePath, 'utf8')) as {
    documents: Array<{
      id: string;
      pages: Array<{ text: string; text_sha256: string }>;
      record_sha256: string;
      [key: string]: unknown;
    }>;
  };
  const record = store.documents.find((row) => row.id === pdfDoc.document.id)!;
  const text = 'A😀B';
  const secondPage = record.pages[1];
  if (!secondPage) throw new Error('synthetic_pdf_page_missing');
  secondPage.text = text;
  secondPage.text_sha256 = sha(text);
  const projection: Record<string, unknown> = { ...record };
  delete projection.record_sha256;
  record.record_sha256 = sha(JSON.stringify(projection));
  await writeFile(storePath, JSON.stringify(store, null, 2) + '\n');
  const refs = await listPrivateDocuments(workspace);
  const ref = refs.documents.find((row) => row.ref.id === pdfDoc.document.id)!.ref;
  const reader = await createPrivateReader(workspace, {
    id: '832db7a3-56e4-48d0-85f1-ef1e15a6b2ea',
    document_ref: ref,
    raw_sha256: pdfDoc.document.raw_sha256,
    page: 2,
  });
  await expect(
    revisePrivateReader(workspace, {
      id: reader.reader.id,
      expected_revision: reader.reader.revision,
      expected_digest: reader.reader.digest,
      add_annotations: [
        {
          id: '932db7a3-56e4-48d0-85f1-ef1e15a6b2ea',
          page: 2,
          start: 1,
          end: 2,
          quote: '\uD83D',
          page_sha256: sha(text),
          note: '',
        },
      ],
    }),
  ).rejects.toMatchObject({ status: 400 });
});

it('keeps exact text evidence bound to immutable correction predecessors and successors', async () => {
  const workspace = await root();
  const originalText = 'The final review must be completed before release.';
  const imported = await importPrivateDocument(workspace, {
    name: 'review.md',
    media_type: 'text/markdown',
    bytes_base64: Buffer.from(originalText).toString('base64'),
  });
  const originalReaderId = 'a32db7a3-56e4-48d0-85f1-ef1e15a6b2ea';
  const originalReader = await createPrivateReader(workspace, {
    id: originalReaderId,
    document_ref: imported.ref,
    raw_sha256: imported.document.raw_sha256,
    page: 1,
  });
  const oldQuote = 'completed before release';
  const oldStart = originalText.indexOf(oldQuote);
  const annotatedOriginal = await revisePrivateReader(workspace, {
    id: originalReaderId,
    expected_revision: originalReader.reader.revision,
    expected_digest: originalReader.reader.digest,
    add_annotations: [
      {
        id: 'b32db7a3-56e4-48d0-85f1-ef1e15a6b2ea',
        page: 1,
        start: oldStart,
        end: oldStart + oldQuote.length,
        quote: oldQuote,
        page_sha256: originalReader.document.pages[0]!.text_sha256,
        note: 'Original retained wording',
      },
    ],
  });
  const correction = {
    document_ref: imported.ref,
    page_corrections: [
      {
        number: 1,
        prior_text_sha256: imported.document.pages[0]!.text_sha256,
        text: 'The final review must be signed before release.',
      },
    ],
    impact: 'meaningful' as const,
    rationale: 'Synthetic correction of the retained extraction text.',
  };
  await previewPrivateDocumentCorrection(workspace, correction);
  const corrected = await correctPrivateDocument(workspace, {
    ...correction,
    request_id: 'c32db7a3-56e4-48d0-85f1-ef1e15a6b2ea',
  });
  expect(corrected.document.supersedes_ref).toEqual(imported.ref);
  expect(corrected.document.raw_sha256).toBe(imported.document.raw_sha256);

  const reopenedOriginal = await openPrivateReader(workspace, originalReaderId);
  expect(reopenedOriginal.reader.document_ref).toEqual(imported.ref);
  expect(reopenedOriginal.reader).toEqual(annotatedOriginal.reader);
  expect(reopenedOriginal.document.pages[0]!.text).toBe(originalText);
  const originalSelection = await selectPrivateReaderAnnotations(
    workspace,
    {
      id: originalReaderId,
      expected_revision: reopenedOriginal.reader.revision,
      expected_digest: reopenedOriginal.reader.digest,
      annotation_ids: ['b32db7a3-56e4-48d0-85f1-ef1e15a6b2ea'],
    },
    'http://127.0.0.1:5178',
  );
  expect(originalSelection.sources[0]?.text).toBe(oldQuote);
  expect(originalSelection.manifest).toMatchObject({ selections: [{ quote: oldQuote }] });

  const successorReaderId = 'd32db7a3-56e4-48d0-85f1-ef1e15a6b2ea';
  const successorReader = await createPrivateReader(workspace, {
    id: successorReaderId,
    document_ref: corrected.ref,
    raw_sha256: corrected.document.raw_sha256,
    page: 1,
  });
  const newQuote = 'must be signed before release';
  const newStart = corrected.document.pages[0]!.text.indexOf(newQuote);
  const annotatedSuccessor = await revisePrivateReader(workspace, {
    id: successorReaderId,
    expected_revision: successorReader.reader.revision,
    expected_digest: successorReader.reader.digest,
    add_annotations: [
      {
        id: 'e32db7a3-56e4-48d0-85f1-ef1e15a6b2ea',
        page: 1,
        start: newStart,
        end: newStart + newQuote.length,
        quote: newQuote,
        page_sha256: successorReader.document.pages[0]!.text_sha256,
        note: 'Human-corrected wording',
      },
    ],
  });
  const reopenedSuccessor = await openPrivateReader(workspace, successorReaderId);
  expect(reopenedSuccessor.reader).toEqual(annotatedSuccessor.reader);
  expect(reopenedSuccessor.reader.document_ref).toEqual(corrected.ref);
  expect(reopenedSuccessor.document.pages[0]!.text).toBe(
    'The final review must be signed before release.',
  );
  const successorSelection = await selectPrivateReaderAnnotations(
    workspace,
    {
      id: successorReaderId,
      expected_revision: reopenedSuccessor.reader.revision,
      expected_digest: reopenedSuccessor.reader.digest,
      annotation_ids: ['e32db7a3-56e4-48d0-85f1-ef1e15a6b2ea'],
    },
    'http://127.0.0.1:5178',
  );
  expect(successorSelection.sources[0]?.text).toBe(newQuote);
  expect(successorSelection.manifest).toMatchObject({ selections: [{ quote: newQuote }] });
  expect((await openPrivateDocument(workspace, imported.document.id, imported.ref)).ref).toEqual(
    imported.ref,
  );
});

it('retains exact text citations across a correction successor and cold reopen', async () => {
  const workspace = await root();
  const originalText = 'The final review must be completed before release.';
  const imported = await importPrivateDocument(workspace, {
    name: 'review.md',
    media_type: 'text/markdown',
    bytes_base64: Buffer.from(originalText).toString('base64'),
  });
  const originalReaderId = 'a32db7a3-56e4-48d0-85f1-ef1e15a6b2ea';
  const originalReader = await createPrivateReader(workspace, {
    id: originalReaderId,
    document_ref: imported.ref,
    raw_sha256: imported.document.raw_sha256,
    page: 1,
  });
  const oldQuote = 'completed before release';
  const oldStart = originalText.indexOf(oldQuote);
  const annotatedOriginal = await revisePrivateReader(workspace, {
    id: originalReaderId,
    expected_revision: originalReader.reader.revision,
    expected_digest: originalReader.reader.digest,
    add_annotations: [
      {
        id: 'b32db7a3-56e4-48d0-85f1-ef1e15a6b2ea',
        page: 1,
        start: oldStart,
        end: oldStart + oldQuote.length,
        quote: oldQuote,
        page_sha256: originalReader.document.pages[0]!.text_sha256,
        note: 'Original retained wording',
      },
    ],
  });
  const correction = {
    document_ref: imported.ref,
    page_corrections: [
      {
        number: 1,
        prior_text_sha256: imported.document.pages[0]!.text_sha256,
        text: 'The final review must be signed before release.',
      },
    ],
    impact: 'meaningful' as const,
    rationale: 'Synthetic correction of the retained extraction text.',
  };
  await previewPrivateDocumentCorrection(workspace, correction);
  const corrected = await correctPrivateDocument(workspace, {
    ...correction,
    request_id: 'c32db7a3-56e4-48d0-85f1-ef1e15a6b2ea',
  });
  expect(corrected.document.supersedes_ref).toEqual(imported.ref);
  expect(corrected.document.raw_sha256).toBe(imported.document.raw_sha256);

  const reopenedOriginal = await openPrivateReader(workspace, originalReaderId);
  expect(reopenedOriginal.reader.document_ref).toEqual(imported.ref);
  expect(reopenedOriginal.reader).toEqual(annotatedOriginal.reader);
  expect(reopenedOriginal.document.pages[0]!.text).toBe(originalText);
  const originalSelection = await selectPrivateReaderAnnotations(
    workspace,
    {
      id: originalReaderId,
      expected_revision: reopenedOriginal.reader.revision,
      expected_digest: reopenedOriginal.reader.digest,
      annotation_ids: ['b32db7a3-56e4-48d0-85f1-ef1e15a6b2ea'],
    },
    'http://127.0.0.1:5178',
  );
  expect(originalSelection.sources[0]?.text).toBe(oldQuote);
  expect(originalSelection.manifest).toMatchObject({ selections: [{ quote: oldQuote }] });

  const successorReaderId = 'd32db7a3-56e4-48d0-85f1-ef1e15a6b2ea';
  const successorReader = await createPrivateReader(workspace, {
    id: successorReaderId,
    document_ref: corrected.ref,
    raw_sha256: corrected.document.raw_sha256,
    page: 1,
  });
  const newQuote = 'must be signed before release';
  const newStart = corrected.document.pages[0]!.text.indexOf(newQuote);
  await revisePrivateReader(workspace, {
    id: successorReaderId,
    expected_revision: successorReader.reader.revision,
    expected_digest: successorReader.reader.digest,
    add_annotations: [
      {
        id: 'e32db7a3-56e4-48d0-85f1-ef1e15a6b2ea',
        page: 1,
        start: newStart,
        end: newStart + newQuote.length,
        quote: newQuote,
        page_sha256: successorReader.document.pages[0]!.text_sha256,
        note: 'Human-corrected wording',
      },
    ],
  });
  const reopenedSuccessor = await openPrivateReader(workspace, successorReaderId);
  expect(reopenedSuccessor.reader.document_ref).toEqual(corrected.ref);
  expect(reopenedSuccessor.document.pages[0]!.text).toBe(
    'The final review must be signed before release.',
  );
  const successorSelection = await selectPrivateReaderAnnotations(
    workspace,
    {
      id: successorReaderId,
      expected_revision: reopenedSuccessor.reader.revision,
      expected_digest: reopenedSuccessor.reader.digest,
      annotation_ids: ['e32db7a3-56e4-48d0-85f1-ef1e15a6b2ea'],
    },
    'http://127.0.0.1:5178',
  );
  expect(successorSelection.sources[0]?.text).toBe(newQuote);
  expect(successorSelection.manifest).toMatchObject({ selections: [{ quote: newQuote }] });
  expect((await openPrivateDocument(workspace, imported.document.id, imported.ref)).ref).toEqual(
    imported.ref,
  );
});

it('rejects whitespace-only quotes before storage and when reopening retained annotations', async () => {
  const workspace = await root();
  const imported = await importPrivateDocument(workspace, {
    name: 'whitespace.pdf',
    media_type: 'application/pdf',
    bytes_base64: pdf(['Page one', 'Text page']).toString('base64'),
  });
  const documentPath = join(workspace, '.signals/private-documents.json');
  const sourceStore = JSON.parse(await readFile(documentPath, 'utf8')) as {
    documents: Array<{
      id: string;
      pages: Array<{ text: string; text_sha256: string }>;
      record_sha256: string;
      [key: string]: unknown;
    }>;
  };
  const source = sourceStore.documents.find((row) => row.id === imported.document.id)!;
  const pageText = 'left \n\u2003 right';
  const page = source.pages[1];
  if (!page) throw new Error('synthetic_pdf_page_missing');
  page.text = pageText;
  page.text_sha256 = sha(pageText);
  const sourceProjection: Record<string, unknown> = { ...source };
  delete sourceProjection.record_sha256;
  source.record_sha256 = sha(JSON.stringify(sourceProjection));
  await writeFile(documentPath, JSON.stringify(sourceStore, null, 2) + '\n');

  const documentRef = (await listPrivateDocuments(workspace)).documents.find(
    (row) => row.ref.id === imported.document.id,
  )!.ref;
  const readerId = 'a32db7a3-56e4-48d0-85f1-ef1e15a6b2ea';
  const reader = await createPrivateReader(workspace, {
    id: readerId,
    document_ref: documentRef,
    raw_sha256: imported.document.raw_sha256,
    page: 2,
  });
  const expectedRevision = reader.reader.revision;
  const expectedDigest = reader.reader.digest;
  const whitespace = [' ', '\n', '\u2003', ' \n\u2003'];
  const start = pageText.indexOf('left') + 'left'.length;
  for (const [index, quote] of whitespace.entries()) {
    await expect(
      revisePrivateReader(workspace, {
        id: readerId,
        expected_revision: expectedRevision,
        expected_digest: expectedDigest,
        add_annotations: [
          {
            id: `b32db7a3-56e4-48d0-85f1-ef1e15a6b2e${index}`,
            page: 2,
            start,
            end: start + quote.length,
            quote,
            page_sha256: page.text_sha256,
            note: 'Whitespace is not a passage',
          },
        ],
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      researchQuestion('Check this source', {
        sources: [{ uri: `http://127.0.0.1:5178/whitespace/${index}`, text: quote }],
        model: 'must-not-run',
        lease: join(workspace, 'invalid-source-must-not-acquire'),
      }),
    ).rejects.toThrow(/invalid_sources/u);
  }
  expect((await openPrivateReader(workspace, readerId)).reader).toMatchObject({
    revision: expectedRevision,
    digest: expectedDigest,
    annotations: [],
  });
  await expect(readFile(join(workspace, 'invalid-source-must-not-acquire'))).rejects.toMatchObject({
    code: 'ENOENT',
  });

  const validQuote = 'left';
  const valid = await revisePrivateReader(workspace, {
    id: readerId,
    expected_revision: expectedRevision,
    expected_digest: expectedDigest,
    add_annotations: [
      {
        id: 'c32db7a3-56e4-48d0-85f1-ef1e15a6b2ea',
        page: 2,
        start: 0,
        end: validQuote.length,
        quote: validQuote,
        page_sha256: page.text_sha256,
        note: '',
      },
    ],
  });
  const selected = await selectPrivateReaderAnnotations(
    workspace,
    {
      id: readerId,
      expected_revision: valid.reader.revision,
      expected_digest: valid.reader.digest,
      annotation_ids: ['c32db7a3-56e4-48d0-85f1-ef1e15a6b2ea'],
    },
    'http://127.0.0.1:5178',
  );
  expect(selected.sources[0]?.text).toBe(validQuote);
  expect(selected.manifest).toMatchObject({ selections: [{ start: 0, end: 4, quote: 'left' }] });

  const readerPath = join(workspace, '.signals/private-reader.json');
  const retainedStore = JSON.parse(await readFile(readerPath, 'utf8')) as {
    readers: Array<{
      digest: string;
      annotations: Array<{
        start: number;
        end: number;
        quote: string;
        [key: string]: unknown;
      }>;
      [key: string]: unknown;
    }>;
  };
  const retained = retainedStore.readers[0]!;
  const saved = retained.annotations[0]!;
  saved.start = start;
  saved.end = start + 3;
  saved.quote = pageText.slice(start, start + 3);
  const readerProjection: Record<string, unknown> = { ...retained };
  delete readerProjection.digest;
  retained.digest = sha(JSON.stringify(readerProjection));
  await writeFile(readerPath, JSON.stringify(retainedStore, null, 2) + '\n');
  await expect(openPrivateReader(workspace, readerId)).rejects.toMatchObject({ status: 503 });
  await expect(
    selectPrivateReaderAnnotations(
      workspace,
      {
        id: readerId,
        expected_revision: valid.reader.revision,
        expected_digest: retained.digest,
        annotation_ids: ['c32db7a3-56e4-48d0-85f1-ef1e15a6b2ea'],
      },
      'http://127.0.0.1:5178',
    ),
  ).rejects.toMatchObject({ status: 503 });
});
