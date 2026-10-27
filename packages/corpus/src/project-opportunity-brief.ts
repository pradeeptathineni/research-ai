import { createHash } from 'node:crypto';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { openTopic } from './knowledge.js';
import { exactOwnerRecord, providerCapabilities, ProviderError } from './provider-capabilities.js';
import {
  listOpportunities,
  loadProjects,
  projectContextFingerprint,
  appendProjectOpportunityBrief,
} from './projects.js';
import {
  readProjectTopicRelevance,
  ProjectTopicRelevanceError,
} from './project-topic-relevance.js';
import { readSourceChangeReview, SourceChangeReviewError } from './source-change-reviews.js';
import { requestStore } from './search-request-store.js';
import { projectOpportunityBriefSchema } from './project-contract.js';

const closed = { additionalProperties: false };
const uuid = Type.String({ pattern: '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$' });
const digestSchema = Type.String({ pattern: '^[a-f0-9]{64}$' });
const briefBindingSchema = Type.Object(
  {
    schema: Type.Literal('signals-provider-contract-binding.v1'),
    owner: Type.Literal('signals-ai'),
    contract_id: Type.Literal('project-opportunity-brief'),
    contract_version: Type.Literal('1.0'),
    digest_kind: Type.Literal('sha256-canonical-contract-json-v1'),
    contract_digest: digestSchema,
    instance_id: uuid,
    owner_epoch: uuid,
    source_commit: Type.Optional(Type.String({ pattern: '^[a-f0-9]{40,64}$' })),
  },
  closed,
);
const reassessmentBindingSchema = Type.Object(
  {
    schema: Type.Literal('signals-provider-contract-binding.v1'),
    owner: Type.Literal('signals-ai'),
    contract_id: Type.Literal('project-opportunity-brief-reassessment'),
    contract_version: Type.Literal('1.0'),
    digest_kind: Type.Literal('sha256-canonical-contract-json-v1'),
    contract_digest: digestSchema,
    instance_id: uuid,
    owner_epoch: uuid,
    source_commit: Type.Optional(Type.String({ pattern: '^[a-f0-9]{40,64}$' })),
  },
  closed,
);
const exactRefSchema = Type.Object(
  {
    owner: Type.Literal('signals-ai'),
    kind: Type.String({ minLength: 1, maxLength: 100 }),
    id: Type.String({ minLength: 1, maxLength: 200 }),
    revision: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
    digest: digestSchema,
  },
  closed,
);
const evidenceSchema = Type.Object(
  {
    ref: exactRefSchema,
    position: Type.Enum(['supports', 'challenges', 'context', 'unknown']),
    confidence: Type.Enum(['high', 'moderate', 'low', 'unknown']),
    rationale: Type.String({ minLength: 1, maxLength: 1000 }),
  },
  closed,
);
const optionSchema = Type.Object(
  {
    kind: Type.Enum(['existing', 'no_action']),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.String({ minLength: 1, maxLength: 1500 }),
  },
  closed,
);
const contentSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200 }),
    observed_need: Type.String({ minLength: 1, maxLength: 3000 }),
    options: Type.Array(optionSchema, { minItems: 2, maxItems: 6 }),
    reversible_intervention: Type.String({ minLength: 1, maxLength: 2000 }),
    responsible_party: Type.String({ minLength: 1, maxLength: 300 }),
    falsifiable_outcome: Type.String({ minLength: 1, maxLength: 1000 }),
    evidence: Type.Array(evidenceSchema, { minItems: 1, maxItems: 12 }),
    contradictions_reviewed: Type.Literal(true),
    contradictions: Type.Array(
      Type.Object(
        {
          statement: Type.String({ minLength: 1, maxLength: 1000 }),
          refs: Type.Array(exactRefSchema, { minItems: 1, maxItems: 6 }),
        },
        closed,
      ),
      { maxItems: 10 },
    ),
    missing_evidence_reviewed: Type.Literal(true),
    missing_evidence: Type.Array(
      Type.Object(
        {
          question: Type.String({ minLength: 1, maxLength: 500 }),
          why_it_matters: Type.String({ minLength: 1, maxLength: 500 }),
        },
        closed,
      ),
      { maxItems: 10 },
    ),
  },
  closed,
);
const selectionSchema = Type.Object(
  {
    project_id: Type.String({ pattern: '^project-[a-f0-9]{24}$' }),
    opportunity_id: Type.String({ minLength: 1, maxLength: 200 }),
    topic_id: uuid,
    relevance_id: uuid,
  },
  closed,
);
const previewSchema = Type.Object({ selection: selectionSchema, content: contentSchema }, closed);
const retainSchema = Type.Object(
  {
    request_id: uuid,
    selection: selectionSchema,
    basis: projectOpportunityBriefSchema.properties.basis,
    content: contentSchema,
    preview_digest: digestSchema,
  },
  closed,
);
const reassessmentRequestSchema = Type.Object(
  {
    request_id: uuid,
    parent_ref: exactRefSchema,
    selection: selectionSchema,
    rationale: Type.String({ minLength: 10, maxLength: 1000 }),
    evidence_updates: Type.Array(
      Type.Object(
        {
          ref: exactRefSchema,
          position: evidenceSchema.properties.position,
          confidence: evidenceSchema.properties.confidence,
          rationale: evidenceSchema.properties.rationale,
        },
        closed,
      ),
      { maxItems: 12 },
    ),
    basis: projectOpportunityBriefSchema.properties.basis,
    preview_digest: digestSchema,
  },
  closed,
);
const reassessmentPreviewInputSchema = Type.Object(
  {
    parent_ref: exactRefSchema,
    selection: selectionSchema,
    rationale: Type.String({ minLength: 10, maxLength: 1000 }),
    evidence_updates: reassessmentRequestSchema.properties.evidence_updates,
  },
  closed,
);
type Selection = Static<typeof selectionSchema>;
type Content = Static<typeof contentSchema>;
type Binding = Static<typeof briefBindingSchema>;
type Basis = Static<typeof projectOpportunityBriefSchema.properties.basis>;
type Brief = Static<typeof projectOpportunityBriefSchema>;
type ExactRef = Static<typeof exactRefSchema>;
type ReassessmentRequest = Static<typeof reassessmentRequestSchema>;
type ReassessmentBinding = Static<typeof reassessmentBindingSchema>;

