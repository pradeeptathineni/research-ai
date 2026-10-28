import { Type, type Static } from 'typebox';
import { sourceTextSchema } from './source-text.js';
import { selectedClaimMaterialSchema, selectedFindingSpanSchema } from './selected-source.js';

const closed = { additionalProperties: false };
const reason = Type.String({ minLength: 1, maxLength: 1200 });
const verdict = Type.Enum(['supported', 'contradicted', 'uncertain']);
const sha = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const claimCitationSchema = Type.Object(
  {
    groupIndex: Type.Integer({ minimum: 0, maximum: 59 }),
    occurrenceIndex: Type.Integer({ minimum: 0, maximum: 23999 }),
  },
  closed,
);
export interface PartialNoteSelection {
  parentRunId: string;
  status: 'cancelled' | 'failed';
  parentSnapshotDigest: string;
  citations: {
    groupIndex: number;
    occurrenceIndex: number;
    uri: string;
    label: string;
    literal: string;
    start: number;
    end: number;
  }[];
}
const uri = Type.String({ minLength: 1, maxLength: 4096 });
const date = Type.String({ minLength: 1, maxLength: 64 });
const reference = Type.Object(
  {
    runId: Type.String({ pattern: '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$' }),
    sourceId: Type.String({ pattern: '^evidence-[a-f0-9]{24}$', maxLength: 200 }),
  },
  closed,
);
export const claimFindingSchema = Type.Object(
  {
    sourceIndex: Type.Integer({ minimum: 0, maximum: 1 }),
    quote: Type.String({ minLength: 8, maxLength: 400 }),
    status: verdict,
    decisive: Type.Boolean(),
    reason,
  },
  closed,
);
const gap = Type.Object({ reason, decisive: Type.Boolean() }, closed);
export const claimResponseSchema = Type.Object(
  {
    verdict,
    reason,
    nextCheck: reason,
    findings: Type.Array(claimFindingSchema, { maxItems: 4 }),
    gaps: Type.Array(gap, { maxItems: 10 }),
  },
  closed,
);
const common = { sourceIndex: Type.Integer({ minimum: 0, maximum: 1 }), requestedUri: uri };
const claimMaterialSchema = Type.Union([
  Type.Object(
    {
      ...common,
      state: Type.Literal('usable'),
      finalUri: uri,
      text: Type.String({ minLength: 1, maxLength: 48000 }),
      snapshotDigest: sha,
      documentDigest: sha,
      normalizer: sourceTextSchema,
      fetchedAt: date,
      publishedAt: Type.Optional(date),
      scope: Type.Enum(['complete-normalized-document', 'retained-excerpt']),
      omissions: Type.Array(reason, { maxItems: 10 }),
      retainedFrom: Type.Optional(reference),
    },
    closed,
  ),
  Type.Object(
    {
      ...common,
      state: Type.Enum(['denied', 'failed', 'omitted', 'cancelled']),
      reason,
      knownLength: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
      retainedFrom: Type.Optional(reference),
      finalUri: Type.Optional(uri),
      documentDigest: Type.Optional(sha),
      fetchedAt: Type.Optional(date),
      normalizer: Type.Optional(sourceTextSchema),
    },
    closed,
  ),
]);
export const linkedClaimReceiptSchema = Type.Object(
  {
    version: Type.Literal(1),
    claimText: Type.String({ minLength: 1, maxLength: 1600 }),
    claimDigest: sha,
    parentRunId: Type.String({ pattern: '^[a-f0-9-]{36}$' }),
    parentAnswerDigest: sha,
    originalNeed: Type.String({ minLength: 1, maxLength: 2000000 }),
    originalContext: Type.String({ maxLength: 4000 }),
    additionalContext: Type.Optional(Type.String({ maxLength: 4000 })),
    selectedMaterial: Type.Array(claimMaterialSchema, { minItems: 1, maxItems: 2 }),
    reviewState: Type.Enum(['not-reviewed', 'incomplete', 'completed']),
    verdict: Type.Union([verdict, Type.Null()]),
    reason,
    nextCheck: reason,
    findings: Type.Array(claimFindingSchema, { maxItems: 4 }),
    gaps: Type.Array(gap, { maxItems: 12 }),
    confidence: Type.Literal('Unknown'),
    historySaved: Type.Boolean(),
    stages: Type.Object(
      {
        acquisitionMs: Type.Number({ minimum: 0 }),
        nativeMs: Type.Number({ minimum: 0 }),
        validationMs: Type.Number({ minimum: 0 }),
      },
      closed,
    ),
    abortOrigin: Type.Union([Type.Enum(['external', 'deadline', 'native']), Type.Null()]),
    rejectedOutput: Type.Optional(
      Type.Object(
        {
          text: Type.String({ maxLength: 32768 }),
          capturedDigest: sha,
          capturedBytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
          omittedBytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
          captureComplete: Type.Boolean(),
          captureScope: Type.Optional(Type.Literal('runner-stdout')),
        },
        closed,
      ),
    ),
  },
  closed,
);
const directFields = Type.Omit(linkedClaimReceiptSchema, [
  'parentRunId',
  'parentAnswerDigest',
]).properties;
export const claimReceiptSchema = Type.Union([
  Type.Object(
    {
      ...directFields,
      version: Type.Literal(4),
      origin: Type.Object(
        { kind: Type.Literal('selected-primary'), requestDigest: sha, selectedPacketDigest: sha },
        closed,
      ),
      selectedMaterial: Type.Array(Type.Union([selectedClaimMaterialSchema, claimMaterialSchema]), {
        minItems: 1,
        maxItems: 1,
      }),
      findingSpans: Type.Array(selectedFindingSpanSchema, { maxItems: 4 }),
    },
    closed,
  ),
  linkedClaimReceiptSchema,
  Type.Object(
    {
      ...directFields,
      version: Type.Literal(2),
      origin: Type.Object({ kind: Type.Literal('request'), requestDigest: sha }, closed),
    },
    closed,
  ),
  Type.Object(
    {
      ...directFields,
      version: Type.Literal(3),
      origin: Type.Object(
        {
          kind: Type.Literal('retained-partial'),
          parentRunId: Type.String({ pattern: '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$' }),
          parentStatus: Type.Enum(['cancelled', 'failed']),
          fullBrief: Type.String({ minLength: 1, maxLength: 24000 }),
          contextState: Type.Literal('missing'),
          citationDecoder: Type.Literal('retained-partial-citations-v1'),
          parentSnapshotDigest: sha,
          lineageDigest: sha,
          selectedCitations: Type.Array(
            Type.Object(
              {
                ...claimCitationSchema.properties,
                sourceIndex: Type.Integer({ minimum: 0, maximum: 1 }),
                uri: Type.String({ minLength: 1, maxLength: 2048 }),
                literal: Type.String({ minLength: 1, maxLength: 4300 }),
                start: Type.Integer({ minimum: 0, maximum: 24000 }),
                end: Type.Integer({ minimum: 1, maximum: 24000 }),
              },
              closed,
            ),
            { minItems: 1, maxItems: 2 },
          ),
        },
        closed,
      ),
    },
    closed,
  ),
]);
export type ClaimReceipt = Static<typeof claimReceiptSchema>;
export type ClaimMaterial = ClaimReceipt['selectedMaterial'][number];
export type ClaimResponse = Static<typeof claimResponseSchema>;
