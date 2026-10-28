import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  unlink,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import type { Browser, BrowserContext } from 'playwright';
import { atomicJson, withWriter } from './search-store.js';
import { requestStore } from './search-request-store.js';
import {
  createSourceCapture,
  openSourceCapture,
  recordRefSchema as refSchema,
  validateSourceCaptureSelection,
  type RecordRef,
  type SourceCaptureFetch,
  type SourceResolver,
} from './source-captures.js';
import type { FetchOptions } from './search-fetch.js';

const closed = { additionalProperties: false };
const sha = Type.String({ pattern: '^[a-f0-9]{64}$' });
const uuid = Type.String({ pattern: '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$' });
const blobSchema = Type.Object(
  {
    sha256: sha,
    bytes: Type.Integer({ minimum: 1, maximum: 2_000_000 }),
    mime: Type.Enum(['image/png', 'text/plain; charset=utf-8']),
  },
  closed,
);
const manifestSchema = Type.Object(
  {
    schema_version: Type.Literal('1.0'),
    capture_id: uuid,
    capture_ref: refSchema,
    source_ref: refSchema,
    raw_digest: sha,
    captured_at: Type.String({ format: 'date-time' }),
    renderer: Type.Object(
      {
        package: Type.Literal('playwright'),
        package_version: Type.Literal('1.63.0'),
        browser: Type.Literal('chromium'),
        browser_version: Type.String({ minLength: 1, maxLength: 80 }),
        method: Type.Literal('set-content-static-html-v1'),
        viewport: Type.Object({ width: Type.Literal(1280), height: Type.Literal(900) }, closed),
        blocked_requests: Type.Integer({ minimum: 0, maximum: 1000 }),
      },
      closed,
    ),
    artifacts: Type.Object({ screenshot: blobSchema, dom: blobSchema, aria: blobSchema }, closed),
    total_bytes: Type.Integer({ minimum: 1, maximum: 4_000_000 }),
    omissions: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), {
      minItems: 5,
      maxItems: 8,
    }),
  },
  closed,
);
const manifestsSchema = Type.Object(
  { schema_version: Type.Literal('1.0'), manifests: Type.Array(manifestSchema, { maxItems: 100 }) },
  closed,
);
const requestSchema = Type.Object(
  {
    request_id: uuid,
    source_ref: refSchema,
    supersedes: Type.Optional(Type.Union([refSchema, Type.Null()])),
  },
  closed,
);
const requestRowSchema = Type.Object(
  {
    request_id: uuid,
    meaning_digest: sha,
    owner_instance: uuid,
    owner_epoch: uuid,
    source_ref: refSchema,
    supersedes: Type.Union([refSchema, Type.Null()]),
    capture_id: uuid,
    state: Type.Enum(['pending', 'unknown', 'completed']),
    created_at: Type.String({ format: 'date-time' }),
    updated_at: Type.String({ format: 'date-time' }),
    reason: Type.String({ minLength: 1, maxLength: 300 }),
    capture_ref: Type.Union([refSchema, Type.Null()]),
    manifest_ref: Type.Union([refSchema, Type.Null()]),
  },
  closed,
);
const requestsSchema = Type.Object(
  {
    schema_version: Type.Literal('1.0'),
    owner_instance: uuid,
    owner_epoch: uuid,
    requests: Type.Array(requestRowSchema, { maxItems: 1000 }),
  },
  closed,
);
type Manifest = Static<typeof manifestSchema>;
type Manifests = Static<typeof manifestsSchema>;
type RequestRow = Static<typeof requestRowSchema>;
type Requests = Static<typeof requestsSchema>;
type Rendered = {
  screenshot: Buffer;
  dom: Buffer;
  aria: Buffer;
  browserVersion: string;
  blockedRequests: number;
  completedExternalRequests: number;
};
type RenderFetch = (
  input: string,
  signal?: AbortSignal,
  redirects?: number,
  allowPdf?: boolean,
  options?: FetchOptions,
) => Promise<SourceCaptureFetch>;
export type SourceRenderRuntime = { fetcher?: RenderFetch };

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sameRef = (left: RecordRef, right: RecordRef) =>
  left.owner === right.owner &&
  left.kind === right.kind &&
  left.id === right.id &&
  left.revision === right.revision &&
  left.digest === right.digest;
