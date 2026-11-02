import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Type, type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { atomicJson, readPrivateJson, withWriter } from '../search-store.js';
import { loadSettings } from '../search-settings.js';
import {
  BriefingRecordReferenceSchema,
  EventSchema,
  FeedbackSchema,
  InterestPreferenceSchema,
  InterestSchema,
  ItemSchema,
  MetricObservationSchema,
  RankingPreferencesSchema,
  SeenStateSchema,
  SourcePreferenceSchema,
  SourceSchema,
  SourceTermsPolicySchema,
  StorySchema,
  DEFAULT_INTEREST_HALF_LIFE_DAYS,
  DEFAULT_INTEREST_WEIGHT,
  DEFAULT_VELOCITY_WEIGHT,
  type BriefingReadApi,
  type BriefingRecord,
  type BriefingRecordReference,
  type BriefingRankInput,
  type Event,
  type Feedback,
  type FeedbackReceipt,
  type Interest,
  type InterestPreference,
  type InterestPreferenceStatus,
  type InterestTuningValue,
  type Item,
  type MetricObservation,
  type RankingPreferences,
  type SeenState,
  type Source,
  type SourcePreference,
  type SourceTermsPolicy,
  type Story,
} from './schema.js';

const emptyState = {
  version: 1,
  items: [] as Item[],
  stories: [] as Story[],
  events: [] as Event[],
  feedback: [] as Feedback[],
  metrics: [] as MetricObservation[],
  seen: {} as Record<string, SeenState>,
  interestPreferences: [] as InterestPreference[],
  sourcePreferences: [] as SourcePreference[],
  rankingPreferences: null as RankingPreferences | null,
  sourceTerms: [] as SourceTermsPolicy[],
  requests: {} as Record<string, { digest: string; result: unknown }>,
};
const refreshSourceSummarySchema = Type.Object(
  {
    sourceId: Type.String({ minLength: 1, maxLength: 160 }),
    state: Type.Enum(['fetched', 'failed']),
    delta: Type.Union([
      Type.Enum(['first-inspection', 'unchanged', 'content-changed-meaning-unassessed']),
      Type.Null(),
    ]),
    newLinkCount: Type.Integer({ minimum: 0, maximum: 10000 }),
    checkedAt: Type.Union([Type.String({ format: 'date-time', maxLength: 40 }), Type.Null()]),
    failureReason: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
  },
  { additionalProperties: false },
);
const refreshSummarySchema = Type.Object(
  {
    capturedDocuments: Type.Integer({ minimum: 0, maximum: 50 }),
    retainedItems: Type.Integer({ minimum: 0, maximum: 100000 }),
    eventRecords: Type.Integer({ minimum: 0, maximum: 100000 }),
    blockedSourceIds: Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { maxItems: 50 }),
    sources: Type.Array(refreshSourceSummarySchema, { maxItems: 50 }),
  },
  { additionalProperties: false },
);
const refreshReceiptSchema = Type.Object(
  {
    schema: Type.Literal('signals.briefing-refresh-receipt.v1'),
    requestId: Type.String({ format: 'uuid' }),
    inputDigest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    status: Type.Enum(['pending', 'complete']),
    startedAt: Type.String({ format: 'date-time', maxLength: 40 }),
    completedAt: Type.Union([Type.String({ format: 'date-time', maxLength: 40 }), Type.Null()]),
    result: Type.Union([refreshSummarySchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type BriefingRefreshSummary = Static<typeof refreshSummarySchema>;
export type BriefingRefreshReceipt = Static<typeof refreshReceiptSchema>;
const stateSchema = Type.Object(
  {
    version: Type.Literal(1),
    items: Type.Array(ItemSchema, { maxItems: 100000 }),
    stories: Type.Array(StorySchema, { maxItems: 100000 }),
    events: Type.Array(EventSchema, { maxItems: 100000 }),
    feedback: Type.Array(FeedbackSchema, { maxItems: 100000 }),
    metrics: Type.Array(MetricObservationSchema, { maxItems: 100000 }),
    seen: Type.Record(Type.String({ minLength: 1, maxLength: 200 }), SeenStateSchema),
    interestPreferences: Type.Array(InterestPreferenceSchema, { maxItems: 512 }),
    sourcePreferences: Type.Array(SourcePreferenceSchema, { maxItems: 50 }),
    rankingPreferences: Type.Union([RankingPreferencesSchema, Type.Null()]),
    sourceTerms: Type.Array(SourceTermsPolicySchema, { maxItems: 50 }),
    requests: Type.Record(
      Type.String({ format: 'uuid' }),
      Type.Object({ digest: Type.String({ pattern: '^[a-f0-9]{64}$' }), result: Type.Unknown() }),
      { maxProperties: 100000 },
    ),
  },
  { additionalProperties: false },
);
type State = typeof emptyState;

function refreshReceipt(value: unknown): BriefingRefreshReceipt | null {
  return Value.Check(refreshReceiptSchema, value) ? value : null;
}

function hash(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
async function readState(root: string): Promise<State> {
  const value = await readPrivateJson(
    root,
    'briefing/state.json',
    structuredClone(emptyState),
    20000000,
  );
  if (!Value.Check(stateSchema, value)) throw new Error('invalid_briefing_state');
  return value as State;
}
async function writeState(root: string, state: State) {
  if (!Value.Check(stateSchema, state)) throw new Error('invalid_briefing_state');
  await atomicJson(resolve(root, '.signals/briefing/state.json'), state);
}
function recordRef<T, K extends BriefingRecordReference['kind']>(record: T, kind: K, id: string) {
  const reference = {
    owner: 'signals-ai',
    kind,
    id,
    revision: `sha256:${hash(canonical(record))}`,
  } satisfies BriefingRecordReference;
  if (!Value.Check(BriefingRecordReferenceSchema, reference)) throw new Error('invalid_record_ref');
  return { record, reference } as BriefingRecord<T, K>;
}
function safeId(prefix: string, value: string) {
  return `${prefix}-${hash(value).slice(0, 32)}`;
}
function currentTime() {
  return new Date().toISOString();
}

/** Only the official public HN story-index routes are treated as the HN API adapter. */
export function isHackerNewsIndexUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    const allowedPaths = new Set([
      '/v0/topstories.json',
      '/v0/newstories.json',
      '/v0/beststories.json',
      '/v0/askstories.json',
      '/v0/showstories.json',
    ]);
    const query = [...url.searchParams.entries()];
    return (
      url.protocol === 'https:' &&
      url.hostname === 'hacker-news.firebaseio.com' &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.hash &&
      allowedPaths.has(url.pathname) &&
      (query.length === 0 ||
        (query.length === 1 && query[0]![0] === 'print' && query[0]![1] === 'pretty'))
    );
  } catch {
    return false;
  }
}

/** The only GitHub public list routes this adapter reads; repository releases and tags stay distinct. */
export function githubPublicRepositoryList(uri: string): {
  owner: string;
  repository: string;
  collection: 'releases' | 'tags';
} | null {
  try {
    const url = new URL(uri);
    const match =
      /^\/repos\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})\/(releases|tags)$/.exec(
        url.pathname,
      );
    const collection = match?.[3];
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'api.github.com' ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !match ||
      (collection !== 'releases' && collection !== 'tags') ||
      match[2] === '.' ||
      match[2] === '..'
    )
      return null;
    return {
      owner: match[1]!,
      repository: match[2]!,
      collection,
    };
  } catch {
    return null;
  }
}

