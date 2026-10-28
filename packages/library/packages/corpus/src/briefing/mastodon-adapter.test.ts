import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings, saveSettings } from '../search-settings.js';
import { FetchHttpError, type fetchEvidence } from '../search-fetch.js';
import { refreshDue } from './ingest.js';
import { createBriefingApi, mastodonTagTimeline } from './store.js';
import { briefingRoute } from './http.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

const endpoints = [
  'https://mastodon.one.example/api/v1/timelines/tag/climatedata',
  'https://mastodon.two.example/api/v1/timelines/tag/climatedata',
];

async function fixtureRoot() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-mastodon-tag-')));
  roots.push(root);
  await saveSettings(
    {
      ...defaultSettings,
      queries: [
        {
          id: 'climate-data',
          query: 'climate data research',
          enabled: true,
          everyDays: 2,
          offsetMinutes: 0,
          concepts: [],
        },
      ],
      followedSources: endpoints.map((uri, index) => ({
        uri,
        label: `Climate data hashtag on instance ${index + 1}`,
        enabled: true,
        interests: ['climate-data'],
      })),
    },
    root,
  );
  return root;
}

function status(
  instance: string,
  id: string,
  counts: { replies: number; boosts: number; favourites: number },
) {
  return {
    id,
    uri: `${instance}/users/alice/statuses/${id}`,
    url: `${instance}/@alice/${id}`,
    created_at: '2026-10-27T22:30:00.000Z',
    account: { acct: `alice@${new URL(instance).hostname}` },
    content: '<p>New climate data research release #ClimateData</p>',
    visibility: 'public',
    sensitive: false,
    spoiler_text: '',
    reblog: null,
    tags: [{ name: 'climatedata' }],
    replies_count: counts.replies,
    reblogs_count: counts.boosts,
    favourites_count: counts.favourites,
  };
}

function response(uri: string, json: unknown) {
  return {
    uri,
    json,
    text: JSON.stringify(json),
    digest: 'b'.repeat(64),
    contentType: 'application/json',
    response: { status: 200, etag: 'mastodon-fixture-v1', lastModified: null, headers: {} },
  } as never;
}

