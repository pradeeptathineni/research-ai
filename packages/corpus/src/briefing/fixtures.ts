import type {
  AllDayEvent,
  BriefingRecordReference,
  BriefingRankInput,
  Feedback,
  InterestPreference,
  Interest,
  Item,
  MetricObservation,
  RankingExplanation,
  SeenState,
  Source,
  Story,
  SourcePreference,
  RankingPreferences,
  TimedEvent,
} from './schema.js';

export const interestFixture = {
  id: 'climate-data',
  query: 'climate data releases',
  label: 'Climate data',
  enabled: true,
  weight: 1,
  halfLifeDays: 30,
  sourceUris: ['https://example.test/feed.xml'],
} satisfies Interest;

export const sourceFixture = {
  id: 'source-feed-1',
  uri: 'https://example.test/feed.xml',
  label: 'Example feed',
  kind: 'rss',
  priority: 0,
  interestIds: ['climate-data'],
  policy: { termsUrl: null, reviewedAt: null, status: 'unknown' },
  health: {
    status: 'stale',
    checkedAt: '2026-10-28T00:00:00.000Z',
    lastSuccessAt: '2026-10-27T00:00:00.000Z',
    reasonCode: null,
  },
} satisfies Source;

export const itemFixture = {
  id: 'item-1',
  sourceId: sourceFixture.id,
  canonicalUrl: 'https://example.test/story/1',
  title: 'A reported data release',
  summary: 'A short feed summary.',
  publishedAt: '2026-10-27T12:00:00.000Z',
  capturedAt: '2026-10-28T00:00:00.000Z',
  contentDigest: 'a'.repeat(64),
  interestIds: [interestFixture.id],
  storyId: 'story-1',
} satisfies Item;

export const storyFixture = {
  id: 'story-1',
  canonicalItemId: itemFixture.id,
  itemIds: [itemFixture.id, 'item-2'],
  relation: 'linked',
  createdAt: '2026-10-28T00:00:00.000Z',
  updatedAt: '2026-10-28T00:00:00.000Z',
} satisfies Story;

export const timedEventFixture = {
  id: 'event-timed',
  sourceItemId: itemFixture.id,
  title: 'Briefing event',
  allDay: false,
  startUtc: '2026-10-28T09:00:00.000Z',
  endUtc: null,
  timeZone: 'America/New_York',
  dstAdjusted: false,
} satisfies TimedEvent;

export const allDayEventFixture = {
  id: 'event-day',
  sourceItemId: itemFixture.id,
  title: 'Briefing day',
  allDay: true,
  startDate: '2026-10-28',
  endDate: null,
  timeZone: 'America/New_York',
  dstAdjusted: false,
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

export const rankingExplanationFixture = {
  algorithm: 'briefing-rank/1',
  baseScore: 50,
  score: 70,
  contributions: [
    {
      key: 'interest-match',
      points: 20,
      explanation: 'Matches a selected interest.',
      refs: [interestFixture.id],
    },
  ],
  inputDigest: 'b'.repeat(64),
  computedAt: '2026-10-28T00:00:00.000Z',
} satisfies RankingExplanation;

export const itemReferenceFixture = {
  owner: 'signals-ai',
  kind: 'briefing-item',
  id: itemFixture.id,
  revision: `sha256:${'a'.repeat(64)}`,
} satisfies BriefingRecordReference;

export const metricObservationFixture = {
  id: 'metric-1',
  itemId: itemFixture.id,
  platform: 'example-platform',
  metric: 'views',
  value: 40,
  observedAt: '2026-10-28T00:00:00.000Z',
  method: 'public-adapter',
  sourceRef: 'https://example.test/story/1',
} satisfies MetricObservation;

export const seenStateFixture = {
  status: 'not-seen-since-capture',
  trackingStartedAt: itemFixture.capturedAt,
  capturedAt: itemFixture.capturedAt,
} satisfies SeenState;

export const unknownSeenStateFixture = {
  status: 'unknown',
  reason: 'before-tracking',
} satisfies SeenState;

export const interestPreferenceFixture = {
  interestId: interestFixture.id,
  weight: 1,
  halfLifeDays: 30,
  updatedAt: '2026-10-28T00:00:00.000Z',
} satisfies InterestPreference;

export const sourcePreferenceFixture = {
  sourceId: sourceFixture.id,
  priority: 0,
  updatedAt: '2026-10-28T00:00:00.000Z',
} satisfies SourcePreference;

export const rankingPreferencesFixture = {
  velocityWeight: 0.1,
  updatedAt: '2026-10-28T00:00:00.000Z',
} satisfies RankingPreferences;

export const rankInputFixture = {
  item: itemFixture,
  itemReference: itemReferenceFixture,
  source: sourceFixture,
  interests: [interestFixture],
  metrics: [metricObservationFixture],
  seen: seenStateFixture,
  feedback: [feedbackFixture],
} satisfies BriefingRankInput;
