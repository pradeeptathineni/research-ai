import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  correctPrivateDocument,
  importPrivateDocument,
  listPrivateDocuments,
  openPrivateDocument,
  previewPrivateDocumentCorrection,
} from './private-documents.js';
import { searchApi } from './search-api.js';
import { saveLibraryLead } from './library-leads.js';
import { exactOwnerRecord } from './provider-capabilities.js';

function requiredString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('missing_fixture_string');
  return value;
}

function requiredReference(value: unknown): { id: string; [key: string]: unknown } {
  if (!value || typeof value !== 'object' || !('id' in value))
    throw new Error('missing_fixture_reference');
  return { ...value, id: requiredString(value.id) };
}

it('imports, previews and freezes an exact human correction successor without changing cited history', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'library-intake-')));
  try {
    const requestId = randomUUID();
    const bytes = Buffer.from('# Synthetic memo\nOld wording.\n', 'utf8');
    const imported = await importPrivateDocument(root, {
      request_id: requestId,
      name: 'synthetic.md',
      media_type: 'text/markdown',
      bytes_base64: bytes.toString('base64'),
    });
    expect(imported.replay).toBe(false);
    expect((await listPrivateDocuments(root)).documents[0]).toMatchObject({
      import_request_id: requestId,
      import_request_digest: imported.document.import_request_digest,
      raw_sha256: imported.document.raw_sha256,
    });
    const priorRef = imported.ref;
    const priorBytes = await readFile(join(root, '.signals/private-documents.json'));
    const prior = await openPrivateDocument(root, priorRef.id, priorRef);
    expect(prior.ref).toEqual(priorRef);
    const page = prior.document.pages[0]!;
    const correction = {
      document_ref: priorRef,
      page_corrections: [
        {
          number: page.number,
          prior_text_sha256: page.text_sha256,
          text: '# Synthetic memo\nCorrected wording.\n',
        },
      ],
      impact: 'uncertain' as const,
      rationale: 'Synthetic fixture correction only.',
    };
    const preview = await previewPrivateDocumentCorrection(root, correction);
    expect(preview.page_changes[0]).toMatchObject({
      prior_text_sha256: page.text_sha256,
      diff: { removed: ['Old wording.'], added: ['Corrected wording.'] },
    });
    const saved = await correctPrivateDocument(root, { ...correction, request_id: randomUUID() });
    expect(saved.replay).toBe(false);
    expect(saved.ref).not.toEqual(priorRef);
    expect(saved.document).toMatchObject({
      supersedes_ref: priorRef,
      raw_sha256: prior.document.raw_sha256,
      extractor: 'operator-extraction-correction-v1',
      revision: {
        kind: 'operator-extraction-correction-v1',
        parent_ref: priorRef,
        impact: 'uncertain',
      },
    });
    expect(await readFile(join(root, '.signals/private-documents.json'))).not.toEqual(priorBytes);
    expect((await openPrivateDocument(root, priorRef.id)).document.pages).toEqual(
      prior.document.pages,
    );
    expect((await openPrivateDocument(root, saved.ref.id, saved.ref)).ref).toEqual(saved.ref);
    expect((await openPrivateDocument(root, saved.ref.id, saved.ref)).document.pages[0]?.text).toBe(
      '# Synthetic memo\nCorrected wording.\n',
    );
    expect((await listPrivateDocuments(root)).documents).toHaveLength(2);
    const replay = await correctPrivateDocument(root, {
      ...correction,
      request_id: saved.document.revision!.request_id,
    });
    expect(replay).toMatchObject({ ref: saved.ref, replay: true });
    await expect(
      correctPrivateDocument(root, {
        ...correction,
        rationale: 'Changed content under the same request identity.',
        request_id: saved.document.revision!.request_id,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      previewPrivateDocumentCorrection(root, {
        ...correction,
        page_corrections: [
          { ...correction.page_corrections[0]!, prior_text_sha256: '0'.repeat(64) },
        ],
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      openPrivateDocument(root, saved.ref.id, {
        ...saved.ref,
        digest: '0'.repeat(64),
        revision: `sha256:${'0'.repeat(64)}`,
      }),
    ).rejects.toMatchObject({ status: 409 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('dispatches a paste capture request UUID to the existing owner capture ID without opening a listener', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'library-capture-')));
  const handler = searchApi(root);
  const host = '127.0.0.1:43127';
  async function call(
    route: string,
    method: 'GET' | 'POST',
    value?: unknown,
    headers: Record<string, string> = {},
  ) {
    const request = Object.assign(
      Readable.from(value === undefined ? [] : [Buffer.from(JSON.stringify(value))]),
      {
        url: `/signals-ai/__signals/api/${route}`,
        method,
        headers: {
          host,
          ...(method === 'POST'
            ? { 'content-type': 'application/json', origin: `http://${host}` }
            : {}),
          ...headers,
        },
      },
    );
    let status = 0;
    let text = '';
    await handler(
      request as never,
      {
        writeHead(code: number) {
          status = code;
        },
        end(chunk?: string) {
          text = chunk ?? '';
        },
      } as never,
    );
    return { status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
  }
  try {
    const session = await call('session', 'GET');
    expect(session.status).toBe(200);
    const csrf = { 'x-signals-token': requiredString(session.body?.token) };
    const scope = await call('request-scope', 'POST', {}, csrf);
    expect(scope.status).toBe(200);
    const providerHeaders = {
      ...csrf,
      'x-signals-provider-version': '1.0',
      'x-signals-instance-id': requiredString(scope.body?.identity),
      'x-signals-owner-epoch': requiredString(scope.body?.epoch),
    };
    const docRequestId = randomUUID();
    const imported = await call(
      'private-documents',
      'POST',
      {
        action: 'import',
        request_id: docRequestId,
        name: 'synthetic.txt',
        media_type: 'text/plain',
        bytes_base64: Buffer.from('Exact route fixture.').toString('base64'),
      },
      providerHeaders,
    );
    expect(imported.status).toBe(201);
    const exactRef = requiredReference(imported.body?.ref);
    const reopened = await call(
      `private-documents/${exactRef.id}?ref=${encodeURIComponent(JSON.stringify(exactRef))}`,
      'GET',
      undefined,
      providerHeaders,
    );
    expect(reopened.status).toBe(200);
    expect(reopened.body!.ref).toEqual(exactRef);
    const drifted = { ...exactRef, digest: '0'.repeat(64), revision: `sha256:${'0'.repeat(64)}` };
    const staleReopen = await call(
      `private-documents/${exactRef.id}?ref=${encodeURIComponent(JSON.stringify(drifted))}`,
      'GET',
      undefined,
      providerHeaders,
    );
    expect(staleReopen.status).toBe(409);
    const lead = await saveLibraryLead(
      root,
      {
        uri: 'https://example.invalid/synthetic',
        name: 'Synthetic capture source',
        description: 'Local fixture only.',
        limits: [],
      },
      randomUUID(),
      'Library intake capture test',
    );
    const retained = await exactOwnerRecord(root, {
      owner: 'signals-ai',
      kind: 'lead',
      id: lead.id,
      revision: null,
      digest: null,
    });
    const requestId = randomUUID();
    const response = await call(
      'source-captures',
      'POST',
      {
        source_ref: retained.ref,
        mode: 'paste',
        text: 'Synthetic versioned capture.',
        observed_at: '2026-10-28T12:00:00Z',
        capture_id: requestId,
      },
      providerHeaders,
    );
    expect(response.status).toBe(201);
    expect(requiredReference(response.body?.ref).id).toBe(requestId);
    expect(response.body!.capture).toMatchObject({
      id: requestId,
      text: 'Synthetic versioned capture.',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
