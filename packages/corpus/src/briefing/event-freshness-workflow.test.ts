import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings, saveSettings } from '../search-settings.js';
import { createBriefingApi, retainBriefingRecords } from './store.js';
import { briefingRoute } from './http.js';
import { itemFixture, storyFixture } from './fixtures.js';
import type { Event, Item, Story } from './schema.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

function localDate(now: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now));
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

describe('Briefing event freshness owner workflow', () => {
  it('ranks exact item-linked event dates and times, preserves timezone uncertainty, and cold-reopens the same evidence', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-event-freshness-')));
    roots.push(root);
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const oldCapture = new Date(now - 15 * 86_400_000).toISOString();
    const timeZone = 'America/New_York';
    const today = localDate(now, timeZone);
    const tomorrow = shiftDate(today, 1);
    const yesterday = shiftDate(today, -1);
    await saveSettings(
      {
        ...defaultSettings,
        queries: [
          {
            id: 'event-context',
            query: 'briefing event',
            enabled: true,
            everyDays: 1,
            offsetMinutes: 0,
            concepts: [],
          },
        ],
        followedSources: [
          {
            uri: 'https://example.test/events.xml',
            label: 'Event fixture',
            enabled: true,
            interests: ['event-context'],
          },
        ],
      },
      root,
    );
    const source = (await createBriefingApi(root).listSources())[0]!.record;
    const itemIds = [
      'expired-fresh',
      'upcoming-old',
      'ongoing',
      'all-day-live',
      'all-day-ended',
      'dst-ambiguous',
      'invalid-zone',
    ];
    const capturedAt = new Map<string, string>([
      ['expired-fresh', nowIso],
      ['upcoming-old', oldCapture],
      ['ongoing', oldCapture],
      ['all-day-live', oldCapture],
      ['all-day-ended', oldCapture],
      ['dst-ambiguous', oldCapture],
      ['invalid-zone', oldCapture],
    ]);
    const items: Item[] = itemIds.map((id, index) => ({
      ...itemFixture,
      id,
      sourceId: source.id,
      storyId: `story-${id}`,
      canonicalUrl: `https://example.test/${id}`,
      title: 'A briefing event for the synthetic workflow',
      contentDigest: String(index + 1).repeat(64),
      observedAt: capturedAt.get(id)!,
      metrics: [],
      interestIds: ['event-context'],
    }));
    const stories: Story[] = items.map((item) => ({
      ...storyFixture,
      id: item.storyId!,
      itemIds: [item.id],
      representativeItemId: item.id,
      firstSeen: item.observedAt,
      lastSeen: item.observedAt,
      relation: 'single',
      groupingEvidence: [],
      interestMatches: [],
    }));
    const timed = (
      id: string,
      itemId: string,
      startUtc: string,
      endUtc: string | null,
      extras: Partial<Event> = {},
    ): Event =>
      ({
        id,
        itemId,
        startUtc,
        endUtc,
        originalTz: timeZone,
        allDay: false,
        dstAmbiguous: false,
        url: null,
        location: null,
        recurrence: null,
        ...extras,
      }) as Event;
    const allDay = (
      id: string,
      itemId: string,
      startDate: string,
      endDate: string | null,
    ): Event => ({
      id,
      itemId,
      startDate,
      endDate,
      originalTz: timeZone,
      allDay: true,
      dstAmbiguous: false,
      url: null,
      location: null,
      recurrence: null,
    });
    const events: Event[] = [
      timed(
        'event-expired',
        'expired-fresh',
        new Date(now - 3 * 86_400_000).toISOString(),
        new Date(now - 2 * 86_400_000).toISOString(),
      ),
      timed('event-upcoming', 'upcoming-old', new Date(now + 86_400_000).toISOString(), null),
      timed(
        'event-ongoing',
        'ongoing',
        new Date(now - 60 * 60_000).toISOString(),
        new Date(now + 60 * 60_000).toISOString(),
      ),
      allDay('event-all-day-live', 'all-day-live', today, tomorrow),
      allDay('event-all-day-ended', 'all-day-ended', yesterday, today),
      timed(
        'event-dst-ambiguous',
        'dst-ambiguous',
        new Date(now + 86_400_000).toISOString(),
        null,
        { dstAmbiguous: true },
      ),
      timed('event-invalid-zone', 'invalid-zone', new Date(now + 86_400_000).toISOString(), null, {
        originalTz: 'Mars/Olympus',
      }),
      {
        id: 'event-no-item',
        startUtc: new Date(now + 86_400_000).toISOString(),
        endUtc: null,
        originalTz: timeZone,
        allDay: false,
        dstAmbiguous: false,
        url: null,
        location: null,
        recurrence: null,
      },
      timed('event-other-item', 'not-a-member', new Date(now + 86_400_000).toISOString(), null),
    ];
    await retainBriefingRecords(root, { items, stories, events });

    const readWorkbench = async () => {
      const response = await briefingRoute(root, 'briefing/workbench', false, undefined, 0);
      expect(response?.status).toBe(200);
      return response!.body as {
        ranked: Array<{
          input: { story: Story; events?: Event[] };
          explanation: {
            total: number;
            components: { freshness: { value: number | null; status: string; refs: string[] } };
          };
        }>;
      };
    };
    const before = await readWorkbench();
    const ranked = new Map(before.ranked.map((row) => [row.input.story.representativeItemId, row]));
    const expired = ranked.get('expired-fresh')!;
    const upcoming = ranked.get('upcoming-old')!;
    expect(expired.input.events?.map(({ id }) => id)).toEqual(['event-expired']);
    expect(upcoming.input.events?.map(({ id }) => id)).toEqual(['event-upcoming']);
    expect(expired.explanation.components.freshness.value).toBe(0);
    expect(upcoming.explanation.components.freshness.value).toBeGreaterThan(
      expired.explanation.components.freshness.value!,
    );
    expect(
      before.ranked.findIndex((row) => row.input.story.id === upcoming.input.story.id),
    ).toBeLessThan(before.ranked.findIndex((row) => row.input.story.id === expired.input.story.id));
    expect(ranked.get('ongoing')!.explanation.components.freshness.value).toBe(100);
    expect(ranked.get('all-day-live')!.explanation.components.freshness.value).toBe(100);
    expect(ranked.get('all-day-ended')!.explanation.components.freshness.value).toBe(0);
    for (const id of ['dst-ambiguous', 'invalid-zone']) {
      expect(ranked.get(id)!.explanation.components.freshness).toMatchObject({
        value: null,
        status: 'unknown',
      });
    }
    expect(
      before.ranked.every(
        (row) =>
          row.input.events?.every((event) => row.input.story.itemIds.includes(event.itemId!)) ??
          true,
      ),
    ).toBe(true);
    expect(
      (await createBriefingApi(root).listEvents()).map(({ record }) => record.id),
    ).toHaveLength(events.length);

    const cold = await readWorkbench();
    const coldById = new Map(cold.ranked.map((row) => [row.input.story.representativeItemId, row]));
    for (const id of itemIds) {
      expect(coldById.get(id)!.input.events).toEqual(ranked.get(id)!.input.events);
      expect(coldById.get(id)!.explanation.components.freshness).toEqual(
        ranked.get(id)!.explanation.components.freshness,
      );
    }
  });
});
