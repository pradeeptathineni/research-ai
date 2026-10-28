import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Type, type TSchema } from 'typebox';
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
  type Event,
  type Feedback,
  type FeedbackReceipt,
  type Interest,
  type InterestPreference,
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

async function projectedInterests(root: string, state: State): Promise<Interest[]> {
  const settings = await loadSettings(root);
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

async function projectedSources(root: string, state: State): Promise<Source[]> {
  const [settings, saved, interests] = await Promise.all([
    loadSettings(root),
    readPrivateJson(root, 'source-state.json', {}, 2000000),
    projectedInterests(root, state),
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
    return {
      id,
      kind: /\.ics(?:$|\?)/i.test(configured.uri)
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
        return [
          {
            story,
            storyReference: recordRef(story, 'briefing-story', story.id).reference,
            items: members,
            metrics: [
              ...new Map(
                [
                  ...members.flatMap((member) => member.item.metrics),
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
        const value = {
          id: request.interestId,
          weight: request.weight,
          halfLifeDays: request.halfLifeDays,
          updatedAt: currentTime(),
        };
        if (
          !Value.Check(InterestPreferenceSchema, value) ||
          !(await projectedInterests(root, state)).some((interest) => interest.id === value.id)
        )
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