export class ProjectOpportunityBriefError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly reason: string,
  ) {
    super(reason);
  }
}
function fail(status: number, code: string, reason: string): never {
  throw new ProjectOpportunityBriefError(status, code, reason);
}
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => JSON.stringify(key) + ':' + canonical(child))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
};
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const bindingDigestKind = 'sha256-canonical-contract-json-v1';
const exactRef = (value: unknown): value is ExactRef => Value.Check(exactRefSchema, value);

export async function projectOpportunityBriefProviderBinding(root: string): Promise<Binding> {
  const scope = await requestStore(root)
    .scope()
    .catch(() =>
      fail(
        503,
        'project_opportunity_brief_unavailable',
        'The Signals owner binding is unavailable.',
      ),
    );
  const response = await providerCapabilities(root, '1.0', scope.identity, scope.epoch);
  const capabilities = response.capabilities as {
    contracts?: Array<{ id: string; versions: string[] }>;
    operations?: Array<{
      name: string;
      target_kinds: string[];
      mutating: boolean;
      authority_required: boolean;
    }>;
    record_kinds?: string[];
    source_commit?: string;
  };
  const contract = capabilities.contracts?.find(
    (row) => row.id === 'project-opportunity-brief' && row.versions.includes('1.0'),
  );
  const read = capabilities.operations?.find(
    (row) => row.name === 'read_project_opportunity_brief',
  );
  const retain = capabilities.operations?.find(
    (row) => row.name === 'retain_project_opportunity_brief',
  );
  if (
    !contract ||
    !read ||
    read.mutating ||
    read.authority_required ||
    !read.target_kinds.includes('project_opportunity_brief') ||
    !retain ||
    !retain.mutating ||
    !retain.authority_required ||
    !retain.target_kinds.includes('project_opportunity_brief') ||
    !capabilities.record_kinds?.includes('project_opportunity_brief')
  )
    fail(
      503,
      'project_opportunity_brief_unavailable',
      'The connected Signals provider lacks the complete opportunity-brief v1 contract.',
    );
  const metadata = {
    contract,
    operations: [read, retain],
    record_kinds: ['project_opportunity_brief'],
  };
  return {
    schema: 'signals-provider-contract-binding.v1',
    owner: 'signals-ai',
    contract_id: 'project-opportunity-brief',
    contract_version: '1.0',
    digest_kind: bindingDigestKind,
    contract_digest: sha256(canonical(metadata)),
    instance_id: scope.identity,
    owner_epoch: scope.epoch,
    ...(typeof capabilities.source_commit === 'string' &&
    /^[a-f0-9]{40,64}$/.test(capabilities.source_commit)
      ? { source_commit: capabilities.source_commit }
      : {}),
  };
}

