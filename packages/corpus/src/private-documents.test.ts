import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, expect, it } from 'vitest';
import { researchQuestion } from '@pradeeptathineni/research-ai';
import {
  importPrivateDocument,
  listPrivateDocuments,
  openPrivateDocument,
  privateDocumentSections,
  readPrivatePdfBytes,
  selectPrivateDocument,
} from './private-documents.js';
import { searchApi } from './search-api.js';

const roots: string[] = [];
const servers: Server[] = [];
async function privateRoot() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-private-documents-')));
  roots.push(root);
  return root;
}
function pdf(texts: string[], padding = '') {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${texts.map((_, index) => `${index * 2 + 3} 0 R`).join(' ')}] /Count ${texts.length} >>`,
    ...texts.flatMap((text, index) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${texts.length * 2 + 3} 0 R >> >> /Contents ${index * 2 + 4} 0 R >>`,
      `<< /Length ${Buffer.byteLength(`BT /F1 18 Tf 72 720 Td (${text}) Tj ET`)} >>\nstream\nBT /F1 18 Tf 72 720 Td (${text}) Tj ET\nendstream`,
    ]),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = `%PDF-1.4\n${padding}`;
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
function bookmarkedPdf() {
  const source = `
import sys
from io import BytesIO
from pypdf import PdfReader, PdfWriter
from pypdf.constants import PageLabelStyle

writer = PdfWriter(clone_from=PdfReader(BytesIO(sys.stdin.buffer.read())))
intro = writer.add_outline_item('Introduction', 0)
writer.add_outline_item('Repeated heading', 1, parent=intro)
writer.add_outline_item('Repeated heading', 2, parent=intro)
writer.add_outline_item('Repeated heading', 3)
writer.set_page_label(0, 2, PageLabelStyle.LOWERCASE_ROMAN)
output = BytesIO()
writer.write(output)
sys.stdout.buffer.write(output.getvalue())
`;
  return execFileSync('python3', ['-c', source], {
    input: pdf(['Page one', 'Page two', 'Page three', 'Page four', 'Page five', 'Page six']),
    maxBuffer: 1024 * 1024,
  });
}
function boundedOutlinePdf(count: number, nested: boolean) {
  const source = `
import sys
from io import BytesIO
from pypdf import PdfReader, PdfWriter

writer = PdfWriter(clone_from=PdfReader(BytesIO(sys.stdin.buffer.read())))
if ${nested ? 'True' : 'False'}:
    parent = None
    for index in range(${count}):
        parent = writer.add_outline_item(f'Level {index}', 0, parent=parent)
else:
    for index in range(${count}):
        writer.add_outline_item(f'Bookmark {index}', 0)
output = BytesIO()
writer.write(output)
sys.stdout.buffer.write(output.getvalue())
`;
  return execFileSync('python3', ['-c', source], {
    input: pdf(['Page one']),
    maxBuffer: 1024 * 1024,
  });
}
function encoded(bytes: Buffer) {
  return {
    name: 'folders/source.pdf',
    media_type: 'application/pdf' as const,
    bytes_base64: bytes.toString('base64'),
  };
}
async function serverFor(root: string) {
  const handler = searchApi(root);
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
  if (!address || typeof address === 'string') throw new Error('expected_ephemeral_loopback_port');
  const base = `http://127.0.0.1:${address.port}/signals-ai/__signals/api/`;
  const session = (await (await fetch(new URL('session', base))).json()) as { token: string };
  const init = await fetch(new URL('request-scope', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signals-token': session.token },
    body: '{}',
  });
  const scope = (await init.json()) as { identity: string; epoch: string };
  return {
    base,
    headers: {
      'content-type': 'application/json',
      'x-signals-provider-version': '1.0',
      'x-signals-instance-id': scope.identity,
      'x-signals-owner-epoch': scope.epoch,
      'x-signals-token': session.token,
    },
  };
}
afterEach(async () => {
  for (const server of servers.splice(0))
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('imports a real two-page text PDF, reopens exact page digests and freezes only page two for replay Research', async () => {
  const root = await privateRoot();
  const bin = join(root, 'bin');
  await mkdir(bin);
  const invocations = join(root, 'codex-executions');
  const promptPath = join(root, 'frozen-prompt.json');
  const fake = join(bin, 'codex');
  const previousPath = process.env.PATH;
  await writeFile(
    fake,
    `#!/bin/sh
if [ "$1" = --version ]; then printf '%s\\n' 'codex-cli 0.160.0'; exit 0; fi
if [ "$1" = login ]; then printf '%s\\n' 'Logged in'; exit 0; fi
if [ "$1" = exec ] && [ "$2" = --help ]; then printf '%s\\n' 'Usage: codex exec --ignore-user-config --ignore-rules --ephemeral --skip-git-repo-check --sandbox --json --output-schema --cd --model --config'; exit 0; fi
if [ "$1" = exec ]; then printf '%s\\n' exec >> '${invocations}'; cat > '${promptPath}'; printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Replay provider answered from supplied frozen text."}}'; printf '%s\\n' '{"type":"turn.completed"}'; exit 0; fi
exit 1
`,
    { mode: 0o700 },
  );
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  try {
    const bytes = pdf(['Page one: alpha', 'Page two: beta']);
    const imported = await importPrivateDocument(root, encoded(bytes));
    expect(imported.document.pages.map((page) => page.text)).toEqual([
      'Page one: alpha',
      'Page two: beta',
    ]);
    expect(imported.document.raw_sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(imported.document.pages[0]!.text_sha256).not.toBe(
      imported.document.pages[1]!.text_sha256,
    );
    await expect(readFile(invocations, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const listed = await listPrivateDocuments(root);
    expect(listed.documents[0]).not.toHaveProperty('pages');
    expect(listed.documents[0]).not.toHaveProperty('raw_base64');
    const reopened = await openPrivateDocument(root, imported.document.id);
    expect(reopened.ref).toEqual(imported.ref);
    const selected = await selectPrivateDocument(
      root,
      { document_ref: reopened.ref, pages: [2] },
      'http://127.0.0.1:5178',
    );
    expect(selected.pages).toEqual([2]);
    expect(selected.sources).toHaveLength(1);
    expect(selected.sources[0]).toMatchObject({
      uri: `http://127.0.0.1:5178/signals-ai/__signals/api/private-documents/${imported.document.id}/pages/2`,
      text: 'Page two: beta',
      observedAt: imported.document.imported_at,
    });
    const result = await researchQuestion('What does the selected page say?', {
      sources: selected.sources,
      model: 'fixture-model',
      effort: 'low',
      lease: join(root, 'research-lease'),
    });
    expect(result.status).toBe('complete');
    expect(result.receipt).toMatchObject({
      mode: 'frozen',
      source: [
        {
          uri: selected.sources[0]!.uri,
          sha256: createHash('sha256').update(selected.sources[0]!.text, 'utf8').digest('hex'),
        },
      ],
    });
    const prompt = await readFile(promptPath, 'utf8');
    expect(prompt).toContain('Page two: beta');
    expect(prompt).not.toContain('Page one: alpha');
  } finally {
    process.env.PATH = previousPath;
  }
});

it('keeps HTML inert and preserves Markdown Unicode', async () => {
  const root = await privateRoot();
  const html = await importPrivateDocument(root, {
    name: 'page.html',
    media_type: 'text/html',
    bytes_base64: Buffer.from(
      '<html><body><main><p>Visible Ω</p><script>PRIVATE_SCRIPT_SENTINEL</script></main></body></html>',
    ).toString('base64'),
  });
  expect(html.document.pages[0]!.text).toContain('Visible Ω');
  expect(html.document.pages[0]!.text).not.toContain('PRIVATE_SCRIPT_SENTINEL');
  const markdown = await importPrivateDocument(root, {
    name: 'notes.md',
    media_type: 'text/markdown',
    bytes_base64: Buffer.from('# Résumé 😀\n').toString('base64'),
  });
  expect(markdown.document.pages[0]!.text).toBe('# Résumé 😀\n');
});

it('refuses malformed, encrypted, image-only, oversized and unavailable-parser PDFs', async () => {
  const root = await privateRoot();
  await expect(
    importPrivateDocument(root, encoded(Buffer.from('%PDF-1.4\nnot a pdf'))),
  ).rejects.toMatchObject({ code: 'pdf_malformed_or_unsupported' });
  const python = process.env.PYTHON ?? 'python3';
  const encrypted = execFileSync(python, [
    '-c',
    'import io,sys\nfrom pypdf import PdfWriter\nw=PdfWriter(); w.add_blank_page(width=72,height=72); w.encrypt(""); b=io.BytesIO(); w.write(b); sys.stdout.buffer.write(b.getvalue())',
  ]);
  await expect(importPrivateDocument(root, encoded(encrypted))).rejects.toMatchObject({
    code: 'pdf_encrypted',
  });
  await expect(importPrivateDocument(root, encoded(pdf([''])))).rejects.toMatchObject({
    code: 'invalid_private_document',
  });
  await expect(
    importPrivateDocument(root, encoded(pdf(['Text'], `%${'x'.repeat(130_000)}\n`))),
  ).resolves.toMatchObject({ document: { pages: [{ text: 'Text' }] } });
  await expect(
    importPrivateDocument(root, {
      name: 'large',
      media_type: 'text/plain',
      bytes_base64: Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64'),
    }),
  ).rejects.toMatchObject({ code: 'invalid_private_document' });
  await expect(
    importPrivateDocument(root, encoded(pdf(['Text'])), { python: join(root, 'missing-python') }),
  ).rejects.toMatchObject({ code: 'pdf_parser_unavailable' });
});

it('imports, reopens and returns a valid PDF at the original-byte limit', async () => {
  const root = await privateRoot();
  const limit = 4 * 1024 * 1024;
  const pages = ['A valid PDF at the byte limit'];
  let bytes = pdf(pages);
  let padding = limit - bytes.length;
  // Keep inert padding before xref so EOF lookup does not scan megabytes of whitespace.
  for (let attempt = 0; attempt < 3 && bytes.length !== limit; attempt++) {
    bytes = pdf(pages, `%${'x'.repeat(padding - 2)}\n`);
    padding += limit - bytes.length;
  }
  expect(bytes.length).toBe(limit);

  const imported = await importPrivateDocument(root, encoded(bytes));
  expect(imported.document.raw_sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(imported.document.pages).toMatchObject([
    { number: 1, text: 'A valid PDF at the byte limit' },
  ]);

  const reopened = await openPrivateDocument(root, imported.document.id);
  expect(reopened.ref).toEqual(imported.ref);
  expect(reopened.document.raw_sha256).toBe(imported.document.raw_sha256);
  const original = await readPrivatePdfBytes(root, {
    document_ref: reopened.ref,
    raw_sha256: reopened.document.raw_sha256,
  });
  expect(Buffer.from(original.bytes_base64, 'base64').equals(bytes)).toBe(true);
}, 15_000);

it('retains and reopens all 64 pages, including late-page frozen citations', async () => {
  const root = await privateRoot();
  const texts = Array.from({ length: 64 }, (_, index) => {
    const number = index + 1;
    const marker =
      number === 1 || number === 61 || number === 64
        ? `Coverage citation on page ${number}. `
        : `Page ${number}. `;
    return marker + 'x'.repeat(820 - marker.length);
  });
  const bytes = pdf(texts);
  const imported = await importPrivateDocument(root, encoded(bytes));
  expect(imported.document.pages).toHaveLength(64);
  expect(imported.document.pages.reduce((sum, page) => sum + page.text.length, 0)).toBeGreaterThan(
    48_000,
  );
  expect(imported.document.raw_sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(imported.document.pages[60]!.text).toContain('Coverage citation on page 61.');

  const listed = await listPrivateDocuments(root);
  expect(listed.documents[0]).toMatchObject({
    page_count: 64,
    raw_sha256: imported.document.raw_sha256,
  });
  expect(listed.documents[0]).not.toHaveProperty('pages');
  const reopened = await openPrivateDocument(root, imported.document.id);
  expect(reopened.ref).toEqual(imported.ref);
  expect(reopened.document.pages.map((page) => page.text_sha256)).toEqual(
    imported.document.pages.map((page) => page.text_sha256),
  );
  const selected = await selectPrivateDocument(
    root,
    { document_ref: reopened.ref, pages: [1, 61, 64] },
    'http://127.0.0.1:5178',
  );
  expect(selected.pages).toEqual([1, 61, 64]);
  expect(selected.sources[1]!.text).toContain('Coverage citation on page 61.');
  await expect(
    privateDocumentSections(root, {
      document_ref: reopened.ref,
      raw_sha256: reopened.document.raw_sha256,
    }),
  ).resolves.toMatchObject({ outcome: 'absent', nodes: [], omitted: 0 });
}, 30_000);

it('refuses page, text and raw-byte overages before changing retained bytes', async () => {
  const root = await privateRoot();
  await importPrivateDocument(root, {
    name: 'retained.txt',
    media_type: 'text/plain',
    bytes_base64: Buffer.from('keep this record').toString('base64'),
  });
  const path = join(root, '.signals/private-documents.json');
  const before = await readFile(path);
  const cases: Array<[unknown, string]> = [
    [encoded(pdf(Array.from({ length: 257 }, () => 'Over page limit'))), 'pdf_page_limit'],
    [
      {
        name: 'too-long.txt',
        media_type: 'text/plain',
        bytes_base64: Buffer.from('x'.repeat(256_001)).toString('base64'),
      },
      'invalid_private_document',
    ],
    [
      {
        name: 'too-large.txt',
        media_type: 'text/plain',
        bytes_base64: Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64'),
      },
      'invalid_private_document',
    ],
  ];
  for (const [input, code] of cases) {
    await expect(importPrivateDocument(root, input)).rejects.toMatchObject({ code });
    expect(await readFile(path)).toEqual(before);
  }
}, 30_000);

it('refuses aggregate raw-byte and serialized-store overages without changing retained bytes', async () => {
  const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
  const record = (index: number, raw: Buffer, text: string) => {
    const draft = {
      schema_version: '1.0',
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      name: `seed-${index}.txt`,
      media_type: 'text/plain',
      imported_at: '2026-10-25T00:00:00.000Z',
      raw_base64: raw.toString('base64'),
      raw_sha256: digest(raw),
      extractor: 'operator-text-v1',
      pages: [{ number: 1, text, text_sha256: digest(text) }],
      qualification: ['Seeded valid private fixture record.'],
    };
    return { ...draft, record_sha256: digest(JSON.stringify(draft)) };
  };
  const seed = async (root: string, documents: object[]) => {
    const directory = join(root, '.signals');
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'private-documents.json');
    await writeFile(path, JSON.stringify({ schema_version: '1.0', documents }));
    return { path, bytes: await readFile(path) };
  };

  const aggregateRoot = await privateRoot();
  const aggregateRaw = Buffer.alloc(1024 * 1024, 'r');
  const aggregateStore = await seed(
    aggregateRoot,
    Array.from({ length: 12 }, (_, index) => record(index, aggregateRaw, 'seed')),
  );
  await expect(
    importPrivateDocument(aggregateRoot, {
      name: 'aggregate-overage.txt',
      media_type: 'text/plain',
      bytes_base64: Buffer.from('x').toString('base64'),
    }),
  ).rejects.toMatchObject({ code: 'private_document_unavailable' });
  expect((await readFile(aggregateStore.path)).equals(aggregateStore.bytes)).toBe(true);

  const storeRoot = await privateRoot();
  const pageText = 'x'.repeat(256_000);
  const sourceBytes = Buffer.alloc(600_000, 'x');
  const storeDocuments = Array.from({ length: 19 }, (_, index) =>
    record(index, sourceBytes, pageText),
  );
  const store = await seed(storeRoot, storeDocuments);
  expect(store.bytes.length).toBeLessThan(20 * 1024 * 1024);
  let probe = pdf(['z'.repeat(255_000)]);
  let padding = 600_000 - probe.length;
  for (let attempt = 0; attempt < 3 && probe.length !== 600_000; attempt++) {
    probe = pdf(['z'.repeat(255_000)], `%${'x'.repeat(padding - 2)}\n`);
    padding += 600_000 - probe.length;
  }
  expect(probe.length).toBe(600_000);
  await expect(importPrivateDocument(storeRoot, encoded(probe))).rejects.toMatchObject({
    code: 'private_document_unavailable',
  });
  expect((await readFile(store.path)).equals(store.bytes)).toBe(true);
}, 60_000);

it('refuses malformed base64 padding and nonalphabet characters without decoding them as bytes', async () => {
  const root = await privateRoot();
  for (const bytes_base64 of ['eA===', 'eA$=']) {
    await expect(
      importPrivateDocument(root, {
        name: 'invalid.pdf',
        media_type: 'application/pdf',
        bytes_base64,
      }),
    ).rejects.toMatchObject({ code: 'invalid_private_document' });
  }
});

it('rejects rehashed inconsistent private state and stale exact document refs', async () => {
  const root = await privateRoot();
  const imported = await importPrivateDocument(root, {
    name: 'notes.txt',
    media_type: 'text/plain',
    bytes_base64: Buffer.from('original text').toString('base64'),
  });
  const path = join(root, '.signals/private-documents.json');
  const stored = JSON.parse(await readFile(path, 'utf8')) as {
    documents: Array<Record<string, unknown>>;
  };
  const record = stored.documents[0]!;
  const page = (record.pages as Array<Record<string, unknown>>)[0]!;
  page.text = 'changed text';
  page.text_sha256 = createHash('sha256').update('changed text').digest('hex');
  await writeFile(path, JSON.stringify(stored));
  await expect(openPrivateDocument(root, imported.document.id)).rejects.toMatchObject({
    code: 'private_document_unavailable',
  });
});

it('reads stable bookmark sections with physical ranges and exact document identity', async () => {
  const root = await privateRoot();
  const bytes = bookmarkedPdf();
  const imported = await importPrivateDocument(root, encoded(bytes));
  const input = { document_ref: imported.ref, raw_sha256: imported.document.raw_sha256 };
  const first = await privateDocumentSections(root, input);
  const reopened = await privateDocumentSections(root, input);
  expect(first).toMatchObject({
    document_ref: imported.ref,
    raw_sha256: imported.document.raw_sha256,
    extractor: 'pypdf-6.15.0',
    outcome: 'available',
    omitted: 0,
    nodes: [
      { title: 'Introduction', parent_id: null, physical_start: 1, physical_end: 3 },
      { title: 'Repeated heading', physical_start: 2, physical_end: 2 },
      { title: 'Repeated heading', physical_start: 3, physical_end: 3 },
      { title: 'Repeated heading', parent_id: null, physical_start: 4, physical_end: 6 },
    ],
  });
  expect(first.nodes.map((node) => node.id)).toEqual(reopened.nodes.map((node) => node.id));
  expect(new Set(first.nodes.map((node) => node.id)).size).toBe(4);
  await expect(
    privateDocumentSections(root, { ...input, raw_sha256: '0'.repeat(64) }),
  ).rejects.toMatchObject({ code: 'provider_record_changed' });
  await expect(
    privateDocumentSections(root, { ...input, path: '/private/source.pdf' }),
  ).rejects.toMatchObject({ code: 'invalid_private_document' });
});

it('reports no outline as absent and keeps the section API under the existing private route guard', async () => {
  const root = await privateRoot();
  const imported = await importPrivateDocument(root, encoded(pdf(['Page one', 'Page two'])));
  const input = { document_ref: imported.ref, raw_sha256: imported.document.raw_sha256 };
  await expect(privateDocumentSections(root, input)).resolves.toMatchObject({
    document_ref: imported.ref,
    outcome: 'absent',
    nodes: [],
    omitted: 0,
  });
  const api = await serverFor(root);
  const noToken = await fetch(new URL('private-documents/sections', api.base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  expect(noToken.status).toBe(403);
  const response = await fetch(new URL('private-documents/sections', api.base), {
    method: 'POST',
    headers: api.headers,
    body: JSON.stringify(input),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    document_ref: imported.ref,
    raw_sha256: imported.document.raw_sha256,
    outcome: 'absent',
    nodes: [],
  });
  const query = await fetch(new URL('private-documents/sections?path=/etc/passwd', api.base), {
    method: 'POST',
    headers: api.headers,
    body: JSON.stringify(input),
  });
  expect(query.status).toBe(400);
});

it('bounds bookmark count and nesting without silently omitting a count', async () => {
  const root = await privateRoot();
  const many = await importPrivateDocument(root, encoded(boundedOutlinePdf(205, false)));
  const deep = await importPrivateDocument(root, encoded(boundedOutlinePdf(20, true)));
  const limitedCount = await privateDocumentSections(root, {
    document_ref: many.ref,
    raw_sha256: many.document.raw_sha256,
  });
  expect(limitedCount).toMatchObject({ outcome: 'available', omitted: 5 });
  expect(limitedCount.nodes).toHaveLength(200);
  const limitedDepth = await privateDocumentSections(root, {
    document_ref: deep.ref,
    raw_sha256: deep.document.raw_sha256,
  });
  expect(limitedDepth).toMatchObject({ outcome: 'available', omitted: 4 });
  expect(limitedDepth.nodes).toHaveLength(16);
});

it('guards bounded import, exact page reads, query fields, token and owner origin over loopback HTTP', async () => {
  const root = await privateRoot();
  const api = await serverFor(root);
  const unauthenticated = await fetch(new URL('private-documents', api.base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x', media_type: 'text/plain', bytes_base64: 'eA==' }),
  });
  expect(unauthenticated.status).toBe(403);
  const pathImport = await fetch(new URL('private-documents', api.base), {
    method: 'POST',
    headers: api.headers,
    body: JSON.stringify({
      name: 'notes.txt',
      media_type: 'text/plain',
      bytes_base64: Buffer.from('text').toString('base64'),
      path: '/etc/passwd',
    }),
  });
  expect(pathImport.status).toBe(400);
  const importResponse = await fetch(new URL('private-documents', api.base), {
    method: 'POST',
    headers: api.headers,
    body: JSON.stringify(encoded(pdf(['Page one', 'Page two'], `%${'x'.repeat(130_000)}\n`))),
  });
  expect(importResponse.status).toBe(201);
  const imported = (await importResponse.json()) as {
    ref: { id: string };
    document: { pages: Array<{ text_sha256: string }> };
  };
  const list = await fetch(new URL('private-documents', api.base), { headers: api.headers });
  expect(list.status).toBe(200);
  const page = await fetch(new URL(`private-documents/${imported.ref.id}/pages/2`, api.base), {
    headers: api.headers,
  });
  expect(page.status).toBe(200);
  expect(await page.json()).toMatchObject({
    document_ref: imported.ref,
    page: { number: 2, text: 'Page two' },
  });
  const extraQuery = await fetch(
    new URL(`private-documents/${imported.ref.id}?path=/etc/passwd`, api.base),
    { headers: api.headers },
  );
  expect(extraQuery.status).toBe(400);
  const wrongOrigin = await fetch(new URL('private-documents/selection', api.base), {
    method: 'POST',
    headers: { ...api.headers, origin: 'https://untrusted.invalid' },
    body: JSON.stringify({ document_ref: imported.ref, pages: [2] }),
  });
  expect(wrongOrigin.status).toBe(403);
  const wrongEpoch = await fetch(new URL('private-documents/selection', api.base), {
    method: 'POST',
    headers: {
      ...api.headers,
      'x-signals-owner-epoch': '00000000-0000-4000-8000-000000000000',
    },
    body: JSON.stringify({ document_ref: imported.ref, pages: [2] }),
  });
  expect(wrongEpoch.status).toBe(409);
  const unknownField = await fetch(new URL('private-documents/selection', api.base), {
    method: 'POST',
    headers: api.headers,
    body: JSON.stringify({ document_ref: imported.ref, pages: [2], path: '/etc/passwd' }),
  });
  expect(unknownField.status).toBe(400);
  const selection = await fetch(new URL('private-documents/selection', api.base), {
    method: 'POST',
    headers: api.headers,
    body: JSON.stringify({ document_ref: imported.ref, pages: [2] }),
  });
  expect(selection.status).toBe(200);
  expect(await selection.json()).toMatchObject({ pages: [2], sources: [{ text: 'Page two' }] });
});
