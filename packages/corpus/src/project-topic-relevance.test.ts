import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createTopic, listTopics, searchKnowledge, updateTopic } from './knowledge.js';
import { loadLibrary } from './library.js';
import { saveLibraryLead } from './library-leads.js';
import { previewProject } from './project-preview.js';
import {
  attachOpportunity,
  loadProjects,
  projectHistory,
  registerProject,
  updateProject,
} from './projects.js';
import { exactOwnerRecord } from './provider-capabilities.js';
import {
  createProjectTopicRelevance,
  projectTopicRelevanceRecordBytes,
  previewProjectTopicRelevance,
  projectTopicRelevanceProviderBinding,
  readProjectTopicRelevance,
} from './project-topic-relevance.js';
import { createSourceCapture, type RecordRef } from './source-captures.js';
import { createSourceChangeReview } from './source-change-reviews.js';
import { loadEntities } from './search-store.js';
import { requestStore } from './search-request-store.js';

it('binds human relevance to exact topic, project and S04 change bases; preserves old records and cold reopens', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-project-topic-relevance-')));
  const projectFolder = join(root, 'selected-project');
  await mkdir(projectFolder);
  await writeFile(
    join(projectFolder, 'README.md'),
    '# Synthetic queue study\n\nCompare two counters.\n',
  );
  try {
    const entityFilename = 'entity-ea916635066b6efdf779ed3b.json';
    await mkdir(join(root, 'signals/entities'), { recursive: true });
    await copyFile(
      resolve(process.cwd(), 'signals/entities', entityFilename),
      join(root, 'signals/entities', entityFilename),
    );
    const [entityRecord] = await loadEntities(join(root, 'signals/entities'));
    if (!entityRecord) throw new Error('missing_synthetic_entity');
    await requestStore(root).initialize();
    const nativeMatches = await loadLibrary(root);
    const finding = nativeMatches[0];
    if (!finding) throw new Error('missing_synthetic_library_finding');
    const selected = await exactOwnerRecord(root, {
      owner: 'signals-ai',
      kind: 'entity',
      id: `public:${entityRecord.entity.id}`,
      revision: null,
      digest: null,
    });
    const topic = await createTopic(root, { name: 'Queue measurement sources' });
    const summary = (await searchKnowledge(root, '')).records.find(
      (row) => row.selection.ref.id === selected.ref.id,
    );
    if (!summary) throw new Error('missing_synthetic_topic_member');
    const member = summary.selection;
    const savedTopic = await updateTopic(root, topic.id, {
      revision: topic.revision,
      name: topic.name,
      selections: [member],
      links: [],
      questions: ['Does this evidence matter to the queue study?'],
    });
    const projectPreview = await previewProject(
      { kind: 'local', path: projectFolder },
      resolve('/synthetic-server'),
    );
    projectPreview.project.purpose = 'Compare service time across two counters.';
    projectPreview.project.constraints = ['No installation during opening hours.'];
    await registerProject(root, projectPreview.project);
    const opportunity = await attachOpportunity(root, {
      projectId: projectPreview.project.id,
      findingKey: finding.key,
      need: 'Choose a low-disruption measurement approach.',
      reason: 'The team has only one short observation window.',
      nextAction: 'compare',
    });

    const source = await saveLibraryLead(
      root,
      {
        uri: 'https://example.org/synthetic-queue-conditions',
        name: 'Synthetic retained queue source',
        description: 'Fixture only.',
        limits: [],
      },
      randomUUID(),
      'project-topic relevance fixture',
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
    const prior = await createSourceCapture(
      root,
      {
        source_ref: sourceRef,
        mode: 'paste',
        text: 'Observation window: ten minutes.',
        observed_at: '2026-10-23T12:00:00Z',
      },
      resolveRef,
    );
    const next = await createSourceCapture(
      root,
      {
        source_ref: sourceRef,
        mode: 'paste',
        text: 'Observation window: five minutes.',
        observed_at: '2026-10-23T13:00:00Z',
        supersedes: prior.ref,
      },
      resolveRef,
    );
    const changeReview = await createSourceChangeReview(root, {
      request_id: randomUUID(),
      prior_capture_ref: prior.ref,
      new_capture_ref: next.ref,
      meaningfulness: 'meaningful',
      change_rationale: 'The stated observation window changed.',
      assertions: [
        {
          entity_ref: selected.ref,
          observation_id: entityRecord.entity.observations[0]!.id,
          currentness: 'needs-review',
          decision: 'retain',
          rationale: 'Keep the original assertion visible while it is reviewed.',
        },
      ],
    });
    const request = {
      request_id: randomUUID(),
      topic_id: savedTopic.id,
      topic_revision: savedTopic.revision,
      member_selections: [member],
      project_id: projectPreview.project.id,
      provider_binding: await projectTopicRelevanceProviderBinding(root),
      opportunity_id: opportunity.id,
      source_change_review_ref: changeReview.ref,
    };
    const { request_id: _requestId, ...previewRequest } = request;
    const preview = await previewProjectTopicRelevance(root, previewRequest);
    expect(preview.preview).toMatchObject({
      topic: { id: savedTopic.id, revision: savedTopic.revision },
      selected_members: [{ state: 'current' }],
      project: { id: projectPreview.project.id, purpose: projectPreview.project.purpose },
      opportunity: { id: opportunity.id, need: opportunity.need },
      source_change_review: {
        ref: changeReview.ref,
        capture_refs: [prior.ref, next.ref],
        meaningfulness: 'meaningful',
      },
    });
    expect(JSON.stringify(preview)).not.toContain(projectFolder);
    await expect(
      createProjectTopicRelevance(root, {
        request_id: randomUUID(),
        basis: {
          ...preview.basis,
          provider_binding: {
            ...preview.basis.provider_binding,
            owner_epoch: randomUUID(),
          },
        },
        relevance: 'uncertain',
        rationale: 'The provider epoch no longer matches the preview.',
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      previewProjectTopicRelevance(root, {
        ...previewRequest,
        topic_id: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 404 });
    await updateProject(root, {
      id: projectPreview.project.id,
      name: projectPreview.project.name,
      purpose: 'Temporarily changed after preview.',
      constraints: projectPreview.project.constraints,
    });
    await expect(
      createProjectTopicRelevance(root, {
        request_id: randomUUID(),
        basis: preview.basis,
        relevance: 'uncertain',
        rationale: 'This preview is stale.',
      }),
    ).rejects.toMatchObject({ status: 409 });
    await updateProject(root, {
      id: projectPreview.project.id,
      name: projectPreview.project.name,
      purpose: projectPreview.project.purpose,
      constraints: projectPreview.project.constraints,
    });
    const topicBytesBefore = await readFile(join(root, '.signals/topics.json'));
    const projectBytesBefore = await readFile(join(root, '.signals/projects.json'));
    const capturesBytesBefore = await readFile(join(root, '.signals/source-captures.json'));
    const changeReviewBytesBefore = await readFile(
      join(root, '.signals/source-change-reviews.json'),
    );
    const historyBefore = await projectHistory(root, projectPreview.project.id);
    const historyBytesBefore = await Promise.all(
      historyBefore.history.map((row) =>
        readFile(
          join(
            root,
            '.signals/project-history',
            projectPreview.project.id,
            `${row.contextDigest}.json`,
          ),
        ),
      ),
    );
    const created = await createProjectTopicRelevance(root, {
      request_id: request.request_id,
      basis: preview.basis,
      relevance: 'uncertain',
      rationale: 'The shorter observation window may affect feasibility; the team should decide.',
    });
    expect(created.replay).toBe(false);
    const exactReview = await projectTopicRelevanceRecordBytes(root, created.review.id);
    expect(createHash('sha256').update(exactReview.bytes).digest('hex')).toBe(created.ref.digest);
    expect((await readFile(join(root, '.signals/topics.json'))).equals(topicBytesBefore)).toBe(
      true,
    );
    expect((await readFile(join(root, '.signals/projects.json'))).equals(projectBytesBefore)).toBe(
      true,
    );
    expect(
      (await readFile(join(root, '.signals/source-captures.json'))).equals(capturesBytesBefore),
    ).toBe(true);
    expect(
      (await readFile(join(root, '.signals/source-change-reviews.json'))).equals(
        changeReviewBytesBefore,
      ),
    ).toBe(true);
    const historyAfter = await projectHistory(root, projectPreview.project.id);
    expect(
      await Promise.all(
        historyAfter.history.map((row) =>
          readFile(
            join(
              root,
              '.signals/project-history',
              projectPreview.project.id,
              `${row.contextDigest}.json`,
            ),
          ),
        ),
      ),
    ).toEqual(historyBytesBefore);
    const duplicate = await createProjectTopicRelevance(root, {
      request_id: request.request_id,
      basis: preview.basis,
      relevance: 'uncertain',
      rationale: 'The shorter observation window may affect feasibility; the team should decide.',
    });
    expect(duplicate).toMatchObject({ replay: true, review: created.review });
    await expect(
      createProjectTopicRelevance(root, {
        request_id: request.request_id,
        basis: preview.basis,
        relevance: 'relevant',
        rationale: 'Changed request content.',
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await readProjectTopicRelevance(root, created.review.id)).basis_status).toBe('current');
    await updateProject(root, {
      id: projectPreview.project.id,
      name: projectPreview.project.name,
      purpose: 'Observe staff handoffs instead of queue time.',
      constraints: projectPreview.project.constraints,
    });
    expect((await readProjectTopicRelevance(root, created.review.id)).basis_status).toBe(
      'needs-review',
    );
    const cold = await readProjectTopicRelevance(root, created.review.id);
    expect(cold.cold_read).toBe(true);
    expect(cold.review).toEqual(created.review);
    expect((await listTopics(root)).topics[0]).toEqual(savedTopic);
    expect((await loadProjects(root)).projects[0]!.purpose).toBe(
      'Observe staff handoffs instead of queue time.',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