async function projectOpportunityBriefReassessmentBinding(
  root: string,
): Promise<ReassessmentBinding> {
  const scope = await requestStore(root)
    .scope()
    .catch(() =>
      fail(
        503,
        'project_opportunity_brief_unavailable',
        'The Signals owner binding is unavailable.',
      ),
    );
  const response = await providerCapabilities(root, '1.0', scope.identity, scope.epoch);
  const capabilities = response.capabilities as {
    contracts?: Array<{ id: string; versions: string[] }>;
    operations?: Array<{
      name: string;
      target_kinds: string[];
      mutating: boolean;
      authority_required: boolean;
    }>;
    record_kinds?: string[];
    source_commit?: string;
  };
  const contract = capabilities.contracts?.find(
    (row) => row.id === 'project-opportunity-brief-reassessment' && row.versions.includes('1.0'),
  );
  const preview = capabilities.operations?.find(
    (row) => row.name === 'preview_project_opportunity_brief_reassessment',
  );
  const save = capabilities.operations?.find(
    (row) => row.name === 'reassess_project_opportunity_brief',
  );
  if (
    !contract ||
    !preview ||
    preview.mutating ||
    preview.authority_required ||
    !preview.target_kinds.includes('project_opportunity_brief') ||
    !save ||
    !save.mutating ||
    !save.authority_required ||
    !save.target_kinds.includes('project_opportunity_brief') ||
    !capabilities.record_kinds?.includes('project_opportunity_brief')
  )
    fail(
      503,
      'project_opportunity_brief_reassessment_unavailable',
      'The connected Signals provider lacks the complete reassessment v1 contract.',
    );
  const metadata = {
    contract,
    operations: [preview, save],
    record_kinds: ['project_opportunity_brief'],
  };
  return {
    schema: 'signals-provider-contract-binding.v1',
    owner: 'signals-ai',
    contract_id: 'project-opportunity-brief-reassessment',
    contract_version: '1.0',
    digest_kind: bindingDigestKind,
    contract_digest: sha256(canonical(metadata)),
    instance_id: scope.identity,
    owner_epoch: scope.epoch,
    ...(typeof capabilities.source_commit === 'string' &&
    /^[a-f0-9]{40,64}$/.test(capabilities.source_commit)
      ? { source_commit: capabilities.source_commit }
      : {}),
  };
}

function briefBytes(brief: Brief) {
  return Buffer.from(JSON.stringify(brief), 'utf8');
}
function briefRef(brief: Brief): ExactRef {
  const digest = sha256(briefBytes(brief));
  return {
    owner: 'signals-ai',
    kind: 'project_opportunity_brief',
    id: brief.id,
    revision: `sha256:${digest}`,
    digest,
  };
}
function same(a: unknown, b: unknown) {
  return canonical(a) === canonical(b);
}

