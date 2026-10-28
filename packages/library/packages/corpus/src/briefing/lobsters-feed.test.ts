import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cachedMaterial, extractFeed } from '../search-document.js';
import { defaultSettings, saveSettings } from '../search-settings.js';
import { type fetchEvidence } from '../search-fetch.js';
import { refreshDue } from './ingest.js';
import { createBriefingApi, lobstersPublicFeed } from './store.js';
import { briefingRoute } from './http.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

const frontUri = 'https://lobste.rs/rss';
const newestUri = 'https://lobste.rs/newest.rss';
const storyUri = 'https://lobste.rs/s/abc123/typed_feed_identity';
const feed = (title: string, guid: string) => `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Lobsters</title>
  <item><title>${title}</title><link>${storyUri}</link><guid>${guid}</guid>
    <author>alice</author><pubDate>Sun, 25 Oct 2026 10:00:00 GMT</pubDate>
    <description>Systems design discussion with operational lessons.</description>
  </item>
</channel></rss>`;

function response(uri: string, xml: string) {
  const digest = createHash('sha256').update(xml).digest('hex');
  return extractFeed(xml, uri).then((material) => ({
    uri,
    text: material.text,
    material,
    digest,
    contentType: 'application/rss+xml',
    response: {
      status: 200,
      etag: `fixture-${digest.slice(0, 8)}`,
      lastModified: null,
      headers: {},
    },
  })) as ReturnType<typeof fetchEvidence>;
}

