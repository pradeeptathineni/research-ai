import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

const closed = { additionalProperties: false } as const;
const opaqueId = Type.String({
  minLength: 1,
  maxLength: 160,
  pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$',
});
const digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const instant = Type.String({ format: 'date-time', maxLength: 40 });
const localDate = Type.String({ format: 'date', maxLength: 10 });

/** Projection of existing SearchSettings queries; Briefing does not author interests. */
export const InterestSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-z0-9-]{1,80}$' }),
    label: Type.String({ minLength: 1, maxLength: 200 }),
    includeTerms: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), {
      minItems: 1,
      maxItems: 30,
    }),
    excludeTerms: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 30 }),
    enabled: Type.Boolean(),
    weight: Type.Number({ minimum: 0, maximum: 1 }),
    halfLifeDays: Type.Number({ exclusiveMinimum: 0 }),
    sources: Type.Array(opaqueId, { maxItems: 50, uniqueItems: true }),
    /** Existing Signals query settings are not Cadence occurrence references. */
    cadenceRef: Type.Union([opaqueId, Type.Null()]),
    revision: digest,
  },
  closed,
);

export const SourceHealthSchema = Type.Object(
  {
    status: Type.Enum(['unknown', 'healthy', 'stale', 'failed']),
    lastGoodAt: Type.Union([instant, Type.Null()]),
    lastAttemptAt: Type.Union([instant, Type.Null()]),
    lastAttemptStatus: Type.Union([Type.Enum(['fetched', 'not-modified', 'failed']), Type.Null()]),
    /** Zero is a successful empty snapshot; null means no successful snapshot is known. */
    lastSuccessfulLinkCount: Type.Union([
      Type.Integer({ minimum: 0, maximum: 10000 }),
      Type.Null(),
    ]),
    failureClass: Type.Union([
      Type.Enum(['unreachable', 'parse-error', 'refused', 'terms-blocked', 'other']),
      Type.Null(),
    ]),
    /** Null means cadence is not uniquely derivable from the configured Interests. */
    expectedIntervalSec: Type.Union([Type.Number({ exclusiveMinimum: 0 }), Type.Null()]),
  },
  closed,
);

export const SourceSchema = Type.Object(
  {
    id: opaqueId,
    kind: Type.String({ pattern: '^(rss|atom|jsonfeed|ics|web|api:[a-z0-9-]+)$' }),
    url: Type.String({ minLength: 1, maxLength: 2048 }),
    attribution: Type.String({ minLength: 1, maxLength: 200 }),
    /** Null remains explicit until a source policy record exists. */
    termsRef: Type.Union([opaqueId, Type.Null()]),
    priority: Type.Number({ minimum: -100, maximum: 100 }),
    interestIds: Type.Array(Type.String({ pattern: '^[a-z0-9-]{1,80}$' }), {
      maxItems: 30,
      uniqueItems: true,
    }),
    health: SourceHealthSchema,
  },
  closed,
);

export const MetricObservationSchema = Type.Object(
  {
    id: opaqueId,
    itemId: opaqueId,
    platform: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,79}$' }),
    name: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,79}$' }),
    value: Type.Number({ minimum: 0 }),
    observedAt: instant,
    scope: Type.String({ minLength: 1, maxLength: 200 }),
    method: Type.Enum(['public-adapter', 'feed', 'caller-reported']),
    sourceRef: Type.Union([Type.String({ maxLength: 2048 }), Type.Null()]),
  },
  closed,
);

export const ItemSchema = Type.Object(
  {
    id: opaqueId,
    sourceId: opaqueId,
    canonicalUrl: Type.String({ minLength: 1, maxLength: 2048 }),
    title: Type.String({ minLength: 1, maxLength: 500 }),
    author: Type.Union([Type.String({ maxLength: 300 }), Type.Null()]),
    publishedAt: Type.Union([instant, Type.Null()]),
    /** Host observation time; distinct from the source-asserted publishedAt. */
    observedAt: instant,
    contentDigest: digest,
    excerpt: Type.String({ maxLength: 5000 }),
    metrics: Type.Array(MetricObservationSchema, { maxItems: 100 }),
    interestIds: Type.Array(Type.String({ pattern: '^[a-z0-9-]{1,80}$' }), {
      maxItems: 30,
      uniqueItems: true,
    }),
    storyId: Type.Union([opaqueId, Type.Null()]),
  },
  closed,
);

