import type { Event, Interest, RankingExplanation } from './briefing/schema.js';

const DAY = 86_400_000;
type EventInterest = Pick<Interest, 'id' | 'enabled' | 'weight' | 'halfLifeDays'>;

function unknown(reason: string, refs: string[]): RankingExplanation['components']['freshness'] {
  return { value: null, status: 'unknown', reason, refs: [...new Set(refs)] };
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function dateInZone(now: number, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(now));
    const field = (type: string) => parts.find((part) => part.type === type)?.value;
    const year = field('year');
    const month = field('month');
    const day = field('day');
    return year && month && day ? `${year}-${month}-${day}` : null;
  } catch {
    return null;
  }
}

function eventScore(event: Event, now: number, halfLifeDays: number): number | null {
  if (event.dstAmbiguous) return null;
  try {
    new Intl.DateTimeFormat('en', { timeZone: event.originalTz });
  } catch {
    return null;
  }
  if (event.allDay) {
    if (!validDate(event.startDate)) return null;
    if (event.endDate !== null && (!validDate(event.endDate) || event.endDate <= event.startDate))
      return null;
    const localToday = dateInZone(now, event.originalTz);
    if (!localToday) return null;
    if (
      localToday >= event.startDate &&
      (event.endDate === null ? localToday === event.startDate : localToday < event.endDate)
    )
      return 100;
    if (localToday >= (event.endDate ?? event.startDate)) return 0;
    const untilDays =
      (Date.parse(`${event.startDate}T00:00:00.000Z`) - Date.parse(`${localToday}T00:00:00.000Z`)) /
      DAY;
    return 100 * 2 ** (-untilDays / halfLifeDays);
  }

  const start = Date.parse(event.startUtc);
  const end = event.endUtc === null ? null : Date.parse(event.endUtc);
  if (!Number.isFinite(start) || (end !== null && (!Number.isFinite(end) || end <= start)))
    return null;
  if (end !== null && start <= now && now < end) return 100;
  if (end !== null && end <= now) return 0;
  if (start < now) return 0;
  return 100 * 2 ** (-((start - now) / DAY) / halfLifeDays);
}

/** Rank only exact item-linked event dates/times; invalid event meaning stays unknown. */
export function briefingEventFreshness(
  events: readonly Event[],
  targets: readonly { itemId: string; interests: readonly EventInterest[] }[],
  now: number,
): RankingExplanation['components']['freshness'] {
  if (!Number.isFinite(now))
    return unknown(
      'Host time is invalid for event freshness.',
      events.map(({ id }) => id),
    );
  if (!events.length) return unknown('No item-linked event is available for event freshness.', []);
  const interestsByItem = new Map(targets.map((target) => [target.itemId, target.interests]));
  const scored: Array<{ value: number; eventId: string }> = [];
  for (const event of events) {
    const interests =
      (event.itemId ? interestsByItem.get(event.itemId) : undefined)?.filter(
        (interest) => interest.enabled && interest.weight > 0,
      ) ?? [];
    if (!event.itemId || !interests.length)
      return unknown('An event is not bound to an item with an enabled freshness interest.', [
        event.id,
      ]);
    const values: number[] = [];
    for (const interest of interests) {
      const value = eventScore(event, now, interest.halfLifeDays);
      if (value === null)
        return unknown('An event has ambiguous or invalid time or timezone data.', [event.id]);
      values.push(value);
    }
    scored.push({ value: Math.max(...values), eventId: event.id });
  }
  return {
    value: Math.round(Math.max(...scored.map(({ value }) => value))),
    status: 'available',
    reason:
      'Event freshness uses time until start, active intervals, or completed dates with the matched interest half-life; all-day dates use the event timezone.',
    refs: [...new Set(scored.map(({ eventId }) => eventId))],
  };
}