const refOf = (kind: string, id: string, projection: object): RecordRef => {
  const digest = sha256(JSON.stringify(projection));
  return { owner: 'signals-ai', kind, id, revision: `sha256:${digest}`, digest };
};

export class SourceRenderError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly reason: string,
    readonly completedExternalRequests?: number,
  ) {
    super(code);
  }
}

function fail(
  status: number,
  code: string,
  reason: string,
  completedExternalRequests?: number,
): never {
  throw new SourceRenderError(status, code, reason, completedExternalRequests);
}

async function privateFile(root: string, name: string, maxBytes: number): Promise<Buffer | null> {
  const folder = resolve(root, '.signals');
  const file = resolve(folder, name);
  const directory = await lstat(folder).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!directory) return null;
  if (!directory.isDirectory() || directory.isSymbolicLink() || (await realpath(folder)) !== folder)
    return fail(
      503,
      'source_render_storage_unavailable',
      'Private render storage is not a safe directory.',
    );
  const before = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!before) return null;
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > maxBytes ||
    (await realpath(file)) !== file
  )
    fail(
      503,
      'source_render_storage_unavailable',
      'Private render state is unsafe or exceeds its limit.',
    );
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes)
      fail(503, 'source_render_storage_unavailable', 'Private render state exceeds its limit.');
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  const after = await lstat(file);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
    fail(409, 'source_render_state_changed', 'Private render state changed during validation.');
  if (!Buffer.from(bytes.toString('utf8')).equals(bytes))
    fail(503, 'source_render_storage_unavailable', 'Private render state is not valid UTF8.');
  return bytes;
}

async function loadRequests(root: string, identity: string, epoch: string): Promise<Requests> {
  const bytes = await privateFile(root, 'source-render-requests.json', 2_000_000);
  if (!bytes)
    return { schema_version: '1.0', owner_instance: identity, owner_epoch: epoch, requests: [] };
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return fail(503, 'source_render_storage_unavailable', 'Render request history is corrupt.');
  }
  if (
    !Value.Check(requestsSchema, value) ||
    value.owner_instance !== identity ||
    value.owner_epoch !== epoch
  )
    return fail(
      409,
      'source_render_scope_changed',
      'Render request history belongs to another owner epoch.',
    );
  return value;
}

async function loadManifests(root: string): Promise<Manifests> {
  const bytes = await privateFile(root, 'source-render-manifests.json', 2_000_000);
  if (!bytes) return { schema_version: '1.0', manifests: [] };
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return fail(503, 'source_render_storage_unavailable', 'Render manifest index is corrupt.');
  }
  if (!Value.Check(manifestsSchema, value) || Buffer.byteLength(JSON.stringify(value)) > 2_000_000)
    return fail(
      503,
      'source_render_storage_unavailable',
      'Render manifest index is invalid or too large.',
    );
  for (const row of value.manifests) {
    if (
      row.capture_ref.id !== row.capture_id ||
      (row.source_ref.kind !== 'entity' && row.source_ref.kind !== 'lead') ||
      row.capture_ref.kind !== 'source_capture' ||
      row.total_bytes !==
        row.artifacts.screenshot.bytes + row.artifacts.dom.bytes + row.artifacts.aria.bytes
    )
      return fail(503, 'source_render_storage_unavailable', 'Render manifest binding is invalid.');
  }
  return value;
}

export async function sourceRenderReadiness() {
  try {
    const { chromium } = await import('playwright');
    const require = createRequire(import.meta.url);
    const packageJson = JSON.parse(
      await readFile(require.resolve('playwright/package.json'), 'utf8'),
    ) as {
      version?: string;
    };
    const executable = chromium.executablePath();
    if (packageJson.version !== '1.63.0')
      return { available: false, reason: 'Optional Playwright runtime must be exactly 1.63.0.' };
    await access(executable, constants.X_OK);
    return {
      available: true,
      reason: 'Pinned Playwright 1.63.0 and its local Chromium executable are present.',
    };
  } catch {
    return {
      available: false,
      reason:
        'Pinned Playwright 1.63.0 or its local Chromium executable is unavailable; no browser was installed or started.',
    };
  }
}

