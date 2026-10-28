import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings, saveSettings } from '../search-settings.js';
import {
  allDayEventFixture,
  itemFixture,
  metricObservationFixture,
  storyFixture,
} from './fixtures.js';
import { exportOpml, parseIcs, parseJsonFeed, parseOpml, refreshBriefing } from './ingest.js';
import { briefingRoute } from './http.js';
import { createBriefingApi, retainBriefingRecords } from './store.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);
async function fixtureRoot() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-briefing-')));
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
          label: 'Example feed',
          enabled: true,
          interests: ['climate-data'],
        },
      ],
    },
    root,
  );
  return root;
}

describe('Briefing same-store API', () => {
  it('projects current Following settings, retains exact records, and cold-reads rank inputs', async () => {
    const root = await fixtureRoot();
    const api = createBriefingApi(root);
    const sourceId = (await api.listSources())[0]!.record.id;
    const item = { ...itemFixture, sourceId };
    const story = { ...storyFixture };
    await retainBriefingRecords(root, {
      items: [item],
      stories: [story],
      events: [allDayEventFixture],
    });
    const [interests, sources, items, stories, events, inputs] = await Promise.all([
      api.listInterests(),
      api.listSources(),
      api.listItems(),
      api.listStories(),
      api.listEvents(),
      api.listRankInputs(),
    ]);
    expect(interests[0]).toMatchObject({
      id: 'climate-data',
      cadenceRef: null,
      halfLifeDays: 0.75,
    });
    expect(sources[0]?.reference.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(items[0]?.reference.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(stories).toHaveLength(1);
    expect(events[0]?.record.allDay && events[0].record.endDate).toBe('2026-10-29');
    expect(inputs[0]?.items[0]?.seen).toEqual({ status: 'unknown', reason: 'not-recorded' });
    expect(inputs[0]?.metrics).toEqual([metricObservationFixture]);
    await expect(createBriefingApi(root).listItems()).resolves.toHaveLength(1);
  });

  it('makes feedback request IDs idempotent, rejects changed replay, and records exact undo', async () => {
    const root = await fixtureRoot();
    const api = createBriefingApi(root);
    const sourceId = (await api.listSources())[0]!.record.id;
    const item = { ...itemFixture, sourceId };
    await retainBriefingRecords(root, { items: [item], stories: [storyFixture] });
    const request = {
      requestId: 'f07c0705-08f9-4772-9175-209699e068c1',
      targetKind: 'story' as const,
      targetId: storyFixture.id,
      action: 'save' as const,
    };
    const first = await api.recordFeedback(request);
    expect(first.replayed).toBe(false);
    expect((await api.recordFeedback(request)).replayed).toBe(true);
    await expect(api.recordFeedback({ ...request, action: 'dismiss' })).rejects.toThrow(
      'request_id_conflict',
    );
    const undo = await api.undoFeedback({
      requestId: 'f07c0705-08f9-4772-9175-209699e068c2',
      feedbackId: first.feedback.id,
    });
    expect(undo.feedback.action === 'undo' && undo.feedback.undoesFeedbackId).toBe(
      first.feedback.id,
    );
    expect((await api.listFeedback()).map((item) => item.action)).toEqual(['save', 'undo']);
    const seen = await api.markSeen({
      requestId: 'f07c0705-08f9-4772-9175-209699e068c3',
      targetKind: 'item',
      targetId: itemFixture.id,
    });
    expect(seen.status).toBe('seen');
    const metric = await api.recordMetricObservation({
      requestId: 'f07c0705-08f9-4772-9175-209699e068c4',
      observation: metricObservationFixture,
    });
    expect(metric.id).toBe(metricObservationFixture.id);
  });

  it('round-trips OPML and rejects entity declarations/credentialed URLs', async () => {
    const root = await fixtureRoot();
    const api = createBriefingApi(root);
    const [source] = await api.listSources();
    const xml = exportOpml([source!.record]);
    expect(parseOpml(xml)).toEqual([
      { url: 'https://example.test/feed.xml', label: 'Example feed', type: 'rss' },
    ]);
    expect(() => parseOpml('<!DOCTYPE opml [<!ENTITY x "x">]><opml/>')).toThrow('invalid_opml');
    expect(() =>
      parseOpml('<opml><outline xmlUrl="https://user:pass@example.test/feed"/></opml>'),
    ).toThrow('invalid_opml_source');
  });

  it('ingests one mocked Following feed with exact item digests and honors explicit blocked terms', async () => {
    const root = await fixtureRoot();
    let fetches = 0;
    const fetch = async (uri: string) => {
      fetches++;
      return {
        uri,
        text: 'New finding\nA careful excerpt.',
        digest: 'a'.repeat(64),
        contentType: 'application/rss+xml',
        response: { status: 200, etag: 'fixture-v1', lastModified: undefined, headers: {} },
        material: {
          text: 'New finding\nA careful excerpt.',
          title: 'Example feed',
          author: null,
          publishedAt: null,
          links: [{ uri: 'https://example.test/story/one', title: 'New finding' }],
          sections: [{ locator: 'item:1', text: 'New finding: A careful excerpt.' }],
          extractor: 'fixture',
        },
      } as never;
    };
    const result = await refreshBriefing(root, { fetch });
    expect(result.briefing.capturedDocuments).toBe(1);
    expect((await createBriefingApi(root).listItems())[0]?.record).toMatchObject({
      canonicalUrl: 'https://example.test/story/one',
      title: 'New finding',
      contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const source = (await createBriefingApi(root).listSources())[0]!.record;
    await createBriefingApi(root).setSourceTermsPolicy({
      requestId: 'a064d6e1-d0e6-4ea8-bd4d-d88f842cfa65',
      sourceId: source.id,
      termsUrl: null,
      status: 'blocked',
    });
    const before = fetches;
    const blockedResult = await refreshBriefing(root, { fetch });
    expect(fetches).toBe(before);
    expect(blockedResult.briefing.blockedSources).toEqual([source.url]);
  });

  it('parses all-day exclusive DTEND and preserves a DST-ambiguous local event', async () => {
    const root = await fixtureRoot();
    const source = (await createBriefingApi(root).listSources())[0]!.record;
    const parsed = parseIcs(
      [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:day-1',
        'DTSTART;VALUE=DATE:20261028',
        'DTEND;VALUE=DATE:20261029',
        'SUMMARY:All day',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:dst-1',
        'DTSTART;TZID=America/New_York:20261101T013000',
        'SUMMARY:Ambiguous local time',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
      source,
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.event).toMatchObject({
      allDay: true,
      startDate: '2026-10-28',
      endDate: '2026-10-29',
    });
    expect(parsed[1]?.event).toMatchObject({
      allDay: false,
      originalTz: 'America/New_York',
      dstAmbiguous: true,
    });
    await retainBriefingRecords(root, {
      items: parsed.map(({ item }) => item),
      events: parsed.map(({ event }) => event),
    });
    expect(
      (await createBriefingApi(root).listEvents()).map(({ record }) => record.id),
    ).toHaveLength(2);
  });

  it('exposes bounded typed route envelopes over the native API contract', async () => {
    const root = await fixtureRoot();
    const read = await briefingRoute(root, 'briefing/interests', false, undefined, 0);
    expect(read).toMatchObject({ status: 200, body: { interests: [{ id: 'climate-data' }] } });
    const request = {
      requestId: 'f07c0705-08f9-4772-9175-209699e068d8',
      targetKind: 'term',
      targetId: 'climate data',
      action: 'mute-term',
    };
    const write = await briefingRoute(root, 'briefing/feedback', true, request, 0);
    expect(write).toMatchObject({
      status: 201,
      body: { feedback: { action: 'mute-term' }, replayed: false },
    });
    await expect(
      briefingRoute(root, 'briefing/feedback', true, { ...request, action: 'unknown' }, 0),
    ).rejects.toThrow('invalid_briefing_feedback');
    await expect(briefingRoute(root, 'briefing/interests', false, undefined, 1)).rejects.toThrow(
      'briefing_query_not_supported',
    );
  });

  it('parses only bounded JSON Feed text fields and validates public entry URLs', async () => {
    const root = await fixtureRoot();
    const source = (await createBriefingApi(root).listSources())[0]!.record;
    const items = parseJsonFeed(
      {
        version: 'https://jsonfeed.org/version/1.1',
        items: [
          {
            id: 'entry-1',
            url: 'https://example.test/entry/1',
            title: 'Entry title',
            content_text: 'Plain text excerpt',
            content_html: '<script>never render this</script>',
            date_published: '2026-10-28T00:00:00Z',
          },
          { id: 'private', url: 'file:///secret', title: 'Rejected scheme' },
        ],
      },
      source,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      canonicalUrl: 'https://example.test/entry/1',
      excerpt: 'Plain text excerpt',
      publishedAt: '2026-10-28T00:00:00.000Z',
    });
    expect(() => parseJsonFeed({ version: 'wrong', items: [] }, source)).toThrow(
      'invalid_json_feed',
    );
  });
});