describe('Mastodon public hashtag Following adapter', () => {
  it('retains an instance-scoped bounded timeline through rank inputs and cold velocity replay', async () => {
    expect(mastodonTagTimeline(endpoints[0]!)).toEqual({
      origin: 'https://mastodon.one.example',
      tag: 'climatedata',
    });
    for (const invalid of [
      'http://mastodon.one.example/api/v1/timelines/tag/climatedata',
      `${endpoints[0]}?limit=100`,
      `${endpoints[0]}/extra`,
      'https://user:secret@mastodon.one.example/api/v1/timelines/tag/climatedata',
      'https://mastodon.one.example/api/v1/timelines/public',
      'https://mastodon.one.example/api/v1/timelines/tag/Climate%2Fdata',
    ])
      expect(mastodonTagTimeline(invalid)).toBeNull();

    const root = await fixtureRoot();
    const snapshots = new Map<string, { replies: number; boosts: number; favourites: number }>([
      [endpoints[0]!, { replies: 2, boosts: 3, favourites: 8 }],
      [endpoints[1]!, { replies: 1, boosts: 5, favourites: 10 }],
    ]);
    const calls: Array<{ uri: string; conditional?: unknown }> = [];
    const fetch: typeof fetchEvidence = async (uri, _signal, _redirects, _allowPdf, options) => {
      calls.push({ uri, conditional: options?.conditional });
      const endpoint = endpoints.find((value) => new URL(uri).origin === new URL(value).origin)!;
      const instance = new URL(endpoint).origin;
      const counts = snapshots.get(endpoint)!;
      const eligible = status(instance, '103206185588894565', counts);
      const excluded = [
        { ...status(instance, 'unlisted', counts), visibility: 'unlisted' },
        { ...status(instance, 'cw', counts), spoiler_text: 'Content warning' },
        { ...status(instance, 'boost', counts), reblog: status(instance, 'original', counts) },
        { ...status(instance, 'other-tag', counts), tags: [{ name: 'other' }] },
      ];
      return response(uri, [eligible, ...excluded]);
    };

    const firstId = '1c614a3a-9a39-4d80-b8cf-8f77fb140001';
    const first = await refreshDue(
      root,
      { once: true, requestId: firstId },
      { fetch, clock: () => new Date('2026-10-28T00:00:00.000Z') },
    );
    expect(first).toMatchObject({ status: 'complete', replayed: false });
    expect(calls.map(({ uri }) => uri)).toEqual(endpoints.map((uri) => `${uri}?limit=10`));
    expect(calls.map(({ conditional }) => conditional)).toEqual([undefined, undefined]);

    const api = createBriefingApi(root);
    const sources = await api.listSources();
    expect(sources.map(({ record }) => record.kind)).toEqual([
      'api:mastodon-tag',
      'api:mastodon-tag',
    ]);
    expect(sources.map(({ record }) => record.health.status)).toEqual(['healthy', 'healthy']);
    expect(sources.map(({ record }) => record.health.lastSuccessfulLinkCount)).toEqual([1, 1]);
    expect(sources.map(({ record }) => record.termsRef)).toEqual([null, null]);
    const items = await api.listItems({ limit: 20 });
    expect(items).toHaveLength(2);
    const originalItemIds = items.map(({ record }) => record.id).sort();
    expect(items.map(({ record }) => record.canonicalUrl).sort()).toEqual(
      endpoints.map((endpoint) => `${new URL(endpoint).origin}/@alice/103206185588894565`).sort(),
    );
    expect(items.map(({ record }) => record.excerpt)).toEqual([
      'New climate data research release #ClimateData',
      'New climate data research release #ClimateData',
    ]);
    const firstInputs = await api.listRankInputs();
    expect(firstInputs).toHaveLength(2);
    for (const input of firstInputs) {
      expect(input.items[0]?.source.kind).toBe('api:mastodon-tag');
      expect(input.items[0]?.source.url).toMatch(
        /^https:\/\/mastodon\.[a-z]+\.example\/api\/v1\/timelines\/tag\/climatedata$/,
      );
      expect(input.metrics).toHaveLength(3);
      expect(new Set(input.metrics.map(({ platform }) => platform)).size).toBe(1);
      expect(input.metrics[0]?.platform).toMatch(/^mastodon-mastodon-[a-z]+-example-[a-f0-9]{8}$/);
      expect(input.metrics[0]?.sourceRef).toBe(`${input.items[0]?.source.url}?limit=10`);
      expect(input.metrics[0]?.scope).toBe('instance-view counts; not cross-instance totals');
      expect(
        input.metrics.every(({ observedAt }) => observedAt === '2026-10-28T00:00:00.000Z'),
      ).toBe(true);
    }
    expect(firstInputs[0]?.metrics[0]?.platform).not.toBe(firstInputs[1]?.metrics[0]?.platform);

    const firstWorkbench = (await briefingRoute(root, 'briefing/workbench', false, undefined, 0))!
      .body as {
      ranked: Array<{
        input: { items: Array<{ source: { url: string } }> };
        explanation: { components: { velocity: { status: string; refs: string[] } } };
      }>;
    };
    expect(firstWorkbench.ranked).toHaveLength(2);
    expect(
      firstWorkbench.ranked.every(
        ({ explanation }) => explanation.components.velocity.status === 'insufficient-observations',
      ),
    ).toBe(true);

    const callsAfterFirst = calls.length;
    const replay = await refreshDue(root, { once: true, requestId: firstId }, { fetch });
    expect(replay).toMatchObject({ status: 'complete', replayed: true });
    expect(calls).toHaveLength(callsAfterFirst);

    snapshots.set(endpoints[0]!, { replies: 6, boosts: 5, favourites: 20 });
    snapshots.set(endpoints[1]!, { replies: 4, boosts: 6, favourites: 30 });
    const second = await refreshDue(
      root,
      { once: true, requestId: '1c614a3a-9a39-4d80-b8cf-8f77fb140002' },
      { fetch, clock: () => new Date('2026-10-28T01:00:00.000Z') },
    );
    expect(second.result?.sources.map(({ delta }) => delta)).toEqual([
      'content-changed-meaning-unassessed',
      'content-changed-meaning-unassessed',
    ]);
    const coldInputs = await api.listRankInputs();
    expect(coldInputs.map(({ metrics }) => metrics.length)).toEqual([6, 6]);
    expect((await api.listItems({ limit: 20 })).map(({ record }) => record.id).sort()).toEqual(
      originalItemIds,
    );
    const coldWorkbench = (await briefingRoute(root, 'briefing/workbench', false, undefined, 0))!
      .body as typeof firstWorkbench;
    expect(coldWorkbench.ranked).toHaveLength(2);
    expect(
      coldWorkbench.ranked.every(
        ({ explanation }) =>
          explanation.components.velocity.status === 'available' &&
          explanation.components.velocity.refs.length === 2,
      ),
    ).toBe(true);

    const blockedSource = sources[0]!.record;
    await api.setSourceTermsPolicy({
      requestId: '1c614a3a-9a39-4d80-b8cf-8f77fb140003',
      sourceId: blockedSource.id,
      termsUrl: 'https://mastodon.one.example/about',
      status: 'blocked',
    });
    calls.length = 0;
    const blocked = await refreshDue(
      root,
      { once: true, requestId: '1c614a3a-9a39-4d80-b8cf-8f77fb140004' },
      { fetch, clock: () => new Date('2026-10-28T02:00:00.000Z') },
    );
    expect(blocked.result?.blockedSourceIds).toEqual([blockedSource.id]);
    expect(calls.map(({ uri }) => uri)).toEqual([`${endpoints[1]}?limit=10`]);
    const afterBlocked = await api.listRankInputs();
    expect(
      afterBlocked.find(({ items: members }) => members[0]?.source.id === blockedSource.id)
        ?.metrics,
    ).toHaveLength(6);
    expect(
      (await api.listSources()).find(({ record }) => record.id === blockedSource.id)?.record
        .termsRef,
    ).not.toBeNull();
  });

  it('records an instance that requires authorization as failed without trying to acquire credentials', async () => {
    const root = await fixtureRoot();
    const calls: string[] = [];
    const fetch: typeof fetchEvidence = async (uri) => {
      calls.push(uri);
      throw new FetchHttpError('source_denied_401', { status: 401 });
    };
    const result = await refreshDue(
      root,
      { once: true, requestId: '1c614a3a-9a39-4d80-b8cf-8f77fb140005' },
      { fetch },
    );
    expect(calls).toEqual(endpoints.map((uri) => `${uri}?limit=10`));
    expect(
      result.result?.sources.map(({ state, failureReason }) => ({ state, failureReason })),
    ).toEqual([
      { state: 'failed', failureReason: 'source_denied_401' },
      { state: 'failed', failureReason: 'source_denied_401' },
    ]);
    const api = createBriefingApi(root);
    expect(await api.listItems()).toEqual([]);
    expect((await api.listSources()).map(({ record }) => record.health.status)).toEqual([
      'failed',
      'failed',
    ]);
  });
});
