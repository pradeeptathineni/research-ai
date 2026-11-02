import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { saveLibraryLead } from './library-leads.js';
import { exactOwnerRecord } from './provider-capabilities.js';
import {
  compareSourceCaptures,
  createSourceCapture,
  openSourceCapture,
  type RecordRef,
  type SourceCaptureOptions,
} from './source-captures.js';
import {
  createSourceArchive,
  readSourceArchive,
  readSourceArchiveRequest,
} from './source-archives.js';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

it('archives exact fetch response bytes without rewriting retained captures or refetching on recovery', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-source-archive-')));
  try {
    const source = await saveLibraryLead(
      root,
      {
        uri: 'https://example.test/synthetic-archive',
        name: 'Synthetic archive source',
        description: 'A local source used by an in-process fetch fixture.',
        limits: ['Synthetic fixture only.'],
      },
      randomUUID(),
      'source archive workflow fixture',
    );
    const sourceRef = (
      await exactOwnerRecord(root, {
        owner: 'signals-ai',
        kind: 'lead',
        id: source.id,
        revision: null,
        digest: null,
      })
    ).ref as RecordRef;
    const resolveRef = async (ref: RecordRef) => {
      const exact = await exactOwnerRecord(root, ref);
      return { bytes: exact.bytes, ref: exact.ref as RecordRef };
    };
    const legacy = await createSourceCapture(
      root,
      {
        source_ref: sourceRef,
        mode: 'paste',
        text: 'A previously retained citation.',
        observed_at: '2026-11-02T08:00:00Z',
      },
      resolveRef,
    );
    const legacyBefore = await openSourceCapture(root, legacy.ref.id);
    expect(legacyBefore.capture.raw_digest).toBeNull();

    const rawBytes = Buffer.from(
      '<html><body><h1>Fixture heading</h1><p>Paragraph source text.</p></body></html>',
      'utf8',
    );
    const normalizedText = 'Fixture heading\nParagraph source text.';
    let fetchCalls = 0;
    const fetcher: NonNullable<SourceCaptureOptions['fetcher']> = async (
      uri,
      _signal,
      _redirects,
      _allowPdf,
      options,
    ) => {
      fetchCalls++;
      expect(options?.includeBytes).toBe(true);
      return {
        text: normalizedText,
        digest: sha(rawBytes),
        uri,
        bytes: Buffer.from(rawBytes),
        contentType: 'text/html; charset=utf-8',
        normalizer: 'text-v2' as const,
      };
    };
    const requestId = randomUUID();
    const request = {
      request_id: requestId,
      capture_request: {
        source_ref: sourceRef,
        mode: 'fetch' as const,
        supersedes: legacy.ref,
      },
    };
    const created = await createSourceArchive(root, request, resolveRef, { fetcher });
    expect(created.state).toBe('archived');
    expect(created.request_id).toBe(requestId);
    expect(created.capture_ref?.id).toBe(requestId);
    expect(created.capture_ref?.kind).toBe('source_capture');
    expect(created.raw_digest).toBe(sha(rawBytes));
    expect(created.archive_ref).not.toBeNull();
    expect(fetchCalls).toBe(1);

    let collisionFetchCalls = 0;
    const collisionFetcher: NonNullable<SourceCaptureOptions['fetcher']> = async (uri) => {
      collisionFetchCalls++;
      return {
        text: 'This response must never be requested.',
        digest: sha(rawBytes),
        uri,
        bytes: Buffer.from(rawBytes),
        contentType: 'text/html; charset=utf-8',
      };
    };
    await expect(
      createSourceArchive(
        root,
        {
          request_id: legacy.ref.id,
          capture_request: { source_ref: sourceRef, mode: 'fetch' },
        },
        resolveRef,
        { fetcher: collisionFetcher },
      ),
    ).rejects.toMatchObject({ status: 409, code: 'source_archive_conflict' });
    expect(collisionFetchCalls).toBe(0);
    expect((await openSourceCapture(root, legacy.ref.id)).capture).toEqual(legacyBefore.capture);
    await expect(readSourceArchiveRequest(root, legacy.ref.id)).rejects.toMatchObject({
      status: 404,
      code: 'source_archive_request_not_found',
    });

    const reopenedCapture = await openSourceCapture(root, requestId);
    expect(reopenedCapture.ref).toEqual(created.capture_ref);
    expect(reopenedCapture.capture.text).toBe(normalizedText);
    expect(reopenedCapture.capture.text).not.toBe(rawBytes.toString('utf8'));
    expect(reopenedCapture.capture.raw_digest).toBe(sha(rawBytes));
    expect('bytes' in reopenedCapture.capture).toBe(false);

    const coldArchive = await readSourceArchive(root, created.capture_ref!);
    expect(coldArchive.state).toBe('available');
    expect(coldArchive.capture_ref).toEqual(created.capture_ref);
    expect(coldArchive.raw_digest).toBe(sha(rawBytes));
    expect(coldArchive.byte_count).toBe(rawBytes.byteLength);
    expect(coldArchive.sha256).toBe(sha(rawBytes));
    expect(Buffer.from(coldArchive.bytes_base64!, 'base64')).toEqual(rawBytes);
    expect(fetchCalls).toBe(1);

    const replay = await createSourceArchive(root, request, resolveRef, { fetcher });
    expect(replay.state).toBe('archived');
    expect(replay.replayed).toBe(true);
    expect(replay.capture_ref).toEqual(created.capture_ref);
    expect(replay.archive_ref).toEqual(created.archive_ref);
    const requestRead = await readSourceArchiveRequest(root, requestId);
    expect(requestRead).toMatchObject({
      state: 'archived',
      request_id: requestId,
      capture_ref: created.capture_ref,
      raw_digest: sha(rawBytes),
      archive_ref: created.archive_ref,
      replayed: true,
    });
    expect(fetchCalls).toBe(1);

    const archiveStoreBytes = await readFile(join(root, '.signals/source-archives.json'));
    try {
      const tampered = JSON.parse(archiveStoreBytes.toString('utf8'));
      const row = tampered.requests.find((entry: any) => entry.request_id === requestId);
      const changedBytes = Buffer.from(rawBytes);
      changedBytes[0] = changedBytes[0]! ^ 1;
      const changedDigest = sha(changedBytes);
      row.bytes_base64 = changedBytes.toString('base64');
      row.manifest.sha256 = changedDigest;
      const manifestDigest = sha(Buffer.from(JSON.stringify(row.manifest), 'utf8'));
      row.archive_ref = {
        owner: 'signals-ai',
        kind: 'source-archive',
        id: requestId,
        revision: `sha256:${manifestDigest}`,
        digest: manifestDigest,
      };
      await writeFile(
        join(root, '.signals/source-archives.json'),
        `${JSON.stringify(tampered, null, 2)}\n`,
      );
      await expect(readSourceArchive(root, created.capture_ref)).rejects.toMatchObject({
        status: 503,
        code: 'source_archive_unavailable',
      });
    } finally {
      await writeFile(join(root, '.signals/source-archives.json'), archiveStoreBytes);
    }
    try {
      const tampered = JSON.parse(archiveStoreBytes.toString('utf8'));
      const row = tampered.requests.find((entry: any) => entry.request_id === requestId);
      row.capture_ref.id = randomUUID();
      await writeFile(
        join(root, '.signals/source-archives.json'),
        `${JSON.stringify(tampered, null, 2)}\n`,
      );
      await expect(readSourceArchiveRequest(root, requestId)).rejects.toMatchObject({
        status: 503,
        code: 'source_archive_unavailable',
      });
    } finally {
      await writeFile(join(root, '.signals/source-archives.json'), archiveStoreBytes);
    }

    const legacyArchive = await readSourceArchive(root, legacy.ref);
    expect(legacyArchive.state).toBe('unavailable');
    expect(legacyArchive.capture_ref).toEqual(legacy.ref);
    expect(legacyArchive.bytes_base64).toBeUndefined();
    expect((await openSourceCapture(root, legacy.ref.id)).capture).toEqual(legacyBefore.capture);
    const comparison = await compareSourceCaptures(root, legacy.ref.id, requestId);
    expect(comparison.left.ref).toEqual(legacy.ref);
    expect(comparison.right.ref).toEqual(created.capture_ref);

    const oversizedBytes = Buffer.alloc(1_000_001, 0x78);
    let oversizedFetchCalls = 0;
    const oversizedFetcher = async (uri: string) => {
      oversizedFetchCalls++;
      return {
        text: 'Captured normalized text remains available.',
        digest: sha(oversizedBytes),
        uri,
        bytes: Buffer.from(oversizedBytes),
        contentType: 'text/plain; charset=utf-8',
      };
    };
    const partialRequestId = randomUUID();
    const partialRequest = {
      request_id: partialRequestId,
      capture_request: {
        source_ref: sourceRef,
        mode: 'fetch' as const,
        supersedes: created.capture_ref,
      },
    };
    const partial = await createSourceArchive(root, partialRequest, resolveRef, {
      fetcher: oversizedFetcher,
    });
    expect(partial.state).toBe('capture-created-archive-unavailable');
    expect(partial.capture_ref?.id).toBe(partialRequestId);
    expect(partial.archive_ref).toBeNull();
    expect(partial.reason).toBeTruthy();
    expect(oversizedFetchCalls).toBe(1);
    expect((await openSourceCapture(root, partialRequestId)).capture.text).toBe(
      'Captured normalized text remains available.',
    );
    expect((await readSourceArchive(root, partial.capture_ref!)).state).toBe('unavailable');
    expect(await readSourceArchiveRequest(root, partialRequestId)).toMatchObject({
      state: 'capture-created-archive-unavailable',
      capture_ref: partial.capture_ref,
      archive_ref: null,
    });
    const partialReplay = await createSourceArchive(root, partialRequest, resolveRef, {
      fetcher: oversizedFetcher,
    });
    expect(partialReplay.state).toBe('capture-created-archive-unavailable');
    expect(partialReplay.replayed).toBe(true);
    expect(partialReplay.capture_ref).toEqual(partial.capture_ref);
    expect(oversizedFetchCalls).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
