import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Value } from 'typebox/value';
import { defaultSettings, saveSettings } from '../search-settings.js';
import { createBriefingApi, retainBriefingRecords } from './store.js';
import { BriefingRankInputSchema } from './schema.js';
import {
  allDayEventFixture,
  itemFixture,
  rankInputFixture,
  storyFixture,
  timedEventFixture,
} from './fixtures.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

async function fixtureRoot() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-event-rank-input-')));
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

describe('event-bound rank inputs', () => {
  it('keeps events optional for legacy inputs and bounds the optional list', () => {
    expect(Value.Check(BriefingRankInputSchema, rankInputFixture)).toBe(true);
    expect(
      Value.Check(BriefingRankInputSchema, {
        ...rankInputFixture,
        events: Array.from({ length: 101 }, (_, index) => ({
          ...timedEventFixture,
          id: `event-${index}`,
        })),
      }),
    ).toBe(false);
  });

  it('attaches only explicitly item-bound events and returns the same cold read', async () => {
    const root = await fixtureRoot();
    const api = createBriefingApi(root);
    const sourceId = (await api.listSources())[0]!.record.id;
    const item = { ...itemFixture, sourceId };
    const { itemId: unboundItemId, ...unbound } = allDayEventFixture;
    expect(unboundItemId).toBe(allDayEventFixture.itemId);
    const unrelated = { ...timedEventFixture, id: 'event-other', itemId: 'other-item' };
    const bound = { ...timedEventFixture, id: 'event-bound', itemId: item.id };
    await retainBriefingRecords(root, {
      items: [item],
      stories: [storyFixture],
      events: [unbound, unrelated, bound],
    });

    const first = await api.listRankInputs();
    expect(first).toHaveLength(1);
    expect(first[0]?.events).toEqual([bound]);
    expect(Value.Check(BriefingRankInputSchema, first[0])).toBe(true);
    await expect(createBriefingApi(root).listRankInputs()).resolves.toEqual(first);

    await retainBriefingRecords(root, {
      items: [
        { ...item, id: 'item-3', canonicalUrl: 'https://example.test/3', storyId: 'story-legacy' },
      ],
      stories: [
        {
          ...storyFixture,
          id: 'story-legacy',
          itemIds: ['item-3'],
          representativeItemId: 'item-3',
        },
      ],
    });
    const legacy = (await api.listRankInputs()).find((input) => input.story.id === 'story-legacy');
    expect(legacy).toBeDefined();
    expect(legacy).not.toHaveProperty('events');
    expect(Value.Check(BriefingRankInputSchema, legacy)).toBe(true);
  });
});
