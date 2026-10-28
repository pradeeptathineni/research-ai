import type { ResearchActivity } from '@pradeeptathineni/research-ai';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { ProviderError } from './provider-capabilities.js';

const closed = { additionalProperties: false };
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const code = Type.String({ pattern: '^[a-z0-9_]{1,100}$' });
const empty = Type.Object({}, closed);
const details = {
  'session.started': Type.Object({ mode: Type.Enum(['live', 'frozen']) }, closed),
  'thread.started': empty,
  'turn.started': empty,
  'web.started': Type.Object({ call: count }, closed),
  'web.completed': Type.Object(
    {
      action: Type.Enum(['search', 'open_page', 'find_in_page', 'other', 'unrecognized', 'absent']),
      url: Type.Union([Type.String({ maxLength: 2000 }), Type.Null()]),
      urlStatus: Type.Enum(['reported', 'absent', 'withheld']),
      searches: count,
      reads: count,
      unclassified: count,
    },
    closed,
  ),
  checkpoint: Type.Object(
    { notes: count, units: count, bytes: count, omitted: Type.Boolean() },
    closed,
  ),
  'runner.error': empty,
  'turn.completed': empty,
  'turn.failed': empty,
  'protocol.failed': Type.Object({ reason: code }, closed),
  'session.stopped': Type.Object({ trigger: code }, closed),
  'activity.limited': Type.Object({ limit: count }, closed),
  'session.settled': Type.Object(
    {
      completed: Type.Boolean(),
      failureReason: Type.Union([code, Type.Null()]),
      cleanup: Type.Boolean(),
      delivered: count,
      omitted: count,
    },
    closed,
  ),
};
const schema = Type.Union(
  Object.entries(details).map(([kind, detail]) =>
    Type.Object(
      {
        version: Type.Literal('research-activity-v1'),
        sequence: Type.Integer({ minimum: 1 }),
        observedAt: Type.String({ maxLength: 40 }),
        kind: Type.Literal(kind),
        detail,
      },
      closed,
    ),
  ),
);
const validEvent = (event: unknown): boolean => Value.Check(schema, event);
export const activityLimits = Object.freeze({
  rows: 256,
  bytes: 256000,
  row_bytes: 4096,
  batch: 100,
});

export class ResearchActivityBuffer {
  private rows: { event: ResearchActivity; bytes: number }[] = [];
  private bytes = 0;
  private session: string | null = null;
  private sequence = 0;
  private dropped = 0;
  private lost = false;
  private settled = false;
  private observedAt: string | null = null;

  // Research observers are synchronous; neither bad input nor storage failure may stop its owner
  accept(event: ResearchActivity, sessionId: string): void {
    try {
      if (
        !/^[a-f0-9-]{36}$/.test(sessionId) ||
        !validEvent(event) ||
        !Number.isFinite(Date.parse(event.observedAt))
      )
        throw new Error('invalid_activity');
      if (event.kind === 'web.completed' && event.detail.url !== null) {
        if (!/^https?:\/\/[\x21-\x7e]+$/i.test(event.detail.url) || /[?#]/.test(event.detail.url))
          throw new Error('unsafe_activity_url');
        const url = new URL(event.detail.url);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          event.detail.urlStatus !== 'reported'
        )
          throw new Error('unsafe_activity_url');
      }
      if (
        event.kind === 'web.completed' &&
        event.detail.url === null &&
        event.detail.urlStatus === 'reported'
      )
        throw new Error('invalid_activity_url_status');
      if (this.session === null) {
        if (event.kind !== 'session.started' || event.sequence !== 1)
          throw new Error('missing_activity_start');
        this.session = sessionId;
      }
      if (this.session !== sessionId || event.sequence !== this.sequence + 1 || this.settled)
        throw new Error('activity_identity_mismatch');
      const serialized = JSON.stringify(event);
      const bytes = Buffer.byteLength(serialized);
      if (bytes > activityLimits.row_bytes) throw new Error('activity_row_limit');
      const copy = JSON.parse(serialized) as ResearchActivity;
      this.rows.push({ event: copy, bytes });
      this.sequence = event.sequence;
      this.observedAt = event.observedAt;
      this.bytes += bytes;
      if (
        event.kind === 'activity.limited' ||
        (event.kind === 'session.settled' && event.detail.omitted > 0)
      )
        this.lost = true;
      this.settled = event.kind === 'session.settled';
      while (this.rows.length > activityLimits.rows || this.bytes > activityLimits.bytes) {
        this.bytes -= this.rows.shift()!.bytes;
        this.dropped++;
      }
    } catch {
      this.lost = true;
    }
  }

  read(after: number, limit: number, expectedSession: string | null, ownerSettled: boolean) {
    if (expectedSession !== null && this.session !== null && expectedSession !== this.session)
      throw new ProviderError(
        409,
        'research_activity_session_mismatch',
        'Activity belongs to another session.',
      );
    if (after > this.sequence)
      throw new ProviderError(
        409,
        'research_activity_cursor_ahead',
        'Cursor is ahead of observed activity.',
      );
    const events = this.rows
      .filter(({ event }) => event.sequence > after)
      .slice(0, limit)
      .map(({ event }) => event);
    const cursor = events.at(-1)?.sequence ?? after;
    const first = this.rows[0]?.event.sequence ?? null;
    return {
      session_id: this.session,
      availability: this.session ? 'available' : 'unavailable',
      reason: this.lost ? 'observation_lost' : this.session ? null : 'no_session_started',
      events,
      next_cursor: cursor,
      first_sequence: first,
      last_sequence: this.sequence,
      gap: this.lost || (first !== null && after < first - 1),
      dropped: this.dropped,
      observation_lost: this.lost,
      last_observed_at: this.observedAt,
      fresh: this.observedAt !== null && Date.now() - Date.parse(this.observedAt) <= 30000,
      session_settled: this.settled,
      complete:
        ownerSettled &&
        this.settled &&
        !this.lost &&
        this.dropped === 0 &&
        cursor === this.sequence,
    };
  }
}

export function activityRead(url: string, storeEpoch: string) {
  const params = new URL(url, 'http://127.0.0.1').searchParams;
  const keys = ['request_id', 'after', 'limit', 'session_id', 'store_epoch'];
  if (
    [...params.keys()].some((key) => !keys.includes(key) || params.getAll(key).length !== 1) ||
    !/^[a-f0-9]{32}$/.test(params.get('request_id') ?? '') ||
    !/^\d{1,16}$/.test(params.get('after') ?? '0') ||
    !/^\d{1,3}$/.test(params.get('limit') ?? '100')
  )
    throw new ProviderError(
      400,
      'invalid_research_activity_read',
      'Supply an exact request and bounded cursor.',
    );
  const after = Number(params.get('after') ?? '0'),
    limit = Number(params.get('limit') ?? '100');
  if (!Number.isSafeInteger(after) || limit < 1 || limit > activityLimits.batch)
    throw new ProviderError(
      400,
      'invalid_research_activity_read',
      'Cursor or batch limit is invalid.',
    );
  if (after && (!params.get('session_id') || !params.get('store_epoch')))
    throw new ProviderError(
      428,
      'research_activity_cursor_binding_required',
      'Reconnect with the original session and store epoch.',
    );
  if (params.has('store_epoch') && params.get('store_epoch') !== storeEpoch)
    throw new ProviderError(
      409,
      'research_activity_store_mismatch',
      'Ephemeral activity store changed; no replay is available.',
    );
  return { id: params.get('request_id')!, after, limit, session: params.get('session_id') };
}
