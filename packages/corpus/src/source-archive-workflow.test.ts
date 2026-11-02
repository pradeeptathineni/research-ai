import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { saveLibraryLead } from './library-leads.js';
import { exactOwnerRecord } from './provider-capabilities.js';
import { defaultSettings, saveSettings } from './search-settings.js';
import {
  createBriefingApi,
  readBriefingCaptureContext,
  retainBriefingRecords,
} from './briefing/store.js';
import {
  compareSourceCaptures,
  createSourceCapture,
  openSourceCapture,
  type RecordRef,
  type SourceCaptureOptions,
} from './source-captures.js';
import type { Item, Story } from './briefing/schema.js';
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
    if (coldArchive.state !== 'available')
      throw new Error('Archived response bytes are unavailable.');
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
    if (legacyArchive.state !== 'unavailable')
      throw new Error('Legacy capture unexpectedly has a raw archive.');
    expect(legacyArchive.capture_ref).toEqual(legacy.ref);
    expect('bytes_base64' in legacyArchive).toBe(false);
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

    await saveSettings(
      {
        ...defaultSettings,
        followedSources: [
          {
            uri: 'https://example.test/fixture-feed.xml',
            label: 'Fixture feed',
            enabled: true,
            interests: ['fixture'],
          },
        ],
        queries: [
          {
            id: 'fixture',
            query: 'fixture',
            enabled: true,
            everyDays: 1,
            offsetMinutes: 0,
            concepts: [],
          },
        ],
      },
      root,
    );
    const briefing = createBriefingApi(root);
    const sourceId = (await briefing.listSources())[0]!.reference.id;
    const item: Item = {
      id: 'fixture-archive-item',
      sourceId,
      canonicalUrl: 'https://example.test/blocked-archive-item',
      title: 'Synthetic blocked source',
      author: null,
      publishedAt: null,
      observedAt: '2026-11-02T00:00:00.000Z',
      contentDigest: sha(Buffer.from('fixture article', 'utf8')),
      excerpt: 'Synthetic fixture item.',
      metrics: [],
      interestIds: [],
      storyId: 'fixture-archive-story',
    };
    const story: Story = {
      id: 'fixture-archive-story',
      itemIds: [item.id],
      representativeItemId: item.id,
      firstSeen: item.observedAt,
      lastSeen: item.observedAt,
      relation: 'single',
      groupingEvidence: [],
      interestMatches: [],
    };
    await retainBriefingRecords(root, { items: [item], stories: [story] });
    const rankInput = (await briefing.listRankInputs()).find((row) => row.story.id === story.id)!;
    const briefingRef: RecordRef = {
      owner: 'signals-ai',
      kind: 'briefing-item',
      id: rankInput.items[0]!.item.id,
      revision: rankInput.items[0]!.itemReference.revision,
      digest: rankInput.items[0]!.itemReference.revision.slice('sha256:'.length),
    };
    await briefing.setSourceTermsPolicy({
      requestId: randomUUID(),
      sourceId,
      termsUrl: 'https://example.test/terms',
      status: 'blocked',
    });
    const deniedRequestId = randomUUID();
    const deniedRequest = {
      request_id: deniedRequestId,
      capture_request: { source_ref: briefingRef, mode: 'fetch' as const },
    };
    let deniedFetchCalls = 0;
    const deniedFetcher: NonNullable<SourceCaptureOptions['fetcher']> = async (uri) => {
      deniedFetchCalls++;
      return {
        text: 'Terms-blocked fetch must not start.',
        digest: sha(rawBytes),
        uri,
        bytes: Buffer.from(rawBytes),
        contentType: 'text/html; charset=utf-8',
      };
    };
    const readBriefingContext: NonNullable<SourceCaptureOptions['readBriefingContext']> = async (
      ref,
    ) => {
      const context = await readBriefingCaptureContext(root, {
        owner: 'signals-ai',
        kind: 'briefing-item',
        id: ref.id,
        revision: ref.revision,
      });
      const itemReference = {
        owner: 'signals-ai' as const,
        kind: 'briefing-item' as const,
        id: ref.id,
        revision: ref.revision,
        digest: ref.digest,
      };
      const sourceReference = {
        owner: 'signals-ai' as const,
        kind: 'briefing-source' as const,
        id: context.sourceReference.id,
        revision: context.sourceReference.revision,
        digest: context.sourceReference.revision.slice('sha256:'.length),
      };
      const exactSource = await resolveRef(sourceReference);
      expect(exactSource.ref).toMatchObject(sourceReference);
      return {
        item_reference: itemReference,
        item_content_digest: context.itemContentDigest,
        source_ref: sourceReference,
        source_health: context.sourceHealth,
        terms_policy: context.termsPolicy ?? {
          id: null,
          sourceId: context.sourceReference.id,
          termsUrl: null,
          status: 'unknown' as const,
          reviewedAt: null,
        },
        observed_at: context.observedAt,
      };
    };
    await expect(
      createSourceArchive(root, deniedRequest, resolveRef, {
        fetcher: deniedFetcher,
        readBriefingContext,
      }),
    ).rejects.toMatchObject({ status: 403, code: 'source_terms_blocked' });
    expect(deniedFetchCalls).toBe(0);
    await expect(openSourceCapture(root, deniedRequestId)).rejects.toMatchObject({
      status: 404,
      code: 'source_capture_not_found',
    });
    const deniedReadback = await readSourceArchiveRequest(root, deniedRequestId);
    expect(deniedReadback).toMatchObject({
      state: 'not-created',
      request_id: deniedRequestId,
      capture_ref: null,
      archive_ref: null,
      replayed: true,
    });
    expect(deniedFetchCalls).toBe(0);
    const deniedReplay = await createSourceArchive(root, deniedRequest, resolveRef, {
      fetcher: deniedFetcher,
      readBriefingContext,
    });
    expect(deniedReplay).toMatchObject({
      state: 'not-created',
      request_id: deniedRequestId,
      capture_ref: null,
      archive_ref: null,
      replayed: true,
    });
    expect(deniedFetchCalls).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