async function currentBasis(root: string, selection: Selection) {
  const binding = await projectOpportunityBriefProviderBinding(root);
  const state = await loadProjects(root);
  const project = state.projects.find((row) => row.id === selection.project_id && row.connected);
  if (!project)
    fail(
      404,
      'project_opportunity_brief_project_missing',
      'The exact connected project is missing.',
    );
  const opportunity = state.opportunities.find((row) => row.id === selection.opportunity_id);
  if (!opportunity || opportunity.projectId !== project.id)
    fail(
      404,
      'project_opportunity_brief_opportunity_missing',
      'The exact project opportunity is missing.',
    );
  const opportunitySummary = (await listOpportunities(root)).find(
    (row) => row.id === opportunity.id,
  );
  if (opportunitySummary?.needsReview)
    fail(
      409,
      'project_opportunity_brief_opportunity_changed',
      'The project opportunity needs review against current project context.',
    );

  const relevance = await readProjectTopicRelevance(root, selection.relevance_id);
  if (relevance.basis_status !== 'current')
    fail(
      409,
      'project_opportunity_brief_relevance_changed',
      'The exact topic relevance review needs review before briefing.',
    );
  const review = relevance.review;
  if (
    review.basis.project_id !== project.id ||
    review.basis.opportunity_id !== opportunity.id ||
    review.basis.topic_id !== selection.topic_id
  )
    fail(
      409,
      'project_opportunity_brief_relevance_mismatch',
      'The saved relevance review does not bind this exact topic, project, and opportunity.',
    );

  const opened = await openTopic(root, selection.topic_id);
  if (opened.topic.revision !== review.basis.topic_revision)
    fail(
      409,
      'project_opportunity_brief_topic_changed',
      'The exact topic changed after its relevance review.',
    );
  if (
    review.basis.member_selections.some(
      (selection) =>
        opened.statuses.find((item) => same(item.selection, selection))?.state !== 'current',
    )
  )
    fail(
      409,
      'project_opportunity_brief_topic_members_changed',
      'One or more selected topic members are changed, missing, or unavailable. Review a fresh topic and relevance basis.',
    );

  let sourceChangeReviewRef: Basis['source_change_review_ref'];
  let sourceCaptureRefs: Basis['source_capture_refs'];
  if (review.basis.source_change_review_ref) {
    const sourceRef = review.basis.source_change_review_ref;
    const sourceReview = await readSourceChangeReview(root, sourceRef.id);
    if (!same(sourceReview.ref, sourceRef))
      fail(
        409,
        'project_opportunity_brief_source_review_changed',
        'The exact source-change review changed.',
      );
    sourceChangeReviewRef = sourceRef;
    sourceCaptureRefs = review.basis.source_capture_refs;
  }

  const allowedRefs = [
    ...review.basis.member_selections.map((item) => item.ref),
    ...(sourceCaptureRefs ?? []),
  ].filter(exactRef);
  for (const ref of allowedRefs) await exactOwnerRecord(root, ref);
  return {
    basis: {
      project_id: project.id,
      project_snapshot_sha256: project.snapshot.digest,
      project_context_sha256: projectContextFingerprint(project),
      opportunity_id: opportunity.id,
      opportunity_sha256: review.basis.opportunity_sha256!,
      topic_id: opened.topic.id,
      topic_revision: opened.topic.revision,
      topic_sha256: review.basis.topic_sha256,
      relevance_ref: relevance.ref,
      ...(sourceChangeReviewRef ? { source_change_review_ref: sourceChangeReviewRef } : {}),
      ...(sourceCaptureRefs ? { source_capture_refs: sourceCaptureRefs } : {}),
      provider_binding: binding,
    } satisfies Basis,
    project: {
      id: project.id,
      name: project.name,
      purpose: project.purpose,
      constraints: project.constraints,
    },
    opportunity: {
      id: opportunity.id,
      title: opportunity.title,
      need: opportunity.need,
      reason: opportunity.reason,
      nextAction: opportunity.nextAction,
    },
    topic: { id: opened.topic.id, revision: opened.topic.revision, name: opened.topic.name },
    relevance: { ref: relevance.ref, judgment: review.relevance, rationale: review.rationale },
    allowedRefs,
  };
}

