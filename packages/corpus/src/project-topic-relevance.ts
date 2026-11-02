import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { openTopic } from './knowledge.js';
import { exactOwnerRecord, providerCapabilities, ProviderError } from './provider-capabilities.js';
import { listOpportunities, loadProjects, projectContextFingerprint } from './projects.js';
import { atomicJson, readPrivateJson, withWriter } from './search-store.js';
import { requestStore } from './search-request-store.js';
import { SourceChangeReviewError } from './source-change-reviews.js';

const closed = { additionalProperties: false };
const uuid = Type.String({ pattern: '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$' });
const digestSchema = Type.String({ pattern: '^[a-f0-9]{64}$' });
const providerBindingSchema = Type.Object(
  {
    schema: Type.Literal('signals-provider-contract-binding.v1'),
    owner: Type.Literal('signals-ai'),
    contract_id: Type.Literal('project-topic-relevance'),
    contract_version: Type.Literal('1.0'),
    digest_kind: Type.Literal('sha256-canonical-contract-json-v1'),
    contract_digest: digestSchema,
    instance_id: uuid,
    owner_epoch: uuid,
    source_commit: Type.Optional(Type.String({ pattern: '^[a-f0-9]{40,64}$' })),
  },
  closed,
);
const selectionSchema = Type.Object(
  {
    ref: Type.Object(
      {
        owner: Type.String({ minLength: 1, maxLength: 200 }),
        kind: Type.String({ minLength: 1, maxLength: 200 }),
        id: Type.String({ minLength: 1, maxLength: 200 }),
        revision: Type.String({ minLength: 1, maxLength: 200 }),
        digest: digestSchema,
      },
      closed,
    ),
    instance_id: Type.String({ minLength: 1, maxLength: 200 }),
    owner_epoch: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
  },
  closed,
);
const basisSchema = Type.Object(
  {
    topic_id: uuid,
    topic_revision: Type.Integer({ minimum: 1 }),
    topic_sha256: digestSchema,
    member_selections: Type.Array(selectionSchema, { minItems: 1, maxItems: 100 }),
    project_id: Type.String({ pattern: '^project-[a-f0-9]{24}$' }),
    project_snapshot_sha256: digestSchema,
    project_context_sha256: digestSchema,
    provider_binding: providerBindingSchema,
    opportunity_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    opportunity_sha256: Type.Optional(digestSchema),
    source_change_review_ref: Type.Optional(
      Type.Object(
        {
          owner: Type.Literal('signals-ai'),
          kind: Type.Literal('source_change_review'),
          id: uuid,
          revision: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
          digest: digestSchema,
        },
        closed,
      ),
    ),
    source_capture_refs: Type.Optional(
      Type.Array(
        Type.Object(
          {
            owner: Type.Literal('signals-ai'),
            kind: Type.Literal('source_capture'),
            id: uuid,
            revision: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
            digest: digestSchema,
          },
          closed,
        ),
        { minItems: 2, maxItems: 2 },
      ),
    ),
  },
  closed,
);
const basisInputSchema = Type.Object(
  {
    topic_id: uuid,
    topic_revision: Type.Integer({ minimum: 1 }),
    member_selections: Type.Array(selectionSchema, { minItems: 1, maxItems: 100 }),
    project_id: Type.String({ pattern: '^project-[a-f0-9]{24}$' }),
    provider_binding: Type.Optional(providerBindingSchema),
    opportunity_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    source_change_review_ref: Type.Optional(
      Type.Object(
        {
          owner: Type.Literal('signals-ai'),
          kind: Type.Literal('source_change_review'),
          id: uuid,
          revision: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
          digest: digestSchema,
        },
        closed,
      ),
    ),
  },
  closed,
);
const sourceCaptureRefSchema = Type.Object(
  {
    owner: Type.Literal('signals-ai'),
    kind: Type.Literal('source_capture'),
    id: uuid,
    revision: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
    digest: digestSchema,
  },
  closed,
);
const sourceChangeReviewSchema = Type.Object(
  {
    schema_version: Type.Literal('source-change-review-v1'),
    id: uuid,
    prior_capture_ref: sourceCaptureRefSchema,
    new_capture_ref: sourceCaptureRefSchema,
    meaningfulness: Type.Enum(['unchanged', 'meaningful', 'not-meaningful', 'uncertain']),
    observed_change: Type.Unknown(),
  },
  { additionalProperties: true },
);
const requestSchema = Type.Object(
  {
    request_id: uuid,
    basis: basisSchema,
    relevance: Type.Enum(['relevant', 'not-relevant', 'uncertain']),
    rationale: Type.String({ minLength: 1, maxLength: 3000 }),
  },
  closed,
);
type Selection = Static<typeof selectionSchema>;
type Basis = Static<typeof basisSchema>;
type BasisInput = Static<typeof basisInputSchema>;
type ProviderBinding = Static<typeof providerBindingSchema>;
type Request = Static<typeof requestSchema>;
type RecordRef = {
  owner: 'signals-ai';
  kind: 'project_topic_relevance';
  id: string;
  revision: string;
  digest: string;
};
type Review = {
  schema_version: 'project-topic-relevance-v1';
  id: string;
  created_at: string;
  request_digest: string;
  basis: Basis;
  relevance: Request['relevance'];
  rationale: string;
  qualifications: string[];
};
type Store = { schema_version: 'project-topic-relevance-store-v1'; reviews: Review[] };

