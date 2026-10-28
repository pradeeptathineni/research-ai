import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { saveLibraryLead } from './library-leads.js';
import { exactOwnerRecord } from './provider-capabilities.js';
import { searchApi } from './search-api.js';
import type { RecordRef } from './source-captures.js';

const roots: string[] = [];
const servers: Server[] = [];
const executeFile = promisify(execFile);
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('serves guarded capture, annotation, exact provider reads and standalone selection across owner restart', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-captures-http-')));
  roots.push(root);
  const lead = await saveLibraryLead(
    root,
    {
      uri: 'https://example.org/synthetic',
      name: 'Synthetic',
      description: 'Fixture only',
      limits: [],
    },
    '123e4567-e89b-42d3-a456-426614174000',
    'http fixture',
  );
  const source = await exactOwnerRecord(root, {
    owner: 'signals-ai',
    kind: 'lead',
    id: lead.id,
    revision: null,
    digest: null,
  });
  const sourceRef = source.ref as RecordRef;
  let handler = searchApi(root);
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
  if (!address || typeof address === 'string') throw new Error('expected ephemeral TCP listener');
  const base = `http://127.0.0.1:${address.port}/signals-ai/__signals/api/`;
  const sessionResponse = await fetch(new URL('session', base));
  expect(sessionResponse.status).toBe(200);
  const session = (await sessionResponse.json()) as { token: string };
  const initialize = await fetch(new URL('request-scope', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signals-token': session.token },
    body: '{}',
  });
  expect(initialize.status).toBe(200);
  const scope = (await initialize.json()) as { identity: string; epoch: string };
  const headers = {
    'content-type': 'application/json',
    'x-signals-provider-version': '1.0',
    'x-signals-instance-id': scope.identity,
    'x-signals-owner-epoch': scope.epoch,
    'x-signals-token': session.token,
  };
  const text = 'Alpha 😀 beta\r\nA quoted condition.';
  const create = await fetch(new URL('source-captures', base), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      source_ref: sourceRef,
      mode: 'paste',
      text,
      observed_at: '2026-10-23T12:00:00Z',
    }),
  });
  expect(create.status).toBe(201);
  const created = (await create.json()) as { ref: RecordRef; capture: { id: string } };
  const anchor = {
    text_sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    start: 15,
    end: 34,
    quote: 'A quoted condition.',
  };
  const annotationResponse = await fetch(new URL('source-annotations', base), {
    method: 'POST',
    headers,
    body: JSON.stringify({ capture_ref: created.ref, anchor, note: 'Fixture interpretation' }),
  });
  expect(annotationResponse.status).toBe(201);
  const annotation = (await annotationResponse.json()) as { ref: RecordRef };
  const selection = {
    capture_ref: created.ref,
    annotation_refs: [annotation.ref],
  };

  const rejected = await fetch(new URL('source-captures/selection', base), {
    method: 'POST',
    headers: { ...headers, origin: 'https://untrusted.invalid' },
    body: JSON.stringify(selection),
  });
  expect(rejected.status).toBe(403);
  const badShape = await fetch(new URL('source-captures/selection', base), {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...selection, extra: true }),
  });
  expect(badShape.status).toBe(400);
  const wrongEpoch = await fetch(new URL('source-captures/selection', base), {
    method: 'POST',
    headers: { ...headers, 'x-signals-owner-epoch': '00000000-0000-4000-8000-000000000000' },
    body: JSON.stringify(selection),
  });
  expect(wrongEpoch.status).toBe(409);

  const exactQuery = new URLSearchParams({ ref: JSON.stringify(created.ref) });
  const exactResponse = await fetch(new URL(`provider/records?${exactQuery}`, base), {
    headers,
  });
  expect(exactResponse.status).toBe(200);
  const exact = (await exactResponse.json()) as { ref: RecordRef; content: string };
  expect(exact.ref).toEqual(created.ref);
  expect(JSON.parse(exact.content)).toEqual(
    (
      (await (
        await fetch(new URL(`source-captures/${created.capture.id}`, base), { headers })
      ).json()) as { capture: unknown }
    ).capture,
  );

  const { stdout: consumer } = await executeFile(
    process.execPath,
    [
      'scripts/examples/source-capture-consumer.mjs',
      base,
      scope.identity,
      scope.epoch,
      session.token,
      JSON.stringify(created.ref),
      JSON.stringify([annotation.ref]),
    ],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 10000 },
  );
  expect(JSON.parse(consumer)).toMatchObject({ capture_ref: created.ref });

  handler = searchApi(root);
  const reopened = await fetch(new URL(`source-captures/${created.capture.id}`, base), {
    headers,
  });
  expect(reopened.status).toBe(200);
  expect(await reopened.json()).toMatchObject({
    capture: { text },
    annotations: [{ ref: annotation.ref }],
  });
});