function validateContent(content: Content, allowedRefs: ExactRef[]) {
  if (!content.options.some((option) => option.kind === 'no_action'))
    fail(
      400,
      'project_opportunity_brief_no_action_option',
      'Include the no-action option among the alternatives.',
    );
  const keys = new Set(allowedRefs.map((ref) => canonical(ref)));
  const evidenceKeys = new Set<string>();
  for (const item of content.evidence) {
    const key = canonical(item.ref);
    if (!keys.has(key))
      fail(
        409,
        'project_opportunity_brief_evidence_not_in_basis',
        'Evidence must use exact topic-member or source-change capture references from the selected relevance review.',
      );
    if (evidenceKeys.has(key))
      fail(
        400,
        'project_opportunity_brief_duplicate_evidence',
        'Each exact source can appear only once in the evidence table.',
      );
    evidenceKeys.add(key);
  }
  for (const contradiction of content.contradictions)
    if (contradiction.refs.some((ref) => !evidenceKeys.has(canonical(ref))))
      fail(
        400,
        'project_opportunity_brief_contradiction_ref',
        'Contradictions must refer to evidence rows in this brief.',
      );
}

export async function previewProjectOpportunityBrief(root: string, input: unknown) {
  if (!Value.Check(previewSchema, input))
    fail(
      400,
      'invalid_project_opportunity_brief',
      'The opportunity brief preview input is invalid.',
    );
  const value = input as { selection: Selection; content: Content };
  const current = await currentBasis(root, value.selection);
  validateContent(value.content, current.allowedRefs);
  const previewDigest = sha256(canonical({ basis: current.basis, content: value.content }));
  return {
    schema_version: 'project-opportunity-brief-preview-v1',
    basis: current.basis,
    preview_digest: previewDigest,
    project: current.project,
    opportunity: current.opportunity,
    topic: current.topic,
    relevance: current.relevance,
    evidence: value.content.evidence.map((item) => ({ ...item, currentness: 'current' as const })),
    content: value.content,
    qualifications: [
      'Evidence positions and confidence are human-authored judgments, not verified claims or automatic scores.',
      'The brief preserves contradictory and missing evidence explicitly; source currentness is reported separately from confidence.',
      'The selected topic membership and relevance judgment do not establish support for the opportunity.',
    ],
  };
}

export async function retainProjectOpportunityBrief(root: string, input: unknown) {
  if (!Value.Check(retainSchema, input))
    fail(
      400,
      'invalid_project_opportunity_brief',
      'The opportunity brief retention input is invalid.',
    );
  const request = input as {
    request_id: string;
    selection: Selection;
    basis: Basis;
    content: Content;
    preview_digest: string;
  };
  const current = await currentBasis(root, request.selection);
  const providerBinding = await projectOpportunityBriefReassessmentBinding(root);
  if (!same(request.basis, current.basis))
    fail(
      409,
      'project_opportunity_brief_basis_changed',
      'The selected project, opportunity, topic, relevance, source, or provider basis changed after preview. Preview again.',
    );
  validateContent(request.content, current.allowedRefs);
  const digest = sha256(
    canonical({ request_id: request.request_id, basis: request.basis, content: request.content }),
  );
  if (
    request.preview_digest !== sha256(canonical({ basis: request.basis, content: request.content }))
  )
    fail(
      409,
      'project_opportunity_brief_preview_changed',
      'Brief content changed after preview. Preview the current text before retaining.',
    );
  const brief: Brief = {
    schema_version: 'project-opportunity-brief-v1',
    id: request.request_id,
    created_at: new Date().toISOString(),
    request_digest: digest,
    basis: request.basis,
    ...request.content,
    qualifications: [
      'This brief records human judgments and exact retained references; it does not verify the underlying claims.',
      'Confidence is independent of source currentness. Changed, missing, unavailable, contradictory, and unknown evidence remain visible.',
      'This brief does not establish consensus, project impact, or authority to execute or publish an intervention.',
    ],
  };
  let retained: Brief;
  try {
    retained = await appendProjectOpportunityBrief(
      root,
      request.selection.opportunity_id,
      brief,
      async () => {
        const latest = await currentBasis(root, request.selection);
        if (!same(latest.basis, request.basis))
          fail(
            409,
            'project_opportunity_brief_basis_changed',
            'The exact brief basis changed during retention. Preview again.',
          );
      },
    );
  } catch (error) {
    if (error instanceof ProjectOpportunityBriefError) throw error;
    const code = error instanceof Error ? error.message : 'project_opportunity_brief_unavailable';
    if (code === 'unknown_opportunity')
      fail(
        404,
        'project_opportunity_brief_opportunity_missing',
        'The exact opportunity is missing.',
      );
    if (code === 'project_opportunity_brief_capacity')
      fail(409, code, 'This opportunity reached its retained brief limit.');
    if (code.startsWith('project_opportunity_brief_'))
      fail(409, code, 'The exact opportunity or brief binding changed during retention.');
    fail(503, 'project_opportunity_brief_unavailable', 'The brief could not be retained safely.');
  }
  return { ref: briefRef(retained), brief: retained, replay: retained !== brief };
}