const recordSchema = Type.Object(
  {
    schema_version: Type.Literal('project-topic-relevance-v1'),
    id: uuid,
    created_at: Type.String({ format: 'date-time' }),
    request_digest: digestSchema,
    basis: basisSchema,
    relevance: Type.Enum(['relevant', 'not-relevant', 'uncertain']),
    rationale: Type.String({ minLength: 1, maxLength: 3000 }),
    qualifications: Type.Array(Type.String({ minLength: 1, maxLength: 600 }), {
      minItems: 1,
      maxItems: 8,
    }),
  },
  closed,
);
const storeSchema = Type.Object(
  {
    schema_version: Type.Literal('project-topic-relevance-store-v1'),
    reviews: Type.Array(recordSchema, { maxItems: 1000 }),
  },
  closed,
);
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => JSON.stringify(key) + ':' + canonical(child))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
};
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const providerBindingDigestKind = 'sha256-canonical-contract-json-v1';
export async function projectTopicRelevanceProviderBinding(root: string): Promise<ProviderBinding> {
  const scope = await requestStore(root)
    .scope()
    .catch(() =>
      fail(503, 'project_topic_relevance_unavailable', 'The Signals owner binding is unavailable.'),
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
    (row) => row.id === 'project-topic-relevance' && row.versions.includes('1.0'),
  );
  const operations = ['read_project_topic_relevance', 'review_project_topic_relevance'].map(
    (name) => capabilities.operations?.find((row) => row.name === name),
  );
  if (
    !contract ||
    operations.some((row) => !row) ||
    !capabilities.record_kinds?.includes('project_topic_relevance')
  )
    fail(
      503,
      'project_topic_relevance_unavailable',
      'The connected Signals provider has no complete project-topic relevance contract.',
    );
  const metadata = {
    contract,
    operations,
    record_kinds: ['project_topic_relevance'],
  };
  return {
    schema: 'signals-provider-contract-binding.v1',
    owner: 'signals-ai',
    contract_id: 'project-topic-relevance',
    contract_version: '1.0',
    digest_kind: providerBindingDigestKind,
    contract_digest: sha256(canonical(metadata)),
    instance_id: scope.identity,
    owner_epoch: scope.epoch,
    ...(typeof capabilities.source_commit === 'string' &&
    /^[a-f0-9]{40,64}$/.test(capabilities.source_commit)
      ? { source_commit: capabilities.source_commit }
      : {}),
  };
}
const reviewBytes = (review: Review) => Buffer.from(JSON.stringify(review), 'utf8');
function reviewRef(review: Review): RecordRef {
  const hash = sha256(reviewBytes(review));
  return {
    owner: 'signals-ai',
    kind: 'project_topic_relevance',
    id: review.id,
    revision: `sha256:${hash}`,
    digest: hash,
  };
}
const selectionKey = (selection: Selection) => canonical(selection);
const projectFingerprint = (project: {
  snapshot: { digest: string };
  purpose: string;
  constraints: string[];
}) => projectContextFingerprint(project as Parameters<typeof projectContextFingerprint>[0]);

export class ProjectTopicRelevanceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly reason: string,
  ) {
    super(code);
  }
}
const fail = (status: number, code: string, reason: string): never => {
  throw new ProjectTopicRelevanceError(status, code, reason);
};
const invalid = (reason = 'Provide an exact connected topic/project basis and a human judgment.') =>
  fail(400, 'invalid_project_topic_relevance', reason);
const changed = (
  reason = 'An exact relevance basis changed; reopen it before recording a judgment.',
) => fail(409, 'project_topic_relevance_changed', reason);

