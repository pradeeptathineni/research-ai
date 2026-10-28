import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { researchQuestion } from '@pradeeptathineni/research-ai';
import { importPrivateDocument, listPrivateDocuments } from './private-documents.js';
import { isWellFormedUnicode, type RecordRef } from './source-captures.js';
import {
  listPrivateCollection,
  openPrivateCollection,
  previewPrivateCollection,
  selectPrivateCollection,
} from './private-collection.js';
import { searchApi } from './search-api.js';

const roots: string[] = [];
const servers: Server[] = [];
async function root() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'signals-private-collection-')));
  roots.push(path);
  return path;
}
afterEach(async () => {
  for (const server of servers.splice(0))
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});
const id = 'a4bb329b-6464-47b4-8f6a-ae98c12294cd';

it('searches every chosen source, reopens immutably and exports only selected snippets', async () => {
  const workspace = await root();
  const a = await importPrivateDocument(workspace, {
    name: 'retention-seven.txt',
    media_type: 'text/plain',
    bytes_base64: Buffer.from('Backups retain records for seven days.').toString('base64'),
  });
  const b = await importPrivateDocument(workspace, {
    name: 'retention-thirty.txt',
    media_type: 'text/plain',
    bytes_base64: Buffer.from('Backups retain records for thirty days.').toString('base64'),
  });
  await importPrivateDocument(workspace, {
    name: 'private-canary.txt',
    media_type: 'text/plain',
    bytes_base64: Buffer.from('private canary not selected').toString('base64'),
  });
  const docs = await listPrivateDocuments(workspace);
  const refs = [a.ref, b.ref];
  expect(docs.documents).toHaveLength(3);
  const request = { id, query: 'backup retention days', document_refs: refs, max_candidates: 24 };
  const preview = await previewPrivateCollection(workspace, request);
  expect(preview.state).toBe('matched');
  expect(new Set(preview.candidates.map((row) => row.name))).toEqual(
    new Set(['retention-seven.txt', 'retention-thirty.txt']),
  );
  expect((await openPrivateCollection(workspace, id)).preview_digest).toBe(preview.preview_digest);
  expect((await listPrivateCollection(workspace)).previews).toHaveLength(1);
  await expect(
    previewPrivateCollection(workspace, { ...request, query: 'retention days' }),
  ).rejects.toMatchObject({ status: 409 });

  const chosen = preview.candidates.find((row) => row.name === 'retention-thirty.txt')!;
  const exported = await selectPrivateCollection(
    workspace,
    {
      query_id: id,
      preview_digest: preview.preview_digest,
      candidate_ids: [chosen.id],
    },
    'http://127.0.0.1:5178',
  );
  expect(exported.sources).toHaveLength(1);
  expect(exported.sources[0]?.text).toBe('Backups retain records for thirty days.');
  expect(JSON.stringify(exported)).not.toContain('private canary');
  expect(exported.manifest[0]).toMatchObject({ document_ref: b.ref, page: 1, start: 0, end: 39 });

  const bin = join(workspace, 'fixture-bin');
  const invocationPath = join(workspace, 'fixture-invocations');
  const promptPath = join(workspace, 'fixture-prompt');
  await mkdir(bin);
  const previousPath = process.env.PATH;
  await writeFile(
    join(bin, 'codex'),
    `#!/bin/sh
if [ "$1" = --version ]; then printf '%s\\n' 'codex-cli 0.160.0'; exit 0; fi
if [ "$1" = login ]; then printf '%s\\n' 'Logged in'; exit 0; fi
if [ "$1" = exec ] && [ "$2" = --help ]; then printf '%s\\n' 'Usage: codex exec --ignore-user-config --ignore-rules --ephemeral --skip-git-repo-check --sandbox --json --output-schema --cd --model --config'; exit 0; fi
if [ "$1" = exec ]; then printf '%s\\n' exec >> '${invocationPath}'; cat > '${promptPath}'; printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Offline fixture consumed selected frozen text."}}'; printf '%s\\n' '{"type":"turn.completed"}'; exit 0; fi
exit 1
`,
    { mode: 0o700 },
  );
  await chmod(join(bin, 'codex'), 0o700);
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  try {
    const replay = await researchQuestion('Inspect the selected retention passage.', {
      sources: exported.sources,
      model: 'fixture-model',
      effort: 'low',
      lease: join(workspace, 'research-fixture-lease'),
    });
    expect(replay.status).toBe('complete');
    expect(replay.receipt).toMatchObject({
      mode: 'frozen',
      source: [{ sha256: createHash('sha256').update(exported.sources[0]!.text).digest('hex') }],
    });
    expect(await readFile(invocationPath, 'utf8')).toBe('exec\n');
    const prompt = await readFile(promptPath, 'utf8');
    expect(prompt).toContain(exported.sources[0]!.text);
    expect(prompt).not.toContain('private canary');
  } finally {
    process.env.PATH = previousPath;
  }
  await expect(
    selectPrivateCollection(
      workspace,
      {
        query_id: id,
        preview_digest: preview.preview_digest,
        candidate_ids: ['f'.repeat(64)],
      },
      'http://127.0.0.1:5178',
    ),
  ).rejects.toMatchObject({ status: 400 });
});

