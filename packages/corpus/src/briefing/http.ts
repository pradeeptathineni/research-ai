import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { refreshBriefing } from './ingest.js';
import { createBriefingApi, listBriefingPreferences, listSourceTerms } from './store.js';

const uuid = Type.String({ format: 'uuid' });
const closed = { additionalProperties: false } as const;
const feedbackRequest = Type.Object(
  {
    requestId: uuid,
    targetKind: Type.Enum(['story', 'source', 'term', 'item']),
    targetId: Type.String({ minLength: 1, maxLength: 2000 }),
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
    until: Type.Optional(Type.String({ format: 'date-time', maxLength: 40 })),
  },
  closed,
);
const refreshRequest = Type.Object(
  {
    once: Type.Literal(true),
    interest: Type.Optional(Type.String({ pattern: '^[a-z0-9-]{1,80}$' })),
  },
  closed,
);
const undoRequest = Type.Object({ requestId: uuid, feedbackId: uuid }, closed);
const seenRequest = Type.Object(
  {
    requestId: uuid,
    targetKind: Type.Enum(['item', 'story']),
    targetId: Type.String({ minLength: 1, maxLength: 200 }),
  },
  closed,
);
const metricRequest = Type.Object(
  {
    requestId: uuid,
    observation: Type.Object(
      {
        id: Type.String({ minLength: 1, maxLength: 160 }),
        itemId: Type.String({ minLength: 1, maxLength: 160 }),
        platform: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,79}$' }),
        name: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,79}$' }),
        value: Type.Number({ minimum: 0 }),
        observedAt: Type.String({ format: 'date-time', maxLength: 40 }),
        scope: Type.String({ minLength: 1, maxLength: 200 }),
        method: Type.Enum(['public-adapter', 'feed', 'caller-reported']),
        sourceRef: Type.Union([Type.String({ maxLength: 2048 }), Type.Null()]),
      },
      closed,
    ),
  },
  closed,
);
const interestPreferenceRequest = Type.Object(
  {
    requestId: uuid,
    interestId: Type.String({ pattern: '^[a-z0-9-]{1,80}$' }),
    weight: Type.Number({ minimum: 0, maximum: 1 }),
    halfLifeDays: Type.Number({ exclusiveMinimum: 0 }),
  },
  closed,
);
const sourcePreferenceRequest = Type.Object(
  {
    requestId: uuid,
    sourceId: Type.String({ minLength: 1, maxLength: 160 }),
    priority: Type.Number({ minimum: -100, maximum: 100 }),
  },
  closed,
);
const rankingPreferenceRequest = Type.Object(
  { requestId: uuid, velocityWeight: Type.Number({ minimum: 0, maximum: 0.25 }) },
  closed,
);
const termsRequest = Type.Object(
  {
    requestId: uuid,
    sourceId: Type.String({ minLength: 1, maxLength: 160 }),
    termsUrl: Type.Union([Type.String({ maxLength: 2048 }), Type.Null()]),
    status: Type.Enum(['unknown', 'recorded', 'blocked']),
  },
  closed,
);

/** Narrow route table over the same Signals state, writer, and established fetcher. */
export async function briefingRoute(
  root: string,
  route: string,
  mutation: boolean,
  body: unknown,
  queryCount: number,
) {
  const api = createBriefingApi(root);
  if (queryCount !== 0) throw new Error('briefing_query_not_supported');
  if (!mutation) {
    switch (route) {
      case 'briefing/interests':
        return { status: 200, body: { interests: await api.listInterests() } };
      case 'briefing/sources':
        return { status: 200, body: { sources: await api.listSources() } };
      case 'briefing/items':
        return { status: 200, body: { items: await api.listItems() } };
      case 'briefing/stories':
        return { status: 200, body: { stories: await api.listStories() } };
      case 'briefing/events':
        return { status: 200, body: { events: await api.listEvents() } };
      case 'briefing/rank-inputs':
        return { status: 200, body: { inputs: await api.listRankInputs() } };
      case 'briefing/feedback':
        return { status: 200, body: { feedback: await api.listFeedback() } };
      case 'briefing/preferences':
        return { status: 200, body: await listBriefingPreferences(root) };
      case 'briefing/source-terms':
        return { status: 200, body: { policies: await listSourceTerms(root) } };
      default:
        return null;
    }
  }
  switch (route) {
    case 'briefing/refresh':
      if (!Value.Check(refreshRequest, body)) throw new Error('invalid_briefing_refresh');
      return { status: 200, body: await refreshBriefing(root, { interest: body.interest }) };
    case 'briefing/feedback':
      if (!Value.Check(feedbackRequest, body)) throw new Error('invalid_briefing_feedback');
      return { status: 201, body: await api.recordFeedback(body) };
    case 'briefing/feedback/undo':
      if (!Value.Check(undoRequest, body)) throw new Error('invalid_briefing_feedback_undo');
      return { status: 201, body: await api.undoFeedback(body) };
    case 'briefing/seen':
      if (!Value.Check(seenRequest, body)) throw new Error('invalid_briefing_seen');
      return { status: 200, body: await api.markSeen(body) };
    case 'briefing/metric-observations':
      if (!Value.Check(metricRequest, body)) throw new Error('invalid_briefing_metric');
      return { status: 201, body: await api.recordMetricObservation(body) };
    case 'briefing/preferences/interest':
      if (!Value.Check(interestPreferenceRequest, body))
        throw new Error('invalid_briefing_interest_preference');
      return { status: 200, body: await api.setInterestPreference(body) };
    case 'briefing/preferences/source':
      if (!Value.Check(sourcePreferenceRequest, body))
        throw new Error('invalid_briefing_source_preference');
      return { status: 200, body: await api.setSourcePreference(body) };
    case 'briefing/preferences/ranking':
      if (!Value.Check(rankingPreferenceRequest, body))
        throw new Error('invalid_briefing_ranking_preference');
      return { status: 200, body: await api.setRankingPreferences(body) };
    case 'briefing/source-terms':
      if (!Value.Check(termsRequest, body)) throw new Error('invalid_briefing_source_terms');
      return { status: 200, body: await api.setSourceTermsPolicy(body) };
    default:
      return null;
  }
}
