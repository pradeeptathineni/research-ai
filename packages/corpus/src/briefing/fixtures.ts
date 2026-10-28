import type {
  AllDayEvent,
  BriefingRankInput,
  BriefingRecordReference,
  Feedback,
  Interest,
  InterestPreference,
  Item,
  MetricObservation,
  RankingExplanation,
  RankingPreferences,
  SeenState,
  Source,
  SourceTermsPolicy,
  Story,
  TimedEvent,
} from './schema.js';

export const sourceFixture = {
  id: 'source-feed-1',
  kind: 'rss',
  url: 'https://example.test/feed.xml',
  attribution: 'Example feed',
  termsRef: null,
  priority: 0,
  interestIds: ['climate-data'],
  health: {
    status: 'unknown',
    lastGoodAt: null,
    lastAttemptAt: null,
    failureClass: null,
    expectedIntervalSec: null,
  },
} satisfies Source;

export const interestFixture = {
  id: 'climate-data',
  label: 'Climate data',
  includeTerms: ['climate data releases'],
  excludeTerms: [],
  enabled: true,
  weight: 1,
  halfLifeDays: 0.75,
  sources: [sourceFixture.id],
  cadenceRef: null,
  revision: 'c'.repeat(64),
} satisfies Interest;

export const metricObservationFixture = {
  id: 'metric-1',
  itemId: 'item-1',
  platform: 'example-platform',
  name: 'views',
  value: 40,
  observedAt: '2026-10-28T00:00:00.000Z',
  scope: 'public page observation',
  method: 'public-adapter',
  sourceRef: 'https://example.test/story/1',
} satisfies MetricObservation;

export const itemFixture = {
  id: 'item-1',
  sourceId: sourceFixture.id,
  canonicalUrl: 'https://example.test/story/1',
  title: 'A reported data release',
  author: null,
  publishedAt: '2026-10-27T12:00:00.000Z',
  observedAt: '2026-10-28T00:00:00.000Z',
  contentDigest: 'a'.repeat(64),
  excerpt: 'A short feed excerpt.',
  metrics: [metricObservationFixture],
  interestIds: [interestFixture.id],
  storyId: 'story-1',
} satisfies Item;

export const storyFixture = {
  id: 'story-1',
  itemIds: [itemFixture.id, 'item-2'],
  representativeItemId: itemFixture.id,
  firstSeen: '2026-10-28T00:00:00.000Z',
  lastSeen: '2026-10-28T00:00:00.000Z',
  relation: 'linked',
  groupingEvidence: [{ rule: 'linked-canonical-url', score: 1, matchedItemId: 'item-2' }],
  interestMatches: [{ interestId: interestFixture.id, matchedTerms: ['climate data'] }],
} satisfies Story;

export const timedEventFixture = {
  id: 'event-timed',
  itemId: itemFixture.id,
  startUtc: '2026-10-28T09:00:00.000Z',
  endUtc: null,
  originalTz: 'America/New_York',
  allDay: false,
  dstAmbiguous: false,
  url: null,
  location: null,
  recurrence: null,
} satisfies TimedEvent;

export const allDayEventFixture = {
  id: 'event-day',
  itemId: itemFixture.id,
  startDate: '2026-10-28',
  endDate: '2026-10-29',
  originalTz: 'America/New_York',
  allDay: true,
  dstAmbiguous: false,
  url: null,
  location: null,
  recurrence: null,
} satisfies AllDayEvent;

export const feedbackFixture = {
  id: 'a064d6e1-d0e6-4ea8-bd4d-d88f842cfa61',
  requestId: 'a064d6e1-d0e6-4ea8-bd4d-d88f842cfa62',
  targetKind: 'story',
  targetId: storyFixture.id,
  action: 'snooze',
  createdAt: '2026-10-28T00:00:00.000Z',
  until: '2026-10-29T00:00:00.000Z',
} satisfies Feedback;

