import { Type, type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';

const closed = { additionalProperties: false };
const short = Type.String({ minLength: 1, maxLength: 200 });
const digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const exactRefSchema = Type.Object(
  {
    owner: Type.Literal('signals-ai'),
    kind: Type.String({ minLength: 1, maxLength: 100 }),
    id: Type.String({ minLength: 1, maxLength: 200 }),
    revision: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
    digest,
  },
  closed,
);
const opportunityBriefBindingSchema = Type.Object(
  {
    schema: Type.Literal('signals-provider-contract-binding.v1'),
    owner: Type.Literal('signals-ai'),
    contract_id: Type.Literal('project-opportunity-brief'),
    contract_version: Type.Literal('1.0'),
    digest_kind: Type.Literal('sha256-canonical-contract-json-v1'),
    contract_digest: digest,
    instance_id: Type.String({ format: 'uuid' }),
    owner_epoch: Type.String({ format: 'uuid' }),
    source_commit: Type.Optional(Type.String({ pattern: '^[a-f0-9]{40,64}$' })),
  },
  closed,
);
const opportunityBriefReassessmentBindingSchema = Type.Object(
  {
    schema: Type.Literal('signals-provider-contract-binding.v1'),
    owner: Type.Literal('signals-ai'),
    contract_id: Type.Literal('project-opportunity-brief-reassessment'),
    contract_version: Type.Literal('1.0'),
    digest_kind: Type.Literal('sha256-canonical-contract-json-v1'),
    contract_digest: digest,
    instance_id: Type.String({ format: 'uuid' }),
    owner_epoch: Type.String({ format: 'uuid' }),
    source_commit: Type.Optional(Type.String({ pattern: '^[a-f0-9]{40,64}$' })),
  },
  closed,
);
const opportunityBriefBasisSchema = Type.Object(
  {
    project_id: Type.String({ pattern: '^project-[a-f0-9]{24}$' }),
    project_snapshot_sha256: digest,
    project_context_sha256: digest,
    opportunity_id: Type.String({ minLength: 1, maxLength: 200 }),
    opportunity_sha256: digest,
    topic_id: Type.String({ format: 'uuid' }),
    topic_revision: Type.Integer({ minimum: 1 }),
    topic_sha256: digest,
    relevance_ref: Type.Object(
      {
        ...exactRefSchema.properties,
        kind: Type.Literal('project_topic_relevance'),
        id: Type.String({ format: 'uuid' }),
      },
      closed,
    ),
    source_change_review_ref: Type.Optional(
      Type.Object(
        {
          ...exactRefSchema.properties,
          kind: Type.Literal('source_change_review'),
          id: Type.String({ format: 'uuid' }),
        },
        closed,
      ),
    ),
    source_capture_refs: Type.Optional(
      Type.Array(
        Type.Object(
          {
            ...exactRefSchema.properties,
            kind: Type.Literal('source_capture'),
            id: Type.String({ format: 'uuid' }),
          },
          closed,
        ),
        { minItems: 2, maxItems: 2 },
      ),
    ),
    provider_binding: opportunityBriefBindingSchema,
  },
  closed,
);
const briefEvidenceSchema = Type.Object(
  {
    ref: exactRefSchema,
    position: Type.Enum(['supports', 'challenges', 'context', 'unknown']),
    confidence: Type.Enum(['high', 'moderate', 'low', 'unknown']),
    rationale: Type.String({ minLength: 1, maxLength: 1000 }),
  },
  closed,
);
const reassessmentSchema = Type.Object(
  {
    parent_ref: Type.Object(
      {
        ...exactRefSchema.properties,
        kind: Type.Literal('project_opportunity_brief'),
        id: Type.String({ format: 'uuid' }),
      },
      closed,
    ),
    provider_binding: opportunityBriefReassessmentBindingSchema,
    rationale: Type.String({ minLength: 10, maxLength: 1000 }),
    changes: Type.Array(
      Type.Object(
        {
          ref: exactRefSchema,
          before: Type.Object(
            {
              position: briefEvidenceSchema.properties.position,
              confidence: briefEvidenceSchema.properties.confidence,
              rationale: briefEvidenceSchema.properties.rationale,
            },
            closed,
          ),
          after: Type.Object(
            {
              position: briefEvidenceSchema.properties.position,
              confidence: briefEvidenceSchema.properties.confidence,
              rationale: briefEvidenceSchema.properties.rationale,
            },
            closed,
          ),
        },
        closed,
      ),
      { maxItems: 12 },
    ),
  },
  closed,
);
const reviewContextSchema = Type.Object(
  {
    schema_version: Type.Literal('project-opportunity-brief-review-context-v1'),
    relevance: Type.Object(
      {
        ref: Type.Object(
          {
            ...exactRefSchema.properties,
            kind: Type.Literal('project_topic_relevance'),
            id: Type.String({ format: 'uuid' }),
          },
          closed,
        ),
        judgment: Type.Enum(['relevant', 'not-relevant', 'uncertain']),
        rationale: Type.String({ minLength: 1, maxLength: 3000 }),
      },
      closed,
    ),
    source_change: Type.Optional(
      Type.Object(
        {
          ref: Type.Object(
            {
              ...exactRefSchema.properties,
              kind: Type.Literal('source_change_review'),
              id: Type.String({ format: 'uuid' }),
            },
            closed,
          ),
          meaningfulness: Type.Enum(['unchanged', 'meaningful', 'not-meaningful', 'uncertain']),
          change_rationale: Type.String({ minLength: 1, maxLength: 1600 }),
          prior_capture_ref: Type.Object(
            {
              ...exactRefSchema.properties,
              kind: Type.Literal('source_capture'),
              id: Type.String({ format: 'uuid' }),
            },
            closed,
          ),
          new_capture_ref: Type.Object(
            {
              ...exactRefSchema.properties,
              kind: Type.Literal('source_capture'),
              id: Type.String({ format: 'uuid' }),
            },
            closed,
          ),
          observed_change: Type.Object(
            {
              state: Type.Enum(['changed', 'unchanged']),
              removed_sha256: digest,
              added_sha256: digest,
              omitted_removed_lines: Type.Integer({ minimum: 0 }),
              omitted_added_lines: Type.Integer({ minimum: 0 }),
              truncated_removed_line: Type.Boolean(),
              truncated_added_line: Type.Boolean(),
            },
            closed,
          ),
          assertions: Type.Array(
            Type.Object(
              {
                entity_ref: exactRefSchema,
                observation_id: Type.String({ minLength: 1, maxLength: 200 }),
                currentness: Type.Enum(['current', 'needs-review']),
                decision: Type.Enum(['retain', 'revise']),
                revised_status: Type.Optional(
                  Type.Enum(['supported', 'contradicted', 'uncertain']),
                ),
                rationale: Type.String({ minLength: 1, maxLength: 1600 }),
                observation_sha256: digest,
              },
              closed,
            ),
            { minItems: 1, maxItems: 40 },
          ),
        },
        closed,
      ),
    ),
  },
  closed,
);
export const projectOpportunityBriefSchema = Type.Object(
  {
    schema_version: Type.Literal('project-opportunity-brief-v1'),
    id: Type.String({ format: 'uuid' }),
    created_at: Type.String({ format: 'date-time' }),
    request_digest: digest,
    basis: opportunityBriefBasisSchema,
    reassessment: Type.Optional(reassessmentSchema),
    review_context: Type.Optional(reviewContextSchema),
    title: short,
    observed_need: Type.String({ minLength: 1, maxLength: 3000 }),
    options: Type.Array(
      Type.Object(
        {
          kind: Type.Enum(['existing', 'no_action']),
          title: short,
          description: Type.String({ minLength: 1, maxLength: 1500 }),
        },
        closed,
      ),
      { minItems: 2, maxItems: 6 },
    ),
    reversible_intervention: Type.String({ minLength: 1, maxLength: 2000 }),
    responsible_party: Type.String({ minLength: 1, maxLength: 300 }),
    falsifiable_outcome: Type.String({ minLength: 1, maxLength: 1000 }),
    evidence: Type.Array(briefEvidenceSchema, { minItems: 1, maxItems: 12 }),
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
    qualifications: Type.Array(Type.String({ minLength: 1, maxLength: 600 }), {
      minItems: 1,
      maxItems: 8,
    }),
  },
  closed,
);
const contextRecordSchema = Type.Object(
  {
    profile: short,
    project: Type.Union([Type.String({ maxLength: 2048 }), Type.Null()]),
    area: short,
    opportunity: Type.String({ maxLength: 5000 }),
    option: short,
    why: Type.String({ maxLength: 5000 }),
    evidence: Type.Array(Type.String({ maxLength: 2048 }), { maxItems: 30 }),
    limitations: Type.Array(Type.String({ maxLength: 3000 }), { maxItems: 30 }),
    next_action: Type.String({ maxLength: 5000 }),
    status: short,
    checked_ref: short,
    date: short,
    id: short,
    source_id: Type.Union([short, Type.Null()]),
    aliases: Type.Array(short, { maxItems: 30 }),
    scope: Type.Enum(['public', 'private']),
    note: Type.Optional(Type.String({ maxLength: 5000 })),
    origin: Type.Object(
      {
        owner: Type.Literal('context-ai'),
        source_commit: short,
        source_profile: short,
        ordinal: Type.Integer({ minimum: 0 }),
        source_record_sha256: digest,
        identity_basis: Type.String({ maxLength: 1000 }),
        annotations_basis: Type.String({ maxLength: 1000 }),
      },
      closed,
    ),
  },
  closed,
);
const projectSourceSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal('local'), path: Type.String({ minLength: 1, maxLength: 2048 }) },
    closed,
  ),
  Type.Object(
    { kind: Type.Literal('github'), uri: Type.String({ minLength: 1, maxLength: 2048 }) },
    closed,
  ),
]);
const snapshotSchema = Type.Object(
  {
    digest,
    observedAt: Type.String({ maxLength: 40 }),
    basis: Type.Enum(['local-documents', 'github-commit']),
    revision: Type.Union([Type.String({ maxLength: 100 }), Type.Null()]),
    dirty: Type.Literal('unknown'),
    files: Type.Array(
      Type.Object(
        {
          path: short,
          digest,
          bytes: Type.Integer({ minimum: 0, maximum: 16384 }),
          excerpt: Type.String({ maxLength: 1500 }),
        },
        closed,
      ),
      { maxItems: 8 },
    ),
    gaps: Type.Array(Type.String({ maxLength: 300 }), { maxItems: 30 }),
  },
  closed,
);
const projectSchema = Type.Object(
  {
    id: Type.String({ pattern: '^project-[a-f0-9]{24}$' }),
    name: short,
    purpose: Type.String({ minLength: 1, maxLength: 3000 }),
    constraints: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 20 }),
    source: projectSourceSchema,
    snapshot: snapshotSchema,
    connected: Type.Boolean(),
  },
  closed,
);
export type Project = Static<typeof projectSchema>;
export const projectHistorySchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    contextDigest: digest,
    retainedAt: Type.String({ maxLength: 40 }),
    project: projectSchema,
  },
  closed,
);
export type ProjectSource = Static<typeof projectSourceSchema>;
const opportunityInputSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 200 }),
    title: short,
    need: Type.String({ minLength: 1, maxLength: 3000 }),
    reason: Type.String({ minLength: 1, maxLength: 3000 }),
    nextAction: Type.Enum(['learn', 'explore', 'compare', 'consider-for-trial']),
    status: Type.Enum(['open', 'saved', 'declined', 'done']),
    note: Type.String({ maxLength: 5000 }),
    scope: Type.Enum(['public', 'private']),
    findingKey: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
    projectRef: Type.Optional(short),
    evidenceRefs: Type.Optional(
      Type.Array(
        Type.Object({ uri: Type.String({ maxLength: 2048 }), label: Type.Optional(short) }, closed),
        { maxItems: 30 },
      ),
    ),
    aliases: Type.Optional(Type.Array(short, { maxItems: 20 })),
  },
  closed,
);
const opportunitySchema = Type.Object(
  {
    ...opportunityInputSchema.properties,
    briefs: Type.Optional(Type.Array(projectOpportunityBriefSchema, { maxItems: 100 })),
    projectId: Type.Optional(projectSchema.properties.id),
    projectSnapshotDigest: Type.Optional(digest),
    projectContextDigest: Type.Optional(digest),
    importedSource: Type.Optional(contextRecordSchema),
    provenance: Type.Object(
      {
        owner: Type.Enum(['signals', 'context-ai']),
        method: Type.Enum(['manual', 'migrated']),
        sourceId: short,
        sourceRevision: Type.String({ maxLength: 100 }),
        sourceDigest: digest,
        importedAt: Type.String({ maxLength: 40 }),
      },
      closed,
    ),
  },
  closed,
);
export type Opportunity = Static<typeof opportunitySchema>;
export const migrationSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    kind: Type.Literal('context-opportunities-migration'),
    source_owner: Type.Literal('context-ai'),
    destination_owner: Type.Literal('signals-ai/project-opportunities'),
    source_commit: short,
    count: Type.Integer({ minimum: 0, maximum: 2000 }),
    source_files: Type.Array(Type.Object({ path: short, sha256: digest }, closed), {
      maxItems: 100,
    }),
    records: Type.Array(contextRecordSchema, { maxItems: 2000 }),
    authority: Type.String({ maxLength: 3000 }),
    method: Type.String({ maxLength: 3000 }),
  },
  closed,
);
export const projectStateSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    projects: Type.Array(projectSchema, { maxItems: 100 }),
    opportunities: Type.Array(opportunitySchema, { maxItems: 2000 }),
  },
  closed,
);
export type ProjectState = Static<typeof projectStateSchema>;
export const previewRequestSchema = Type.Object({ source: projectSourceSchema }, closed);
export const registerRequestSchema = Type.Object(
  {
    previewId: Type.String({ format: 'uuid' }),
    name: short,
    purpose: projectSchema.properties.purpose,
    constraints: projectSchema.properties.constraints,
  },
  closed,
);
export const updateProjectSchema = Type.Object(
  {
    id: projectSchema.properties.id,
    name: short,
    purpose: projectSchema.properties.purpose,
    constraints: projectSchema.properties.constraints,
  },
  closed,
);
export const projectIdSchema = Type.Object({ id: projectSchema.properties.id }, closed);
export const attachSchema = Type.Object(
  {
    projectId: projectSchema.properties.id,
    findingKey: Type.String({ minLength: 1, maxLength: 300 }),
    need: opportunityInputSchema.properties.need,
    reason: opportunityInputSchema.properties.reason,
    nextAction: opportunityInputSchema.properties.nextAction,
  },
  closed,
);
export const updateOpportunitySchema = Type.Object(
  {
    id: opportunityInputSchema.properties.id,
    status: opportunityInputSchema.properties.status,
    note: opportunityInputSchema.properties.note,
  },
  closed,
);
export const associateOpportunitySchema = Type.Object(
  { id: opportunityInputSchema.properties.id, projectId: projectSchema.properties.id },
  closed,
);
export const setupRequestSchema = Type.Object(
  {
    projectId: projectSchema.properties.id,
    opportunityId: opportunityInputSchema.properties.id,
    need: Type.String({ minLength: 1, maxLength: 512 }),
    targetProfile: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$' }),
  },
  closed,
);
export const researchPreviewSchema = Type.Object(
  { id: projectSchema.properties.id, question: Type.String({ minLength: 1, maxLength: 2000 }) },
  closed,
);
export function checked<T>(schema: TSchema, input: unknown): T {
  if (!Value.Check(schema, input)) throw new Error('invalid_project_request');
  return input as T;
}
