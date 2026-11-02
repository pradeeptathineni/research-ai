import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings, saveSettings } from '../search-settings.js';
import { createBriefingApi, retainBriefingRecords } from './store.js';
import { briefingRoute } from './http.js';
import { itemFixture, storyFixture } from './fixtures.js';
import type { Item, MetricObservation, Story } from './schema.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const metric = (id: string, itemId: string, value: number, observedAt: string): MetricObservation => ({
  id, itemId, platform: 'hacker-news', name: 'points', value, observedAt,
  scope: 'item', method: 'feed', sourceRef: null,
});

describe('Briefing social pulse owner workflow', () => {
  it('keeps item observations separate, computes only a trustworthy same-item rate, and preserves it on cold reread', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-social-pulse-')));
    roots.push(root);
    await saveSettings({
      ...defaultSettings,
      queries: [{ id: 'pulse', query: 'synthetic pulse', enabled: true, everyDays: 1, offsetMinutes: 0, concepts: [] }],
      followedSources: [{ uri: 'https://example.test/pulse.xml', label: 'Pulse fixture', enabled: true, interests: ['pulse'] }],
    }, root);
    const source = (await createBriefingApi(root).listSources())[0]!.record;
    const start = '2026-11-01T10:00:00.000Z';
    const later = '2026-11-01T12:00:00.000Z';
    const observations = [
      metric('item-a-one', 'item-a', 10, start), metric('item-a-two', 'item-a', 22, later),
      { ...metric('item-a-independent', 'item-a', 700, later), scope: 'independent report', method: 'caller-reported' as const, sourceRef: 'https://example.test/independent' },
      metric('item-b-one', 'item-b', 900, start), metric('item-c-one', 'item-c', 3, start),
      metric('item-c-two', 'item-c', 8, later),
      metric('item-d-one', 'item-d', 20, start), metric('item-d-two', 'item-d', 2, later),
      metric('item-e-one', 'item-e', 4, start), metric('item-e-conflict', 'item-e', 9, start),
      metric('item-e-later', 'item-e', 12, later),
    ];
    const ids = ['item-a', 'item-b', 'item-c', 'item-d', 'item-e'];
    const items: Item[] = ids.map((id, index) => ({
      ...itemFixture, id, sourceId: source.id, storyId: `story-${id}`,
      canonicalUrl: `https://example.test/${id}`, title: `Synthetic ${id}`,
      contentDigest: String(index + 1).repeat(64), observedAt: start,
      metrics: observations.filter((entry) => entry.itemId === id),
    }));
    const stories: Story[] = items.map((item) => ({
      ...storyFixture, id: item.storyId!, itemIds: [item.id], representativeItemId: item.id,
      firstSeen: start, lastSeen: start, relation: 'single', groupingEvidence: [], interestMatches: [],
    }));
    await retainBriefingRecords(root, { items, stories });

    const readPulse = async () => {
      const response = await briefingRoute(root, 'briefing/workbench', false, undefined, 0);
      expect(response?.status).toBe(200);
      const ranked = (response!.body as { ranked: Array<{ input: { story: Story }; socialPulse: Array<any> }> }).ranked;
      return Object.fromEntries(ranked.map(({ input, socialPulse }) => [input.story.representativeItemId, socialPulse]));
    };
    const before = await readPulse();
    const pulse = (itemId: string, method = 'feed') => before[itemId]!.find((entry: any) => entry.method === method);
    expect(pulse('item-a')).toMatchObject({ itemId: 'item-a', scope: 'item', method: 'feed', sourceRef: null, latestValue: 22, latestObservedAt: later, observationCount: 2, firstObservedAt: start, delta: 12, elapsedHours: 2, perHour: 6, status: 'available' });
    expect(pulse('item-a', 'caller-reported')).toMatchObject({ itemId: 'item-a', scope: 'independent report', method: 'caller-reported', sourceRef: 'https://example.test/independent', latestValue: 700, observationCount: 1, delta: null, perHour: null, status: 'insufficient-observations' });
    expect(pulse('item-b')).toMatchObject({ observationCount: 1, delta: null, perHour: null, status: 'insufficient-observations' });
    expect(pulse('item-c')).toMatchObject({ itemId: 'item-c', delta: 5, elapsedHours: 2, perHour: 2.5, status: 'available' });
    expect(pulse('item-d')).toMatchObject({ delta: null, perHour: null, status: 'counter-decreased' });
    expect(pulse('item-e')).toMatchObject({ latestValue: 12, delta: null, perHour: null, status: 'ambiguous-observations' });

    const coldApi = createBriefingApi(root);
    const reopened = await readPulse();
    expect(reopened).toEqual(before);
    expect((await coldApi.listItems()).find(({ record }) => record.id === 'item-a')!.record.metrics).toEqual(items[0]!.metrics);
  });
});
