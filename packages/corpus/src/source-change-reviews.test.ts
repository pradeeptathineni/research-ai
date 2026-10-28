import { mkdtemp, readFile, realpath, rm, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { saveLibraryLead } from './library-leads.js';
import { exactOwnerRecord } from './provider-capabilities.js';
import { createSourceCapture, type RecordRef } from './source-captures.js';
import {
  createSourceChangeReview,
  listSourceChangeReviews,
  previewSourceChange,
  readSourceChangeReview,
} from './source-change-reviews.js';
import { openSourceCapture } from './source-captures.js';

const resolveRef = async (root: string, ref: RecordRef) => {
  const exact = await exactOwnerRecord(root, ref);
  return { bytes: exact.bytes, ref: exact.ref as RecordRef };
};

it('retains changed and unchanged human reviews with exact bases, refuses stale inputs and reopens cold by UUID', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-source-change-review-')));
  const source = await saveLibraryLead(
    root,
    {
      uri: 'https://example.org/retained-source',
      name: 'Synthetic retained source',
      description: 'Local fixture only.',
      limits: [],
    },
    randomUUID(),
    'source-change review fixture',
  );
  const entityFilename = 'entity-ea916635066b6efdf779ed3b.json';
  const fixtureEntity = resolve(process.cwd(), 'signals/entities', entityFilename);
  await mkdir(join(root, 'signals/entities'), { recursive: true });
  await copyFile(fixtureEntity, join(root, 'signals/entities', entityFilename));
  try {
    const sourceRef = (
      await exactOwnerRecord(root, {
        owner: 'signals-ai',
        kind: 'lead',
        id: source.id,
        revision: null,
        digest: null,
      })
    ).ref as RecordRef;
    const entity = JSON.parse(
      await readFile(join(root, 'signals/entities', entityFilename), 'utf8'),
    ) as any;
    const entityRef = (
      await exactOwnerRecord(root, {
        owner: 'signals-ai',
        kind: 'entity',
        id: `public:${entity.entity.id}`,
        revision: null,
        digest: null,
      })
    ).ref as RecordRef;
    const observationId = entity.entity.observations[0].id as string;
    const first = await createSourceCapture(
      root,
      {
        source_ref: sourceRef,
        mode: 'paste',
        text: 'A retained statement.\nOld condition.',
        observed_at: '2026-10-23T12:00:00Z',
      },
      (ref) => resolveRef(root, ref),
    );
    const second = await createSourceCapture(
      root,
      {
        source_ref: sourceRef,
        mode: 'fetch',
        supersedes: first.ref,
      },
      (ref) => resolveRef(root, ref),
      {
        fetcher: async () => ({
          text: 'A retained statement.\nNew condition.',
          digest: createHash('sha256').update('synthetic fetched bytes').digest('hex'),
          uri: 'https://example.org/retained-source',
          normalizer: 'text-v2',
        }),
      },
    );
    const preview = await previewSourceChange(root, first.capture.id, second.capture.id);
    expect(preview.observed_change).toMatchObject({
      state: 'changed',
      removed: ['Old condition.'],
      added: ['New condition.'],
    });
    expect(preview.observed_change.removed_line_refs).toEqual([{
      line_number: 2,
      line_sha256: createHash('sha256').update('Old condition.').digest('hex'),
      text: 'Old condition.',
    }]);
    expect(preview.observed_change.added_line_refs).toEqual([{
      line_number: 2,
      line_sha256: createHash('sha256').update('New condition.').digest('hex'),
      text: 'New condition.',
    }]);
    expect(preview.version_coverage.prior).toMatchObject({
      text_sha256: first.capture.text_sha256,
      raw_digest: null,
      scope: {
        capture: { mode: 'paste', omitted_utf16_units: 0 },
        extraction: { kind: 'operator-text-v1' },
      },
    });
    expect(preview.version_coverage.next).toMatchObject({
      text_sha256: second.capture.text_sha256,
      raw_digest: second.capture.raw_digest,
      scope: {
        capture: { mode: 'fetch', omitted_utf16_units: 0 },
        extraction: { kind: 'unmeasured' },
      },
    });
    const request = {
      request_id: randomUUID(),
      prior_capture_ref: first.ref,
      new_capture_ref: second.ref,
      meaningfulness: 'meaningful',
      change_rationale: 'The source changed the described scope.',
      assertions: [
        {
          entity_ref: entityRef,
          observation_id: observationId,
          currentness: 'needs-review',
          decision: 'revise',
          revised_status: 'uncertain',
          rationale: 'Recheck this judgment against the new source wording.',
          change_evidence: [
            {
              side: 'prior',
              capture_ref: first.ref,
              line_number: 2,
              line_sha256: createHash('sha256').update('Old condition.').digest('hex'),
            },
            {
              side: 'next',
              capture_ref: second.ref,
              line_number: 2,
              line_sha256: createHash('sha256').update('New condition.').digest('hex'),
            },
          ],
        },
      ],
    } as const;
    const created = await createSourceChangeReview(root, request);
    expect(created.review.assertions[0]).toMatchObject({
      currentness: 'needs-review',
      decision: 'revise',
      revised_status: 'uncertain',
    });
    expect(created.review.prior_capture_ref).toEqual(first.ref);
    expect(created.review.new_capture_ref).toEqual(second.ref);
    expect(created.review.version_coverage).toEqual(preview.version_coverage);
    expect(created.review.assertions[0]?.change_evidence).toEqual(request.assertions[0]?.change_evidence);
    expect((await listSourceChangeReviews(root)).reviews[0]?.impact_evidence_state).toBe('bound');
    const exactReview = await exactOwnerRecord(root, created.ref);
    expect(JSON.parse(exactReview.bytes.toString('utf8'))).toEqual(created.review);
    const replay = await createSourceChangeReview(root, request);
    expect(replay.replay).toBe(true);
    expect(replay.review.id).toBe(created.review.id);
    await expect(
      createSourceChangeReview(root, { ...request, change_rationale: 'different request body' }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      createSourceChangeReview(root, {
        ...request,
        request_id: randomUUID(),
        assertions: [
          {
            ...request.assertions[0],
            entity_ref: {
              ...entityRef,
              digest: '0'.repeat(64),
              revision: `sha256:${'0'.repeat(64)}`,
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      createSourceChangeReview(root, {
        ...request,
        request_id: randomUUID(),
        assertions: [{
          ...request.assertions[0],
          change_evidence: [{
            ...request.assertions[0].change_evidence[0],
            line_number: 1,
          }],
        }],
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      createSourceChangeReview(root, {
        ...request,
        request_id: randomUUID(),
        assertions: [{
          ...request.assertions[0],
          change_evidence: [{
            ...request.assertions[0].change_evidence[0],
            line_sha256: '0'.repeat(64),
          }],
        }],
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await listSourceChangeReviews(root)).reviews).toHaveLength(1);

    const third = await createSourceCapture(
      root,
      {
        source_ref: sourceRef,
        mode: 'paste',
        text: 'A retained statement.\nNew condition.',
        observed_at: '2026-10-23T14:00:00Z',
        supersedes: second.ref,
      },
      (ref) => resolveRef(root, ref),
    );
    const unchanged = await previewSourceChange(root, second.capture.id, third.capture.id);
    expect(unchanged.observed_change.state).toBe('unchanged');
    const unchangedReview = await createSourceChangeReview(root, {
      request_id: randomUUID(),
      prior_capture_ref: second.ref,
      new_capture_ref: third.ref,
      meaningfulness: 'unchanged',
      change_rationale: 'The retained text is identical across these adjacent versions.',
      assertions: [
        {
          entity_ref: entityRef,
          observation_id: observationId,
          currentness: 'current',
          decision: 'retain',
          rationale: 'This assertion remains current after reviewing the unchanged source text.',
        },
      ],
    });
    expect(unchangedReview.review.observed_change.state).toBe('unchanged');
    const reviewList = await listSourceChangeReviews(root);
    expect(reviewList.reviews).toHaveLength(2);
    expect(reviewList.reviews[1]?.impact_evidence_state).toBe('unbound');
    const longVersion = await createSourceCapture(
      root,
      {
        source_ref: sourceRef,
        mode: 'paste',
        text: 'z'.repeat(10000),
        observed_at: '2026-10-23T15:00:00Z',
        supersedes: third.ref,
      },
      (ref) => resolveRef(root, ref),
    );
    const longDiff = await previewSourceChange(root, third.capture.id, longVersion.capture.id);
    expect(longDiff.observed_change.truncated_added_line).toBe(true);
    expect(Buffer.byteLength(longDiff.observed_change.added.join('\n'))).toBeLessThanOrEqual(5000);
    expect(longDiff.observed_change.added[0]).toContain('[line excerpt truncated]');
    await expect(previewSourceChange(root, randomUUID(), randomUUID())).rejects.toMatchObject({
      status: 404,
    });
    await rm(join(root, '.signals/library-leads.json'));
    const reopened = await readSourceChangeReview(root, created.review.id);
    expect(reopened.cold_read).toBe(true);
    expect(reopened.ref).toEqual(created.ref);
    expect(reopened.review).toEqual(created.review);
    const captureStorePath = join(root, '.signals/source-captures.json');
    const captureStoreBytes = await readFile(captureStorePath);
    const captureStore = JSON.parse(captureStoreBytes.toString('utf8')) as any;
    captureStore.captures = captureStore.captures.filter((row: any) => row.id !== first.capture.id);
    await writeFile(captureStorePath, JSON.stringify(captureStore));
    await expect(readSourceChangeReview(root, created.review.id)).rejects.toMatchObject({ status: 503 });
    await writeFile(captureStorePath, captureStoreBytes);
    expect((await openSourceCapture(root, first.capture.id)).capture.text).toBe(
      'A retained statement.\nOld condition.',
    );
    await expect(readSourceChangeReview(root, randomUUID())).rejects.toMatchObject({ status: 404 });
    const reviewStorePath = join(root, '.signals/source-change-reviews.json');
    const legacyStore = JSON.parse(await readFile(reviewStorePath, 'utf8')) as any;
    delete legacyStore.reviews[0].version_coverage;
    await writeFile(reviewStorePath, JSON.stringify(legacyStore));
    const legacyRead = await readSourceChangeReview(root, created.review.id);
    expect(legacyRead.review).not.toHaveProperty('version_coverage');
    expect(legacyRead.impact_evidence_state).toBe('bound');
    const legacyUnbound = await readSourceChangeReview(root, unchangedReview.review.id);
    expect(legacyUnbound.impact_evidence_state).toBe('unbound');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