export async function renderStaticHtml(html: string): Promise<Rendered> {
  const inputBytes = Buffer.from(html, 'utf8');
  if (inputBytes.length > 2_000_000 || !Buffer.from(inputBytes.toString('utf8')).equals(inputBytes))
    fail(413, 'source_render_html_limit', 'HTML must be valid UTF8 and at most 2 MiB.');
  const readiness = await sourceRenderReadiness();
  if (!readiness.available) fail(503, 'source_render_browser_unavailable', readiness.reason);
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let blockedRequests = 0;
  let completedExternalRequests = 0;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const browserVersion = browser.version();
    context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      javaScriptEnabled: false,
      serviceWorkers: 'block',
      offline: true,
    });
    await context.route('**/*', (route) => {
      blockedRequests++;
      return route.abort();
    });
    const page = await context.newPage();
    const initialMainFrameUrl = page.mainFrame().url();
    let mainFrameNavigationAttempted = false;
    page.on('request', (request) => {
      if (!request.isNavigationRequest()) return;
      try {
        if (request.frame() === page.mainFrame()) mainFrameNavigationAttempted = true;
      } catch {
        // A failed main-frame navigation can lose its frame association. Fail closed.
        mainFrameNavigationAttempted = true;
      }
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && frame.url() !== initialMainFrameUrl)
        mainFrameNavigationAttempted = true;
    });
    const refuseNavigation = () => {
      if (mainFrameNavigationAttempted || page.mainFrame().url() !== initialMainFrameUrl)
        fail(
          422,
          'source_render_navigation_blocked',
          'The static page attempted to replace its main document. No render artifacts were retained; inspect the text capture separately.',
          completedExternalRequests,
        );
    };
    page.on('requestfinished', (request) => {
      if (/^https?:$/.test(new URL(request.url()).protocol)) completedExternalRequests++;
    });
    page.setDefaultTimeout(10_000);
    try {
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 10_000 });
    } catch (error) {
      refuseNavigation();
      throw error;
    }
    refuseNavigation();
    const domText = await page.evaluate(() => document.documentElement?.outerHTML ?? '');
    const ariaText = await page.locator('body').ariaSnapshot();
    const screenshot = await page.screenshot({
      type: 'png',
      fullPage: false,
      animations: 'disabled',
      timeout: 15_000,
    });
    refuseNavigation();
    const result = {
      screenshot: Buffer.from(screenshot),
      dom: Buffer.from(domText, 'utf8'),
      aria: Buffer.from(ariaText, 'utf8'),
      browserVersion,
      blockedRequests,
      completedExternalRequests,
    };
    if (result.dom.length > 128_000 || result.aria.length > 128_000)
      fail(
        413,
        'source_render_artifact_limit',
        'Rendered DOM and ARIA artifacts are limited to 128 KiB each.',
      );
    if (
      result.screenshot.length > 2_000_000 ||
      result.screenshot.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    )
      fail(413, 'source_render_artifact_limit', 'Rendered PNG must be valid and at most 2 MiB.');
    const total = result.screenshot.length + result.dom.length + result.aria.length;
    if (total > 4_000_000)
      fail(
        413,
        'source_render_artifact_limit',
        'Combined rendered artifacts are limited to 4 MiB.',
      );
    return result;
  } catch (error) {
    if (error instanceof SourceRenderError) throw error;
    return fail(
      503,
      'source_render_browser_failed',
      'The isolated local browser failed to render this capture. The existing text capture remains available; inspect render request status before acting again.',
    );
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

function artifactBytes(rendered: Rendered) {
  return {
    screenshot: { bytes: rendered.screenshot, mime: 'image/png' as const, suffix: '.png' },
    dom: { bytes: rendered.dom, mime: 'text/plain; charset=utf-8' as const, suffix: '.txt' },
    aria: { bytes: rendered.aria, mime: 'text/plain; charset=utf-8' as const, suffix: '.txt' },
  };
}

async function ensureBlobDirectory(root: string) {
  const signals = resolve(root, '.signals');
  const parent = await lstat(signals).catch(() => null);
  if (
    !parent ||
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (await realpath(signals)) !== signals
  )
    fail(
      503,
      'source_render_storage_unavailable',
      'Private render storage is not a safe directory.',
    );
  const directory = resolve(signals, 'source-render-blobs');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(directory)) !== directory)
    fail(503, 'source_render_storage_unavailable', 'Render blob directory is unsafe.');
  return directory;
}