describe('Lobsters public RSS Following adapter', () => {
  it('retains exact source/story identities through interest ranking, policy block and cold read', async () => {
    expect(lobstersPublicFeed(frontUri)).toBe(true);
    expect(lobstersPublicFeed(newestUri)).toBe(true);
    expect(lobstersPublicFeed('https://lobste.rs/t/systems.rss')).toBe(false);
    for (const invalid of [
      'http://lobste.rs/rss',
      'https://lobste.rs.attacker.test/rss',
      'https://alice@lobste.rs/rss',
      'https://lobste.rs/search.rss?q=systems',
      'https://lobste.rs/rss?token=x',
      'https://lobste.rs/t/contains%2Fslash.rss',
    ])
      expect(lobstersPublicFeed(invalid)).toBe(false);

    const material = await extractFeed(feed('Systems design in production', storyUri), frontUri);
    expect(material.links).toEqual([{ uri: storyUri, title: 'Systems design in production' }]);
    expect(material.feedEntries).toEqual([
      {
        identity: storyUri,
        author: 'alice',
        publishedAt: '2026-10-25T10:00:00.000Z',
      },
    ]);
    const previousCacheShape = structuredClone(material);
    delete previousCacheShape.feedEntries;
    expect(cachedMaterial(previousCacheShape)).toEqual(previousCacheShape);

    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-lobsters-')));
    roots.push(root);
    await saveSettings(
      {
        ...defaultSettings,
        queries: [
          {
            id: 'systems-design',
            query: 'systems design',
            enabled: true,
            everyDays: 2,
            offsetMinutes: 0,
            concepts: [],
          },
        ],
        followedSources: [
          {
            uri: frontUri,
            label: 'Lobsters front page',
            enabled: true,
            interests: ['systems-design'],
          },
          {
            uri: newestUri,
            label: 'Lobsters newest',
            enabled: true,
            interests: ['systems-design'],
          },
        ],
      },
      root,
    );
    const bodies = new Map([
      [frontUri, feed('Systems design in production', storyUri)],
      [newestUri, feed('Systems design notes from operators', 'lobsters:item:newest-42')],
    ]);
    const calls: string[] = [];
    const fetch: typeof fetchEvidence = async (uri) => {
      calls.push(uri);
      const body = bodies.get(uri);
      if (!body) throw new Error('unexpected_feed_request');
      return response(uri, body);
    };
    const now = new Date('2026-10-28T12:00:00.000Z');
    const firstId = '8d0724ee-2034-49d2-903a-661100648a58';
    const first = await refreshDue(
      root,
      { once: true, requestId: firstId },
      { fetch, clock: () => now },
    );
    expect(first).toMatchObject({ status: 'complete', replayed: false });
    expect(first.result?.sources).toHaveLength(2);
    expect(first.result?.sources.every((source) => source.state === 'fetched')).toBe(true);
    expect(calls).toEqual([frontUri, newestUri]);

    const api = createBriefingApi(root);
    const sources = await api.listSources();
    expect(sources.map(({ record }) => record.kind)).toEqual(['rss', 'rss']);
    expect(sources.every(({ record }) => record.termsRef === null)).toBe(true);
    expect(sources.every(({ record }) => record.health.status === 'healthy')).toBe(true);
    expect(sources.every(({ record }) => record.health.lastSuccessfulLinkCount === 1)).toBe(true);
    const items = await api.listItems({ limit: 100 });
    expect(items).toHaveLength(2);
    expect(items.every(({ record }) => record.canonicalUrl === storyUri)).toBe(true);
    expect(items.every(({ record }) => record.author === 'alice')).toBe(true);
    expect(items.every(({ record }) => record.publishedAt === '2026-10-25T10:00:00.000Z')).toBe(
      true,
    );
    expect(items.every(({ record }) => record.observedAt === now.toISOString())).toBe(true);
    expect(new Set(items.map(({ record }) => record.id)).size).toBe(2);

    const workbench = (await briefingRoute(root, 'briefing/workbench', false, undefined, 0))!;
    const ranked = (
      workbench.body as {
        ranked: Array<{
          input: { story: { representativeItemId: string } };
          explanation: { total: number | null };
        }>;
      }
    ).ranked;
    expect(ranked).toHaveLength(2);
    expect(ranked.every(({ explanation }) => typeof explanation.total === 'number')).toBe(true);
    expect(
      ranked.every(({ input }) =>
        items.some(({ record }) => record.id === input.story.representativeItemId),
      ),
    ).toBe(true);

    const replay = await refreshDue(
      root,
      { once: true, requestId: firstId },
      { fetch, clock: () => now },
    );
    expect(replay).toMatchObject({ status: 'complete', replayed: true });
    expect(calls).toHaveLength(2);
    expect(
      (await createBriefingApi(root).listItems({ limit: 100 })).map(
        ({ reference }) => reference.revision,
      ),
    ).toEqual(items.map(({ reference }) => reference.revision));

    const blockedSource = sources.find(({ record }) => record.url === newestUri)!.record;
    await api.setSourceTermsPolicy({
      requestId: 'fb82323d-f46c-48dd-af91-405e83bdd906',
      sourceId: blockedSource.id,
      termsUrl: null,
      status: 'blocked',
    });
    const second = await refreshDue(
      root,
      { once: true, requestId: '2f29e3ef-4c7d-4d0c-bbf5-b8195fd07939' },
      { fetch, clock: () => now },
    );
    expect(second.result?.blockedSourceIds).toContain(blockedSource.id);
    expect(calls).toEqual([frontUri, newestUri, frontUri]);
  });

  it('rejects a feed response whose final URI is not the exact followed collection', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-lobsters-redirect-')));
    roots.push(root);
    await saveSettings(
      {
        ...defaultSettings,
        queries: [
          {
            id: 'systems',
            query: 'systems',
            enabled: true,
            everyDays: 2,
            offsetMinutes: 0,
            concepts: [],
          },
        ],
        followedSources: [
          { uri: frontUri, label: 'Lobsters', enabled: true, interests: ['systems'] },
        ],
      },
      root,
    );
    const result = await refreshDue(
      root,
      { once: true, requestId: '1f6fcd64-5870-4aae-aa01-40a186c42c8b' },
      {
        fetch: async (uri) => response(`${uri}?unexpected=1`, feed('Systems design', storyUri)),
        clock: () => new Date('2026-10-28T12:00:00.000Z'),
      },
    );
    expect(result.result?.sources[0]?.state).toBe('failed');
    expect(await createBriefingApi(root).listItems({ limit: 100 })).toHaveLength(0);
  });
});
