import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({ request: mocks.request }));

import { defaultSettings, saveSettings } from '../search-settings.js';
import { briefingRoute } from './http.js';
import { refreshBriefing } from './ingest.js';
import { createBriefingApi } from './store.js';
import { fetchEvidence } from '../search-fetch.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  mocks.lookup.mockReset();
  mocks.request.mockReset();
});

function respond(contentType: string, body: string) {
  mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  mocks.request.mockImplementation(
    (_url: unknown, _options: unknown, callback: (response: unknown) => void) => {
      const req = new EventEmitter() as EventEmitter & {
        end: () => void;
        destroy: (error?: Error) => void;
      };
      req.end = () => {
        const response = Object.assign(Readable.from([Buffer.from(body)]), {
          statusCode: 200,
          headers: { 'content-type': contentType, etag: 'json-feed-v1' },
        });
        queueMicrotask(() => callback(response));
      };
      req.destroy = (error?: Error) => {
        if (error) req.emit('error', error);
      };
      return req;
    },
  );
}

const feed = {
  version: 'https://jsonfeed.org/version/1.1',
  title: 'Climate updates',
  items: [
    {
      id: 'entry-1',
      url: 'https://publisher.example.test/stories/climate-release',
      title: 'Climate data release',
      content_text: 'The agency published a new climate data series.',
      content_html: '<p>The agency published a new climate data series.</p>',
      date_published: '2026-10-27T14:00:00Z',
      authors: [{ name: 'Example Publisher' }],
    },
  ],
};

describe('JSON Feed HTTP media compatibility', () => {
  it('follows application/feed+json through the real owner parser and retains a ranked story', async () => {
    respond('application/feed+json; charset=utf-8', JSON.stringify(feed));
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-json-feed-media-')));
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
            uri: 'https://feeds.example.test/climate.json',
            label: 'Climate updates',
            enabled: true,
            interests: ['climate-data'],
          },
        ],
      },
      root,
    );

    const refresh = await refreshBriefing(root);
    expect(refresh.sources).toHaveLength(1);
    expect(refresh.sources[0]?.state).toBe('fetched');
    expect(mocks.request).toHaveBeenCalledTimes(1);
    const requestOptions = mocks.request.mock.calls[0]![1] as { headers: { accept: string } };
    expect(requestOptions.headers.accept).toContain('application/feed+json');

    const api = createBriefingApi(root);
    const [source] = await api.listSources();
    const [item] = await api.listItems();
    const [story] = await api.listStories();
    expect(source?.record).toMatchObject({ kind: 'jsonfeed', health: { status: 'healthy' } });
    expect(item?.record).toMatchObject({
      sourceId: source?.record.id,
      canonicalUrl: feed.items[0]!.url,
      title: feed.items[0]!.title,
      author: 'Example Publisher',
      excerpt: feed.items[0]!.content_text,
      publishedAt: '2026-10-27T14:00:00.000Z',
    });
    expect(item?.reference).toMatchObject({ owner: 'signals-ai', kind: 'briefing-item' });
    expect(item?.reference.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(story?.record).toMatchObject({
      representativeItemId: item?.record.id,
      itemIds: [item?.record.id],
    });
    expect(story?.reference).toMatchObject({ owner: 'signals-ai', kind: 'briefing-story' });

    const workbench = (await briefingRoute(root, 'briefing/workbench', false, undefined, 0))!;
    expect((workbench.body as { ranked: Array<{ input: { story: { id: string } } }> }).ranked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          input: expect.objectContaining({
            story: expect.objectContaining({ id: story?.record.id }),
          }),
        }),
      ]),
    );
  });

  it('does not accept unrelated vendor +json media types as feed documents', async () => {
    respond('application/vnd.example.payload+json', JSON.stringify(feed));
    await expect(fetchEvidence('https://feeds.example.test/data.json')).rejects.toThrow(
      'unsupported_content',
    );
  });
});
