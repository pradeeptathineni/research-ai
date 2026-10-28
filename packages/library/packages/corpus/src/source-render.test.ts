import { createServer, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { extractHtml } from './search-document.js';
import { currentHtmlText } from '../../domain/src/source-text.js';
import { saveLibraryLead } from './library-leads.js';
import { exactOwnerRecord } from './provider-capabilities.js';
import { requestStore } from './search-request-store.js';
import { searchApi } from './search-api.js';
import type { RecordRef } from './source-captures.js';
import {
  openSourceCapture,
  listSourceCaptures,
  type SourceCaptureFetch,
  type SourceResolver,
} from './source-captures.js';
import {
  compareSourceRenderAttachments,
  openSourceRender,
  readSourceRenderBlob,
  readSourceRenderRequest,
  renderSourceCapture,
  renderStaticHtml,
  SourceRenderError,
  type SourceRenderRuntime,
} from './source-render.js';

const roots: string[] = [];
const servers: Server[] = [];
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-source-render-')));
  roots.push(root);
  const scope = await requestStore(root).initialize();
  const lead = await saveLibraryLead(
    root,
    {
      uri: 'https://example.org/static-capture-fixture',
      name: 'Synthetic static source',
      description: 'Authored local rendering fixture; no source claim is tested.',
      limits: [],
    },
    randomUUID(),
    'Authored static capture fixture',
  );
  const exact = await exactOwnerRecord(root, {
    owner: 'signals-ai',
    kind: 'lead',
    id: lead.id,
    revision: null,
    digest: null,
  });
  const sourceRef = exact.ref as RecordRef;
  const resolver: SourceResolver = async (ref) => {
    const current = await exactOwnerRecord(root, ref);
    return { bytes: current.bytes, ref: current.ref as RecordRef };
  };
  let html = (version: number) =>
    `<!doctype html><html><head><title>Fixture ${version}</title><link rel="stylesheet" href="https://blocked.example/site.css"></head><body><h1>Local static heading ${version}</h1><img alt="fixture illustration" src="https://blocked.example/image.png"><script>document.body.dataset.ran = 'yes'</script><p>Rendered fixture version ${version}.</p></body></html>`;
  let fetches = 0;
  const fetcher = async (
    uri: string,
    _signal?: AbortSignal,
    _redirects?: number,
    _allowPdf?: boolean,
    options?: { includeBytes?: boolean },
  ) => {
    fetches++;
    const text = html(fetches);
    const bytes = Buffer.from(text, 'utf8');
    const material = extractHtml(text, uri, currentHtmlText);
    const fetched: SourceCaptureFetch = {
      text: material.text,
      digest: sha(text),
      uri,
      normalizer: currentHtmlText,
      material,
      ...(options?.includeBytes ? { bytes, contentType: 'text/html; charset=utf-8' } : {}),
      response: { status: 200 },
    };
    return fetched;
  };
  const runtime: SourceRenderRuntime = { fetcher };
  return {
    root,
    scope,
    sourceRef,
    resolver,
    runtime,
    setHtml: (next: typeof html) => (html = next),
    getFetches: () => fetches,
  };
}