export const GroupingEvidenceSchema = Type.Object(
  {
    rule: Type.Enum(['exact-canonical-url', 'linked-canonical-url', 'near-title-shingle']),
    score: Type.Number({ minimum: 0, maximum: 1 }),
    matchedItemId: Type.Union([opaqueId, Type.Null()]),
  },
  closed,
);

export const InterestMatchSchema = Type.Object(
  {
    interestId: Type.String({ pattern: '^[a-z0-9-]{1,80}$' }),
    matchedTerms: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 30 }),
  },
  closed,
);

/** Grouping only links retained Items; split derives individual stories without deleting Items. */
export const StorySchema = Type.Object(
  {
    id: opaqueId,
    itemIds: Type.Array(opaqueId, { minItems: 1, maxItems: 100, uniqueItems: true }),
    representativeItemId: opaqueId,
    firstSeen: instant,
    lastSeen: instant,
    relation: Type.Enum(['single', 'exact', 'linked', 'near']),
    groupingEvidence: Type.Array(GroupingEvidenceSchema, { maxItems: 100 }),
    interestMatches: Type.Array(InterestMatchSchema, { maxItems: 30 }),
  },
  closed,
);

/** endDate is the exclusive calendar date carried by ICS DTEND, never an inclusive label. */
export const AllDayEventSchema = Type.Object(
  {
    id: opaqueId,
    itemId: Type.Optional(opaqueId),
    startDate: localDate,
    endDate: Type.Union([localDate, Type.Null()]),
    originalTz: Type.String({ minLength: 1, maxLength: 100 }),
    allDay: Type.Literal(true),
    dstAmbiguous: Type.Boolean(),
    url: Type.Union([Type.String({ maxLength: 2048 }), Type.Null()]),
    location: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
    recurrence: Type.Union([Type.String({ maxLength: 2048 }), Type.Null()]),
  },
  closed,
);

export const TimedEventSchema = Type.Object(
  {
    id: opaqueId,
    itemId: Type.Optional(opaqueId),
    startUtc: instant,
    endUtc: Type.Union([instant, Type.Null()]),
    originalTz: Type.String({ minLength: 1, maxLength: 100 }),
    allDay: Type.Literal(false),
    dstAmbiguous: Type.Boolean(),
    url: Type.Union([Type.String({ maxLength: 2048 }), Type.Null()]),
    location: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
    recurrence: Type.Union([Type.String({ maxLength: 2048 }), Type.Null()]),
  },
  closed,
);
export const EventSchema = Type.Union([TimedEventSchema, AllDayEventSchema]);

const feedbackBase = {
  id: Type.String({ format: 'uuid' }),
  requestId: Type.String({ format: 'uuid' }),
  targetKind: Type.Enum(['story', 'source', 'term', 'item']),
  targetId: Type.String({ minLength: 1, maxLength: 2000 }),
  createdAt: instant,
  until: Type.Optional(instant),
};
export const FeedbackSchema = Type.Union([
  Type.Object(
    {
      ...feedbackBase,
      action: Type.Enum([
        'more',
        'less',
        'mute-source',
        'mute-term',
        'snooze',
        'save',
        'dismiss',
        'split',
      ]),
    },
    closed,
  ),
  Type.Object(
    {
      ...feedbackBase,
      action: Type.Literal('undo'),
      undoesFeedbackId: Type.String({ format: 'uuid' }),
    },
    closed,
  ),
]);

export const SeenStateSchema = Type.Union([
  Type.Object(
    {
      status: Type.Literal('seen'),
      firstSeenAt: instant,
      lastSeenAt: instant,
      observations: Type.Integer({ minimum: 1 }),
    },
    closed,
  ),
  Type.Object(
    {
      status: Type.Literal('not-seen-since-capture'),
      trackingStartedAt: instant,
      capturedAt: instant,
    },
    closed,
  ),
  Type.Object(
    { status: Type.Literal('unknown'), reason: Type.Enum(['before-tracking', 'not-recorded']) },
    closed,
  ),
]);