async function storeBlob(directory: string, bytes: Buffer, suffix: string, digest: string) {
  const path = resolve(directory, digest + suffix);
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing) {
    if (
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      existing.size !== bytes.length ||
      (await realpath(path)) !== path
    )
      fail(
        503,
        'source_render_storage_unavailable',
        'Existing content-addressed render blob is unsafe.',
      );
    const old = await readFile(path);
    if (!old.equals(bytes) || sha256(old) !== digest)
      fail(
        503,
        'source_render_storage_unavailable',
        'Existing content-addressed render blob failed digest validation.',
      );
    return;
  }
  const pending = resolve(directory, `.pending-${randomUUID()}`);
  const handle = await open(
    pending,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(pending, path);
  } catch (error) {
    await unlink(pending).catch(() => {});
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return storeBlob(directory, bytes, suffix, digest);
  }
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size !== bytes.length ||
    (await realpath(path)) !== path
  )
    fail(503, 'source_render_storage_unavailable', 'Committed render blob failed validation.');
}

async function blobStoreBytes(directory: string) {
  let total = 0;
  for (const name of await readdir(directory)) {
    if (!/^[a-f0-9]{64}\.(png|txt)$/.test(name))
      fail(
        503,
        'source_render_storage_unavailable',
        'Render blob directory contains an unexpected entry.',
      );
    const stat = await lstat(resolve(directory, name));
    if (!stat.isFile() || stat.isSymbolicLink())
      fail(
        503,
        'source_render_storage_unavailable',
        'Render blob directory contains an unsafe entry.',
      );
    total += stat.size;
  }
  return total;
}

async function storeArtifacts(root: string, rendered: Rendered) {
  const entries = artifactBytes(rendered);
  const total = Object.values(entries).reduce((sum, entry) => sum + entry.bytes.length, 0);
  if (total > 4_000_000)
    fail(413, 'source_render_artifact_limit', 'Combined rendered artifacts are limited to 4 MiB.');
  const directory = await ensureBlobDirectory(root);
  if ((await blobStoreBytes(directory)) + total > 400_000_000)
    fail(
      413,
      'source_render_store_limit',
      'The bounded render blob store is full; no old artifact was removed.',
    );
  const artifacts = {} as Manifest['artifacts'];
  for (const name of ['screenshot', 'dom', 'aria'] as const) {
    const entry = entries[name];
    const digest = sha256(entry.bytes);
    await storeBlob(directory, entry.bytes, entry.suffix, digest);
    artifacts[name] = { sha256: digest, bytes: entry.bytes.length, mime: entry.mime };
  }
  return { artifacts, total_bytes: total, directory };
}

function manifestRef(manifest: Manifest) {
  return refOf('source_capture_render', manifest.capture_id, manifest);
}

async function persistManifest(root: string, manifest: Manifest) {
  return withWriter(root, async () => {
    const index = await loadManifests(root);
    if (index.manifests.some((row) => row.capture_id === manifest.capture_id))
      fail(
        409,
        'source_render_conflict',
        'A render attachment already exists for this exact capture.',
      );
    if (index.manifests.length >= 100)
      fail(413, 'source_render_store_limit', 'Render manifest capacity (100 captures) is full.');
    index.manifests.push(manifest);
    if (Buffer.byteLength(JSON.stringify(index, null, 2) + '\n') > 2_000_000)
      fail(413, 'source_render_store_limit', 'The bounded render manifest index is full.');
    await atomicJson(resolve(root, '.signals/source-render-manifests.json'), index);
    return manifestRef(manifest);
  });
}

function receipt(row: RequestRow, state: 'completed' | 'unknown', manifest?: Manifest) {
  return {
    schema_version: 'signals-source-render-v1',
    request_id: row.request_id,
    state,
    capture_ref: row.capture_ref,
    manifest_ref: row.manifest_ref,
    ...(manifest ? { manifest } : {}),
    ...(state === 'unknown' ? { reason: row.reason } : {}),
  };
}

