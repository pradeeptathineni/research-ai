import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type {
  BriefingRankInput,
  BriefingRecord,
  BriefingRecordReference,
  Event,
  Feedback,
  FeedbackReceipt,
  FeedbackRequest,
  Interest,
  InterestPreference,
  Item,
  MetricObservation,
  RankingExplanation,
  RankingPreferences,
  Source,
  SourcePreference,
  Story,
} from '../../../../packages/corpus/src/briefing/schema.js';
import { rankBriefingStory } from '../../../../packages/corpus/src/briefing-rank.js';
import { eventCalendar } from '../../../../packages/corpus/src/briefing-calendar.js';
import { isStoryHidden } from '../../../../packages/corpus/src/briefing-feedback.js';
import './briefing-page.css';

type Api = <T>(route: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
type Envelope<K extends string, T> = { [P in K]: T };
type Snapshot = {
  status: 'loading' | 'ready' | 'unavailable';
  reason?: string;
  interests: Interest[];
  sources: Array<BriefingRecord<Source, 'briefing-source'>>;
  items: Array<BriefingRecord<Item, 'briefing-item'>>;
  stories: Array<BriefingRecord<Story, 'briefing-story'>>;
  events: Array<BriefingRecord<Event, 'briefing-event'>>;
  inputs: BriefingRankInput[];
  metrics: MetricObservation[];
  feedback: Feedback[];
  explanations: Record<string, RankingExplanation>;
  ranking: RankingPreferences;
  interestPreferences: InterestPreference[];
  sourcePreferences: SourcePreference[];
};
type FollowThroughIntent = {
  action:
    | 'investigate'
    | 'check-claim'
    | 'discuss'
    | 'plan'
    | 'watch'
    | 'assess-reuse'
    | 'save'
    | 'remind';
  reference: BriefingRecordReference;
  storyReference?: BriefingRecordReference;
  itemReference?: BriefingRecordReference;
  sourceReferences: BriefingRecordReference[];
  title: string;
  url?: string;
};
type Props = { api?: Api; onFollowThrough?: (intent: FollowThroughIntent) => boolean };
type Row = {
  story: Story;
  item: Item;
  source?: Source;
  reference: BriefingRecordReference;
  storyReference: BriefingRecordReference;
  sourceReferences: BriefingRecordReference[];
  explanation?: RankingExplanation;
};

const scopes = ['Now', 'Today', 'Week', 'Events'] as const;
type Scope = (typeof scopes)[number];
const observationTime = (value: string, timeZone: string) => {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return `Time unavailable · ${value}`;
  }
};
const dateTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
function inScope(value: string, scope: Scope, now: number, timeZone: string) {
  const observed = Date.parse(value);
  if (!Number.isFinite(observed)) return false;
  if (scope === 'Now') return observed >= now - DAY && observed <= now;
  if (scope === 'Week') return observed >= now - 7 * DAY && observed <= now;
  if (scope === 'Today') {
    const day = (stamp: number) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(stamp);
    return day(observed) === day(now);
  }
  return false;
}
const DAY = 86_400_000;
function downloadEvent(event: Event, title: string) {
  const url = URL.createObjectURL(
    new Blob([eventCalendar(event, title)], { type: 'text/calendar;charset=utf-8' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${event.id}.ics`;
  anchor.click();
  URL.revokeObjectURL(url);
}
function metricsForItem(metrics: MetricObservation[], itemId: string) {
  const groups = new Map<string, MetricObservation[]>();
  for (const row of metrics.filter((entry) => entry.itemId === itemId)) {
    const key = `${row.platform}:${row.name}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map((rows) => {
    const sorted = [...rows].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    const last = sorted.at(-1)!;
    const first = sorted.at(-2);
    const elapsed = first
      ? (Date.parse(last.observedAt) - Date.parse(first.observedAt)) / 3_600_000
      : 0;
    return {
      last,
      first,
      elapsed,
      delta: first ? last.value - first.value : 0,
      count: sorted.length,
    };
  });
}

export default function BriefingPage({ api, onFollowThrough }: Props) {
  const [scope, setScope] = useState<Scope>('Now');
  const [interestId, setInterestId] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [tuning, setTuning] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [velocityWeight, setVelocityWeight] = useState(0.05);
  const [interestDraft, setInterestDraft] = useState<
    Record<string, { weight: number; halfLifeDays: number }>
  >({});
  const [sourceDraft, setSourceDraft] = useState<Record<string, number>>({});
  const [undoable, setUndoable] = useState<Feedback>();
  const pending = useRef(new Map<string, Record<string, unknown>>());
  const requestFor = (key: string, fields: Record<string, unknown>) => {
    const request = pending.current.get(key) ?? { requestId: crypto.randomUUID(), ...fields };
    pending.current.set(key, request);
    return request;
  };

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!api) return;
      setSnapshot((current) => (current ? { ...current, status: 'loading' } : undefined));
      try {
        const [i, s, items, stories, events, inputs, feedback, preferences] = await Promise.all([
          api<Envelope<'interests', Interest[]>>('briefing/interests', undefined, signal),
          api<Envelope<'sources', Snapshot['sources']>>('briefing/sources', undefined, signal),
          api<Envelope<'items', Snapshot['items']>>('briefing/items', undefined, signal),
          api<Envelope<'stories', Snapshot['stories']>>('briefing/stories', undefined, signal),
          api<Envelope<'events', Snapshot['events']>>('briefing/events', undefined, signal),
          api<Envelope<'inputs', BriefingRankInput[]>>('briefing/rank-inputs', undefined, signal),
          api<Envelope<'feedback', Feedback[]>>('briefing/feedback', undefined, signal),
          api<{
            ranking: RankingPreferences;
            interests: InterestPreference[];
            sources: SourcePreference[];
          }>('briefing/preferences', undefined, signal),
        ]);
        const velocity = preferences.ranking.velocityWeight;
        const explanations = Object.fromEntries(
          await Promise.all(
            inputs.inputs.map(
              async (input) =>
                [
                  input.story.id,
                  await rankBriefingStory(input, { velocityWeight: velocity }),
                ] as const,
            ),
          ),
        );
        setVelocityWeight(velocity);
        setSnapshot({
          status: 'ready',
          interests: i.interests,
          sources: s.sources,
          items: items.items,
          stories: stories.stories,
          events: events.events,
          inputs: inputs.inputs,
          metrics: inputs.inputs.flatMap((input) => input.metrics),
          feedback: feedback.feedback,
          explanations,
          ranking: preferences.ranking,
          interestPreferences: preferences.interests,
          sourcePreferences: preferences.sources,
        });
        setError('');
      } catch (cause) {
        if (signal?.aborted) return;
        setSnapshot((current) => ({
          status: 'unavailable',
          reason: cause instanceof Error ? cause.message : 'Briefing owner could not be read.',
          interests: current?.interests ?? [],
          sources: current?.sources ?? [],
          items: current?.items ?? [],
          stories: current?.stories ?? [],
          events: current?.events ?? [],
          inputs: current?.inputs ?? [],
          metrics: current?.metrics ?? [],
          feedback: current?.feedback ?? [],
          explanations: current?.explanations ?? {},
          ranking: current?.ranking ?? {
            velocityWeight: 0.05,
            updatedAt: new Date().toISOString(),
          },
          interestPreferences: current?.interestPreferences ?? [],
          sourcePreferences: current?.sourcePreferences ?? [],
        }));
      }
    },
    [api],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const rows = useMemo<Row[]>(() => {
    if (!snapshot) return [];
    const now = Date.now();
    const items = new Map(
      snapshot.items.map(({ record, reference }) => [record.id, { record, reference }]),
    );
    const sources = new Map(
      snapshot.sources.map(({ record, reference }) => [record.id, { record, reference }]),
    );
    return snapshot.stories
      .flatMap(({ record: story, reference }) => {
        const itemRef = items.get(story.representativeItemId);
        if (!itemRef) return [];
        const item = itemRef.record;
        if (interestId && !story.interestMatches.some((match) => match.interestId === interestId))
          return [];
        if (
          !inScope(item.observedAt, scope, now, dateTimeZone()) ||
          isStoryHidden(snapshot.feedback, story, item, now)
        )
          return [];
        const sourceReferences = [
          ...new Set(
            story.itemIds.flatMap((id) => {
              const related = items.get(id);
              const sourceReference = related
                ? sources.get(related.record.sourceId)?.reference
                : undefined;
              return sourceReference ? [sourceReference] : [];
            }),
          ),
        ];
        return [
          {
            story,
            item,
            source: sources.get(item.sourceId)?.record,
            reference: itemRef.reference,
            storyReference: reference,
            sourceReferences,
            explanation: snapshot.explanations[story.id],
          },
        ];
      })
      .sort(
        (a, b) =>
          (b.explanation?.total ?? -1) - (a.explanation?.total ?? -1) ||
          b.item.observedAt.localeCompare(a.item.observedAt),
      );
  }, [snapshot, interestId, scope]);
  const selected = rows.find((row) => row.story.id === selectedId) ?? rows[0];
  const activeMutes =
    snapshot?.feedback.filter(
      (entry) =>
        (entry.action === 'mute-source' || entry.action === 'mute-term') &&
        !snapshot.feedback.some(
          (undo) => undo.action === 'undo' && undo.undoesFeedbackId === entry.id,
        ),
    ).length ?? 0;

  async function write<T>(route: string, body: unknown): Promise<T> {
    if (!api) throw new Error('Briefing owner is not connected.');
    setBusy(true);
    setError('');
    try {
      const response = await api<T>(route, body);
      await load();
      return response;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Briefing update was not confirmed.';
      setError(message);
      throw cause;
    } finally {
      setBusy(false);
    }
  }
  async function feedback(
    targetKind: FeedbackRequest['targetKind'],
    targetId: string,
    action: FeedbackRequest['action'],
    until?: string,
  ) {
    try {
      const key = `feedback:${targetKind}:${targetId}:${action}:${until ?? ''}`;
      const receipt = await write<FeedbackReceipt>(
        'briefing/feedback',
        requestFor(key, { targetKind, targetId, action, ...(until ? { until } : {}) }),
      );
      pending.current.delete(key);
      setUndoable(receipt.feedback);
      setNotice('Saved · Undo');
    } catch {
      /* The error is visible and the owner remains authoritative. */
    }
  }
  async function undo() {
    if (!undoable) return;
    try {
      const key = `undo:${undoable.id}`;
      await write<FeedbackReceipt>(
        'briefing/feedback/undo',
        requestFor(key, { feedbackId: undoable.id }),
      );
      pending.current.delete(key);
      setUndoable(undefined);
      setNotice('Change undone.');
    } catch {
      /* The error is visible and the exact owner receipt can be retried from the view. */
    }
  }
  async function refresh() {
    try {
      await write('briefing/refresh', { once: true });
      setNotice('One refresh pass completed.');
    } catch {
      /* The error is visible. */
    }
  }
  async function saveInterest(interest: Interest) {
    const pref = snapshot?.interestPreferences.find((entry) => entry.id === interest.id);
    const draft = interestDraft[interest.id] ?? {
      weight: pref?.weight ?? interest.weight,
      halfLifeDays: pref?.halfLifeDays ?? 0.75,
    };
    try {
      const key = `interest:${interest.id}:${draft.weight}:${draft.halfLifeDays}`;
      await write(
        'briefing/preferences/interest',
        requestFor(key, { interestId: interest.id, ...draft }),
      );
      pending.current.delete(key);
      setNotice('Interest tuning saved for the next ranking pass.');
    } catch {
      /* The error is visible. */
    }
  }
  async function saveSource(source: Source) {
    const priority =
      sourceDraft[source.id] ??
      snapshot?.sourcePreferences.find((entry) => entry.id === source.id)?.priority ??
      source.priority;
    try {
      const key = `source:${source.id}:${priority}`;
      await write(
        'briefing/preferences/source',
        requestFor(key, { sourceId: source.id, priority }),
      );
      pending.current.delete(key);
      setNotice('Source priority saved for the next ranking pass.');
    } catch {
      /* The error is visible. */
    }
  }
  async function saveVelocity() {
    try {
      const key = `ranking:velocity:${velocityWeight}`;
      await write('briefing/preferences/ranking', requestFor(key, { velocityWeight }));
      pending.current.delete(key);
      setNotice('Velocity weight saved for the next ranking pass.');
    } catch {
      /* The error is visible. */
    }
  }

  function sendFollowThrough(row: Row, action: FollowThroughIntent['action']) {
    const handled = onFollowThrough?.({
      action,
      reference: row.reference,
      storyReference: row.storyReference,
      itemReference: row.reference,
      sourceReferences: row.sourceReferences,
      title: row.item.title,
      url: row.item.canonicalUrl,
    });
    if (!handled) setNotice(`${action} is not connected to an existing capability in this view.`);
  }

  function sendEventFollowThrough(event: Event, reference: BriefingRecordReference, title: string) {
    const item = event.itemId
      ? snapshot?.items.find((candidate) => candidate.record.id === event.itemId)
      : undefined;
    const source = item
      ? snapshot?.sources.find((candidate) => candidate.record.id === item.record.sourceId)
      : undefined;
    const handled = onFollowThrough?.({
      action: 'remind',
      reference,
      itemReference: item?.reference,
      sourceReferences: source ? [source.reference] : [],
      title,
      url: event.url ?? item?.record.canonicalUrl,
    });
    if (!handled) setNotice('remind is not connected to an existing capability in this view.');
  }

  function onKeys(event: KeyboardEvent<HTMLElement>) {
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLSelectElement ||
      event.target instanceof HTMLTextAreaElement
    )
      return;
    const key = event.key.toLowerCase();
    if (!['j', 'k', 'o', 'i', 'd', 's', 'm'].includes(key)) return;
    event.preventDefault();
    const index = rows.findIndex((row) => row.story.id === selected?.story.id);
    if (key === 'j' || key === 'k') {
      const next = Math.max(0, Math.min(rows.length - 1, index + (key === 'j' ? 1 : -1)));
      setSelectedId(rows[next]?.story.id ?? '');
      return;
    }
    if (!selected) return;
    if (key === 'o') {
      setSelectedId(selected.story.id);
      document.querySelector<HTMLElement>('.briefing-page__inspector h2')?.focus();
      return;
    }
    if (key === 'm') void feedback('source', selected.item.sourceId, 'mute-source');
    else if (key === 's') sendFollowThrough(selected, 'save');
    else if (key === 'i') sendFollowThrough(selected, 'investigate');
    else if (key === 'd') sendFollowThrough(selected, 'discuss');
  }

  const timeZone = dateTimeZone();
  return (
    <main className="briefing-page" aria-label="Research Briefing" tabIndex={0} onKeyDown={onKeys}>
      <header className="briefing-page__header">
        <div>
          <p className="briefing-page__eyebrow">Research · Briefing</p>
          <h1>Briefing</h1>
          <p>Stories and events from followed interests, with their sources.</p>
        </div>
        <div>
          <button
            type="button"
            className="briefing-page__tune"
            aria-expanded={tuning}
            onClick={() => setTuning((value) => !value)}
          >
            {tuning ? 'Close tuning' : 'Tune'}
          </button>
          <button type="button" disabled={busy || !api} onClick={() => void refresh()}>
            Refresh once
          </button>
        </div>
      </header>
      <nav className="briefing-page__filters" aria-label="Briefing filters">
        <div className="briefing-page__interests" aria-label="Interests">
          <button type="button" aria-pressed={!interestId} onClick={() => setInterestId('')}>
            All interests
          </button>
          {(snapshot?.interests ?? []).map((interest) => (
            <button
              key={interest.id}
              type="button"
              aria-pressed={interestId === interest.id}
              onClick={() => setInterestId(interest.id)}
            >
              <span
                aria-hidden="true"
                className="briefing-page__weight-dot"
                style={{ opacity: Math.max(0.25, interest.weight) }}
              />
              {interest.label}
            </button>
          ))}
        </div>
        <div className="briefing-page__scopes" role="group" aria-label="Time scope">
          {scopes.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={scope === value}
              onClick={() => setScope(value)}
            >
              {value}
            </button>
          ))}
        </div>
        <span className="briefing-page__mute-count" role="status">
          Muted <span>{activeMutes}</span>
        </span>
      </nav>
      {tuning && (
        <section className="briefing-page__tuning" aria-label="Ranking preferences">
          <h2>Ranking preferences</h2>
          <p>
            Updates affect the next ranking pass. They do not change the underlying interests or sources.
          </p>
          <label>
            Velocity weight · {velocityWeight.toFixed(2)}
            <input
              type="range"
              min="0"
              max="0.25"
              step="0.01"
              value={velocityWeight}
              onChange={(event) => setVelocityWeight(Number(event.currentTarget.value))}
            />
          </label>
          <button type="button" disabled={busy || !api} onClick={() => void saveVelocity()}>
            Save velocity weight
          </button>
          {(snapshot?.interests ?? []).map((interest) => {
            const pref = snapshot?.interestPreferences.find((entry) => entry.id === interest.id);
            const draft = interestDraft[interest.id] ?? {
              weight: pref?.weight ?? interest.weight,
              halfLifeDays: pref?.halfLifeDays ?? 0.75,
            };
            return (
              <div className="briefing-page__tune-row" key={interest.id}>
                <strong>{interest.label}</strong>
                <label>
                  Weight · {draft.weight.toFixed(2)}
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={draft.weight}
                    onChange={(event) =>
                      setInterestDraft((current) => ({
                        ...current,
                        [interest.id]: { ...draft, weight: Number(event.currentTarget.value) },
                      }))
                    }
                  />
                </label>
                <label>
                  Freshness half-life · {draft.halfLifeDays} days
                  <input
                    type="number"
                    min="0.001"
                    step="0.25"
                    value={draft.halfLifeDays}
                    onChange={(event) =>
                      setInterestDraft((current) => ({
                        ...current,
                        [interest.id]: {
                          ...draft,
                          halfLifeDays: Number(event.currentTarget.value),
                        },
                      }))
                    }
                  />
                </label>
                <button
                  type="button"
                  disabled={busy || !api}
                  onClick={() => void saveInterest(interest)}
                >
                  Save
                </button>
              </div>
            );
          })}
          {(snapshot?.sources ?? []).map(({ record: source }) => (
            <div className="briefing-page__tune-row" key={source.id}>
              <strong>{source.attribution}</strong>
              <label>
                Priority
                <input
                  type="range"
                  min="-100"
                  max="100"
                  step="1"
                  value={
                    sourceDraft[source.id] ??
                    snapshot?.sourcePreferences.find((entry) => entry.id === source.id)?.priority ??
                    source.priority
                  }
                  onChange={(event) =>
                    setSourceDraft((current) => ({
                      ...current,
                      [source.id]: Number(event.currentTarget.value),
                    }))
                  }
                />
              </label>
              <button type="button" disabled={busy || !api} onClick={() => void saveSource(source)}>
                Save
              </button>
            </div>
          ))}
        </section>
      )}
      {!api ? (
        <p className="briefing-page__status" role="status">
          Briefing is not connected in this view.
        </p>
      ) : !snapshot || snapshot.status === 'loading' ? (
        <p className="briefing-page__status" role="status">
          Loading Briefing records…
        </p>
      ) : snapshot.status === 'unavailable' ? (
        <p className="briefing-page__status" role="status">
          Briefing data unavailable · {snapshot.reason}
        </p>
      ) : null}
      {error && (
        <p className="briefing-page__error" role="alert">
          {error}
        </p>
      )}
      {(notice || undoable) && (
        <p className="briefing-page__notice" role="status">
          {notice}{' '}
          {undoable && (
            <button type="button" disabled={busy} onClick={() => void undo()}>
              Undo
            </button>
          )}
        </p>
      )}
      <div className="briefing-page__layout">
        <section className="briefing-page__river" aria-label="Stories">
          {scope === 'Events' ? (
            <p className="briefing-page__empty">
              Choose an event below to inspect its original time and source.
            </p>
          ) : rows.length ? (
            rows.map(({ story, item, source, explanation, reference }) => (
              <button
                key={story.id}
                type="button"
                className="briefing-page__story"
                aria-current={selected?.story.id === story.id ? 'true' : undefined}
                onClick={() => setSelectedId(story.id)}
              >
                <span className="briefing-page__observed">
                  Observed {observationTime(item.observedAt, timeZone)}
                </span>
                <strong>{item.title || item.excerpt.slice(0, 120)}</strong>
                <span className="briefing-page__meta">
                  {source?.attribution ?? 'Source unavailable'} · {story.itemIds.length} item
                  {story.itemIds.length === 1 ? '' : 's'} ·{' '}
                  {story.interestMatches
                    .map(
                      (match) =>
                        snapshot?.interests.find((entry) => entry.id === match.interestId)?.label ??
                        match.interestId,
                    )
                    .join(', ')}
                </span>
                <span className="briefing-page__score">
                  {explanation ? `${explanation.total.toFixed(1)} · Why this` : 'Score unavailable'}
                </span>
                <span className="briefing-page__row-actions" aria-hidden="true">
                  Investigate · Discuss · Save · Mute
                </span>
                <span className="briefing-page__sr">Reference {reference.revision}</span>
              </button>
            ))
          ) : snapshot?.status === 'ready' ? (
            <p className="briefing-page__empty">
              No stories match this view. Failed or stale sources remain visible in the source list.
            </p>
          ) : null}
        </section>
        <aside className="briefing-page__inspector" aria-label="Selected story">
          {selected ? (
            <>
              <p className="briefing-page__eyebrow">Story · {selected.story.relation}</p>
              <h2 tabIndex={-1}>{selected.item.title || 'Untitled item'}</h2>
              <p>{selected.item.excerpt || 'No excerpt was captured.'}</p>
              <p className="briefing-page__meta">
                {selected.source?.attribution ?? 'Source unavailable'} · observed{' '}
                {observationTime(selected.item.observedAt, timeZone)} ·{' '}
                {selected.item.author ?? 'Author unknown'}
              </p>
              <section aria-label="Why this story">
                <h3>Why this</h3>
                {selected.explanation ? (
                  <>
                    <strong>
                      {selected.explanation.total.toFixed(1)} / 100 ·{' '}
                      {selected.explanation.completeness}
                    </strong>
                    <ul className="briefing-page__reasons">
                      {Object.entries(selected.explanation.components).map(([key, component]) => (
                        <li key={key}>
                          <span>
                            <b>{key}</b> · {component.status} · {component.reason}
                          </span>
                          <b>
                            {(component.value ?? 0).toFixed(1)} ×{' '}
                            {selected.explanation!.weights[
                              key as keyof RankingExplanation['weights']
                            ].toFixed(2)}
                          </b>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p>Ranking explanation unavailable for this story.</p>
                )}
              </section>
              <section aria-label="Platform observations">
                <h3>Platform metrics</h3>
                {metricsForItem(snapshot?.metrics ?? [], selected.item.id).map(
                  ({ last, elapsed, delta, count }) => (
                    <p key={`${last.platform}:${last.name}`}>
                      <strong>{last.platform}</strong> · {last.value} {last.name} · as of{' '}
                      {observationTime(last.observedAt, timeZone)}
                      {count < 2 ? (
                        <span> · Not enough observations for a trend</span>
                      ) : (
                        <span>
                          {' '}
                          · {delta >= 0 ? '+' : ''}
                          {delta} in {elapsed.toFixed(1)} h ({count} observations) · {last.scope}
                        </span>
                      )}
                    </p>
                  ),
                )}
                {!metricsForItem(snapshot?.metrics ?? [], selected.item.id).length && (
                  <p>No platform observations recorded.</p>
                )}
              </section>
              <div className="briefing-page__actions">
                {(
                  [
                    'investigate',
                    'check-claim',
                    'discuss',
                    'plan',
                    'watch',
                    'assess-reuse',
                    'save',
                  ] as const
                ).map((action) => (
                  <button
                    key={action}
                    type="button"
                    onClick={() => sendFollowThrough(selected, action)}
                  >
                    {action === 'check-claim'
                      ? 'Check claim'
                      : action === 'assess-reuse'
                        ? 'Assess reuse'
                        : action[0]!.toUpperCase() + action.slice(1)}
                  </button>
                ))}
                <button
                  type="button"
                  disabled={busy || !api}
                  onClick={() => void feedback('source', selected.item.sourceId, 'mute-source')}
                >
                  Mute source · M
                </button>
                {selected.story.interestMatches
                  .flatMap((match) => match.matchedTerms)
                  .slice(0, 3)
                  .map((term) => (
                    <button
                      key={`term:${term}`}
                      type="button"
                      disabled={busy || !api}
                      onClick={() => void feedback('term', term, 'mute-term')}
                    >
                      Mute “{term}”
                    </button>
                  ))}
                <button
                  type="button"
                  disabled={busy || !api}
                  onClick={() => void feedback('story', selected.story.id, 'more')}
                >
                  More like this
                </button>
                <button
                  type="button"
                  disabled={busy || !api}
                  onClick={() => void feedback('story', selected.story.id, 'less')}
                >
                  Less like this
                </button>
                <button
                  type="button"
                  disabled={busy || !api}
                  onClick={() =>
                    void feedback(
                      'story',
                      selected.story.id,
                      'snooze',
                      new Date(Date.now() + DAY).toISOString(),
                    )
                  }
                >
                  Snooze 24 h
                </button>
                <button
                  type="button"
                  disabled={busy || !api}
                  onClick={() => void feedback('story', selected.story.id, 'dismiss')}
                >
                  Dismiss
                </button>
                <button
                  type="button"
                  disabled={busy || !api}
                  onClick={() => void feedback('story', selected.story.id, 'split')}
                >
                  Split story
                </button>
              </div>
            </>
          ) : (
            <p>Select a story to inspect its sources and ranking.</p>
          )}
        </aside>
      </div>
      <section className="briefing-page__events" aria-label="Upcoming events">
        <header>
          <div>
            <h2>Events</h2>
            <p>Times display in {timeZone}; the original IANA zone is preserved.</p>
          </div>
        </header>
        {(snapshot?.events ?? []).map(({ record: event, reference }) => {
          const itemId = event.itemId;
          const item = itemId
            ? snapshot?.items.find((candidate) => candidate.record.id === itemId)?.record
            : undefined;
          const label = item?.title ?? event.location ?? 'Untitled event';
          const start = event.allDay ? event.startDate : event.startUtc;
          return (
            <article key={event.id} className="briefing-page__event">
              <div>
                <strong>{label}</strong>
                <p>
                  {event.allDay ? event.startDate : observationTime(event.startUtc, timeZone)} ·{' '}
                  {event.originalTz}
                  {event.dstAmbiguous ? ' · DST ambiguous' : ''}
                  {event.location ? ` · ${event.location}` : ''}
                </p>
              </div>
              <div>
                <button type="button" onClick={() => downloadEvent(event, label)}>
                  Add to calendar · ICS
                </button>
                <button
                  type="button"
                  onClick={() => sendEventFollowThrough(event, reference, label)}
                >
                  Remind me
                </button>
              </div>
              <span className="briefing-page__sr">Event starts {start}</span>
            </article>
          );
        })}
        {snapshot?.status === 'ready' && !snapshot.events.length && (
          <p className="briefing-page__empty">No events in current records.</p>
        )}
      </section>
      <section className="briefing-page__source-health" aria-label="Source health">
        {(snapshot?.sources ?? []).map(({ record: source }) => (
          <span
            key={source.id}
            data-health={source.health.status}
            title={source.health.failureClass ?? source.health.status}
          >
            {source.attribution} · {source.health.status}
            {source.health.status === 'failed'
              ? ` · ${source.health.failureClass ?? 'failure class unknown'}`
              : ''}
          </span>
        ))}
      </section>
      <p className="briefing-page__keyboard">
        J / K move · O open details · I investigate · D discuss · S save · M mute
      </p>
    </main>
  );
}
