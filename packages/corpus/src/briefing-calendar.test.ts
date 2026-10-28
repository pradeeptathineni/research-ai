import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings, saveSettings } from './search-settings.js';
import { eventCalendar } from './briefing-calendar.js';
import type { Event } from './briefing/schema.js';
import { allDayEventFixture, itemFixture, storyFixture, timedEventFixture } from './briefing/fixtures.js';
import { briefingRoute } from './briefing/http.js';
import { createBriefingApi, retainBriefingRecords } from './briefing/store.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

async function fixtureRoot() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-briefing-calendar-')));
  roots.push(root);
  await saveSettings(
    {
      ...defaultSettings,
      queries: [
        {
          id: 'climate-data',
          query: 'climate data releases',
          enabled: true,
          everyDays: 2,
          offsetMinutes: 0,
          concepts: [],
        },
      ],
      followedSources: [
        {
          uri: 'https://example.test/feed.xml',
          label: 'Fixture feed',
          enabled: true,
          interests: ['climate-data'],
        },
      ],
    },
    root,
  );
  return root;
}

describe('Briefing ICS export', () => {
  it('keeps all-day dates as dates and preserves the exclusive end date', () => {
    const event: Event = {
      id: 'event-all-day',
      itemId: 'item-one',
      allDay: true,
      startDate: '2026-11-01',
      endDate: '2026-11-02',
      originalTz: 'America/New_York',
      dstAmbiguous: false,
      recurrence: null,
      location: null,
      url: null,
    };
    const payload = eventCalendar(event, 'DST calendar day');
    expect(payload).toContain('DTSTART;VALUE=DATE:20261101');
    expect(payload).toContain('DTEND;VALUE=DATE:20261102');
    expect(payload).toContain('X-ORIGINAL-TIMEZONE:America/New_York');
    expect(payload).not.toContain('DTSTART:');
  });

  it('exports timed events as UTC instants with their original zone and ambiguity flag', () => {
    const event: Event = {
      id: 'event-timed',
      itemId: 'item-one',
      allDay: false,
      startUtc: '2026-11-01T05:30:00.000Z',
      endUtc: null,
      originalTz: 'America/New_York',
      dstAmbiguous: true,
      recurrence: null,
      location: null,
      url: null,
    };
    const payload = eventCalendar(event, 'Ambiguous local time');
    expect(payload).toContain('DTSTART:20261101T053000Z');
    expect(payload).toContain('X-ORIGINAL-TIMEZONE:America/New_York');
    expect(payload).toContain('X-DST-AMBIGUOUS:TRUE');
  });

  it('serves a bounded calendar from the exact retained event and refuses extra query fields', async () => {
    const root = await fixtureRoot();
    const sourceId = (await createBriefingApi(root).listSources())[0]!.record.id;
    const item = { ...itemFixture, sourceId };
    await retainBriefingRecords(root, {
      items: [item],
      stories: [storyFixture],
      events: [allDayEventFixture, timedEventFixture],
    });

    const allDay = await briefingRoute(
      root,
      'briefing/events/calendar',
      false,
      undefined,
      1,
      new URLSearchParams('eventId=event-day'),
    );
    expect(allDay?.status).toBe(200);
    expect(allDay?.body).toMatchObject({
      schema: 'signals.briefing-event-calendar.v1',
      reference: {
        owner: 'signals-ai',
        kind: 'briefing-event',
        id: 'event-day',
      },
      title: itemFixture.title,
      filename: 'briefing-event-event-day.ics',
    });
    expect(allDay?.body.ics).toContain('DTSTART;VALUE=DATE:20261028');
    expect(allDay?.body.ics).toContain('DTEND;VALUE=DATE:20261029');
    expect(allDay?.body.ics).toContain('X-ORIGINAL-TIMEZONE:America/New_York');
    expect(allDay?.body.ics.length).toBeLessThanOrEqual(16_384);

    const timed = await briefingRoute(
      root,
      'briefing/events/calendar',
      false,
      undefined,
      1,
      new URLSearchParams('eventId=event-timed'),
    );
    expect(timed?.body.ics).toContain('DTSTART:20261028T090000Z');
    expect(timed?.body.ics).toContain('X-DST-AMBIGUOUS:FALSE');

    await expect(
      briefingRoute(
        root,
        'briefing/events/calendar',
        false,
        undefined,
        2,
        new URLSearchParams('eventId=event-day&extra=1'),
      ),
    ).rejects.toThrow('invalid_briefing_event_calendar_query');
    await expect(
      briefingRoute(
        root,
        'briefing/events/calendar',
        false,
        undefined,
        1,
        new URLSearchParams('eventId=not-retained'),
      ),
    ).rejects.toThrow('unknown_briefing_event');
  });
});
