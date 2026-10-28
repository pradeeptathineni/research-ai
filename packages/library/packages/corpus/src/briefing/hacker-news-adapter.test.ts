import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings, saveSettings } from '../search-settings.js';
import { refreshDue } from './ingest.js';
import { createBriefingApi, isHackerNewsIndexUri } from './store.js';
import { briefingRoute } from './http.js';
import { type fetchEvidence } from '../search-fetch.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

const indexUri = 'https://hacker-news.firebaseio.com/v0/topstories.json';

async function sourceRoot() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-hacker-news-')));
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
          uri: indexUri,
          label: 'Hacker News top stories',
          enabled: true,
          interests: ['climate-data'],
        },
      ],
    },
    root,
  );
  return root;
}

function hnItem(id: number) {
  return {
    id,
    type: 'story',
    by: `author-${id}`,
    time: 1_798_000_000,
    title: `Climate data release ${id}`,
    url: `https://publisher.example.test/releases/${id}`,
    text: '<p>New climate data is now available.</p>',
    score: 12,
    descendants: 4,
  };
}

function response(uri: string, json: unknown) {
  return {
    uri,
    json,
    text: JSON.stringify(json),
    digest: 'a'.repeat(64),
    contentType: 'application/json',
    response: { status: 200, etag: 'fixture-v1', lastModified: null, headers: {} },
  } as never;
}