/** Exact user-followed Mastodon hashtag timeline URL; transport adds its own fixed limit. */
export function mastodonTagTimeline(uri: string): { origin: string; tag: string } | null {
  try {
    const url = new URL(uri);
    const match = /^\/api\/v1\/timelines\/tag\/([A-Za-z0-9_]{1,80})$/.exec(url.pathname);
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !match
    )
      return null;
    return { origin: url.origin, tag: match[1]! };
  } catch {
    return null;
  }
}

/** Documented public Lobsters RSS collections; no search or private endpoint variants. */
export function lobstersPublicFeed(uri: string): boolean {
  try {
    const url = new URL(uri);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'lobste.rs' &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.pathname === '/rss' || url.pathname === '/newest.rss')
    );
  } catch {
    return false;
  }
}

async function projectedInterests(
  root: string,
  state: State,
  settingsInput?: Awaited<ReturnType<typeof loadSettings>>,
): Promise<Interest[]> {
  const settings = settingsInput ?? (await loadSettings(root));
  const overrides = new Map(state.interestPreferences.map((item) => [item.id, item]));
  return settings.queries.map((query) => {
    const preference = overrides.get(query.id);
    const sources = (settings.followedSources ?? [])
      .filter(
        (source) =>
          source.enabled && (!source.interests.length || source.interests.includes(query.id)),
      )
      .map((source) => safeId('source', source.uri));
    const projected = {
      id: query.id,
      label: query.query,
      includeTerms: [query.query],
      excludeTerms: [],
      enabled: query.enabled,
      weight: preference?.weight ?? DEFAULT_INTEREST_WEIGHT,
      halfLifeDays: preference?.halfLifeDays ?? DEFAULT_INTEREST_HALF_LIFE_DAYS,
      sources,
      cadenceRef: null,
    };
    return { ...projected, revision: hash(canonical(projected)) };
  });
}