/** Produces a successor preview against a freshly reviewed current basis. */
export async function previewProjectOpportunityBriefReassessment(root: string, input: unknown) {
  const raw = input as Record<string, unknown>;
  const previewInput = {
    parent_ref: raw?.parent_ref,
    selection: raw?.selection,
    rationale: raw?.rationale,
    evidence_updates: raw?.evidence_updates,
  };
  if (!Value.Check(reassessmentPreviewInputSchema, previewInput))
    fail(
      400,
      'invalid_project_opportunity_brief_reassessment',
      'The reassessment preview input is invalid.',
    );
  const request = previewInput as {
    parent_ref: ExactRef;
    selection: Selection;
    rationale: string;
    evidence_updates: ReassessmentRequest['evidence_updates'];
  };
  const parent = await readProjectOpportunityBrief(root, request.parent_ref.id);
  if (!same(parent.ref, request.parent_ref))
    fail(
      409,
      'project_opportunity_brief_parent_changed',
      'The exact retained parent brief changed.',
    );
  if (
    parent.brief.basis.project_id !== request.selection.project_id ||
    parent.brief.basis.opportunity_id !== request.selection.opportunity_id ||
    parent.brief.basis.topic_id !== request.selection.topic_id
  )
    fail(
      409,
      'project_opportunity_brief_parent_scope',
      'Reassessment must preserve the parent project, opportunity, and topic.',
    );
  const current = await currentBasis(root, request.selection);
  const providerBinding = await projectOpportunityBriefReassessmentBinding(root);
  const evidence = parent.brief.evidence.map((item) => {
    const update = request.evidence_updates.find((row) => same(row.ref, item.ref));
    return update
      ? {
          ...item,
          position: update.position,
          confidence: update.confidence,
          rationale: update.rationale,
        }
      : item;
  });
  if (
    request.evidence_updates.some(
      (update) => !parent.brief.evidence.some((item) => same(item.ref, update.ref)),
    )
  )
    fail(
      409,
      'project_opportunity_brief_reassessment_ref',
      'Evidence updates must refer to exact rows in the parent brief.',
    );
  if (
    new Set(request.evidence_updates.map((row) => canonical(row.ref))).size !==
    request.evidence_updates.length
  )
    fail(
      400,
      'project_opportunity_brief_reassessment_duplicate',
      'Each evidence row can be revised only once.',
    );
  const changes = request.evidence_updates.flatMap((update) => {
    const before = parent.brief.evidence.find((item) => same(item.ref, update.ref))!;
    const after = {
      position: update.position,
      confidence: update.confidence,
      rationale: update.rationale,
    };
    const prior = {
      position: before.position,
      confidence: before.confidence,
      rationale: before.rationale,
    };
    return same(prior, after) ? [] : [{ ref: update.ref, before: prior, after }];
  });
  const preview = {
    schema_version: 'project-opportunity-brief-reassessment-preview-v1',
    parent_ref: parent.ref,
    provider_binding: providerBinding,
    parent_basis_status: parent.basis_status,
    basis: current.basis,
    rationale: request.rationale,
    changes,
    content: {
      ...parent.brief,
      basis: undefined,
      reassessment: undefined,
      id: undefined,
      created_at: undefined,
      request_digest: undefined,
      ...{ evidence },
    },
  };
  return { ...preview, preview_digest: sha256(canonical(preview)) };
}