async function loadStore(root: string): Promise<Store> {
  const value = await readPrivateJson(
    root,
    'project-topic-relevance.json',
    { schema_version: 'project-topic-relevance-store-v1', reviews: [] },
    4_000_000,
  );
  if (!Value.Check(storeSchema, value))
    fail(503, 'project_topic_relevance_unavailable', 'Retained review history is malformed.');
  const store = value as Store;
  if (
    new Set(store.reviews.map((row) => row.id)).size !== store.reviews.length ||
    store.reviews.some(
      (row) =>
        row.basis.member_selections.some((selection, index, all) =>
          all.slice(0, index).some((prior) => selectionKey(prior) === selectionKey(selection)),
        ) ||
        (row.basis.opportunity_id === undefined) !== (row.basis.opportunity_sha256 === undefined) ||
        (row.basis.source_change_review_ref === undefined) !==
          (row.basis.source_capture_refs === undefined),
    )
  )
    fail(503, 'project_topic_relevance_unavailable', 'Review history failed its integrity checks.');
  return store;
}

function topicDigest(topic: unknown) {
  return sha256(canonical(topic));
}
function opportunityDigest(opportunity: unknown) {
  return sha256(canonical(opportunity));
}
async function readSourceChangeReview(root: string, ref: Basis['source_change_review_ref']) {
  if (!ref) return null;
  let exact;
  try {
    exact = await exactOwnerRecord(root, ref);
  } catch (error) {
    if (error instanceof ProviderError) {
      if (error.status === 404)
        fail(
          404,
          'project_topic_relevance_missing_basis',
          'The exact source-change review is missing.',
        );
      if (error.status === 409) changed('The exact source-change review changed.');
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(exact.bytes.toString('utf8'));
  } catch {
    fail(
      503,
      'project_topic_relevance_unavailable',
      'The retained source-change review is unreadable.',
    );
  }
  if (!Value.Check(sourceChangeReviewSchema, parsed))
    fail(
      503,
      'project_topic_relevance_unavailable',
      'The source-change review has an invalid schema or capture binding.',
    );
  const review = parsed;
  const refs = [review.prior_capture_ref, review.new_capture_ref];
  if (review.id !== ref.id)
    fail(
      503,
      'project_topic_relevance_unavailable',
      'The source-change review has an invalid identity.',
    );
  for (const capture of refs) {
    try {
      await exactOwnerRecord(root, capture);
    } catch (error) {
      if (error instanceof ProviderError) {
        if (error.status === 404)
          fail(
            404,
            'project_topic_relevance_missing_basis',
            'A capture bound by the source-change review is missing.',
          );
        if (error.status === 409) changed('A capture bound by the source-change review changed.');
      }
      throw error;
    }
  }
  return { review, capture_refs: refs };
}

async function currentBasis(
  root: string,
  input: Pick<
    BasisInput,
    | 'topic_id'
    | 'topic_revision'
    | 'member_selections'
    | 'project_id'
    | 'provider_binding'
    | 'opportunity_id'
    | 'source_change_review_ref'
  >,
) {
  const binding = await projectTopicRelevanceProviderBinding(root);
  if (input.provider_binding && canonical(binding) !== canonical(input.provider_binding))
    changed('The Signals provider contract or owner epoch changed; reopen the exact basis.');
  let opened;
  try {
    opened = await openTopic(root, input.topic_id);
  } catch (error) {
    if ((error as { status?: number })?.status === 404)
      fail(404, 'project_topic_relevance_missing_basis', 'The exact connected topic is missing.');
    throw error;
  }
  const topic = opened.topic as {
    id: string;
    revision: number;
    members: Array<{ selection: Selection }>;
    [key: string]: unknown;
  };
  if (topic.revision !== input.topic_revision)
    changed('The topic revision changed; reopen the topic before reviewing project relevance.');
  const currentKeys = new Set(topic.members.map((member) => selectionKey(member.selection)));
  if (
    new Set(input.member_selections.map(selectionKey)).size !== input.member_selections.length ||
    input.member_selections.some((selection) => !currentKeys.has(selectionKey(selection)))
  )
    changed('Every selected source must remain an exact member of this topic revision.');
  const projects = await loadProjects(root);
  const project = projects.projects.find((row) => row.id === input.project_id);
  if (!project)
    return fail(404, 'project_topic_relevance_missing_basis', 'The project is missing.');
  if (!project.connected)
    fail(503, 'project_topic_relevance_unavailable', 'The project is disconnected.');
  const topicSha = topicDigest(topic);
  const projectContextSha = projectFingerprint(project);
  const basis: Basis = {
    topic_id: topic.id,
    topic_revision: topic.revision,
    topic_sha256: topicSha,
    member_selections: input.member_selections,
    project_id: project.id,
    project_snapshot_sha256: project.snapshot.digest,
    project_context_sha256: projectContextSha,
    provider_binding: binding,
  };
  const preview: Record<string, unknown> = {
    topic: { id: topic.id, revision: topic.revision, name: topic.name },
    selected_members: input.member_selections.map((selection) => ({
      selection,
      state:
        opened.statuses.find((row) => selectionKey(row.selection) === selectionKey(selection))
          ?.state ?? 'unavailable',
    })),
    project: {
      id: project.id,
      name: project.name,
      purpose: project.purpose,
      constraints: project.constraints,
      snapshot_digest: project.snapshot.digest,
      context_digest: projectContextSha,
    },
  };
  if (input.opportunity_id) {
    const [opportunity] = await listOpportunities(root).then((rows) =>
      rows.filter((row) => row.id === input.opportunity_id),
    );
    if (!opportunity || opportunity.projectId !== project.id)
      return fail(
        404,
        'project_topic_relevance_missing_basis',
        'The selected opportunity is not connected to this project.',
      );
    if (opportunity.needsReview)
      changed('The selected opportunity needs review against its project context first.');
    const fingerprint = opportunityDigest(opportunity);
    basis.opportunity_id = opportunity.id;
    basis.opportunity_sha256 = fingerprint;
    preview.opportunity = {
      id: opportunity.id,
      title: opportunity.title,
      need: opportunity.need,
      reason: opportunity.reason,
      next_action: opportunity.nextAction,
      status: opportunity.status,
      digest: fingerprint,
    };
  }
  if (input.source_change_review_ref) {
    const context = await readSourceChangeReview(root, input.source_change_review_ref);
    basis.source_change_review_ref = input.source_change_review_ref;
    basis.source_capture_refs = context!.capture_refs;
    preview.source_change_review = {
      ref: input.source_change_review_ref,
      capture_refs: context!.capture_refs,
      meaningfulness: context!.review.meaningfulness,
      observed_change: context!.review.observed_change,
      qualification: 'This exact review is caller-selected context; no project impact is inferred.',
    };
  }
  return { basis, preview };
}

export async function previewProjectTopicRelevance(root: string, input: unknown) {
  if (!Value.Check(basisInputSchema, input)) invalid();
  const current = await currentBasis(root, input as BasisInput);
  return {
    schema_version: 'project-topic-relevance-preview-v1',
    basis: current.basis,
    preview: current.preview,
    qualifications: [
      'This preview binds exact retained inputs only; topic membership does not establish evidence support.',
      'Relevance is a caller judgment for the selected project context, never an automatic score.',
    ],
  };
}

export async function createProjectTopicRelevance(root: string, input: unknown) {
  if (!Value.Check(requestSchema, input)) invalid();
  const request = input as Request;
  const requestDigest = sha256(canonical(request));
  const previous = (await loadStore(root)).reviews.find((row) => row.id === request.request_id);
  if (previous) {
    if (previous.request_digest !== requestDigest)
      changed(
        'This request UUID already names a different immutable relevance review. Read the original UUID.',
      );
    return { ref: reviewRef(previous), review: previous, replay: true };
  }
  const inputFromBasis: BasisInput = {
    topic_id: request.basis.topic_id,
    topic_revision: request.basis.topic_revision,
    member_selections: request.basis.member_selections,
    project_id: request.basis.project_id,
    provider_binding: request.basis.provider_binding,
    ...(request.basis.opportunity_id ? { opportunity_id: request.basis.opportunity_id } : {}),
    ...(request.basis.source_change_review_ref
      ? { source_change_review_ref: request.basis.source_change_review_ref }
      : {}),
  };
  const { basis } = await currentBasis(root, inputFromBasis);
  if (canonical(basis) !== canonical(request.basis))
    changed(
      'The exact topic/project basis changed after preview; preview again before judging it.',
    );
  const review: Review = {
    schema_version: 'project-topic-relevance-v1',
    id: request.request_id,
    created_at: new Date().toISOString(),
    request_digest: requestDigest,
    basis,
    relevance: request.relevance,
    rationale: request.rationale,
    qualifications: [
      'The relevance value and rationale are human judgments, not machine-scored evidence.',
      'Project and topic records are retained separately and were not changed by this review.',
      'Optional source-change context carries no automatic impact, truth, freshness or succession conclusion.',
    ],
  };
  let retained = review;
  await withWriter(root, async () => {
    const store = await loadStore(root);
    const duplicate = store.reviews.find((row) => row.id === review.id);
    if (duplicate) {
      if (duplicate.request_digest !== requestDigest)
        changed('This request UUID already names a different review.');
      retained = duplicate;
      return;
    }
    const latest = await currentBasis(root, inputFromBasis);
    if (canonical(latest.basis) !== canonical(request.basis))
      changed('The topic/project basis changed before the review could be retained.');
    if (store.reviews.length >= 1000)
      fail(
        503,
        'project_topic_relevance_capacity',
        'Review history is full; existing records are preserved.',
      );
    store.reviews.push(review);
    if (Buffer.byteLength(JSON.stringify(store), 'utf8') > 4_000_000)
      fail(
        503,
        'project_topic_relevance_capacity',
        'Review history would exceed 4 MB; existing records are preserved.',
      );
    await atomicJson(resolve(root, '.signals/project-topic-relevance.json'), store);
  });
  return { ref: reviewRef(retained), review: retained, replay: retained !== review };
}

export async function listProjectTopicRelevance(root: string) {
  const store = await loadStore(root);
  return {
    schema_version: 'project-topic-relevance-list-v1',
    reviews: store.reviews.map((review) => ({
      id: review.id,
      ref: reviewRef(review),
      created_at: review.created_at,
      topic_id: review.basis.topic_id,
      topic_revision: review.basis.topic_revision,
      project_id: review.basis.project_id,
      opportunity_id: review.basis.opportunity_id ?? null,
      relevance: review.relevance,
    })),
  };
}

export async function readProjectTopicRelevance(root: string, id: string) {
  if (!Value.Check(uuid, id)) invalid('Relevance review identity must be a UUID.');
  const review = (await loadStore(root)).reviews.find((row) => row.id === id);
  if (!review)
    return fail(404, 'project_topic_relevance_missing_review', 'No retained review has that UUID.');
  let basis_status: 'current' | 'needs-review' | 'missing' | 'unavailable' = 'current';
  const reasons: string[] = [];
  const sourceReviewRef = review.basis.source_change_review_ref;
  try {
    const current = await currentBasis(root, {
      topic_id: review.basis.topic_id,
      topic_revision: review.basis.topic_revision,
      member_selections: review.basis.member_selections,
      project_id: review.basis.project_id,
      provider_binding: review.basis.provider_binding,
      ...(review.basis.opportunity_id ? { opportunity_id: review.basis.opportunity_id } : {}),
      ...(sourceReviewRef ? { source_change_review_ref: sourceReviewRef } : {}),
    });
    if (canonical(current.basis) !== canonical(review.basis)) {
      basis_status = 'needs-review';
      reasons.push('A retained basis fingerprint differs from the review.');
    }
    for (const member of current.preview.selected_members as Array<{ state: string }>) {
      if (member.state === 'changed') {
        basis_status = 'needs-review';
        reasons.push('A topic member now resolves to a changed version.');
      } else if (member.state === 'missing' && basis_status === 'current') {
        basis_status = 'missing';
        reasons.push('A topic member is missing.');
      } else if (member.state === 'unavailable' && basis_status === 'current') {
        basis_status = 'unavailable';
        reasons.push('A topic member is unavailable.');
      }
    }
  } catch (error) {
    if (error instanceof ProjectTopicRelevanceError) {
      if (error.status === 404) basis_status = 'missing';
      else if (error.status === 409) basis_status = 'needs-review';
      else basis_status = 'unavailable';
      reasons.push(error.reason);
    } else if (error instanceof ProviderError || error instanceof SourceChangeReviewError) {
      basis_status =
        error.status === 404 ? 'missing' : error.status === 409 ? 'needs-review' : 'unavailable';
      reasons.push('An exact retained owner basis could not be resolved.');
    } else {
      basis_status = 'unavailable';
      reasons.push('Current basis status could not be read.');
    }
  }
  return {
    ref: reviewRef(review),
    review,
    basis_status,
    reasons: [...new Set(reasons)],
    cold_read: true,
  };
}

export async function projectTopicRelevanceRecordBytes(root: string, id: string) {
  if (!Value.Check(uuid, id)) invalid('Relevance review identity must be a UUID.');
  const review = (await loadStore(root)).reviews.find((row) => row.id === id);
  if (!review)
    return fail(404, 'project_topic_relevance_missing_review', 'No retained review has that UUID.');
  return {
    bytes: reviewBytes(review),
    storage: 'project_topic_relevance_record' as const,
  };
}