async function projectedSources(
  root: string,
  state: State,
  settingsInput?: Awaited<ReturnType<typeof loadSettings>>,
): Promise<Source[]> {
  const settings = settingsInput ?? (await loadSettings(root));
  const [saved, interests] = await Promise.all([
    readPrivateJson(root, 'source-state.json', {}, 2000000),
    projectedInterests(root, state, settings),
  ]);
  if (!saved || typeof saved !== 'object' || Array.isArray(saved))
    throw new Error('invalid_source_state');
  const sourceState = saved as Record<
    string,
    {
      state?: string;
      fetchedAt?: string;
      links?: string[];
      lastAttempt?: {
        checkedAt?: string;
        status?: 'fetched' | 'not-modified' | 'failed';
        reason?: string | null;
      };
    }
  >;
  const preference = new Map(state.sourcePreferences.map((item) => [item.id, item.priority]));
  const policy = new Map(state.sourceTerms.map((item) => [item.sourceId, item]));
  return (settings.followedSources ?? []).map((configured) => {
    const id = safeId('source', configured.uri);
    const associated = interests.filter(
      (interest) =>
        interest.enabled &&
        (configured.interests.length === 0 || configured.interests.includes(interest.id)),
    );
    const intervals = [
      ...new Set(
        associated.map(
          (interest) =>
            settings.queries.find((query) => query.id === interest.id)!.everyDays * 86400,
        ),
      ),
    ];
    const expectedIntervalSec = intervals.length === 1 ? intervals[0]! : null;
    const prior = sourceState[configured.uri];
    const lastGoodAt = prior?.state === 'fetched' && prior.fetchedAt ? prior.fetchedAt : null;
    const lastAttemptAt = prior?.lastAttempt?.checkedAt ?? null;
    const failed = prior?.lastAttempt?.status === 'failed';
    const stale = Boolean(
      lastGoodAt &&
      expectedIntervalSec &&
      Date.now() - Date.parse(lastGoodAt) > expectedIntervalSec * 2000,
    );
    const terms = policy.get(id);
    const health = {
      status: failed
        ? ('failed' as const)
        : stale
          ? ('stale' as const)
          : lastGoodAt
            ? ('healthy' as const)
            : ('unknown' as const),
      lastGoodAt,
      lastAttemptAt,
      lastAttemptStatus: prior?.lastAttempt?.status ?? null,
      lastSuccessfulLinkCount:
        prior?.state === 'fetched' && prior.fetchedAt ? (prior.links?.length ?? 0) : null,
      failureClass: failed ? ('other' as const) : null,
      expectedIntervalSec,
    };
    const githubSource = githubPublicRepositoryList(configured.uri);
    return {
      id,
      kind: githubSource
        ? githubSource.collection === 'releases'
          ? 'api:github-releases'
          : 'api:github-tags'
        : isHackerNewsIndexUri(configured.uri)
          ? 'api:hacker-news'
          : mastodonTagTimeline(configured.uri)
            ? 'api:mastodon-tag'
            : /\.ics(?:$|\?)/i.test(configured.uri)
              ? 'ics'
              : /\.json(?:$|\?)/i.test(configured.uri)
                ? 'jsonfeed'
                : /(?:\.rss|\.atom|\.xml|\/feed|\/rss)(?:$|[/?#])/i.test(configured.uri)
                  ? /\.atom(?:$|\?)/i.test(configured.uri)
                    ? 'atom'
                    : 'rss'
                  : 'web',
      url: configured.uri,
      attribution: configured.label,
      termsRef: terms?.id ?? null,
      priority: preference.get(id) ?? 0,
      interestIds: configured.interests,
      health,
    } satisfies Source;
  });
}

function rankInputsFromState(
  state: State,
  interests: Interest[],
  sources: Source[],
  options: { interestId?: string; after?: string; limit?: number },
): BriefingRankInput[] {
  const items = state.items.filter(
    (item) =>
      (!options.interestId || item.interestIds.includes(options.interestId)) &&
      (!options.after || item.observedAt >= options.after),
  );
  const itemMap = new Map(items.map((item) => [item.id, item]));
  const stories = state.stories
    .filter((story) => story.itemIds.some((id) => itemMap.has(id)))
    .slice(0, options.limit ?? 100);
  return stories.flatMap((story) => {
    const members = story.itemIds.flatMap((id) => {
      const item = itemMap.get(id);
      const source = sources.find((record) => record.id === item?.sourceId);
      if (!item || !source) return [];
      return [
        {
          item,
          itemReference: recordRef(item, 'briefing-item', item.id).reference,
          source,
          sourceReference: recordRef(source, 'briefing-source', source.id).reference,
          interests: interests.filter((interest) => item.interestIds.includes(interest.id)),
          seen: state.seen[item.id] ??
            state.seen[story.id] ?? {
              status: 'unknown' as const,
              reason: 'not-recorded' as const,
            },
        },
      ];
    });
    if (!members.length) return [];
    const memberItemIds = new Set(members.map((member) => member.item.id));
    const events = state.events.filter(
      (event) => event.itemId !== undefined && memberItemIds.has(event.itemId),
    );
    if (events.length > 100) throw new Error('briefing_story_event_limit_exceeded');
    return [
      {
        story,
        storyReference: recordRef(story, 'briefing-story', story.id).reference,
        items: members,
        ...(events.length ? { events } : {}),
        metrics: [
          ...new Map(
            [
              ...members.flatMap((member) =>
                member.item.metrics.filter((metric) => metric.itemId === member.item.id),
              ),
              ...state.metrics.filter((metric) =>
                members.some((member) => member.item.id === metric.itemId),
              ),
            ].map((metric) => [metric.id, metric]),
          ).values(),
        ],
        feedback: state.feedback.filter(
          (feedback) =>
            feedback.targetId === story.id ||
            members.some((member) => feedback.targetId === member.item.id),
        ),
      },
    ];
  });
}

function makeApi(root: string): BriefingReadApi {
  const mutate = <T>(requestId: string, body: unknown, change: (state: State) => T | Promise<T>) =>
    withWriter(root, async () => {
      const state = await readState(root);
      const key = requestId;
      const requestDigest = hash(canonical(body));
      const prior = state.requests[key];
      if (prior) {
        if (prior.digest !== requestDigest) throw new Error('request_id_conflict');
        const result = structuredClone(prior.result);
        return (
          result && typeof result === 'object' && 'replayed' in result
            ? { ...result, replayed: true }
            : result
        ) as T;
      }
      const result = await change(state);
      state.requests[key] = { digest: requestDigest, result };
      await writeState(root, state);
      return result;
    });
  return {
    async listInterests() {
      const state = await readState(root);
      return projectedInterests(root, state);
    },
    async listSources() {
      const state = await readState(root);
      return (await projectedSources(root, state)).map((record) =>
        recordRef(record, 'briefing-source', record.id),
      );
    },
    async listItems(options = {}) {
      const state = await readState(root);
      return state.items
        .filter(
          (record) =>
            (!options.sourceId || options.sourceId === record.sourceId) &&
            (!options.interestId || record.interestIds.includes(options.interestId)) &&
            (!options.after || record.observedAt >= options.after) &&
            (!options.before || record.observedAt <= options.before),
        )
        .slice(0, options.limit ?? 100)
        .map((record) => recordRef(record, 'briefing-item', record.id));
    },
    async listStories(options = {}) {
      const state = await readState(root);
      return state.stories
        .filter(
          (record) =>
            (!options.interestId ||
              record.interestMatches.some((match) => match.interestId === options.interestId)) &&
            (!options.after || record.lastSeen >= options.after) &&
            (!options.before || record.firstSeen <= options.before),
        )
        .slice(0, options.limit ?? 100)
        .map((record) => recordRef(record, 'briefing-story', record.id));
    },
    async readStoryInspection(storyId) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(storyId))
        throw new Error('invalid_briefing_story_id');
      const state = await readState(root);
      const story = state.stories.find((record) => record.id === storyId);
      if (!story)
        return {
          status: 'missing' as const,
          story: null,
          members: [],
          qualification:
            'No exact story ID was found in this current retained owner read; this does not establish deletion or exhaustive absence.',
        };
      const [sources] = await Promise.all([projectedSources(root, state)]);
      const sourceById = new Map(sources.map((source) => [source.id, source]));
      const itemById = new Map(state.items.map((item) => [item.id, item]));
      const members = story.itemIds.map((itemId) => {
        const item = itemById.get(itemId);
        const source = item ? sourceById.get(item.sourceId) : undefined;
        return {
          itemId,
          item: item ? recordRef(item, 'briefing-item', item.id) : null,
          itemAvailability: item ? ('retained' as const) : ('unavailable' as const),
          source: source ? recordRef(source, 'briefing-source', source.id) : null,
          sourceAvailability: source
            ? ('retained' as const)
            : ('unavailable' as const),
        };
      });
      return {
        status: 'found' as const,
        story: recordRef(story, 'briefing-story', story.id),
        members,
        qualification:
          'Exact current retained story lookup; ordered member joins are bounded by the stored story schema; missing joins are unavailable, not proof of deletion.',
      };
    },
    async listEvents(options = {}) {
      const state = await readState(root);
      return state.events
        .filter(
          (record) =>
            !options.after ||
            ('startUtc' in record
              ? record.startUtc >= options.after
              : record.startDate >= options.after),
        )
        .slice(0, options.limit ?? 100)
        .map((record) => recordRef(record, 'briefing-event', record.id));
    },
    async listFeedback(options = {}) {
      const state = await readState(root);
      return state.feedback
        .filter((record) => !options.after || record.createdAt >= options.after)
        .slice(0, options.limit ?? 100);
    },
    async listRankInputs(options = {}) {
      const state = await readState(root);
      const interests = await projectedInterests(root, state);
      const sources = await projectedSources(root, state);
      return rankInputsFromState(state, interests, sources, options);
    },
    async recordFeedback(request) {
      const result = await mutate(request.requestId, request, async (state) => {
        const targetExists =
          request.targetKind === 'story'
            ? state.stories.some((story) => story.id === request.targetId)
            : request.targetKind === 'item'
              ? state.items.some((item) => item.id === request.targetId)
              : request.targetKind === 'source'
                ? (await projectedSources(root, state)).some(
                    (source) => source.id === request.targetId,
                  )
                : request.targetId.length > 0;
        if (!targetExists) throw new Error('unknown_feedback_target');
        const feedback = {
          id: request.requestId,
          requestId: request.requestId,
          targetKind: request.targetKind,
          targetId: request.targetId,
          action: request.action,
          createdAt: currentTime(),
          ...(request.until ? { until: request.until } : {}),
        } satisfies Feedback;
        if (!Value.Check(FeedbackSchema, feedback)) throw new Error('invalid_feedback');
        state.feedback.push(feedback);
        return {
          feedback,
          revision: hash(canonical(feedback)),
          replayed: false,
        } satisfies FeedbackReceipt;
      });
      return result;
    },
    async undoFeedback(request) {
      return mutate(request.requestId, request, (state) => {
        const original = state.feedback.find(
          (item) => item.id === request.feedbackId && item.action !== 'undo',
        );
        if (!original) throw new Error('unknown_feedback');
        if (
          state.feedback.some(
            (item) => item.action === 'undo' && item.undoesFeedbackId === original.id,
          )
        )
          throw new Error('feedback_already_undone');
        const feedback = {
          id: request.requestId,
          requestId: request.requestId,
          targetKind: original.targetKind,
          targetId: original.targetId,
          action: 'undo',
          createdAt: currentTime(),
          undoesFeedbackId: original.id,
        } satisfies Feedback;
        state.feedback.push(feedback);
        return {
          feedback,
          revision: hash(canonical(feedback)),
          replayed: false,
        } satisfies FeedbackReceipt;
      });
    },
    async recordMetricObservation(request) {
      return mutate(request.requestId, request, (state) => {
        if (
          !Value.Check(MetricObservationSchema, request.observation) ||
          !state.items.some((item) => item.id === request.observation.itemId)
        )
          throw new Error('invalid_metric_observation');
        const prior = state.metrics.find((item) => item.id === request.observation.id);
        if (prior && canonical(prior) !== canonical(request.observation))
          throw new Error('metric_observation_conflict');
        if (!prior) state.metrics.push(request.observation);
        return request.observation;
      });
    },
    async setInterestPreference(request) {
      return mutate(request.requestId, request, async (state) => {
        const current = (await projectedInterests(root, state)).find(
          (interest) => interest.id === request.interestId,
        );
        if (!current) throw new Error('invalid_interest_preference');
        if (
          request.expected &&
          (current.weight !== request.expected.weight ||
            current.halfLifeDays !== request.expected.halfLifeDays)
        )
          throw new Error('briefing_interest_preference_changed');
        const value = {
          id: request.interestId,
          weight: request.weight,
          halfLifeDays: request.halfLifeDays,
          updatedAt: currentTime(),
        };
        if (!Value.Check(InterestPreferenceSchema, value))
          throw new Error('invalid_interest_preference');
        const prior = state.interestPreferences.findIndex((item) => item.id === value.id);
        if (prior >= 0) state.interestPreferences[prior] = value;
        else state.interestPreferences.push(value);
        return value;
      });
    },
    async setSourcePreference(request) {
      return mutate(request.requestId, request, async (state) => {
        const value = {
          id: request.sourceId,
          priority: request.priority,
          updatedAt: currentTime(),
        };
        if (!Value.Check(SourcePreferenceSchema, value))
          throw new Error('invalid_source_preference');
        if (!(await projectedSources(root, state)).some((source) => source.id === value.id))
          throw new Error('unknown_source_preference');
        const prior = state.sourcePreferences.findIndex((item) => item.id === value.id);
        if (prior >= 0) state.sourcePreferences[prior] = value;
        else state.sourcePreferences.push(value);
        return value;
      });
    },
    async getRankingPreferences() {
      const state = await readState(root);
      return (
        state.rankingPreferences ?? {
          velocityWeight: DEFAULT_VELOCITY_WEIGHT,
          updatedAt: '1970-01-01T00:00:00.000Z',
        }
      );
    },
    async setRankingPreferences(request) {
      return mutate(request.requestId, request, (state) => {
        const value = { velocityWeight: request.velocityWeight, updatedAt: currentTime() };
        if (!Value.Check(RankingPreferencesSchema, value))
          throw new Error('invalid_ranking_preferences');
        state.rankingPreferences = value;
        return value;
      });
    },
    async setSourceTermsPolicy(request) {
      return mutate(request.requestId, request, async (state) => {
        if (!(await projectedSources(root, state)).some((source) => source.id === request.sourceId))
          throw new Error('unknown_source_terms_target');
        const value = {
          id: safeId('terms', request.sourceId),
          sourceId: request.sourceId,
          termsUrl: request.termsUrl,
          status: request.status,
          reviewedAt: request.status === 'unknown' ? null : currentTime(),
        };
        if (!Value.Check(SourceTermsPolicySchema, value))
          throw new Error('invalid_source_terms_policy');
        const prior = state.sourceTerms.findIndex((item) => item.sourceId === value.sourceId);
        if (prior >= 0) state.sourceTerms[prior] = value;
        else state.sourceTerms.push(value);
        return value;
      });
    },
    async markSeen(request) {
      return mutate(request.requestId, request, (state) => {
        const exists =
          request.targetKind === 'item'
            ? state.items.some((item) => item.id === request.targetId)
            : state.stories.some((story) => story.id === request.targetId);
        if (!exists) throw new Error('unknown_seen_target');
        const now = currentTime();
        const prior = state.seen[request.targetId];
        const seen =
          prior?.status === 'seen'
            ? {
                status: 'seen' as const,
                firstSeenAt: prior.firstSeenAt,
                lastSeenAt: now,
                observations: prior.observations + 1,
              }
            : { status: 'seen' as const, firstSeenAt: now, lastSeenAt: now, observations: 1 };
        state.seen[request.targetId] = seen;
        return seen;
      });
    },
  };
}

