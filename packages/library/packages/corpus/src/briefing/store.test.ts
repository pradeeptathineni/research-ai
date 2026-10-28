import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings, loadSettings, saveSettings } from '../search-settings.js';
import {
  allDayEventFixture,
  itemFixture,
  metricObservationFixture,
  storyFixture,
} from './fixtures.js';
import {
  exportOpml,
  importBriefingOpml,
  parseIcs,
  parseJsonFeed,
  parseOpml,
  previewBriefingOpml,
  refreshBriefing,
} from './ingest.js';
import { briefingRoute } from './http.js';
import { createBriefingApi, retainBriefingRecords } from './store.js';
import { searchApi } from '../search-api.js';

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
  it('keeps OPML receipts read-only to generic settings saves', async () => {
    const root = await fixtureRoot();
    const opml =
      '<opml><body><outline text="Added" xmlUrl="https://example.test/added.xml"/></body></opml>';
    const preview = await previewBriefingOpml(root, opml);
    const requestId = '2e4ef39f-14cb-4327-b345-861c3b94920a';
    await importBriefingOpml(root, opml, requestId, preview);
    const committed = await loadSettings(root);
    const receipt = committed.briefingOpmlImports;
    await expect(saveSettings({ ...committed, briefingOpmlImports: [] }, root)).rejects.toThrow(
      'briefing_import_receipts_read_only',
    );
    await expect(
      saveSettings(
        {
          ...committed,
          briefingOpmlImports: [
            ...(receipt ?? []),
            { ...receipt![0]!, requestId: '2e4ef39f-14cb-4327-b345-861c3b94920b' },
          ],
        },
        root,
      ),
    ).rejects.toThrow('briefing_import_receipts_read_only');
    const { briefingOpmlImports: _omitted, ...legacyShape } = committed;
    await saveSettings(legacyShape, root);
    await saveSettings(committed, root);
    expect((await loadSettings(root)).briefingOpmlImports).toEqual(receipt);
  });

  it('preserves disabled Following identity when OPML updates a URL', async () => {
    const root = await fixtureRoot();
    const existing = {
      uri: 'https://example.test/extra.xml',
      label: 'Old label',
      enabled: false,
      interests: ['climate-data'],
    };
    const current = await loadSettings(root);
    await saveSettings(
      { ...current, followedSources: [...(current.followedSources ?? []), existing] },
      root,
    );
    const opml =
      '<opml><body><outline text="New label" xmlUrl="https://example.test/extra.xml"/></body></opml>';
    const preview = await previewBriefingOpml(root, opml);
    expect(preview.sources[0]?.status).toBe('update');
    await importBriefingOpml(root, opml, '7a21f9cb-a8e5-4bdd-a2f5-dd41be26d361', preview);
    expect(
      (await loadSettings(root)).followedSources?.find(({ uri }) => uri === existing.uri),
    ).toEqual({
      ...existing,
      label: 'New label',
    });
  });

  it('does not rewrite settings when an OPML request is replayed', async () => {
    const root = await fixtureRoot();
    const opml =
      '<opml><body><outline text="Added" xmlUrl="https://example.test/added.xml"/></body></opml>';
    const preview = await previewBriefingOpml(root, opml);
    const requestId = '351f3ca7-3c50-4b02-9bd1-96b27b4aec08';
    await importBriefingOpml(root, opml, requestId, preview);
    const file = join(root, '.signals/settings.json');
    const beforeBytes = await readFile(file);
    const beforeInode = (await stat(file, { bigint: true })).ino;
    expect((await importBriefingOpml(root, opml, requestId, preview)).replayed).toBe(true);
    expect(await readFile(file)).toEqual(beforeBytes);
    expect((await stat(file, { bigint: true })).ino).toBe(beforeInode);
  });

  it('keeps OPML mutations behind the existing session authority and rejects open payloads', async () => {
    const root = await fixtureRoot();
    const handler = searchApi(root);
    const call = async (path: string, method: 'GET' | 'POST', value?: unknown, token?: string) => {
      const request = Object.assign(
        Readable.from(value === undefined ? [] : [Buffer.from(JSON.stringify(value))]),
        {
          url: `/signals-ai/__signals/api/${path}`,
          method,
          headers: {
            host: '127.0.0.1:5178',
            origin: 'http://127.0.0.1:5178',
            ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
            ...(token ? { 'x-signals-token': token } : {}),
          },
        },
      );
      let status = 0;
      let payload = '';
      await handler(
        request as never,
        {
          writeHead(code: number) {
            status = code;
          },
          end(chunk?: string) {
            payload = chunk ?? '';
          },
        } as never,
      );
      return { status, body: payload ? (JSON.parse(payload) as Record<string, unknown>) : null };
    };
    const denied = await call('briefing/opml/import', 'POST', {
      opml: '<opml/>',
      requestId: '0b3a8401-3c65-4fab-9a6b-1b55a886c059',
      inputDigest: 'a'.repeat(64),
      settingsDigest: 'b'.repeat(64),
      previewDigest: 'c'.repeat(64),
    });
    expect(denied.status).toBe(403);
    expect(denied.body?.code).toBe('csrf_token_required');
    const session = await call('session', 'GET');
    const token = String(session.body?.token);
    const malformed = await call(
      'briefing/opml/preview',
      'POST',
      { opml: '<opml/>', extra: true },
      token,
    );
    expect(malformed.status).toBe(400);
    expect((await createBriefingApi(root).listSources()).length).toBe(1);
  });

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
    expect(
      parseOpml(exportOpml([{ ...source!.record, attribution: 'R&D <updates>' }]))[0]?.label,
    ).toBe('R&D <updates>');
    expect(
      parseOpml(
        exportOpml([{ ...source!.record, kind: 'atom', url: 'https://example.test/feed.atom' }]),
      )[0]?.type,
    ).toBe('atom');
    expect(() => parseOpml('<!DOCTYPE opml [<!ENTITY x "x">]><opml/>')).toThrow('invalid_opml');
    expect(() =>
      parseOpml('<opml><outline xmlUrl="https://user:pass@example.test/feed"/></opml>'),
    ).toThrow('invalid_opml_source');
  });

  it('previews, imports, reopens and refuses changed OPML replays; refresh preserves empty versus failure', async () => {
    const root = await fixtureRoot();
    const opml =
      '<opml><body><outline text="Research &amp; updates" type="rss" xmlUrl="https://example.test/extra.xml"/></body></opml>';
    const preview = (await briefingRoute(root, 'briefing/opml/preview', true, { opml }, 0))!
      .body as {
      inputDigest: string;
      settingsDigest: string;
      previewDigest: string;
      resultingSettingsDigest: string;
      sources: Array<{ status: string; label: string }>;
    };
    expect(preview.sources).toEqual([
      {
        url: 'https://example.test/extra.xml',
        label: 'Research & updates',
        type: 'rss',
        status: 'add',
      },
    ]);
    const requestId = '0b3a8401-3c65-4fab-9a6b-1b55a886c051';
    const request = {
      opml,
      requestId,
      inputDigest: preview.inputDigest,
      settingsDigest: preview.settingsDigest,
      previewDigest: preview.previewDigest,
    };
    const imported = (await briefingRoute(root, 'briefing/opml/import', true, request, 0))!
      .body as {
      replayed: boolean;
      resultingSettingsDigest: string;
      acquisition: string;
    };
    expect(imported).toMatchObject({
      replayed: false,
      acquisition: 'not_started',
      resultingSettingsDigest: preview.resultingSettingsDigest,
    });
    expect(
      (await briefingRoute(root, 'briefing/opml/import', true, request, 0))!.body,
    ).toMatchObject({ replayed: true });
    const changedPreview = (await briefingRoute(
      root,
      'briefing/opml/preview',
      true,
      { opml: opml.replace('Research &amp; updates', 'Different label') },
      0,
    ))!.body as typeof preview;
    await expect(
      briefingRoute(
        root,
        'briefing/opml/import',
        true,
        {
          opml: opml.replace('Research &amp; updates', 'Different label'),
          requestId,
          inputDigest: changedPreview.inputDigest,
          settingsDigest: changedPreview.settingsDigest,
          previewDigest: changedPreview.previewDigest,
        },
        0,
      ),
    ).rejects.toThrow('request_id_conflict');
    const cold = (await briefingRoute(
      root,
      'briefing/opml/import-status',
      false,
      undefined,
      1,
      new URLSearchParams({ requestId }),
    ))!.body as { found: boolean; receipt?: { previewDigest: string }; settingsDigest: string };
    expect(cold).toMatchObject({
      found: true,
      receipt: { previewDigest: preview.previewDigest },
      settingsDigest: preview.resultingSettingsDigest,
    });
    await expect(
      briefingRoute(
        root,
        'briefing/opml/import-status',
        false,
        undefined,
        2,
        new URLSearchParams({ requestId, extra: 'no' }),
      ),
    ).rejects.toThrow('invalid_briefing_opml_import_status_query');
    expect(await briefingRoute(root, 'briefing/opml/import', false, undefined, 0)).toBeNull();

    const api = createBriefingApi(root);
    const sources = await api.listSources();
    const importedSource = sources.find(({ record }) => record.url.endsWith('/extra.xml'))!.record;
    await api.setSourceTermsPolicy({
      requestId: '0b3a8401-3c65-4fab-9a6b-1b55a886c052',
      sourceId: importedSource.id,
      termsUrl: null,
      status: 'blocked',
    });
    let calls = 0;
    const emptyFetch = async (uri: string) => {
      calls++;
      return {
        uri,
        text: '',
        digest: 'b'.repeat(64),
        contentType: 'application/rss+xml',
        response: { status: 200, etag: 'empty', lastModified: undefined, headers: {} },
        material: {
          text: '',
          title: 'Empty fixture',
          author: null,
          publishedAt: null,
          links: [],
          sections: [],
          extractor: 'fixture',
        },
      } as never;
    };
    const emptyResult = await refreshBriefing(root, { fetch: emptyFetch });
    expect(calls).toBe(1);
    expect(emptyResult.sources[0]).toMatchObject({ state: 'fetched', health: { links: [] } });
    const afterEmpty = await createBriefingApi(root).listSources();
    expect(
      afterEmpty.find(({ record }) => record.url.endsWith('/feed.xml'))?.record.health,
    ).toMatchObject({
      lastAttemptStatus: 'fetched',
      lastSuccessfulLinkCount: 0,
    });
    expect(
      afterEmpty.find(({ record }) => record.url.endsWith('/extra.xml'))?.record.health.status,
    ).toBe('unknown');
    await refreshBriefing(root, {
      fetch: async () => {
        throw new Error('fixture_fetch_failed');
      },
    });
    const coldSources = await createBriefingApi(root).listSources();
    expect(
      coldSources.find(({ record }) => record.url.endsWith('/feed.xml'))?.record.health,
    ).toMatchObject({
      status: 'failed',
      lastAttemptStatus: 'failed',
      lastSuccessfulLinkCount: 0,
    });
    expect((await createBriefingApi(root).listSources()).length).toBe(2);
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

  it('exposes exact F1 ranking explanations with retained workbench references', async () => {
    const root = await fixtureRoot();
    const sourceId = (await createBriefingApi(root).listSources())[0]!.record.id;
    await retainBriefingRecords(root, {
      items: [{ ...itemFixture, sourceId }],
      stories: [storyFixture],
      events: [allDayEventFixture],
    });

    const response = await briefingRoute(root, 'briefing/workbench', false, undefined, 0);
    expect(response).toMatchObject({
      status: 200,
      body: {
        schema: 'signals.briefing-workbench.v1',
        ranked: [
          {
            input: {
              story: { id: storyFixture.id },
              storyReference: {
                owner: 'signals-ai',
                kind: 'briefing-story',
                id: storyFixture.id,
              },
            },
            explanation: {
              storyId: storyFixture.id,
              formula: 'briefing-linear-v1',
              inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
            },
          },
        ],
        events: [
          {
            reference: {
              owner: 'signals-ai',
              kind: 'briefing-event',
              id: allDayEventFixture.id,
            },
          },
        ],
        sources: [
          {
            reference: {
              owner: 'signals-ai',
              kind: 'briefing-source',
              id: sourceId,
            },
          },
        ],
      },
    });
    const body = response?.body as {
      ranked: Array<{
        explanation: { completeness: string; total: number };
        input: { storyReference: { revision: string } };
      }>;
      events: Array<{ reference: { revision: string } }>;
    };
    expect(body.ranked[0]?.input.storyReference.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(body.ranked[0]?.explanation).toMatchObject({ completeness: 'partial' });
    expect(body.ranked[0]?.explanation.total).toBeGreaterThanOrEqual(0);
    expect(body.ranked[0]?.explanation.total).toBeLessThanOrEqual(100);
    expect(body.events[0]?.reference.revision).toMatch(/^sha256:[a-f0-9]{64}$/);

    await createBriefingApi(root).recordFeedback({
      requestId: 'f07c0705-08f9-4772-9175-209699e068d9',
      targetKind: 'source',
      targetId: sourceId,
      action: 'mute-source',
    });
    const muted = await briefingRoute(root, 'briefing/workbench', false, undefined, 0);
    expect((muted?.body as { ranked: unknown[] }).ranked).toEqual([]);
  });

  it('previews a draft velocity weight against the same retained stories without saving it', async () => {
    const root = await fixtureRoot();
    const sourceId = (await createBriefingApi(root).listSources())[0]!.record.id;
    await retainBriefingRecords(root, {
      items: [{ ...itemFixture, sourceId }],
      stories: [storyFixture],
    });

    const before = await briefingRoute(root, 'briefing/preferences', false, undefined, 0);
    const preview = await briefingRoute(
      root,
      'briefing/preferences/ranking-preview',
      true,
      { velocityWeight: 0.2 },
      0,
    );
    expect(preview).toMatchObject({
      status: 200,
      body: {
        schema: 'signals.briefing-ranking-preview.v1',
        currentVelocityWeight: 0.05,
        draftVelocityWeight: 0.2,
        stories: [
          {
            storyId: storyFixture.id,
            storyTitle: itemFixture.title,
            storyReference: {
              owner: 'signals-ai',
              kind: 'briefing-story',
              id: storyFixture.id,
            },
            currentPosition: 1,
            draftPosition: 1,
          },
        ],
      },
    });
    const row = (preview?.body as { stories: Array<{ currentScore: number; draftScore: number }> })
      .stories[0]!;
    expect(row.currentScore).toBeGreaterThanOrEqual(0);
    expect(row.currentScore).toBeLessThanOrEqual(100);
    expect(row.draftScore).toBeGreaterThanOrEqual(0);
    expect(row.draftScore).toBeLessThanOrEqual(100);
    expect(await briefingRoute(root, 'briefing/preferences', false, undefined, 0)).toEqual(before);
    await expect(
      briefingRoute(root, 'briefing/preferences/ranking-preview', true, { velocityWeight: 0.3 }, 0),
    ).rejects.toThrow('invalid_briefing_ranking_preview');
    await expect(
      briefingRoute(root, 'briefing/preferences/ranking-preview', true, { velocityWeight: 0.1 }, 1),
    ).rejects.toThrow('briefing_query_not_supported');
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
