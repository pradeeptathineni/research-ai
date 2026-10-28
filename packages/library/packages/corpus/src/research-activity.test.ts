import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { ResearchActivity } from '@pradeeptathineni/research-ai';
import { ResearchActivityBuffer, activityRead, activityLimits } from './research-activity.js';

const start = (sequence = 1): ResearchActivity => ({
  version: 'research-activity-v1',
  sequence,
  observedAt: new Date().toISOString(),
  kind: 'session.started',
  detail: { mode: 'live' },
});
const event = (sequence: number): ResearchActivity => ({
  ...start(sequence),
  kind: 'turn.started',
  detail: {},
});

it('keeps exact per-session replay, source settlement and owner completion separate', () => {
  const buffer = new ResearchActivityBuffer(),
    session = randomUUID();
  expect(buffer.read(0, 100, null, false)).toMatchObject({
    availability: 'unavailable',
    complete: false,
    fresh: false,
  });
  expect(buffer.accept(start(), session)).toBeUndefined();
  buffer.accept(event(2), session);
  const first = buffer.read(0, 1, null, false);
  expect(first).toMatchObject({
    session_id: session,
    next_cursor: 1,
    last_sequence: 2,
    gap: false,
  });
  expect(buffer.read(1, 100, session, false).events.map((row) => row.sequence)).toEqual([2]);
  expect(() => buffer.read(2, 100, randomUUID(), false)).toThrow(
    'research_activity_session_mismatch',
  );
  expect(() => buffer.read(3, 100, session, false)).toThrow('research_activity_cursor_ahead');
  buffer.accept(
    {
      ...event(3),
      kind: 'session.settled',
      detail: { completed: true, failureReason: null, cleanup: true, delivered: 2, omitted: 0 },
    },
    session,
  );
  expect(buffer.read(2, 100, session, false)).toMatchObject({
    session_settled: true,
    complete: false,
  });
  expect(buffer.read(3, 100, session, true)).toMatchObject({
    session_settled: true,
    complete: true,
    events: [],
  });
});

it('bounds retained rows and bytes and exposes a cursor-relative gap', () => {
  const buffer = new ResearchActivityBuffer(),
    session = randomUUID();
  buffer.accept(start(), session);
  for (let sequence = 2; sequence <= 280; sequence++) buffer.accept(event(sequence), session);
  const batch = buffer.read(0, 100, session, false);
  expect(batch.gap).toBe(true);
  expect(batch.dropped).toBe(24);
  expect(batch.first_sequence).toBe(25);
  expect(batch.events).toHaveLength(100);
  expect(buffer.read(24, 100, session, false).gap).toBe(false);
  expect(JSON.stringify(buffer.read(0, 256, session, false)).length).toBeLessThan(
    activityLimits.bytes + 2000,
  );
  const byteBound = new ResearchActivityBuffer();
  byteBound.accept(start(), session);
  for (let sequence = 2; sequence <= 180; sequence++)
    byteBound.accept(
      {
        ...event(sequence),
        kind: 'web.completed',
        detail: {
          action: 'open_page',
          url: 'https://example.org/' + 'a'.repeat(1900),
          urlStatus: 'reported',
          searches: 0,
          reads: sequence - 1,
          unclassified: 0,
        },
      },
      session,
    );
  const retained = byteBound.read(0, 256, session, false);
  expect(retained.dropped).toBeGreaterThan(0);
  expect(retained.events.length).toBeLessThan(activityLimits.rows);
  expect(Buffer.byteLength(JSON.stringify(retained))).toBeLessThan(activityLimits.bytes + 2000);
});

it('isolates observer failures and refuses private fields, unsafe URLs and session mixing', () => {
  const first = new ResearchActivityBuffer(),
    second = new ResearchActivityBuffer();
  const a = randomUUID(),
    b = randomUUID();
  first.accept(start(), a);
  second.accept(start(), b);
  first.accept({ ...event(2), private: 'PRIVATE_CANARY' } as unknown as ResearchActivity, a);
  first.accept(
    {
      ...event(2),
      kind: 'web.completed',
      detail: {
        action: 'open_page',
        url: 'https://example.org/?PRIVATE_CANARY',
        urlStatus: 'reported',
        searches: 0,
        reads: 1,
        unclassified: 0,
      },
    },
    a,
  );
  first.accept(event(2), b);
  expect(first.read(0, 100, a, false)).toMatchObject({
    observation_lost: true,
    gap: true,
    last_sequence: 1,
  });
  expect(second.read(0, 100, b, false)).toMatchObject({
    observation_lost: false,
    gap: false,
    session_id: b,
  });
  expect(JSON.stringify(first.read(0, 100, a, false))).not.toContain('PRIVATE_CANARY');
});

it('marks upstream omission and stale evidence without inventing completion', () => {
  const buffer = new ResearchActivityBuffer(),
    session = randomUUID();
  buffer.accept({ ...start(), observedAt: '2020-01-01T00:00:00.000Z' }, session);
  buffer.accept({ ...event(2), kind: 'activity.limited', detail: { limit: 512 } }, session);
  expect(buffer.read(0, 100, session, false)).toMatchObject({
    observation_lost: true,
    complete: false,
  });
  const stale = new ResearchActivityBuffer();
  stale.accept({ ...start(), observedAt: '2020-01-01T00:00:00.000Z' }, session);
  expect(stale.read(0, 100, session, false)).toMatchObject({ fresh: false, complete: false });
});

it('binds reconnect cursors and rejects unknown, repeated and unbounded query inputs', () => {
  const request = 'a'.repeat(32),
    session = randomUUID(),
    epoch = randomUUID();
  const path = `http://127.0.0.1/provider/research-activity?request_id=${request}`;
  expect(activityRead(path, epoch)).toEqual({ id: request, after: 0, limit: 100, session: null });
  for (const suffix of ['&extra=1', '&after=-1', '&limit=101', '&request_id=' + request])
    expect(() => activityRead(path + suffix, epoch)).toThrow('invalid_research_activity_read');
  expect(() => activityRead(path + '&after=1', epoch)).toThrow(
    'research_activity_cursor_binding_required',
  );
  expect(() =>
    activityRead(path + `&after=1&session_id=${session}&store_epoch=wrong`, epoch),
  ).toThrow('research_activity_store_mismatch');
});