export function createBriefingApi(root: string) {
  return makeApi(root);
}

export async function listSourceTerms(root: string) {
  return (await readState(root)).sourceTerms;
}

/** Exact serialized bytes for the small Briefing record kinds exposed to local owners. */
export async function briefingRecordBytes(
  root: string,
  kind: 'briefing-item' | 'briefing-source',
  id: string,
) {
  const state = await readState(root);
  const record =
    kind === 'briefing-item'
      ? state.items.find((item) => item.id === id)
      : (await projectedSources(root, state)).find((source) => source.id === id);
  if (!record) {
    const error = new Error('briefing_record_not_found');
    Object.assign(error, { status: 404, code: 'briefing_record_not_found' });
    throw error;
  }
  return Buffer.from(canonical(record));
}

export type BriefingCaptureContext = {
  itemReference: BriefingRecordReference;
  itemContentDigest: string;
  sourceReference: BriefingRecordReference;
  sourceHealth: Source['health'];
  termsPolicy: SourceTermsPolicy | null;
  observedAt: string;
};

/** Resolves a selected Briefing item and its current linked source/policy without fetching it. */
export async function readBriefingCaptureContext(
  root: string,
  itemReference: unknown,
): Promise<BriefingCaptureContext> {
  if (
    !Value.Check(BriefingRecordReferenceSchema, itemReference) ||
    itemReference.kind !== 'briefing-item'
  )
    throw new Error('invalid_briefing_item_reference');
  const state = await readState(root);
  const item = state.items.find((candidate) => candidate.id === itemReference.id);
  if (!item) {
    const error = new Error('briefing_item_missing');
    Object.assign(error, { status: 404, code: 'briefing_item_missing' });
    throw error;
  }
  const currentItemReference = recordRef(item, 'briefing-item', item.id).reference;
  if (canonical(currentItemReference) !== canonical(itemReference)) {
    const error = new Error('briefing_item_changed');
    Object.assign(error, { status: 409, code: 'briefing_item_changed' });
    throw error;
  }
  const source = (await projectedSources(root, state)).find(
    (candidate) => candidate.id === item.sourceId,
  );
  if (!source) {
    const error = new Error('briefing_source_missing');
    Object.assign(error, { status: 404, code: 'briefing_source_missing' });
    throw error;
  }
  return {
    itemReference: currentItemReference,
    itemContentDigest: item.contentDigest,
    sourceReference: recordRef(source, 'briefing-source', source.id).reference,
    sourceHealth: source.health,
    termsPolicy: state.sourceTerms.find((policy) => policy.sourceId === source.id) ?? null,
    observedAt: currentTime(),
  };
}

