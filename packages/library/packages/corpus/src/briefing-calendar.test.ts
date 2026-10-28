import { describe, expect, it } from 'vitest';
import { eventCalendar } from './briefing-calendar.js';
import type { Event } from './briefing/schema.js';

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
});