async function requestReceipt(root: string, row: RequestRow, completedMismatchReason = row.reason) {
  const manifest = await manifestForCapture(root, row.capture_id);
  if (row.state === 'completed') {
    if (manifest && row.manifest_ref && sameRef(manifestRef(manifest), row.manifest_ref))
      return receipt(row, 'completed', manifest);
    return receipt(
      {
        ...row,
        state: 'unknown',
        reason: completedMismatchReason,
      },
      'unknown',
      manifest ?? undefined,
    );
  }
  const captureRef = row.capture_ref ?? (await captureRefIfPresent(root, row.capture_id));
  return receipt(
    {
      ...row,
      capture_ref: captureRef,
      manifest_ref: manifest ? manifestRef(manifest) : row.manifest_ref,
    },
    'unknown',
    manifest ?? undefined,
  );
}

async function captureRefIfPresent(root: string, id: string) {
  try {
    const opened = await openSourceCapture(root, id);
    return opened.ref;
  } catch (error) {
    if (
      error instanceof Error &&
      'status' in error &&
      (error as { status: unknown }).status === 404
    )
      return null;
    throw error;
  }
}

async function manifestForCapture(root: string, id: string) {
  return (await loadManifests(root)).manifests.find((row) => row.capture_id === id) ?? null;
}

async function updateRequest(
  root: string,
  identity: string,
  epoch: string,
  id: string,
  update: (row: RequestRow) => void,
) {
  return withWriter(root, async () => {
    const ledger = await loadRequests(root, identity, epoch);
    const row = ledger.requests.find((item) => item.request_id === id);
    if (!row)
      fail(404, 'source_render_request_not_found', 'Render request identity is not retained.');
    update(row);
    row.updated_at = new Date().toISOString();
    await atomicJson(resolve(root, '.signals/source-render-requests.json'), ledger);
    return row;
  });
}