export async function listBriefingPreferences(root: string) {
  const state = await readState(root);
  return {
    ranking: state.rankingPreferences ?? {
      velocityWeight: DEFAULT_VELOCITY_WEIGHT,
      updatedAt: '1970-01-01T00:00:00.000Z',
    },
    interests: state.interestPreferences,
    sources: state.sourcePreferences,
  };
}

/** One retained owner snapshot for comparing a current and draft Interest rank. */
export async function readBriefingInterestPreviewSnapshot(root: string, interestId: string) {
  const state = await readState(root);
  const settings = await loadSettings(root);
  const [interests, sources] = await Promise.all([
    projectedInterests(root, state, settings),
    projectedSources(root, state, settings),
  ]);
  const interest = interests.find((entry) => entry.id === interestId);
  if (!interest) throw new Error('unknown_briefing_interest');
  return {
    interest: {
      interestId: interest.id,
      weight: interest.weight,
      halfLifeDays: interest.halfLifeDays,
    },
    rankInputs: rankInputsFromState(state, interests, sources, { limit: 512 }),
    ranking: state.rankingPreferences ?? {
      velocityWeight: DEFAULT_VELOCITY_WEIGHT,
      updatedAt: '1970-01-01T00:00:00.000Z',
    },
  };
}

function briefingRefreshInputDigest(interest?: string) {
  return hash(
    canonical({ operation: 'briefing.refreshDue', once: true, interest: interest ?? null }),
  );
}

