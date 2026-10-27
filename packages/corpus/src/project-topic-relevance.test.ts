import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createTopic, listTopics, searchKnowledge, updateTopic } from './knowledge.js';
import { loadLibrary } from './library.js';
import { saveLibraryLead } from './library-leads.js';
import { previewProject } from './project-preview.js';
import {
  attachOpportunity,
  associateOpportunity,
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
import {
  listProjectOpportunityBriefs,
  previewProjectOpportunityBrief,
  projectOpportunityBriefProviderBinding,
  projectOpportunityBriefRecordBytes,
  readProjectOpportunityBrief,
  retainProjectOpportunityBrief,
  previewProjectOpportunityBriefReassessment,
  reassessProjectOpportunityBrief,
} from './project-opportunity-brief.js';

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
    const briefContent = {
      title: 'Measure queue handoffs with a short observation',
      observed_need:
        'The team needs a low-disruption way to compare service time across two counters.',
      options: [
        {
          kind: 'no_action' as const,
          title: 'No action',
          description: 'Keep the current process and make no measurement change.',
        },
        {
          kind: 'existing' as const,
          title: 'Long observation',
          description: 'Observe both counters over a longer time window.',
        },
      ],
      reversible_intervention:
        'Run one short, staff-approved observation and stop if the queue is disrupted.',
      responsible_party: 'The project operator with staff consent.',
      falsifiable_outcome:
        'The two-counter sample produces a repeatable time difference without increasing queue disruption.',
      evidence: [
        {
          ref: member.ref,
          position: 'supports' as const,
          confidence: 'moderate' as const,
          rationale:
            'This retained source frames a relevant measurement question; the interpretation remains human.',
        },
        {
          ref: next.ref,
          position: 'challenges' as const,
          confidence: 'low' as const,
          rationale:
            'The changed capture records a shorter window, which may not support a stable comparison.',
        },
      ],
      contradictions_reviewed: true as const,
      contradictions: [
        {
          statement:
            'The retained source suggests a comparison is useful, while the newer capture shortens the observation window.',
          refs: [member.ref, next.ref],
        },
      ],
      missing_evidence_reviewed: true as const,
      missing_evidence: [
        {
          question: 'Would staff accept a short observation during peak service?',
          why_it_matters:
            'Without staff acceptance, the reversible test may still disrupt service.',
        },
      ],
    };
    const selection = {
      project_id: projectPreview.project.id,
      opportunity_id: opportunity.id,
      topic_id: savedTopic.id,
      relevance_id: created.review.id,
    };
    const briefPreview = await previewProjectOpportunityBrief(root, {
      selection,
      content: briefContent,
    });
    expect(briefPreview).toMatchObject({
      project: { id: projectPreview.project.id },
      opportunity: { id: opportunity.id },
      topic: { id: savedTopic.id, revision: savedTopic.revision },
      relevance: { judgment: 'uncertain' },
      evidence: [{ currentness: 'current' }, { currentness: 'current' }],
    });
    expect(briefPreview.basis.provider_binding).toEqual(
      await projectOpportunityBriefProviderBinding(root),
    );
    const briefId = randomUUID();
    const brief = await retainProjectOpportunityBrief(root, {
      request_id: briefId,
      selection,
      basis: briefPreview.basis,
      content: briefContent,
      preview_digest: briefPreview.preview_digest,
    });
    expect(brief.ref.kind).toBe('project_opportunity_brief');
    const briefBytes = await projectOpportunityBriefRecordBytes(root, briefId);
    expect(createHash('sha256').update(briefBytes.bytes).digest('hex')).toBe(brief.ref.digest);
    expect(existsSync(join(root, '.signals/project-opportunity-briefs.json'))).toBe(false);
    expect(await listProjectOpportunityBriefs(root)).toMatchObject({
      briefs: [
        { ref: brief.ref, project_id: projectPreview.project.id, opportunity_id: opportunity.id },
      ],
    });
    expect((await readProjectOpportunityBrief(root, briefId)).basis_status).toBe('current');
    expect((await readProjectTopicRelevance(root, created.review.id)).basis_status).toBe('current');
    const sameBrief = await retainProjectOpportunityBrief(root, {
      request_id: briefId,
      selection,
      basis: briefPreview.basis,
      content: briefContent,
      preview_digest: briefPreview.preview_digest,
    });
    expect(sameBrief).toMatchObject({ replay: true, brief: brief.brief });
    const changedContent = { ...briefContent, title: 'Changed under the same request ID' };
    const changedPreview = await previewProjectOpportunityBrief(root, {
      selection,
      content: changedContent,
    });
    await expect(
      retainProjectOpportunityBrief(root, {
        request_id: briefId,
        selection,
        basis: changedPreview.basis,
        content: changedContent,
        preview_digest: changedPreview.preview_digest,
      }),
    ).rejects.toMatchObject({ code: 'project_opportunity_brief_uuid_conflict' });
    await expect(
      previewProjectOpportunityBrief(root, {
        selection,
        content: {
          ...briefContent,
          evidence: [
            { ...briefContent.evidence[0]!, ref: { ...member.ref, digest: '0'.repeat(64) } },
          ],
        },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await readProjectOpportunityBrief(root, briefId)).brief).toEqual(brief.brief);
    await updateProject(root, {
      id: projectPreview.project.id,
      name: projectPreview.project.name,
      purpose: 'Observe staff handoffs instead of queue time.',
      constraints: projectPreview.project.constraints,
    });
    expect((await readProjectTopicRelevance(root, created.review.id)).basis_status).toBe(
      'needs-review',
    );
    const coldBrief = await readProjectOpportunityBrief(root, briefId);
    expect(coldBrief).toMatchObject({
      basis_status: 'needs-review',
      brief: { id: briefId, title: briefContent.title },
      cold_read: true,
      evidence_currentness: [{ state: 'current' }, { state: 'current' }],
    });
    await associateOpportunity(root, {
      id: opportunity.id,
      projectId: projectPreview.project.id,
    });
    const refreshedRelevancePreview = await previewProjectTopicRelevance(root, {
      ...previewRequest,
      provider_binding: await projectTopicRelevanceProviderBinding(root),
    });
    const refreshedRelevance = await createProjectTopicRelevance(root, {
      request_id: randomUUID(),
      basis: refreshedRelevancePreview.basis,
      relevance: 'uncertain',
      rationale: 'Reassess the same topic against the updated project context.',
    });
    const reassessmentSelection = {
      ...selection,
      relevance_id: refreshedRelevance.review.id,
    };
    const parentRef = coldBrief.ref;
    const reassessmentInput = {
      parent_ref: parentRef,
      selection: reassessmentSelection,
      rationale: 'Reconsidered the retained interpretation after reviewing the project context.',
      evidence_updates: [
        {
          ref: briefContent.evidence[0]!.ref,
          position: 'context' as const,
          confidence: 'low' as const,
          rationale:
            'This source frames the question but does not directly support the proposed comparison.',
        },
      ],
    };
    const reassessmentPreview = await previewProjectOpportunityBriefReassessment(
      root,
      reassessmentInput,
    );
    const successorId = randomUUID();
    const successor = await reassessProjectOpportunityBrief(root, {
      request_id: successorId,
      ...reassessmentInput,
      basis: reassessmentPreview.basis,
      preview_digest: reassessmentPreview.preview_digest,
    });
    const replayedSuccessor = await reassessProjectOpportunityBrief(root, {
      request_id: successorId,
      ...reassessmentInput,
      basis: reassessmentPreview.basis,
      preview_digest: reassessmentPreview.preview_digest,
    });
    expect(replayedSuccessor).toMatchObject({
      replay: true,
      ref: successor.ref,
      brief: successor.brief,
    });
    expect(successor.brief.reassessment).toMatchObject({
      parent_ref: parentRef,
      rationale: reassessmentInput.rationale,
      changes: [{ ref: briefContent.evidence[0]!.ref }],
    });
    expect(successor.brief.evidence[1]).toEqual(brief.brief.evidence[1]);
    expect((await readProjectOpportunityBrief(root, briefId)).ref).toEqual(parentRef);
    const coldSuccessor = await readProjectOpportunityBrief(root, successorId);
    expect(coldSuccessor).toMatchObject({
      brief: { id: successorId, reassessment: { parent_ref: parentRef } },
      cold_read: true,
    });
    expect(coldSuccessor.brief.evidence[0]).toMatchObject({
      position: 'context',
      confidence: 'low',
    });
    const stalePreview = await previewProjectOpportunityBriefReassessment(root, {
      ...reassessmentInput,
      rationale: 'Reassess after checking the current project context again.',
      evidence_updates: [],
    });
    await updateProject(root, {
      id: projectPreview.project.id,
      name: projectPreview.project.name,
      purpose: 'Concurrent edit after reassessment preview.',
      constraints: projectPreview.project.constraints,
    });
    await expect(
      reassessProjectOpportunityBrief(root, {
        request_id: randomUUID(),
        parent_ref: parentRef,
        selection: reassessmentSelection,
        rationale: 'Reassess after checking the current project context again.',
        evidence_updates: [],
        basis: stalePreview.basis,
        preview_digest: stalePreview.preview_digest,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const cold = await readProjectTopicRelevance(root, created.review.id);
    expect(cold.cold_read).toBe(true);
    expect(cold.review).toEqual(created.review);
    expect((await listTopics(root)).topics[0]).toEqual(savedTopic);
    expect((await loadProjects(root)).projects[0]!.purpose).toBe(
      'Concurrent edit after reassessment preview.',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
