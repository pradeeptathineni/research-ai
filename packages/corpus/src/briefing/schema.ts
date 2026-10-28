import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

const closed = { additionalProperties: false } as const;
const opaqueId = Type.String({ minLength: 1, maxLength: 160, pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$' });
const digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const instant = Type.String({ format: 'date-time', maxLength: 40 });
const localDate = Type.String({ format: 'date', maxLength: 10 });

/** An exact projection of an existing SearchSettings query; not a second interest owner. */
export const InterestSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-z0-9-]{1,80}$' }),
    query: Type.String({ minLength: 1, maxLength: 2000 }),
    label: Type.String({ minLength: 1, maxLength: 200 }),
    enabled: Type.Boolean(),
    sourceUris: Type.Array(Type.String({ maxLength: 2048 }), { maxItems: 50, uniqueItems: true }),
  },
  closed,
);

export const SourceHealthSchema = Type.Object(
  {
    status: Type.Enum(['unknown', 'healthy', 'stale', 'failed', 'disabled']),
    checkedAt: Type.Union([instant, Type.Null()]),
    lastSuccessAt: Type.Union([instant, Type.Null()]),
    reasonCode: Type.Union([Type.String({ maxLength: 120 }), Type.Null()]),
  },
  closed,
);

export const SourceSchema = Type.Object(
  {
    id: opaqueId,
    uri: Type.String({ minLength: 1, maxLength: 2048 }),
    label: Type.String({ minLength: 1, maxLength: 200 }),
    kind: Type.Enum(['rss', 'atom', 'json-feed', 'opml', 'ics', 'web']),
    interestIds: Type.Array(Type.String({ pattern: '^[a-z0-9-]{1,80}$' }), {
      maxItems: 30,
      uniqueItems: true,
    }),
    policy: Type.Object(
      {
        termsUrl: Type.Union([Type.String({ maxLength: 2048 }), Type.Null()]),
        reviewedAt: Type.Union([instant, Type.Null()]),
        status: Type.Enum(['unknown', 'recorded']),
      },
      closed,
    ),
    health: SourceHealthSchema,
  },
  closed,
);

export const ItemSchema = Type.Object(
  {
    id: opaqueId,
    sourceId: opaqueId,
    canonicalUrl: Type.String({ minLength: 1, maxLength: 2048 }),
    title: Type.String({ minLength: 1, maxLength: 500 }),
    summary: Type.String({ maxLength: 5000 }),
    publishedAt: Type.Union([instant, Type.Null()]),
    capturedAt: instant,
    contentDigest: digest,
    interestIds: Type.Array(Type.String({ pattern: '^[a-z0-9-]{1,80}$' }), {
      maxItems: 30,
      uniqueItems: true,
    }),
    storyId: Type.Union([opaqueId, Type.Null()]),
  },
  closed,
);

/** Group membership never removes or rewrites member Items, so a story can be split reversibly. */
export const StorySchema = Type.Object(
  {
    id: opaqueId,
    canonicalItemId: opaqueId,
    itemIds: Type.Array(opaqueId, { minItems: 2, maxItems: 100, uniqueItems: true }),
    relation: Type.Enum(['exact', 'linked', 'near']),
    createdAt: instant,
    updatedAt: instant,
  },
  closed,
);

export const TimedEventSchema = Type.Object(
  {
    id: opaqueId,
    sourceItemId: opaqueId,
    title: Type.String({ minLength: 1, maxLength: 500 }),
    allDay: Type.Literal(false),
    startUtc: instant,
    endUtc: Type.Union([instant, Type.Null()]),
    timeZone: Type.String({ minLength: 1, maxLength: 100 }),
    dstAdjusted: Type.Boolean(),
  },
  closed,
);

export const AllDayEventSchema = Type.Object(
  {
    id: opaqueId,
    sourceItemId: opaqueId,
    title: Type.String({ minLength: 1, maxLength: 500 }),
    allDay: Type.Literal(true),
    startDate: localDate,
    endDate: Type.Union([localDate, Type.Null()]),
    timeZone: Type.String({ minLength: 1, maxLength: 100 }),
    dstAdjusted: Type.Boolean(),
  },
  closed,
);

export const EventSchema = Type.Union([TimedEventSchema, AllDayEventSchema]);