/** Claims one explicit refresh in the existing Briefing request ledger before any acquisition. */
export async function beginBriefingRefresh(
  root: string,
  requestId: string,
  interest?: string,
): Promise<{ claimed: boolean; replayed: boolean; receipt: BriefingRefreshReceipt }> {
  if (!Value.Check(Type.String({ format: 'uuid' }), requestId))
    throw new Error('invalid_briefing_refresh_request_id');
  const inputDigest = briefingRefreshInputDigest(interest);
  return withWriter(root, async () => {
    const state = await readState(root);
    const prior = state.requests[requestId];
    if (prior) {
      if (prior.digest !== inputDigest) throw new Error('request_id_conflict');
      const receipt = refreshReceipt(prior.result);
      if (!receipt || receipt.requestId !== requestId || receipt.inputDigest !== inputDigest)
        throw new Error('request_id_conflict');
      return { claimed: false, replayed: true, receipt: structuredClone(receipt) };
    }
    const receipt: BriefingRefreshReceipt = {
      schema: 'signals.briefing-refresh-receipt.v1',
      requestId,
      inputDigest,
      status: 'pending',
      startedAt: currentTime(),
      completedAt: null,
      result: null,
    };
    state.requests[requestId] = { digest: inputDigest, result: receipt };
    await writeState(root, state);
    return { claimed: true, replayed: false, receipt };
  });
}