export async function renderSourceCapture(
  root: string,
  input: unknown,
  resolveSource: SourceResolver,
  runtime: SourceRenderRuntime = {},
) {
  if (!Value.Check(requestSchema, input))
    fail(
      400,
      'invalid_source_render_request',
      'Supply a request UUID, exact current source ref and optional exact predecessor.',
    );
  const data = input;
  const selection = await validateSourceCaptureSelection(
    root,
    data.source_ref,
    data.supersedes ?? undefined,
    resolveSource,
  );
  const scope = await requestStore(root).scope();
  const meaning = {
    owner_instance: scope.identity,
    owner_epoch: scope.epoch,
    source_ref: selection.sourceRef,
    supersedes: selection.supersedes ?? null,
  };
  const meaning_digest = sha256(JSON.stringify(meaning));
  const admission = await withWriter(root, async () => {
    const ledger = await loadRequests(root, scope.identity, scope.epoch);
    const old = ledger.requests.find((row) => row.request_id === data.request_id);
    if (old) {
      if (old.meaning_digest !== meaning_digest)
        fail(
          409,
          'source_render_request_conflict',
          'This request UUID is already bound to a different exact source or predecessor.',
        );
      return { created: false, row: old };
    }
    if (ledger.requests.length >= 1000)
      fail(
        413,
        'source_render_store_limit',
        'Render request history is full; no history was removed.',
      );
    const now = new Date().toISOString();
    const row: RequestRow = {
      request_id: data.request_id,
      meaning_digest,
      owner_instance: scope.identity,
      owner_epoch: scope.epoch,
      source_ref: selection.sourceRef,
      supersedes: selection.supersedes ?? null,
      capture_id: randomUUID(),
      state: 'pending',
      created_at: now,
      updated_at: now,
      reason: 'Admission is durable; acquisition may have started.',
      capture_ref: null,
      manifest_ref: null,
    };
    ledger.requests.push(row);
    await atomicJson(resolve(root, '.signals/source-render-requests.json'), ledger);
    return { created: true, row };
  });
  if (!admission.created) {
    const row = admission.row;
    return requestReceipt(root, row, 'Completed receipt no longer matches its exact manifest.');
  }

  let captureRef: RecordRef | null = null;
  let manifest: Manifest | null = null;
  try {
    const renderedResult: { value?: Rendered } = {};
    const fetcher = runtime.fetcher;
    const capture = await createSourceCapture(
      root,
      {
        source_ref: selection.sourceRef,
        mode: 'fetch',
        ...(selection.supersedes ? { supersedes: selection.supersedes } : {}),
      },
      resolveSource,
      {
        captureId: admission.row.capture_id,
        includeBytes: true,
        ...(fetcher ? { fetcher } : {}),
        beforeRetain: async (fetched) => {
          if (!fetched.bytes || !/^text\/html(?:\s*;|$)/i.test(fetched.contentType ?? ''))
            fail(
              415,
              'source_render_html_required',
              'Browser rendering requires the captured response to be HTML.',
            );
          if (
            fetched.bytes.length > 2_000_000 ||
            !Buffer.from(fetched.bytes.toString('utf8')).equals(fetched.bytes)
          )
            fail(
              413,
              'source_render_html_limit',
              'Source HTML must be valid UTF8 and at most 2 MiB.',
            );
          renderedResult.value = await renderStaticHtml(fetched.bytes.toString('utf8'));
        },
      },
    );
    captureRef = capture.ref;
    await updateRequest(root, scope.identity, scope.epoch, data.request_id, (row) => {
      row.capture_ref = capture.ref;
      row.reason = 'The exact v1 text capture is retained; render attachment is in progress.';
    });
    const rendered = renderedResult.value;
    if (!rendered)
      fail(503, 'source_render_browser_failed', 'The browser produced no render artifacts.');
    const artifacts = await storeArtifacts(root, rendered);
    manifest = {
      schema_version: '1.0',
      capture_id: capture.capture.id,
      capture_ref: capture.ref,
      source_ref: selection.sourceRef,
      raw_digest: capture.capture.raw_digest!,
      captured_at: new Date().toISOString(),
      renderer: {
        package: 'playwright',
        package_version: '1.63.0',
        browser: 'chromium',
        browser_version: rendered.browserVersion,
        method: 'set-content-static-html-v1',
        viewport: { width: 1280, height: 900 },
        blocked_requests: rendered.blockedRequests,
      },
      artifacts: artifacts.artifacts,
      total_bytes: artifacts.total_bytes,
      omissions: [
        'JavaScript was disabled; dynamic page behavior was not rendered.',
        'All browser network requests were aborted and service workers were blocked; external resources are absent.',
        'The browser offline context and request interception are browser controls, not OS-level network isolation.',
        'No browser profile, cookies, authentication, CDP connection or network replay was used.',
        'Screenshot is the fixed 1280x900 viewport; content outside it is not represented.',
        'DOM and ARIA are retained as inert UTF8 text and are not served as HTML.',
        'Rendered appearance and extracted text do not verify source claims or factual support.',
      ],
    };
    if (!Value.Check(manifestSchema, manifest))
      fail(503, 'source_render_manifest_invalid', 'Render manifest failed its closed schema.');
    const manifestRef = await persistManifest(root, manifest);
    const completedRow = await updateRequest(
      root,
      scope.identity,
      scope.epoch,
      data.request_id,
      (row) => {
        row.state = 'completed';
        row.capture_ref = capture.ref;
        row.manifest_ref = manifestRef;
        row.reason = 'Exact source capture and render attachment are retained.';
      },
    );
    return receipt(completedRow, 'completed', manifest);
  } catch (error) {
    const unknownRow = await updateRequest(
      root,
      scope.identity,
      scope.epoch,
      data.request_id,
      (row) => {
        row.state = 'unknown';
        if (captureRef) row.capture_ref = captureRef;
        if (manifest) row.manifest_ref = manifestRef(manifest);
        row.reason =
          'The render attempt did not complete with a confirmed durable receipt; inspect exact owner state before a new request.';
      },
    );
    if (captureRef)
      return receipt(
        unknownRow,
        'unknown',
        manifest ?? (await manifestForCapture(root, admission.row.capture_id)) ?? undefined,
      );
    throw error;
  }
}

export async function readSourceRenderRequest(root: string, id: string) {
  if (!Value.Check(uuid, id))
    fail(400, 'invalid_source_render_request', 'Request identity must be a UUID.');
  const scope = await requestStore(root).scope();
  const ledger = await loadRequests(root, scope.identity, scope.epoch);
  const row = ledger.requests.find((item) => item.request_id === id);
  if (!row)
    fail(404, 'source_render_request_not_found', 'Render request identity is not retained.');
  return requestReceipt(root, row);
}

