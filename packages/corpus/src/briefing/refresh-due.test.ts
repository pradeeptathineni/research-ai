import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings, saveSettings } from '../search-settings.js';
import { briefingRoute } from './http.js';
import { refreshDue } from './ingest.js';
import { createBriefingApi } from './store.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

async function fixtureRoot() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-briefing-refresh-due-')));
  roots.push(root);
  await saveSettings(
    {
      ...defaultSettings,
      queries: [
        {
          id: 'climate-data',
          query: 'climate data release',
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

describe('Briefing refreshDue owner workflow', () => {
  it('claims once, reuses Following validators, cold-reads exact outcomes and preserves story/event behavior', async () => {
    const root = await fixtureRoot();
    const opml =
      '<opml><body><outline text="Webinar calendar" type="ical" xmlUrl="https://example.test/calendar.ics"/></body></opml>';
    const preview = (await briefingRoute(root, 'briefing/opml/preview', true, { opml }, 0))!
      .body as {
      inputDigest: string;
      settingsDigest: string;
      previewDigest: string;
    };
    const imported = await briefingRoute(
      root,
      'briefing/opml/import',
      true,
      {
        opml,
        requestId: '0b3a8401-3c65-4fab-9a6b-1b55a886c051',
        inputDigest: preview.inputDigest,
        settingsDigest: preview.settingsDigest,
        previewDigest: preview.previewDigest,
      },
      0,
    );
    expect(imported?.body).toMatchObject({ acquisition: 'not_started', replayed: false });

    const firstRequestId = '0b3a8401-3c65-4fab-9a6b-1b55a886c052';
    const firstCalls: Array<{
      uri: string;
      options?: { conditional?: Record<string, string>; allowNotModified?: boolean };
    }> = [];
    const firstFetch = async (
      uri: string,
      _signal?: AbortSignal,
      _redirects?: number,
      _allowPdf?: boolean,
      options?: { conditional?: Record<string, string>; allowNotModified?: boolean },
    ) => {
      firstCalls.push({ uri, options });
      if (uri.endsWith('/calendar.ics'))
        return {
          uri,
          text: [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:synthetic-webinar',
            'DTSTART;VALUE=DATE:20261029',
            'DTEND;VALUE=DATE:20261030',
            'SUMMARY:Climate data release webinar',
            'END:VEVENT',
            'END:VCALENDAR',
          ].join('\r\n'),
          digest: 'c'.repeat(64),
          contentType: 'text/calendar',
          response: {
            status: 200,
            etag: 'calendar-v1',
            lastModified: 'Wed, 28 Oct 2026 00:00:00 GMT',
            headers: {},
          },
        } as never;
      return {
        uri,
        text: 'Climate data release\nA synthetic feed item.',
        digest: 'a'.repeat(64),
        contentType: 'application/rss+xml',
        response: {
          status: 200,
          etag: 'feed-v1',
          lastModified: 'Wed, 28 Oct 2026 00:00:00 GMT',
          headers: {},
        },
        material: {
          text: 'Climate data release\nA synthetic feed item.',
          title: 'Example feed',
          author: null,
          publishedAt: '2026-10-28T00:00:00.000Z',
          links: [
            { uri: 'https://example.test/story/climate-release', title: 'Climate data release' },
          ],
          sections: [{ locator: 'item:1', text: 'A synthetic climate data update.' }],
          extractor: 'synthetic-fixture',
        },
      } as never;
    };

    const first = await refreshDue(
      root,
      { once: true, requestId: firstRequestId },
      { fetch: firstFetch },
    );
    expect(first).toMatchObject({ status: 'complete', replayed: false });
    expect(firstCalls).toHaveLength(2);
    expect(firstCalls.every(({ options }) => options?.allowNotModified !== true)).toBe(true);

    const replay = await briefingRoute(
      root,
      'briefing/refresh',
      true,
      { once: true, requestId: firstRequestId },
      0,
    );
    expect(replay?.body).toMatchObject({ status: 'complete', replayed: true });
    expect(firstCalls).toHaveLength(2);
    await expect(
      refreshDue(
        root,
        { once: true, requestId: firstRequestId, interest: 'other-interest' },
        { fetch: firstFetch },
      ),
    ).rejects.toThrow('request_id_conflict');

    const status = await briefingRoute(
      root,
      'briefing/refresh-status',
      false,
      undefined,
      1,
      new URLSearchParams({ requestId: firstRequestId }),
    );
    expect(status?.body).toMatchObject({
      found: true,
      receipt: { requestId: firstRequestId, status: 'complete', result: { capturedDocuments: 2 } },
    });
    const unknownId = '0b3a8401-3c65-4fab-9a6b-1b55a886c059';
    const unknownStatus = await briefingRoute(
      root,
      'briefing/refresh-status',
      false,
      undefined,
      1,
      new URLSearchParams({ requestId: unknownId }),
    );
    expect(unknownStatus?.body).toEqual({ found: false, requestId: unknownId });
    await expect(
      briefingRoute(
        root,
        'briefing/refresh-status',
        false,
        undefined,
        2,
        new URLSearchParams({ requestId: firstRequestId, extra: '1' }),
      ),
    ).rejects.toThrow('invalid_briefing_refresh_status_query');

    const pendingId = '0b3a8401-3c65-4fab-9a6b-1b55a886c053';
    const pendingFetchCalls: string[] = [];
    const pendingFetcher = async (uri: string) => {
      pendingFetchCalls.push(uri);
      throw new Error('must_not_be_called_for_pending_request');
    };
    // Simulate process loss after the durable claim but before fetch or completion.
    const { beginBriefingRefresh } = await import('./store.js');
    const itemCountBeforePendingReplay = (await createBriefingApi(root).listItems()).length;
    await beginBriefingRefresh(root, pendingId);
    const pendingReplay = await refreshDue(
      root,
      { once: true, requestId: pendingId },
      { fetch: pendingFetcher },
    );
    expect(pendingReplay).toMatchObject({ status: 'pending', replayed: true });
    expect(pendingFetchCalls).toEqual([]);
    expect(await createBriefingApi(root).listItems()).toHaveLength(itemCountBeforePendingReplay);
    const pendingStatus = await briefingRoute(
      root,
      'briefing/refresh-status',
      false,
      undefined,
      1,
      new URLSearchParams({ requestId: pendingId }),
    );
    expect(pendingStatus?.body).toMatchObject({
      found: true,
      receipt: { requestId: pendingId, status: 'pending', completedAt: null, result: null },
    });

    const secondRequestId = '0b3a8401-3c65-4fab-9a6b-1b55a886c054';
    const secondCalls: Array<{
      uri: string;
      conditional?: Record<string, string>;
      allowNotModified?: boolean;
    }> = [];
    const notModifiedFetch = async (
      uri: string,
      _signal?: AbortSignal,
      _redirects?: number,
      _allowPdf?: boolean,
      options?: { conditional?: Record<string, string>; allowNotModified?: boolean },
    ) => {
      secondCalls.push({
        uri,
        conditional: options?.conditional,
        allowNotModified: options?.allowNotModified,
      });
      return {
        uri,
        text: '',
        digest: 'd'.repeat(64),
        contentType: uri.endsWith('.ics') ? 'text/calendar' : 'application/rss+xml',
        response: {
          status: 304,
          etag: options?.conditional?.etag,
          lastModified: options?.conditional?.lastModified,
          headers: {},
        },
      } as never;
    };
    const second = await refreshDue(
      root,
      { once: true, requestId: secondRequestId },
      { fetch: notModifiedFetch },
    );
    expect(second).toMatchObject({ status: 'complete', replayed: false });
    expect(secondCalls).toHaveLength(2);
    expect(
      secondCalls.every(
        ({ allowNotModified, conditional }) => allowNotModified && conditional?.etag,
      ),
    ).toBe(true);

    const api = createBriefingApi(root);
    const coldSources = await api.listSources();
    expect(coldSources).toHaveLength(2);
    expect(coldSources.every(({ record }) => record.health.status === 'healthy')).toBe(true);
    expect(
      coldSources.every(({ record }) => record.health.lastAttemptStatus === 'not-modified'),
    ).toBe(true);
    const workbench = (await briefingRoute(root, 'briefing/workbench', false, undefined, 0))!
      .body as {
      ranked: Array<{
        explanation: { formula: string; total: number };
        input: { items: Array<{ item: { id: string; sourceId: string } }> };
      }>;
    };
    expect(workbench.ranked).toHaveLength(2);
    expect(
      workbench.ranked.every(
        ({ explanation }) =>
          explanation.formula === 'briefing-linear-v1' &&
          explanation.total >= 0 &&
          explanation.total <= 100,
      ),
    ).toBe(true);

    const feedSourceId = coldSources.find(({ record }) => record.url.endsWith('/feed.xml'))!.record
      .id;
    // Resolve the feed story using its retained representative item identity.
    const feedItemId = (await api.listItems()).find(
      ({ record }) => record.sourceId === feedSourceId,
    )!.record.id;
    const exactStory = (await api.listStories()).find(
      ({ record }) => record.representativeItemId === feedItemId,
    )!.record;
    expect(
      workbench.ranked.some(({ input }) => input.items.some(({ item }) => item.id === feedItemId)),
    ).toBe(true);

    const mute = await briefingRoute(
      root,
      'briefing/feedback',
      true,
      {
        requestId: '0b3a8401-3c65-4fab-9a6b-1b55a886c055',
        targetKind: 'source',
        targetId: feedSourceId,
        action: 'mute-source',
      },
      0,
    );
    expect(mute?.status).toBe(201);
    const afterMute = (await briefingRoute(root, 'briefing/workbench', false, undefined, 0))!
      .body as typeof workbench;
    expect(
      afterMute.ranked.some(({ input }) =>
        input.items.some(({ item }) => item.sourceId === feedSourceId),
      ),
    ).toBe(false);
    const undoMute = await briefingRoute(
      root,
      'briefing/feedback/undo',
      true,
      {
        requestId: '0b3a8401-3c65-4fab-9a6b-1b55a886c056',
        feedbackId: (mute!.body as { feedback: { id: string } }).feedback.id,
      },
      0,
    );
    expect(undoMute?.status).toBe(201);

    const snoozeUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const snooze = await briefingRoute(
      root,
      'briefing/feedback',
      true,
      {
        requestId: '0b3a8401-3c65-4fab-9a6b-1b55a886c057',
        targetKind: 'story',
        targetId: exactStory.id,
        action: 'snooze',
        until: snoozeUntil,
      },
      0,
    );
    const whileSnoozed = (await briefingRoute(root, 'briefing/workbench', false, undefined, 0))!
      .body as typeof workbench;
    expect(
      whileSnoozed.ranked.some(({ input }) =>
        input.items.some(({ item }) => item.sourceId === feedSourceId),
      ),
    ).toBe(false);
    const undoSnooze = await briefingRoute(
      root,
      'briefing/feedback/undo',
      true,
      {
        requestId: '0b3a8401-3c65-4fab-9a6b-1b55a886c058',
        feedbackId: (snooze!.body as { feedback: { id: string } }).feedback.id,
      },
      0,
    );
    expect(undoSnooze?.status).toBe(201);
    const afterUndo = (await briefingRoute(root, 'briefing/workbench', false, undefined, 0))!
      .body as typeof workbench;
    expect(
      afterUndo.ranked.some(({ input }) =>
        input.items.some(({ item }) => item.sourceId === feedSourceId),
      ),
    ).toBe(true);

    const event = (await api.listEvents())[0]!.record;
    const calendar = await briefingRoute(
      root,
      'briefing/events/calendar',
      false,
      undefined,
      1,
      new URLSearchParams({ eventId: event.id }),
    );
    expect((calendar?.body as { ics: string }).ics).toContain('DTSTART;VALUE=DATE:20261029');
    expect((calendar?.body as { ics: string }).ics).toContain('DTEND;VALUE=DATE:20261030');
    expect((await createBriefingApi(root).listItems()).length).toBe(2);
    expect((await createBriefingApi(root).listEvents()).length).toBe(1);
  });
});
