import type { Event } from './briefing/schema.js';

const escapeIcs = (value: string) =>
  value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
const utcIcs = (value: string) =>
  new Date(value)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
const dateIcs = (value: string) => value.replace(/-/g, '');

/** Produces a local ICS payload only; it does not contact a calendar service. */
export function eventCalendar(event: Event, title: string) {
  const start = event.allDay
    ? `DTSTART;VALUE=DATE:${dateIcs(event.startDate)}`
    : `DTSTART:${utcIcs(event.startUtc)}`;
  const end = event.allDay
    ? event.endDate && `DTEND;VALUE=DATE:${dateIcs(event.endDate)}`
    : event.endUtc && `DTEND:${utcIcs(event.endUtc)}`;
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Signals//Briefing//EN',
    'BEGIN:VEVENT',
    `UID:${escapeIcs(event.id)}@signals.local`,
    `SUMMARY:${escapeIcs(title)}`,
    start,
    ...(end ? [end] : []),
    `X-ORIGINAL-TIMEZONE:${escapeIcs(event.originalTz)}`,
    `X-DST-AMBIGUOUS:${event.dstAmbiguous ? 'TRUE' : 'FALSE'}`,
    ...(event.recurrence ? [`RRULE:${escapeIcs(event.recurrence)}`] : []),
    ...(event.location ? [`LOCATION:${escapeIcs(event.location)}`] : []),
    ...(event.url ? [`URL:${escapeIcs(event.url)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}