it('keeps no-match explicit and refuses a changed backing extraction on reopen', async () => {
  const workspace = await root();
  const doc = await importPrivateDocument(workspace, {
    name: 'one.txt',
    media_type: 'text/plain',
    bytes_base64: Buffer.from('The source says nothing about the query.').toString('base64'),
  });
  const noMatch = await previewPrivateCollection(workspace, {
    id,
    query: 'xylophone',
    document_refs: [doc.ref],
  });
  expect(noMatch.state).toBe('no_match');
  expect(noMatch.candidates).toEqual([]);
  const path = join(workspace, '.signals/private-documents.json');
  const store = JSON.parse(await readFile(path, 'utf8')) as { documents: Array<{ name: string }> };
  store.documents[0]!.name = 'tampered.txt';
  await writeFile(path, JSON.stringify(store));
  await expect(openPrivateCollection(workspace, id)).rejects.toMatchObject({ status: 503 });
});

it('finds terms crossing a window edge and searches late documents beyond the old passage cap', async () => {
  const workspace = await root();
  const refs: RecordRef[] = [];
  for (let index = 0; index < 20; index++) {
    let content = 'z'.repeat(48000);
    if (index === 0)
      content = `${'z'.repeat(799)}😀 ${'z'.repeat(194)} retention ${'z'.repeat(48000 - 1007)}`;
    if (index === 19) content = `${'zz '.repeat(15997)}retention`;
    const imported = await importPrivateDocument(workspace, {
      name: `selected-${index + 1}.txt`,
      media_type: 'text/plain',
      bytes_base64: Buffer.from(content).toString('base64'),
    });
    refs.push(imported.ref);
  }
  const preview = await previewPrivateCollection(workspace, {
    id,
    query: 'retention',
    document_refs: refs,
    max_candidates: 24,
  });
  expect(preview.state).toBe('matched');
  expect(preview.candidates.map((row) => row.name)).toContain('selected-1.txt');
  expect(preview.candidates.map((row) => row.name)).toContain('selected-20.txt');
  for (const row of preview.candidates) {
    expect(row.quote).toBeTruthy();
    expect(isWellFormedUnicode(row.quote)).toBe(true);
    expect(row.start).toBeGreaterThanOrEqual(0);
    expect(row.end - row.start).toBe(row.quote.length);
  }
});

it('serves preview, reopen and selection through the guarded owner HTTP route', async () => {
  const workspace = await root();
  const handler = searchApi(workspace);
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
  if (!address || typeof address === 'string') throw new Error('loopback_server_address_missing');
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
  const imported = await importPrivateDocument(workspace, {
    name: 'http-private.txt',
    media_type: 'text/plain',
    bytes_base64: Buffer.from('HTTP local retention evidence.').toString('base64'),
  });
  const previewResponse = await fetch(new URL('private-collection/preview', base), {
    method: 'POST',
    headers,
    body: JSON.stringify({ id, query: 'retention', document_refs: [imported.ref] }),
  });
  expect(previewResponse.status).toBe(200);
  const preview = (await previewResponse.json()) as Awaited<
    ReturnType<typeof previewPrivateCollection>
  >;
  const reopened = await fetch(new URL(`private-collection/${id}`, base), { headers });
  expect(reopened.status).toBe(200);
  const selectionResponse = await fetch(new URL('private-collection/selection', base), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query_id: id,
      preview_digest: preview.preview_digest,
      candidate_ids: [preview.candidates[0]!.id],
    }),
  });
  expect(selectionResponse.status).toBe(200);
  const selected = (await selectionResponse.json()) as Awaited<
    ReturnType<typeof selectPrivateCollection>
  >;
  expect(selected.sources[0]?.text).toBe('HTTP local retention evidence.');
  const denied = await fetch(new URL('private-collection/selection', base), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signals-provider-version': '1.0',
      'x-signals-instance-id': scope.identity,
      'x-signals-owner-epoch': scope.epoch,
    },
    body: '{}',
  });
  expect(denied.status).toBe(403);
});