/** Appends an immutable successor; lock-time checks prevent stale previews and lost-reply replacement. */
export async function reassessProjectOpportunityBrief(root: string, input: unknown) {
  if (!Value.Check(reassessmentRequestSchema, input))
    fail(
      400,
      'invalid_project_opportunity_brief_reassessment',
      'The reassessment request is invalid.',
    );
  const request = input as ReassessmentRequest;
  const preview = await previewProjectOpportunityBriefReassessment(root, request);
  if (!same(preview.basis, request.basis) || preview.preview_digest !== request.preview_digest)
    fail(
      409,
      'project_opportunity_brief_reassessment_preview_changed',
      'The parent, current basis, rationale, or human edits changed after preview. Preview again.',
    );
  const parent = await readProjectOpportunityBrief(root, request.parent_ref.id);
  const digest = sha256(
    canonical({
      request_id: request.request_id,
      parent_ref: request.parent_ref,
      basis: request.basis,
      rationale: request.rationale,
      changes: preview.changes,
    }),
  );
  const successor: Brief = {
    ...preview.content,
    schema_version: 'project-opportunity-brief-v1',
    id: request.request_id,
    created_at: new Date().toISOString(),
    request_digest: digest,
    basis: request.basis,
    reassessment: {
      parent_ref: request.parent_ref,
      provider_binding: preview.provider_binding,
      rationale: request.rationale,
      changes: preview.changes,
    },
    qualifications: [
      ...parent.brief.qualifications,
      'This immutable successor records a human reassessment; unchanged evidence judgments remain inherited, and evidence currentness is evaluated separately.',
    ],
  } as Brief;
  let retained: Brief;
  try {
    retained = await appendProjectOpportunityBrief(
      root,
      request.selection.opportunity_id,
      successor,
      async () => {
        const latestParent = await projectOpportunityBriefRecordBytes(root, request.parent_ref.id);
        if (sha256(latestParent.bytes) !== request.parent_ref.digest)
          fail(
            409,
            'project_opportunity_brief_parent_changed',
            'The exact retained parent changed during reassessment.',
          );
        const latest = await currentBasis(root, request.selection);
        if (!same(latest.basis, request.basis))
          fail(
            409,
            'project_opportunity_brief_basis_changed',
            'The fresh basis changed during reassessment. Preview again.',
          );
        const latestBinding = await projectOpportunityBriefReassessmentBinding(root);
        if (!same(latestBinding, preview.provider_binding))
          fail(
            409,
            'project_opportunity_brief_basis_changed',
            'The reassessment provider binding changed during save. Preview again.',
          );
      },
    );
  } catch (error) {
    if (error instanceof ProjectOpportunityBriefError) throw error;
    const code = error instanceof Error ? error.message : 'project_opportunity_brief_unavailable';
    if (code === 'project_opportunity_brief_uuid_conflict')
      fail(409, code, 'This request ID already names a different successor.');
    if (code.startsWith('project_opportunity_brief_'))
      fail(409, code, 'The exact parent or current basis changed during reassessment.');
    fail(
      503,
      'project_opportunity_brief_unavailable',
      'The successor could not be retained safely.',
    );
  }
  return { ref: briefRef(retained), brief: retained, replay: retained !== successor };
}