const rankingComponent = Type.Object(
  {
    value: Type.Union([Type.Number({ minimum: 0, maximum: 100 }), Type.Null()]),
    status: Type.Enum(['available', 'unknown', 'insufficient-observations']),
    reason: Type.String({ minLength: 1, maxLength: 500 }),
    refs: Type.Array(opaqueId, { maxItems: 100, uniqueItems: true }),
  },
  closed,
);
const rankingWeights = Type.Object(
  {
    relevance: Type.Number({ minimum: 0, maximum: 1 }),
    freshness: Type.Number({ minimum: 0, maximum: 1 }),
    sourcePriority: Type.Number({ minimum: 0, maximum: 1 }),
    novelty: Type.Number({ minimum: 0, maximum: 1 }),
    velocity: Type.Number({ minimum: 0, maximum: 0.25 }),
  },
  closed,
);
export const RankingExplanationSchema = Type.Object(
  {
    storyId: opaqueId,
    formula: Type.Literal('briefing-linear-v1'),
    components: Type.Object(
      {
        relevance: rankingComponent,
        freshness: rankingComponent,
        sourcePriority: rankingComponent,
        novelty: rankingComponent,
        velocity: rankingComponent,
      },
      closed,
    ),
    weights: rankingWeights,
    completeness: Type.Enum(['partial', 'complete']),
    total: Type.Number({ minimum: 0, maximum: 100 }),
    computedAt: instant,
    inputDigest: digest,
  },
  closed,
);

export const InterestTuningValueSchema = Type.Object(
  {
    interestId: Type.String({ pattern: '^[a-z0-9-]{1,80}$' }),
    weight: Type.Number({ minimum: 0, maximum: 1 }),
    halfLifeDays: Type.Number({ exclusiveMinimum: 0 }),
  },
  closed,
);
export const InterestPreferencePreviewStorySchema = Type.Object(
  {
    storyId: opaqueId,
    title: Type.String({ minLength: 1, maxLength: 500 }),
    currentPosition: Type.Integer({ minimum: 1, maximum: 512 }),
    draftPosition: Type.Integer({ minimum: 1, maximum: 512 }),
    currentScore: Type.Number({ minimum: 0, maximum: 100 }),
    draftScore: Type.Number({ minimum: 0, maximum: 100 }),
    currentExplanation: RankingExplanationSchema,
    draftExplanation: RankingExplanationSchema,
  },
  closed,
);
export const InterestPreferencePreviewSchema = Type.Object(
  {
    schema: Type.Literal('signals.briefing-interest-preview.v1'),
    readAt: instant,
    current: InterestTuningValueSchema,
    draft: InterestTuningValueSchema,
    stories: Type.Array(InterestPreferencePreviewStorySchema, { maxItems: 512 }),
  },
  closed,
);

/** Null before explicit recording; no legal or terms decision is inferred from a feed URL. */
export const SourceTermsPolicySchema = Type.Object(
  {
    id: opaqueId,
    sourceId: opaqueId,
    termsUrl: Type.Union([Type.String({ maxLength: 2048 }), Type.Null()]),
    status: Type.Enum(['unknown', 'recorded', 'blocked']),
    reviewedAt: Type.Union([instant, Type.Null()]),
  },
  closed,
);

export const RankingPreferencesSchema = Type.Object(
  {
    velocityWeight: Type.Number({ minimum: 0, maximum: 0.25 }),
    updatedAt: instant,
  },
  closed,
);

export const InterestPreferenceSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-z0-9-]{1,80}$' }),
    weight: Type.Number({ minimum: 0, maximum: 1 }),
    halfLifeDays: Type.Number({ exclusiveMinimum: 0 }),
    updatedAt: instant,
  },
  closed,
);
export const InterestPreferenceStatusSchema = Type.Union([
  Type.Object(
    {
      status: Type.Literal('found'),
      requestId: Type.String({ format: 'uuid' }),
      preference: InterestPreferenceSchema,
      currentPreference: Type.Union([InterestTuningValueSchema, Type.Null()]),
      currentMatches: Type.Boolean(),
    },
    closed,
  ),
  Type.Object(
    {
      status: Type.Literal('not-found'),
      requestId: Type.String({ format: 'uuid' }),
      qualification: Type.String({ minLength: 1, maxLength: 500 }),
    },
    closed,
  ),
]);
export const SourcePreferenceSchema = Type.Object(
  {
    id: opaqueId,
    priority: Type.Number({ minimum: -100, maximum: 100 }),
    updatedAt: instant,
  },
  closed,
);