export async function openSourceRender(root: string, captureId: string, digest?: string) {
  if (!Value.Check(uuid, captureId) || (digest !== undefined && !Value.Check(sha, digest)))
    fail(
      400,
      'invalid_source_render_request',
      'A capture UUID and optional exact manifest digest are required.',
    );
  const capture = await openSourceCapture(root, captureId);
  const manifest = await manifestForCapture(root, captureId);
  if (!manifest)
    fail(404, 'source_render_not_found', 'This exact capture has no retained render attachment.');
  const ref = manifestRef(manifest);
  if (
    (digest !== undefined && ref.digest !== digest) ||
    !sameRef(capture.ref, manifest.capture_ref)
  )
    fail(409, 'source_render_changed', 'The exact render manifest or base capture changed.');
  return { ref, manifest };
}

export async function readSourceRenderBlob(
  root: string,
  captureId: string,
  digest: string,
  artifact: string,
) {
  if (!['screenshot', 'dom', 'aria'].includes(artifact))
    fail(
      400,
      'invalid_source_render_artifact',
      'Choose one exact screenshot, DOM or ARIA artifact.',
    );
  const opened = await openSourceRender(root, captureId, digest);
  const name = artifact as keyof Manifest['artifacts'];
  const descriptor = opened.manifest.artifacts[name];
  const suffix = name === 'screenshot' ? '.png' : '.txt';
  const directory = resolve(root, '.signals/source-render-blobs');
  const stat = await lstat(directory).catch(() => null);
  if (
    !stat ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await realpath(directory)) !== directory
  )
    fail(
      503,
      'source_render_storage_unavailable',
      'Render blob directory is unavailable or unsafe.',
    );
  const path = resolve(directory, descriptor.sha256 + suffix);
  const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (
    !before ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size !== descriptor.bytes ||
    (await realpath(path)) !== path
  )
    fail(503, 'source_render_blob_unavailable', 'Exact render artifact is unavailable or unsafe.');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  const after = await lstat(path);
  if (
    before.ino !== after.ino ||
    before.size !== after.size ||
    bytes.length !== descriptor.bytes ||
    sha256(bytes) !== descriptor.sha256
  )
    fail(409, 'source_render_blob_changed', 'Exact render artifact failed digest validation.');
  return { bytes, mime: descriptor.mime, ref: opened.ref };
}

export async function compareSourceRenderAttachments(
  root: string,
  leftId: string,
  rightId: string,
) {
  const [leftCapture, rightCapture] = await Promise.all([
    openSourceCapture(root, leftId),
    openSourceCapture(root, rightId),
  ]);
  if (leftCapture.capture.source_id !== rightCapture.capture.source_id)
    fail(400, 'invalid_source_render_comparison', 'Compare only captures of the same source.');
  const [left, right] = await Promise.all([
    manifestForCapture(root, leftId),
    manifestForCapture(root, rightId),
  ]);
  const leftRef = left ? manifestRef(left) : null;
  const rightRef = right ? manifestRef(right) : null;
  return {
    left: { capture_ref: leftCapture.ref, manifest_ref: leftRef },
    right: { capture_ref: rightCapture.ref, manifest_ref: rightRef },
    availability_changed: Boolean(left) !== Boolean(right),
    same_manifest: leftRef && rightRef ? sameRef(leftRef, rightRef) : null,
    artifact_digest_changes: {
      screenshot:
        left && right
          ? left.artifacts.screenshot.sha256 !== right.artifacts.screenshot.sha256
          : null,
      dom: left && right ? left.artifacts.dom.sha256 !== right.artifacts.dom.sha256 : null,
      aria: left && right ? left.artifacts.aria.sha256 !== right.artifacts.aria.sha256 : null,
    },
    qualification: [
      'Equal screenshot digests do not prove the pages are equivalent.',
      'Different rendered artifact digests do not prove a semantic source or factual change.',
    ],
  };
}

export async function sourceRenderRecordBytes(root: string, id: string) {
  if (!Value.Check(uuid, id))
    fail(400, 'invalid_provider_reference', 'Render manifest IDs must be UUIDs.');
  const manifest = await manifestForCapture(root, id);
  if (!manifest) fail(404, 'provider_record_not_found', 'Exact render manifest is unavailable.');
  return {
    bytes: Buffer.from(JSON.stringify(manifest), 'utf8'),
    storage: 'source_capture_render_record' as const,
  };
}