function findBrief(state: Awaited<ReturnType<typeof loadProjects>>, id: string) {
  for (const opportunity of state.opportunities) {
    const brief = opportunity.briefs?.find((row) => row.id === id);
    if (brief) return { opportunity, brief };
  }
  return null;
}

export async function listProjectOpportunityBriefs(root: string) {
  const state = await loadProjects(root);
  return {
    schema_version: 'project-opportunity-brief-list-v1',
    briefs: state.opportunities.flatMap((opportunity) =>
      (opportunity.briefs ?? []).map((brief) => ({
        ref: briefRef(brief),
        created_at: brief.created_at,
        project_id: brief.basis.project_id,
        opportunity_id: brief.basis.opportunity_id,
        title: brief.title,
      })),
    ),
  };
}

export async function readProjectOpportunityBrief(root: string, id: string) {
  if (!Value.Check(uuid, id))
    fail(400, 'invalid_project_opportunity_brief_id', 'Brief identity must be a UUID.');
  const found = findBrief(await loadProjects(root), id);
  if (!found) fail(404, 'project_opportunity_brief_missing', 'No retained brief has that UUID.');
  let basis_status: 'current' | 'needs-review' | 'missing' | 'unavailable' = 'current';
  const reasons: string[] = [];
  const evidence_currentness: Array<{
    ref: ExactRef;
    state: 'current' | 'changed' | 'missing' | 'unavailable';
  }> = [];
  try {
    const current = await currentBasis(root, {
      project_id: found.brief.basis.project_id,
      opportunity_id: found.brief.basis.opportunity_id,
      topic_id: found.brief.basis.topic_id,
      relevance_id: found.brief.basis.relevance_ref.id,
    });
    if (!same(current.basis, found.brief.basis)) {
      basis_status = 'needs-review';
      reasons.push(
        'The saved project, opportunity, topic, relevance, source, or provider basis changed.',
      );
    }
  } catch (error) {
    if (
      error instanceof ProjectOpportunityBriefError ||
      error instanceof ProjectTopicRelevanceError ||
      error instanceof SourceChangeReviewError
    ) {
      basis_status =
        error.status === 404 ? 'missing' : error.status === 409 ? 'needs-review' : 'unavailable';
      reasons.push(
        error instanceof ProjectOpportunityBriefError
          ? error.reason
          : 'The exact retained topic or source review is no longer current.',
      );
    } else {
      basis_status = 'unavailable';
      reasons.push('Current basis status could not be read.');
    }
  }
  for (const item of found.brief.evidence) {
    try {
      await exactOwnerRecord(root, item.ref);
      evidence_currentness.push({ ref: item.ref, state: 'current' });
    } catch (error) {
      const status = error instanceof ProviderError ? error.status : 503;
      const state = status === 404 ? 'missing' : status === 409 ? 'changed' : 'unavailable';
      evidence_currentness.push({ ref: item.ref, state });
      basis_status = status === 404 ? 'missing' : status === 409 ? 'needs-review' : 'unavailable';
      reasons.push(
        state === 'missing'
          ? 'An exact evidence record is missing.'
          : state === 'changed'
            ? 'An exact evidence record changed.'
            : 'An exact evidence record is unavailable.',
      );
    }
  }
  return {
    ref: briefRef(found.brief),
    brief: found.brief,
    basis_status,
    evidence_currentness,
    reasons: [...new Set(reasons)],
    cold_read: true,
  };
}

export async function projectOpportunityBriefRecordBytes(root: string, id: string) {
  if (!Value.Check(uuid, id))
    fail(400, 'invalid_project_opportunity_brief_id', 'Brief identity must be a UUID.');
  const found = findBrief(await loadProjects(root), id);
  if (!found) fail(404, 'project_opportunity_brief_missing', 'No retained brief has that UUID.');
  return { bytes: briefBytes(found.brief), storage: 'project_opportunity_brief_record' as const };
}
