import { mkdtemp, readFile, realpath, rm, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
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
        mode: 'paste',
        text: 'A retained statement.\nNew condition.',
        observed_at: '2026-10-23T13:00:00Z',
        supersedes: first.ref,
      },
      (ref) => resolveRef(root, ref),
    );
    const preview = await previewSourceChange(root, first.capture.id, second.capture.id);
    expect(preview.observed_change).toMatchObject({
      state: 'changed',
      removed: ['Old condition.'],
      added: ['New condition.'],
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
    expect((await listSourceChangeReviews(root)).reviews).toHaveLength(2);
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
    await expect(readSourceChangeReview(root, randomUUID())).rejects.toMatchObject({ status: 404 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