/** Feedback is append-only; undo is a new record referencing the exact prior feedback ID. */
const feedbackIdentity = {
  id: Type.String({ format: 'uuid' }),
  requestId: Type.String({ format: 'uuid' }),
  targetKind: Type.Enum(['interest', 'source', 'item', 'story', 'event']),
  targetId: opaqueId,
  createdAt: instant,
};
export const FeedbackSchema = Type.Union([
  Type.Object(
    {
      ...feedbackIdentity,
      action: Type.Enum(['boost', 'dismiss']),
      weight: Type.Optional(Type.Integer({ minimum: -100, maximum: 100 })),
    },
    closed,
  ),
  Type.Object(
    { ...feedbackIdentity, action: Type.Literal('mute'), until: Type.Optional(instant) },
    closed,
  ),
  Type.Object({ ...feedbackIdentity, action: Type.Literal('snooze'), until: instant }, closed),
  Type.Object(
    {
      ...feedbackIdentity,
      action: Type.Literal('undo'),
      undoesFeedbackId: Type.String({ format: 'uuid' }),
    },
    closed,
  ),
]);

export const RankingExplanationSchema = Type.Object(
  {
    algorithm: Type.String({ minLength: 1, maxLength: 120 }),
    baseScore: Type.Integer({ minimum: 0, maximum: 100 }),
    score: Type.Integer({ minimum: 0, maximum: 100 }),
    contributions: Type.Array(
      Type.Object(
        {
          key: Type.String({ minLength: 1, maxLength: 80 }),
          points: Type.Integer({ minimum: -100, maximum: 100 }),
          explanation: Type.String({ minLength: 1, maxLength: 500 }),
          refs: Type.Array(opaqueId, { maxItems: 100, uniqueItems: true }),
        },
        closed,
      ),
      { maxItems: 50 },
    ),
    inputDigest: digest,
    computedAt: instant,
  },
  closed,
);

/** Stable local references for consumers; opening one still reads the owning Signals record. */
export const BriefingRecordReferenceSchema = Type.Object(
  {
    owner: Type.Literal('signals-ai'),
    kind: Type.Enum(['briefing-item', 'briefing-story', 'briefing-event']),
    id: opaqueId,
    revision: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
  },
  closed,
);

export type Interest = Static<typeof InterestSchema>;
export type SourceHealth = Static<typeof SourceHealthSchema>;
export type Source = Static<typeof SourceSchema>;
export type Item = Static<typeof ItemSchema>;
export type Story = Static<typeof StorySchema>;
export type Event = Static<typeof EventSchema>;
export type TimedEvent = Static<typeof TimedEventSchema>;
export type AllDayEvent = Static<typeof AllDayEventSchema>;
export type Feedback = Static<typeof FeedbackSchema>;
export type RankingExplanation = Static<typeof RankingExplanationSchema>;
export type BriefingRecordReference = Static<typeof BriefingRecordReferenceSchema>;

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
  weight?: number;
};
export type FeedbackUndoRequest = { requestId: string; feedbackId: string };
export type FeedbackReceipt = { feedback: Feedback; revision: string; replayed: boolean };

/** S1 implementations use the existing Signals private store and writer lock. */
export interface BriefingReadApi {
  listInterests(): Promise<Interest[]>;
  listSources(): Promise<Source[]>;
  listItems(options?: BriefingReadOptions): Promise<Item[]>;
  listStories(options?: BriefingReadOptions): Promise<Story[]>;
  listEvents(options?: BriefingReadOptions): Promise<Event[]>;
  listFeedback(options?: BriefingReadOptions): Promise<Feedback[]>;
  recordFeedback(request: FeedbackRequest): Promise<FeedbackReceipt>;
  undoFeedback(request: FeedbackUndoRequest): Promise<FeedbackReceipt>;
}

export function scoreFromContributions(
  baseScore: number,
  contributions: ReadonlyArray<{ points: number }>,
): number {
  return Math.max(
    0,
    Math.min(100, baseScore + contributions.reduce((sum, row) => sum + row.points, 0)),
  );
}

export function isRankingExplanation(value: unknown): value is RankingExplanation {
  if (!Value.Check(RankingExplanationSchema, value)) return false;
  const explanation = value as RankingExplanation;
  return (
    explanation.score ===
    scoreFromContributions(explanation.baseScore, explanation.contributions)
  );
}

export const BRIEFING_SCHEMA_VERSION = 1 as const;
export const FEEDBACK_API_CONTRACT = 'briefing-feedback/1' as const;