export const undoFixture = {
  id: 'a064d6e1-d0e6-4ea8-bd4d-d88f842cfa63',
  requestId: 'a064d6e1-d0e6-4ea8-bd4d-d88f842cfa64',
  targetKind: 'story',
  targetId: storyFixture.id,
  action: 'undo',
  createdAt: '2026-10-28T00:01:00.000Z',
  undoesFeedbackId: feedbackFixture.id,
} satisfies Feedback;

export const sourceReferenceFixture = {
  owner: 'signals-ai',
  kind: 'briefing-source',
  id: sourceFixture.id,
  revision: `sha256:${'d'.repeat(64)}`,
} satisfies BriefingRecordReference;

export const itemReferenceFixture = {
  owner: 'signals-ai',
  kind: 'briefing-item',
  id: itemFixture.id,
  revision: `sha256:${'a'.repeat(64)}`,
} satisfies BriefingRecordReference;

export const storyReferenceFixture = {
  owner: 'signals-ai',
  kind: 'briefing-story',
  id: storyFixture.id,
  revision: `sha256:${'b'.repeat(64)}`,
} satisfies BriefingRecordReference;

export const eventReferenceFixture = {
  owner: 'signals-ai',
  kind: 'briefing-event',
  id: timedEventFixture.id,
  revision: `sha256:${'e'.repeat(64)}`,
} satisfies BriefingRecordReference;

export const seenStateFixture = {
  status: 'not-seen-since-capture',
  trackingStartedAt: itemFixture.observedAt,
  capturedAt: itemFixture.observedAt,
} satisfies SeenState;

export const unknownSeenStateFixture = {
  status: 'unknown',
  reason: 'before-tracking',
} satisfies SeenState;

export const interestPreferenceFixture = {
  id: interestFixture.id,
  weight: 1,
  halfLifeDays: 0.75,
  updatedAt: '2026-10-28T00:00:00.000Z',
} satisfies InterestPreference;

export const rankingPreferencesFixture = {
  velocityWeight: 0.05,
  updatedAt: '2026-10-28T00:00:00.000Z',
} satisfies RankingPreferences;

export const sourcePreferenceFixture = {
  id: sourceFixture.id,
  priority: 0,
  updatedAt: '2026-10-28T00:00:00.000Z',
};

export const sourceTermsPolicyFixture = {
  id: 'terms-source-feed-1',
  sourceId: sourceFixture.id,
  termsUrl: 'https://example.test/terms',
  status: 'recorded',
  reviewedAt: '2026-10-28T00:00:00.000Z',
} satisfies SourceTermsPolicy;

export const rankingExplanationFixture = {
  storyId: storyFixture.id,
  formula: 'briefing-linear-v1',
  components: {
    relevance: {
      value: 80,
      status: 'available',
      reason: 'Matched selected terms.',
      refs: [interestFixture.id],
    },
    freshness: {
      value: 50,
      status: 'available',
      reason: '18-hour half-life.',
      refs: [itemFixture.id],
    },
    sourcePriority: {
      value: 50,
      status: 'available',
      reason: 'Neutral source priority.',
      refs: [sourceFixture.id],
    },
    novelty: {
      value: 100,
      status: 'available',
      reason: 'Not seen since capture.',
      refs: [itemFixture.id],
    },
    velocity: {
      value: null,
      status: 'insufficient-observations',
      reason: 'Fewer than two observations.',
      refs: [metricObservationFixture.id],
    },
  },
  weights: { relevance: 0.45, freshness: 0.25, sourcePriority: 0.15, novelty: 0.1, velocity: 0.05 },
  completeness: 'partial',
  total: 66,
  computedAt: '2026-10-28T00:00:00.000Z',
  inputDigest: 'b'.repeat(64),
} satisfies RankingExplanation;

export const rankInputFixture = {
  story: storyFixture,
  storyReference: storyReferenceFixture,
  items: [
    {
      item: itemFixture,
      itemReference: itemReferenceFixture,
      source: sourceFixture,
      sourceReference: sourceReferenceFixture,
      interests: [interestFixture],
      seen: seenStateFixture,
    },
  ],
  metrics: [metricObservationFixture],
  feedback: [feedbackFixture],
} satisfies BriefingRankInput;