it('renders static HTML in isolated Chromium without JavaScript or external-resource access', async () => {
  const html = `<!doctype html><html><head>
    <link rel="preconnect" href="https://blocked.example">
    <link rel="dns-prefetch" href="//blocked.example">
    <meta http-equiv="refresh" content="3600;url=https://blocked.example/redirected">
  </head><body><h1>Visible heading</h1>
    <img alt="blocked image" src="https://blocked.example/image.png">
    <script>document.body.dataset.ran="yes"</script>
  </body></html>`;
  const rendered = await renderStaticHtml(html);
  expect(rendered.screenshot.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(rendered.dom.toString()).toContain('Visible heading');
  expect(rendered.dom.toString()).not.toContain('data-ran="yes"');
  expect(rendered.aria.toString()).toContain('Visible heading');
  expect(rendered.blockedRequests).toBeGreaterThan(0);
  expect(rendered.completedExternalRequests).toBe(0);
  expect(rendered.dom.length).toBeLessThanOrEqual(128_000);
  expect(rendered.aria.length).toBeLessThanOrEqual(128_000);
  await expect(renderStaticHtml('<p>' + 'x'.repeat(2_000_001) + '</p>')).rejects.toMatchObject({
    status: 413,
    code: 'source_render_html_limit',
  });
});

it('refuses an immediate main-frame meta-refresh without retaining a capture or manifest', async () => {
  const f = await fixture();
  f.setHtml(
    () => `<!doctype html><html><head>
    <meta http-equiv="refresh" content="0;url=https://blocked.example/redirected">
  </head><body><h1>Must not be captured as the source</h1>
    <img alt="blocked external image" src="https://blocked.example/image.png">
  </body></html>`,
  );
  const requestId = randomUUID();
  const failure = await renderSourceCapture(
    f.root,
    { request_id: requestId, source_ref: f.sourceRef },
    f.resolver,
    f.runtime,
  ).then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(SourceRenderError);
  expect(failure).toMatchObject({
    status: 422,
    code: 'source_render_navigation_blocked',
  });
  expect((failure as SourceRenderError).completedExternalRequests).toBe(0);
  const pending = await readSourceRenderRequest(f.root, requestId);
  expect(pending).toMatchObject({
    state: 'unknown',
    capture_ref: null,
    manifest_ref: null,
  });
  expect((await listSourceCaptures(f.root)).captures).toEqual([]);
  expect(f.getFetches()).toBe(1);
});

it('admits once, binds one exact v1 capture, and reopens digest-checked artifacts and comparison', async () => {
  const f = await fixture();
  const requestId = randomUUID();
  const request = { request_id: requestId, source_ref: f.sourceRef };
  const first = await renderSourceCapture(f.root, request, f.resolver, f.runtime);
  expect(first).toMatchObject({
    schema_version: 'signals-source-render-v1',
    state: 'completed',
    request_id: requestId,
    capture_ref: { owner: 'signals-ai', kind: 'source_capture' },
    manifest_ref: { owner: 'signals-ai', kind: 'source_capture_render' },
    manifest: { renderer: { package_version: '1.63.0', method: 'set-content-static-html-v1' } },
  });
  if (first.state !== 'completed' || !first.capture_ref || !first.manifest_ref || !first.manifest)
    throw new Error('render_fixture_not_completed');
  expect(first.manifest.renderer.blocked_requests).toBeGreaterThan(0);
  expect(first.manifest.omissions).toContain(
    'JavaScript was disabled; dynamic page behavior was not rendered.',
  );
  expect(f.getFetches()).toBe(1);
  const firstCapture = await openSourceCapture(f.root, first.capture_ref.id);
  expect(firstCapture.capture.schema_version).toBe('1.0');
  expect(firstCapture.capture.text).toContain('Local static heading 1');
  expect(firstCapture.capture.text).not.toContain('<script>');
  const reopened = await openSourceRender(f.root, first.capture_ref.id, first.manifest_ref.digest);
  expect(reopened.ref).toEqual(first.manifest_ref);
  // A cold consumer starts with the v1 capture UUID; it need not have cached
  // the manifest digest to discover the sole immutable attachment.
  expect(await openSourceRender(f.root, first.capture_ref.id)).toEqual(reopened);
  await expect(
    openSourceRender(f.root, first.capture_ref.id, '0'.repeat(64)),
  ).rejects.toMatchObject({
    status: 409,
    code: 'source_render_changed',
  });
  const png = await readSourceRenderBlob(
    f.root,
    first.capture_ref.id,
    first.manifest_ref.digest,
    'screenshot',
  );
  const dom = await readSourceRenderBlob(
    f.root,
    first.capture_ref.id,
    first.manifest_ref.digest,
    'dom',
  );
  const aria = await readSourceRenderBlob(
    f.root,
    first.capture_ref.id,
    first.manifest_ref.digest,
    'aria',
  );
  expect(png.mime).toBe('image/png');
  expect(png.bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(dom.mime).toBe('text/plain; charset=utf-8');
  expect(dom.bytes.toString()).toContain('Local static heading 1');
  expect(aria.bytes.toString()).toContain('Local static heading 1');
  expect(sha(png.bytes)).toBe(first.manifest.artifacts.screenshot.sha256);
  expect(sha(dom.bytes)).toBe(first.manifest.artifacts.dom.sha256);
  expect(sha(aria.bytes)).toBe(first.manifest.artifacts.aria.sha256);
  expect(await readSourceRenderRequest(f.root, requestId)).toMatchObject({
    state: 'completed',
    capture_ref: first.capture_ref,
  });

  const duplicate = await renderSourceCapture(f.root, request, f.resolver, f.runtime);
  expect(duplicate).toMatchObject({
    state: 'completed',
    capture_ref: first.capture_ref,
    manifest_ref: first.manifest_ref,
  });
  expect(f.getFetches()).toBe(1);
  const otherLead = await saveLibraryLead(
    f.root,
    {
      uri: 'https://example.org/other-static-capture',
      name: 'Other synthetic source',
      description: 'Second authored fixture.',
      limits: [],
    },
    randomUUID(),
    'Second authored capture fixture',
  );
  const otherRef = (
    await exactOwnerRecord(f.root, {
      owner: 'signals-ai',
      kind: 'lead',
      id: otherLead.id,
      revision: null,
      digest: null,
    })
  ).ref as RecordRef;
  await expect(
    renderSourceCapture(f.root, { ...request, source_ref: otherRef }, f.resolver, f.runtime),
  ).rejects.toMatchObject({ status: 409, code: 'source_render_request_conflict' });
  expect(f.getFetches()).toBe(1);

  const second = await renderSourceCapture(
    f.root,
    { request_id: randomUUID(), source_ref: f.sourceRef, supersedes: first.capture_ref },
    f.resolver,
    f.runtime,
  );
  expect(second.state).toBe('completed');
  if (second.state !== 'completed' || !second.capture_ref)
    throw new Error('successor_fixture_not_completed');
  expect(f.getFetches()).toBe(2);
  const comparison = await compareSourceRenderAttachments(
    f.root,
    first.capture_ref.id,
    second.capture_ref.id,
  );
  expect(comparison).toMatchObject({
    availability_changed: false,
    same_manifest: false,
    artifact_digest_changes: { dom: true, aria: true },
  });
});

it('keeps an uncertain admitted request readback-only when acquisition fails', async () => {
  const f = await fixture();
  let calls = 0;
  const runtime: SourceRenderRuntime = {
    fetcher: async () => {
      calls++;
      throw new Error('synthetic acquisition failure');
    },
  };
  const request = { request_id: randomUUID(), source_ref: f.sourceRef };
  await expect(renderSourceCapture(f.root, request, f.resolver, runtime)).rejects.toMatchObject({
    status: 503,
    code: 'source_capture_unavailable',
  });
  const readback = await readSourceRenderRequest(f.root, request.request_id);
  expect(readback).toMatchObject({ state: 'unknown', capture_ref: null, manifest_ref: null });
  const duplicate = await renderSourceCapture(f.root, request, f.resolver, runtime);
  expect(duplicate).toMatchObject({ state: 'unknown', capture_ref: null });
  expect(calls).toBe(1);
});

it('serves guarded HTTP creation, manifest and inert artifacts with the same owner scope', async () => {
  const f = await fixture();
  const handler = searchApi(
    f.root,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    f.runtime,
  );
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
  if (!address || typeof address === 'string') throw new Error('server_address_unavailable');
  const base = `http://127.0.0.1:${address.port}/signals-ai/__signals/api/`;
  const session = (await (await fetch(base + 'session')).json()) as { token: string };
  const scope = { identity: f.scope.identity, epoch: f.scope.epoch };
  const headers = {
    'x-signals-token': session.token,
    'x-signals-provider-version': '1.0',
    'x-signals-instance-id': scope.identity,
    'x-signals-owner-epoch': scope.epoch,
  };
  const capabilities = (await (
    await fetch(base + 'provider/capabilities', {
      headers: {
        'x-signals-provider-version': '1.0',
        'x-signals-instance-id': scope.identity,
        'x-signals-owner-epoch': scope.epoch,
      },
    })
  ).json()) as {
    capabilities: {
      contracts: { id: string; versions: string[] }[];
      operations: { name: string; mutating: boolean }[];
    };
  };
  expect(capabilities.capabilities.contracts).toContainEqual({
    id: 'source-capture-render',
    versions: ['1.0'],
  });
  expect(capabilities.capabilities.operations).toContainEqual({
    name: 'source_capture_render',
    mutating: true,
    target_kinds: ['entity', 'lead'],
    authority_required: true,
  });

  const request = { request_id: randomUUID(), source_ref: f.sourceRef };
  const created = await fetch(base + 'source-captures/render', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  expect(created.status).toBe(200);
  const result = (await created.json()) as {
    capture_ref: RecordRef;
    manifest_ref: RecordRef;
    manifest: { artifacts: { screenshot: { sha256: string } } };
  };
  expect(result.manifest_ref.kind).toBe('source_capture_render');
  expect(
    (await fetch(base + `source-captures/render-requests/${request.request_id}`, { headers }))
      .status,
  ).toBe(200);
  const manifest = await fetch(
    base + `source-captures/${result.capture_ref.id}/render?digest=${result.manifest_ref.digest}`,
    { headers },
  );
  expect(manifest.status).toBe(200);
  const coldManifest = await fetch(base + `source-captures/${result.capture_ref.id}/render`, {
    headers,
  });
  expect(coldManifest.status).toBe(200);
  expect(await coldManifest.text()).toBe(await manifest.text());
  expect(
    (
      await fetch(
        base + `source-captures/${result.capture_ref.id}/render?digest=${'0'.repeat(64)}`,
        { headers },
      )
    ).status,
  ).toBe(409);
  const image = await fetch(
    base +
      `source-captures/${result.capture_ref.id}/render/blob?manifest=${result.manifest_ref.digest}&artifact=screenshot`,
    { headers },
  );
  expect(image.status).toBe(200);
  expect(image.headers.get('content-type')).toBe('image/png');
  expect(image.headers.get('x-content-type-options')).toBe('nosniff');
  expect(sha(Buffer.from(await image.arrayBuffer()))).toBe(
    result.manifest.artifacts.screenshot.sha256,
  );
  const text = await fetch(
    base +
      `source-captures/${result.capture_ref.id}/render/blob?manifest=${result.manifest_ref.digest}&artifact=dom`,
    { headers },
  );
  expect(text.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  expect(await text.text()).toContain('Local static heading 1');
  expect(
    (
      await fetch(
        base +
          `source-captures/${result.capture_ref.id}/render?digest=${result.manifest_ref.digest}`,
      )
    ).status,
  ).toBe(428);
  expect(
    (
      await fetch(
        base +
          `source-captures/${result.capture_ref.id}/render/blob?manifest=${result.manifest_ref.digest}&artifact=dom&path=whatever`,
        { headers },
      )
    ).status,
  ).toBe(400);
  const exactManifest = await fetch(
    base + 'provider/records?ref=' + encodeURIComponent(JSON.stringify(result.manifest_ref)),
    { headers },
  );
  expect(exactManifest.status).toBe(200);
  expect(((await exactManifest.json()) as { content: string }).content).toContain(
    result.capture_ref.id,
  );
});