/** Completes only a receipt previously claimed with this exact request identity and input. */
export async function completeBriefingRefresh(
  root: string,
  requestId: string,
  inputDigest: string,
  result: BriefingRefreshSummary,
): Promise<BriefingRefreshReceipt> {
  if (!Value.Check(refreshSummarySchema, result))
    throw new Error('invalid_briefing_refresh_result');
  return withWriter(root, async () => {
    const state = await readState(root);
    const prior = state.requests[requestId];
    if (!prior || prior.digest !== inputDigest) throw new Error('briefing_refresh_claim_missing');
    const current = refreshReceipt(prior.result);
    if (!current || current.inputDigest !== inputDigest)
      throw new Error('briefing_refresh_claim_missing');
    if (current.status === 'complete') return structuredClone(current);
    const receipt: BriefingRefreshReceipt = {
      ...current,
      status: 'complete',
      completedAt: currentTime(),
      result: structuredClone(result),
    };
    state.requests[requestId] = { digest: inputDigest, result: receipt };
    await writeState(root, state);
    return receipt;
  });
}

/** Cold readback for one request ID. Other native operations sharing the request ledger stay hidden. */
export async function readBriefingRefresh(root: string, requestId: string) {
  if (!Value.Check(Type.String({ format: 'uuid' }), requestId))
    throw new Error('invalid_briefing_refresh_request_id');
  const state = await readState(root);
  const value = state.requests[requestId]?.result;
  const receipt = refreshReceipt(value);
  return receipt && receipt.requestId === requestId
    ? { found: true as const, receipt: structuredClone(receipt) }
    : { found: false as const, requestId };
}