/** revision hashes canonical serialized Signals record bytes, not source contentDigest. */
export const BriefingRecordReferenceSchema = Type.Object(
  {
    owner: Type.Literal('signals-ai'),
    kind: Type.Enum(['briefing-source', 'briefing-item', 'briefing-story', 'briefing-event']),
    id: opaqueId,
    revision: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
  },
  closed,
);

export const BriefingRankItemInputSchema = Type.Object(
  {
    item: ItemSchema,
    itemReference: BriefingRecordReferenceSchema,
    source: SourceSchema,
    sourceReference: BriefingRecordReferenceSchema,
    interests: Type.Array(InterestSchema, { maxItems: 30 }),
    seen: SeenStateSchema,
  },
  closed,
);
export const BriefingRankInputSchema = Type.Object(
  {
    story: StorySchema,
    storyReference: BriefingRecordReferenceSchema,
    items: Type.Array(BriefingRankItemInputSchema, { minItems: 1, maxItems: 100 }),
    events: Type.Optional(Type.Array(EventSchema, { maxItems: 100 })),
    metrics: Type.Array(MetricObservationSchema, { maxItems: 1000 }),
    feedback: Type.Array(FeedbackSchema, { maxItems: 100 }),
  },
  closed,
);

export type Interest = Static<typeof InterestSchema>;
export type SourceHealth = Static<typeof SourceHealthSchema>;
export type Source = Static<typeof SourceSchema>;
export type MetricObservation = Static<typeof MetricObservationSchema>;
export type Item = Static<typeof ItemSchema>;
export type Story = Static<typeof StorySchema>;
export type Event = Static<typeof EventSchema>;
export type TimedEvent = Static<typeof TimedEventSchema>;
export type AllDayEvent = Static<typeof AllDayEventSchema>;
export type Feedback = Static<typeof FeedbackSchema>;
export type RankingExplanation = Static<typeof RankingExplanationSchema>;
export type SeenState = Static<typeof SeenStateSchema>;
export type SourceTermsPolicy = Static<typeof SourceTermsPolicySchema>;
export type BriefingRankItemInput = Static<typeof BriefingRankItemInputSchema>;
export type BriefingRankInput = Static<typeof BriefingRankInputSchema>;
export type BriefingRecordReference = Static<typeof BriefingRecordReferenceSchema>;
export type BriefingRecord<T, K extends BriefingRecordReference['kind']> = {
  record: T;
  reference: BriefingRecordReference & { kind: K };
};

export type BriefingReadOptions = {
  interestId?: string;
  sourceId?: string;
  after?: string;
  before?: string;
  limit?: number;
};
export type FeedbackRequest = {
  requestId: string;
  targetKind: Feedback['targetKind'];
  targetId: string;
  action: Exclude<Feedback['action'], 'undo'>;
  until?: string;
};
export type FeedbackUndoRequest = { requestId: string; feedbackId: string };
export type FeedbackReceipt = { feedback: Feedback; revision: string; replayed: boolean };
export type MetricObservationRequest = { requestId: string; observation: MetricObservation };
export type InterestPreference = Pick<Interest, 'id' | 'weight' | 'halfLifeDays'> & {
  updatedAt: string;
};
export type InterestPreferenceRequest = {
  requestId: string;
  interestId: string;
  weight: number;
  halfLifeDays: number;
  expected?: { weight: number; halfLifeDays: number };
};
export type InterestTuningValue = Static<typeof InterestTuningValueSchema>;
export type InterestPreferencePreview = Static<typeof InterestPreferencePreviewSchema>;
export type InterestPreferenceStatus = Static<typeof InterestPreferenceStatusSchema>;
export type SourcePreference = Pick<Source, 'id' | 'priority'> & { updatedAt: string };
export type SourcePreferenceRequest = { requestId: string; sourceId: string; priority: number };
export type RankingPreferences = Static<typeof RankingPreferencesSchema>;
export type RankingPreferencesRequest = { requestId: string; velocityWeight: number };
export type SourceTermsPolicyRequest = {
  requestId: string;
  sourceId: string;
  termsUrl: string | null;
  status: SourceTermsPolicy['status'];
};