describe('Hacker News public API Following adapter', () => {
  it('retains a bounded top-story pass with exact source/item/story identity and ranking', async () => {
    expect(isHackerNewsIndexUri(indexUri)).toBe(true);
    expect(isHackerNewsIndexUri(`${indexUri}?print=pretty`)).toBe(true);
    expect(isHackerNewsIndexUri('http://hacker-news.firebaseio.com/v0/topstories.json')).toBe(
      false,
    );
    expect(
      isHackerNewsIndexUri('https://hacker-news.firebaseio.com.attacker.test/v0/topstories.json'),
    ).toBe(false);
    expect(isHackerNewsIndexUri('https://hacker-news.firebaseio.com/v0/user/ada.json')).toBe(false);
    expect(isHackerNewsIndexUri(`${indexUri}?print=pretty&other=1`)).toBe(false);
    const root = await sourceRoot();
    const ids = Array.from({ length: 21 }, (_, index) => index + 101);
    const calls: Array<{
      uri: string;
      conditional?: { etag?: string; lastModified?: string };
      allowNotModified?: boolean;
    }> = [];
    const fetch: typeof fetchEvidence = async (uri, _signal, _redirects, _allowPdf, options) => {
      calls.push({
        uri,
        conditional: options?.conditional,
        allowNotModified: options?.allowNotModified,
      });
      if (uri === indexUri) return response(uri, ids);
      const itemId = Number(uri.split('/').at(-1)?.replace('.json', ''));
      return response(uri, hnItem(itemId));
    };

    const firstRequestId = '131c32fd-b456-4cf3-866c-2e036524d901';
    const pass = await refreshDue(root, { once: true, requestId: firstRequestId }, { fetch });
    expect(pass).toMatchObject({ status: 'complete', replayed: false });
    expect(pass.result?.sources[0]?.state).toBe('fetched');
    expect(calls).toHaveLength(21);
    expect(calls[0]?.uri).toBe(indexUri);
    expect(calls.at(-1)?.uri).toBe('https://hacker-news.firebaseio.com/v0/item/120.json');
    expect(calls.map(({ uri }) => uri)).not.toContain(
      'https://hacker-news.firebaseio.com/v0/item/121.json',
    );

    const api = createBriefingApi(root);
    const [source] = await api.listSources();
    const items = await api.listItems({ limit: 100 });
    const stories = await api.listStories({ limit: 100 });
    expect(source?.record).toMatchObject({
      kind: 'api:hacker-news',
      health: { status: 'healthy', lastSuccessfulLinkCount: 21 },
      termsRef: null,
    });
    expect(items).toHaveLength(20);
    expect(stories).toHaveLength(20);
    const item = items.find(({ record }) => record.canonicalUrl.endsWith('/releases/101'))!;
    expect(item.record).toMatchObject({
      sourceId: source?.record.id,
      title: 'Climate data release 101',
      author: 'author-101',
      excerpt: 'New climate data is now available.',
      canonicalUrl: 'https://publisher.example.test/releases/101',
      publishedAt: new Date(1_798_000_000_000).toISOString(),
    });
    expect(item.reference).toMatchObject({ owner: 'signals-ai', kind: 'briefing-item' });
    expect(item.reference.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(
      stories.find(({ record }) => record.representativeItemId === item.record.id)?.reference,
    ).toMatchObject({ owner: 'signals-ai', kind: 'briefing-story' });

    const workbench = (await briefingRoute(root, 'briefing/workbench', false, undefined, 0))!;
    const ranked = (workbench.body as { ranked: Array<{ input: { story: { id: string } } }> })
      .ranked;
    expect(ranked).toHaveLength(20);
    expect(ranked.some(({ input }) => input.story.id === stories[0]?.record.id)).toBe(true);

    const firstReplay = await refreshDue(
      root,
      { once: true, requestId: firstRequestId },
      { fetch },
    );
    expect(firstReplay).toMatchObject({ status: 'complete', replayed: true });
    expect(calls).toHaveLength(21);
    expect((await api.listItems({ limit: 100 })).length).toBe(20);

    const priorItemRevision = item.reference.revision;
    const repeated = await refreshDue(
      root,
      { once: true, requestId: '131c32fd-b456-4cf3-866c-2e036524d902' },
      { fetch },
    );
    expect(repeated.result?.sources[0]?.delta).toBe('unchanged');
    expect(calls).toHaveLength(42);
    expect(calls[21]?.uri).toBe(indexUri);
    expect(calls[21]?.conditional).toBeUndefined();
    expect(calls[21]?.allowNotModified).toBeUndefined();
    expect(
      (await api.listItems({ limit: 100 })).find(({ record }) => record.id === item.record.id)
        ?.reference.revision,
    ).toBe(priorItemRevision);

    const changedFetch: typeof fetchEvidence = async (uri) => {
      if (uri === indexUri) return response(uri, ids);
      const itemId = Number(uri.split('/').at(-1)?.replace('.json', ''));
      return response(
        uri,
        itemId === 101
          ? { ...hnItem(itemId), title: 'Climate data release revised' }
          : hnItem(itemId),
      );
    };
    const changed = await refreshDue(
      root,
      { once: true, requestId: '131c32fd-b456-4cf3-866c-2e036524d903' },
      { fetch: changedFetch },
    );
    expect(changed.result?.sources[0]?.delta).toBe('content-changed-meaning-unassessed');
    const successors = (await api.listItems({ limit: 100 })).filter(
      ({ record }) => record.canonicalUrl === item.record.canonicalUrl,
    );
    expect(successors).toHaveLength(2);
    expect(new Set(successors.map(({ record }) => record.contentDigest)).size).toBe(2);
    expect(successors.some(({ reference }) => reference.revision === priorItemRevision)).toBe(true);
  });

  it('fails malformed index data and leaves unknown/blocked source terms explicit', async () => {
    const root = await sourceRoot();
    const calls: string[] = [];
    const invalidFetch: typeof fetchEvidence = async (uri) => {
      calls.push(uri);
      return response(uri, [101, '102']);
    };
    const failed = await refreshDue(
      root,
      { once: true, requestId: 'ae631bb4-3110-4b29-9382-190020280002' },
      { fetch: invalidFetch },
    );
    expect(failed.result?.sources[0]?.state).toBe('failed');
    expect(calls).toEqual([indexUri]);
    const api = createBriefingApi(root);
    expect((await api.listSources())[0]?.record.health.status).toBe('failed');
    expect((await api.listSources())[0]?.record.termsRef).toBeNull();
    expect(await api.listItems()).toEqual([]);

    const sourceId = (await api.listSources())[0]!.record.id;
    await api.setSourceTermsPolicy({
      requestId: 'ae631bb4-3110-4b29-9382-190020280001',
      sourceId,
      termsUrl: 'https://github.com/HackerNews/API',
      status: 'blocked',
    });
    calls.length = 0;
    const blocked = await refreshDue(
      root,
      { once: true, requestId: 'ae631bb4-3110-4b29-9382-190020280003' },
      { fetch: invalidFetch },
    );
    expect(blocked.result?.blockedSourceIds).toEqual([sourceId]);
    expect(blocked.result?.sources).toEqual([]);
    expect(calls).toEqual([]);
    expect((await api.listSources())[0]?.record.termsRef).not.toBeNull();
  });

  it('retains request-identified score snapshots and exposes velocity only after a later observation', async () => {
    const root = await sourceRoot();
    const calls: string[] = [];
    let score = 12;
    let descendants = 4;
    const fetch: typeof fetchEvidence = async (uri) => {
      calls.push(uri);
      return response(uri, uri === indexUri ? [901] : { ...hnItem(901), score, descendants });
    };
    const firstId = 'f7db905b-12c9-4e7b-9a4e-a1b716a10d01';
    const first = await refreshDue(
      root,
      { once: true, requestId: firstId },
      { fetch, clock: () => new Date('2026-10-28T00:00:00.000Z') },
    );
    expect(first).toMatchObject({ status: 'complete', replayed: false });
    const api = createBriefingApi(root);
    const firstInputs = await api.listRankInputs();
    expect(firstInputs).toHaveLength(1);
    expect(firstInputs[0]?.metrics).toHaveLength(2);
    expect(firstInputs[0]?.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: 'hacker-news',
          name: 'score',
          value: 12,
          observedAt: '2026-10-28T00:00:00.000Z',
          sourceRef: 'https://hacker-news.firebaseio.com/v0/item/901.json',
          method: 'public-adapter',
        }),
        expect.objectContaining({ name: 'comments', value: 4 }),
      ]),
    );
    const firstWorkbench = (await briefingRoute(root, 'briefing/workbench', false, undefined, 0))!
      .body as {
        ranked: Array<{
          explanation: {
            components: { velocity: { status: string; reason: string; refs: string[] } };
          };
        }>;
      };
    expect(firstWorkbench.ranked[0]?.explanation.components.velocity).toMatchObject({
      status: 'insufficient-observations',
      refs: [],
    });

    const callsAfterFirst = calls.length;
    score = 99;
    const replay = await refreshDue(root, { once: true, requestId: firstId }, { fetch });
    expect(replay).toMatchObject({ status: 'complete', replayed: true });
    expect(calls).toHaveLength(callsAfterFirst);
    expect((await api.listRankInputs())[0]?.metrics).toHaveLength(2);

    score = 24;
    descendants = 8;
    const second = await refreshDue(
      root,
      { once: true, requestId: 'f7db905b-12c9-4e7b-9a4e-a1b716a10d02' },
      { fetch, clock: () => new Date('2026-10-28T01:00:00.000Z') },
    );
    expect(second.result?.sources[0]?.delta).toBe('content-changed-meaning-unassessed');
    const coldInputs = await api.listRankInputs();
    expect(coldInputs[0]?.metrics).toHaveLength(4);
    expect(new Set(coldInputs[0]?.metrics.map((metric) => metric.id)).size).toBe(4);
    const secondWorkbench = (await briefingRoute(root, 'briefing/workbench', false, undefined, 0))!
      .body as typeof firstWorkbench;
    const velocity = secondWorkbench.ranked[0]?.explanation.components.velocity;
    expect(velocity?.status).toBe('available');
    expect(velocity?.refs).toHaveLength(2);
    expect(velocity?.reason).toContain('hacker-news:score');
    expect((await api.listSources())[0]?.record.termsRef).toBeNull();
  });
});