/** Cold readback for a preference-write request; other request ledger entries stay hidden. */
export async function readBriefingInterestPreference(
  root: string,
  requestId: string,
): Promise<InterestPreferenceStatus> {
  if (!Value.Check(Type.String({ format: 'uuid' }), requestId))
    throw new Error('invalid_briefing_interest_status_request_id');
  const state = await readState(root);
  const saved = state.requests[requestId]?.result;
  if (!Value.Check(InterestPreferenceSchema, saved))
    return {
      status: 'not-found',
      requestId,
      qualification:
        'No exact InterestPreference result was found; this does not prove the request did not execute.',
    };
  const preference = structuredClone(saved);
  const projected = (await projectedInterests(root, state)).find(
    (interest) => interest.id === preference.id,
  );
  const currentPreference: InterestTuningValue | null = projected
    ? {
        interestId: projected.id,
        weight: projected.weight,
        halfLifeDays: projected.halfLifeDays,
      }
    : null;
  return {
    status: 'found',
    requestId,
    preference,
    currentPreference,
    currentMatches:
      currentPreference !== null &&
      currentPreference.weight === preference.weight &&
      currentPreference.halfLifeDays === preference.halfLifeDays,
  };
}

export async function retainBriefingRecords(
  root: string,
  input: { items?: Item[]; stories?: Story[]; events?: Event[] },
) {
  await withWriter(root, async () => {
    const state = await readState(root);
    const append = (records: unknown[], schema: TSchema, collection: unknown[]) => {
      for (const record of records) {
        if (!Value.Check(schema, record)) throw new Error('invalid_briefing_record');
        const candidate = record as { id: string };
        const prior = collection.findIndex((item) => (item as { id: string }).id === candidate.id);
        if (prior < 0) collection.push(record);
        else if (
          schema === ItemSchema &&
          (collection[prior] as Item).canonicalUrl === (record as Item).canonicalUrl &&
          (collection[prior] as Item).contentDigest === (record as Item).contentDigest
        )
          continue;
        else if (
          schema === StorySchema &&
          canonical((collection[prior] as Story).itemIds) === canonical((record as Story).itemIds)
        )
          continue;
        else if (canonical(collection[prior]) !== canonical(record))
          throw new Error('briefing_record_conflict');
      }
    };
    append(input.items ?? [], ItemSchema, state.items);
    append(input.stories ?? [], StorySchema, state.stories);
    append(input.events ?? [], EventSchema, state.events);
    await writeState(root, state);
  });
}