/** All writes/reads use the existing Signals private store and Search writer lock. */
export interface BriefingReadApi {
  listInterests(): Promise<Interest[]>;
  listSources(): Promise<Array<BriefingRecord<Source, 'briefing-source'>>>;
  listItems(options?: BriefingReadOptions): Promise<Array<BriefingRecord<Item, 'briefing-item'>>>;
  listStories(
    options?: BriefingReadOptions,
  ): Promise<Array<BriefingRecord<Story, 'briefing-story'>>>;
  listEvents(
    options?: BriefingReadOptions,
  ): Promise<Array<BriefingRecord<Event, 'briefing-event'>>>;
  listFeedback(options?: BriefingReadOptions): Promise<Feedback[]>;
  listRankInputs(options?: BriefingReadOptions): Promise<BriefingRankInput[]>;
  recordFeedback(request: FeedbackRequest): Promise<FeedbackReceipt>;
  undoFeedback(request: FeedbackUndoRequest): Promise<FeedbackReceipt>;
  recordMetricObservation(request: MetricObservationRequest): Promise<MetricObservation>;
  setInterestPreference(request: InterestPreferenceRequest): Promise<InterestPreference>;
  setSourcePreference(request: SourcePreferenceRequest): Promise<SourcePreference>;
  getRankingPreferences(): Promise<RankingPreferences>;
  setRankingPreferences(request: RankingPreferencesRequest): Promise<RankingPreferences>;
  setSourceTermsPolicy(request: SourceTermsPolicyRequest): Promise<SourceTermsPolicy>;
  markSeen(request: {
    requestId: string;
    targetKind: 'item' | 'story';
    targetId: string;
  }): Promise<SeenState>;
}

const BASE_WEIGHTS = { relevance: 0.45, freshness: 0.25, sourcePriority: 0.15, novelty: 0.1 };
export const DEFAULT_VELOCITY_WEIGHT = 0.05 as const;
export const DEFAULT_INTEREST_WEIGHT = 1 as const;
export const DEFAULT_INTEREST_HALF_LIFE_DAYS = 0.75 as const;
export function effectiveRankingWeights(velocity: number) {
  const scale = (1 - velocity) / 0.95;
  return {
    relevance: BASE_WEIGHTS.relevance * scale,
    freshness: BASE_WEIGHTS.freshness * scale,
    sourcePriority: BASE_WEIGHTS.sourcePriority * scale,
    novelty: BASE_WEIGHTS.novelty * scale,
    velocity,
  };
}
export function rankingTotal(
  components: RankingExplanation['components'],
  weights: RankingExplanation['weights'],
) {
  const total =
    (components.relevance.value ?? 0) * weights.relevance +
    (components.freshness.value ?? 0) * weights.freshness +
    (components.sourcePriority.value ?? 0) * weights.sourcePriority +
    (components.novelty.value ?? 0) * weights.novelty +
    (components.velocity.value ?? 0) * weights.velocity;
  return Math.round(total * 100) / 100;
}
export function isRankingExplanation(value: unknown): value is RankingExplanation {
  if (!Value.Check(RankingExplanationSchema, value)) return false;
  const explanation = value as RankingExplanation;
  const componentValues = Object.values(explanation.components);
  const allKnown = componentValues.every((component) => component.status === 'available');
  const statusesValid = componentValues.every(
    (component) =>
      (component.status === 'available') === (component.value !== null) &&
      (component.status !== 'insufficient-observations' || component.value === null),
  );
  return (
    statusesValid &&
    explanation.completeness === (allKnown ? 'complete' : 'partial') &&
    explanation.total === rankingTotal(explanation.components, explanation.weights)
  );
}

export const BRIEFING_SCHEMA_VERSION = 1 as const;
export const FEEDBACK_API_CONTRACT = 'briefing-feedback/1' as const;
