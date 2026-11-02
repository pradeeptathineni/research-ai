import { describe, expect, it } from 'vitest';
import type { Event, Interest } from './briefing/schema.js';
import { briefingEventFreshness } from './briefing-event-freshness.js';

const target = {
  itemId: 'item-one',
  interests: [{ id: 'interest-one', enabled: true, weight: 1, halfLifeDays: 1 }] satisfies Pick<
    Interest,
    'id' | 'enabled' | 'weight' | 'halfLifeDays'
  >[],
};
const now = Date.parse('2026-11-02T12:00:00.000Z');
const timed = (patch: Partial<Extract<Event, { allDay: false }>> = {}): Event => ({
  id: 'event-one',
  itemId: 'item-one',
  startUtc: '2026-11-03T12:00:00.000Z',
  endUtc: null,
  originalTz: 'America/New_York',
  allDay: false,
  dstAmbiguous: false,
  url: null,
  location: null,
  recurrence: null,
  ...patch,
});
const allDay = (patch: Partial<Extract<Event, { allDay: true }>> = {}): Event => ({
  id: 'event-day',
  itemId: 'item-one',
  startDate: '2026-11-03',
  endDate: '2026-11-04',
  originalTz: 'America/New_York',
  allDay: true,
  dstAmbiguous: false,
  url: null,
  location: null,
  recurrence: null,
  ...patch,
});

describe('Briefing event freshness', () => {
  it('decays upcoming timed events and scores explicit ongoing or ended intervals', () => {
    expect(briefingEventFreshness([timed()], [target], now)).toMatchObject({
      value: 50,
      status: 'available',
      refs: ['event-one'],
    });
    expect(
      briefingEventFreshness(
        [timed({ startUtc: '2026-11-02T11:00:00.000Z', endUtc: '2026-11-02T13:00:00.000Z' })],
        [target],
        now,
      ).value,
    ).toBe(100);
    expect(
      briefingEventFreshness(
        [timed({ startUtc: '2026-11-02T09:00:00.000Z', endUtc: '2026-11-02T10:00:00.000Z' })],
        [target],
        now,
      ).value,
    ).toBe(0);
    expect(
      briefingEventFreshness([timed({ startUtc: '2026-11-02T11:00:00.000Z' })], [target], now)
        .value,
    ).toBe(0);
    expect(
      briefingEventFreshness([timed({ startUtc: '2026-11-02T12:00:00.000Z' })], [target], now)
        .value,
    ).toBe(100);
  });

  it('compares all-day dates in the event zone and honors exclusive endDate', () => {
    const justBeforeTokyoStart = Date.parse('2026-11-02T14:59:00.000Z');
    expect(
      briefingEventFreshness(
        [allDay({ startDate: '2026-11-03', endDate: '2026-11-04', originalTz: 'Asia/Tokyo' })],
        [target],
        justBeforeTokyoStart,
      ).status,
    ).toBe('available');
    const startOfEndDateInNewYork = Date.parse('2026-11-04T05:00:00.000Z');
    expect(briefingEventFreshness([allDay()], [target], startOfEndDateInNewYork).value).toBe(0);
    expect(
      briefingEventFreshness([allDay()], [target], Date.parse('2026-11-03T17:00:00.000Z')).value,
    ).toBe(100);
  });

  it('keeps ambiguous or invalid dates unknown and never falls back for supplied empty events', () => {
    for (const event of [
      timed({ dstAmbiguous: true }),
      timed({ originalTz: 'Not/AZone' }),
      timed({ startUtc: '2026-11-03T12:00:00.000Z', endUtc: '2026-11-03T12:00:00.000Z' }),
      allDay({ endDate: '2026-11-02' }),
    ]) {
      expect(briefingEventFreshness([event], [target], now)).toMatchObject({
        value: null,
        status: 'unknown',
        refs: [event.id],
      });
    }
    expect(briefingEventFreshness([], [target], now)).toMatchObject({
      value: null,
      status: 'unknown',
      refs: [],
    });
  });
});
