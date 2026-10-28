import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { isStoryHidden } from '../briefing-feedback.js';
import { rankBriefingStory } from '../briefing-rank.js';
import { eventCalendar } from '../briefing-calendar.js';
import {
  importBriefingOpml,
  previewBriefingOpml,
  readBriefingOpmlImport,
  refreshBriefing,
} from './ingest.js';
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
const opmlPreviewRequest = Type.Object({ opml: Type.String({ maxLength: 1000000 }) }, closed);
const opmlImportRequest = Type.Object(
  {
    opml: Type.String({ maxLength: 1000000 }),
    requestId: uuid,
    inputDigest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    settingsDigest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    previewDigest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
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
const rankingPreviewRequest = Type.Object(
  { velocityWeight: Type.Number({ minimum: 0, maximum: 0.25 }) },
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
  query?: URLSearchParams,
) {
  const api = createBriefingApi(root);
  if (!mutation && route === 'briefing/events/calendar') {
    const entries = [...(query ?? new URLSearchParams()).entries()];
    if (
      queryCount !== 1 ||
      entries.length !== 1 ||
      entries[0]![0] !== 'eventId' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(entries[0]![1])
    )
      throw new Error('invalid_briefing_event_calendar_query');
    const [events, items] = await Promise.all([
      api.listEvents(),
      api.listItems(),
    ]);
    const retained = events.find((entry) => entry.record.id === entries[0]![1]);
    if (!retained) throw new Error('unknown_briefing_event');
    const item = retained.record.itemId
      ? items.find((entry) => entry.record.id === retained.record.itemId)
      : undefined;
    const title = item?.record.title ?? 'Briefing event';
    const ics = eventCalendar(retained.record, title);
    if (ics.length > 16_384) throw new Error('briefing_event_calendar_too_large');
    return {
      status: 200,
      body: {
        schema: 'signals.briefing-event-calendar.v1',
        reference: retained.reference,
        title,
        filename: `briefing-event-${retained.record.id}.ics`,
        ics,
      },
    };
  }
  if (!mutation && route === 'briefing/opml/import-status') {
    const entries = [...(query ?? new URLSearchParams()).entries()];
    if (queryCount !== 1 || entries.length !== 1 || entries[0]![0] !== 'requestId')
      throw new Error('invalid_briefing_opml_import_status_query');
    return { status: 200, body: await readBriefingOpmlImport(root, entries[0]![1]) };
  }
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
      case 'briefing/workbench': {
        const [inputs, events, sources, interests, feedback, sourceTerms, preferences] =
          await Promise.all([
            api.listRankInputs(),
            api.listEvents(),
            api.listSources(),
            api.listInterests(),
            api.listFeedback(),
            listSourceTerms(root),
            listBriefingPreferences(root),
          ]);
        const now = Date.now();
        const ranked = (
          await Promise.all(
            inputs.map(async (input) => {
              const representative = input.items.find(
                ({ item }) => item.id === input.story.representativeItemId,
              );
              if (!representative || isStoryHidden(feedback, input.story, representative.item, now))
                return null;
              return {
                input,
                explanation: await rankBriefingStory(input, {
                  now,
                  velocityWeight: preferences.ranking.velocityWeight,
                }),
              };
            }),
          )
        )
          .filter((entry) => entry !== null)
          .sort((left, right) => {
            const leftObserved = left.input.items.find(
              ({ item }) => item.id === left.input.story.representativeItemId,
            )?.item.observedAt;
            const rightObserved = right.input.items.find(
              ({ item }) => item.id === right.input.story.representativeItemId,
            )?.item.observedAt;
            return (
              right.explanation.total - left.explanation.total ||
              (rightObserved ?? '').localeCompare(leftObserved ?? '')
            );
          });
        return {
          status: 200,
          body: {
            schema: 'signals.briefing-workbench.v1',
            readAt: new Date(now).toISOString(),
            ranked,
            events,
            sources,
            interests,
            sourceTerms,
            preferences,
          },
        };
      }
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
    case 'briefing/preferences/ranking-preview': {
      if (!Value.Check(rankingPreviewRequest, body))
        throw new Error('invalid_briefing_ranking_preview');
      const [inputs, feedback, preferences] = await Promise.all([
        api.listRankInputs(),
        api.listFeedback(),
        listBriefingPreferences(root),
      ]);
      const now = Date.now();
      const rank = async (velocityWeight: number) =>
        (
          await Promise.all(
            inputs.map(async (input) => {
              const representative = input.items.find(
                ({ item }) => item.id === input.story.representativeItemId,
              );
              if (!representative || isStoryHidden(feedback, input.story, representative.item, now))
                return null;
              return {
                input,
                explanation: await rankBriefingStory(input, { now, velocityWeight }),
              };
            }),
          )
        )
          .filter((entry) => entry !== null)
          .sort((left, right) => {
            const leftObserved = left.input.items.find(
              ({ item }) => item.id === left.input.story.representativeItemId,
            )?.item.observedAt;
            const rightObserved = right.input.items.find(
              ({ item }) => item.id === right.input.story.representativeItemId,
            )?.item.observedAt;
            return (
              right.explanation.total - left.explanation.total ||
              (rightObserved ?? '').localeCompare(leftObserved ?? '')
            );
          });
      const currentWeight = preferences.ranking.velocityWeight;
      const draftWeight = body.velocityWeight;
      const [current, draft] = await Promise.all([rank(currentWeight), rank(draftWeight)]);
      const currentById = new Map(
        current.map((entry, index) => [entry.input.story.id, { entry, position: index + 1 }]),
      );
      const stories = draft.map(({ input, explanation }, index) => {
        const currentEntry = currentById.get(input.story.id);
        const representative = input.items.find(
          ({ item }) => item.id === input.story.representativeItemId,
        );
        if (!currentEntry || !representative)
          throw new Error('briefing_ranking_preview_input_changed');
        return {
          storyId: input.story.id,
          story: input.story,
          storyTitle: representative.item.title,
          storyReference: input.storyReference,
          currentPosition: currentEntry.position,
          draftPosition: index + 1,
          currentScore: currentEntry.entry.explanation.total,
          draftScore: explanation.total,
        };
      });
      return {
        status: 200,
        body: {
          schema: 'signals.briefing-ranking-preview.v1',
          readAt: new Date(now).toISOString(),
          currentVelocityWeight: currentWeight,
          draftVelocityWeight: draftWeight,
          stories,
        },
      };
    }
    case 'briefing/refresh':
      if (!Value.Check(refreshRequest, body)) throw new Error('invalid_briefing_refresh');
      return { status: 200, body: await refreshBriefing(root, { interest: body.interest }) };
    case 'briefing/opml/preview':
      if (!Value.Check(opmlPreviewRequest, body)) throw new Error('invalid_briefing_opml_preview');
      return { status: 200, body: await previewBriefingOpml(root, body.opml) };
    case 'briefing/opml/import':
      if (!Value.Check(opmlImportRequest, body)) throw new Error('invalid_briefing_opml_import');
      return {
        status: 200,
        body: await importBriefingOpml(root, body.opml, body.requestId, {
          inputDigest: body.inputDigest,
          settingsDigest: body.settingsDigest,
          previewDigest: body.previewDigest,
        }),
      };
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
