import { describe, expect, it } from 'vitest';
import { summarizeBriefingPulse } from './briefing-pulse.js';

const metric = (
  id: string,
  itemId: string,
  platform: string,
  name: string,
  value: number,
  observedAt: string,
) => ({
  id,
  itemId,
  platform,
  name,
  value,
  observedAt,
  scope: 'item',
  method: 'feed' as const,
  sourceRef: null,
});

describe('Briefing social pulse', () => {
  it('computes rates only within the same item, platform, and metric', () => {
    const summaries = summarizeBriefingPulse([
      metric('a1', 'item-a', 'hn', 'points', 10, '2026-11-01T10:00:00.000Z'),
      metric('a2', 'item-a', 'hn', 'points', 22, '2026-11-01T12:00:00.000Z'),
      metric('b1', 'item-b', 'hn', 'points', 1000, '2026-11-01T10:00:00.000Z'),
      metric('c1', 'item-a', 'reddit', 'points', 900, '2026-11-01T12:00:00.000Z'),
      metric('d1', 'item-a', 'hn', 'comments', 5, '2026-11-01T12:00:00.000Z'),
    ]);
    expect(summaries).toHaveLength(4);
    expect(
      summaries.find(
        (row) => row.itemId === 'item-a' && row.platform === 'hn' && row.name === 'points',
      ),
    ).toMatchObject({
      latestValue: 22,
      observationCount: 2,
      delta: 12,
      elapsedHours: 2,
      perHour: 6,
      status: 'available',
    });
    expect(summaries.filter((row) => row.status === 'insufficient-observations')).toHaveLength(3);
  });

  it('keeps insufficient, decreasing, and conflicting same-time readings uncertain', () => {
    const rows = summarizeBriefingPulse([
      metric('one', 'one', 'hn', 'points', 5, '2026-11-01T10:00:00.000Z'),
      metric('down1', 'down', 'hn', 'points', 8, '2026-11-01T10:00:00.000Z'),
      metric('down2', 'down', 'hn', 'points', 3, '2026-11-01T11:00:00.000Z'),
      metric('conflict1', 'conflict', 'hn', 'points', 3, '2026-11-01T10:00:00.000Z'),
      metric('conflict2', 'conflict', 'hn', 'points', 9, '2026-11-01T10:00:00.000Z'),
      metric('conflict3', 'conflict', 'hn', 'points', 12, '2026-11-01T11:00:00.000Z'),
    ]);
    expect(rows.find((row) => row.itemId === 'one')).toMatchObject({
      status: 'insufficient-observations',
      perHour: null,
    });
    expect(rows.find((row) => row.itemId === 'down')).toMatchObject({
      status: 'counter-decreased',
      delta: null,
      perHour: null,
    });
    expect(rows.find((row) => row.itemId === 'conflict')).toMatchObject({
      status: 'ambiguous-observations',
      delta: null,
      perHour: null,
    });
  });

  it('groups offset-equivalent instants and counts only distinct instants', () => {
    const rows = summarizeBriefingPulse([
      metric('latest', 'ordered', 'hn', 'points', 15, '2026-11-01T10:00:00.000Z'),
      metric('earlier', 'ordered', 'hn', 'points', 5, '2026-11-01T11:00:00.000+02:00'),
      metric('duplicate', 'ordered', 'hn', 'points', 5, '2026-11-01T09:00:00.000Z'),
      metric('conflict-a', 'offset-conflict', 'hn', 'points', 2, '2026-11-01T09:00:00.000Z'),
      metric('conflict-b', 'offset-conflict', 'hn', 'points', 8, '2026-11-01T11:00:00.000+02:00'),
    ]);
    expect(rows.find((row) => row.itemId === 'ordered')).toMatchObject({
      firstObservedAt: '2026-11-01T09:00:00.000Z',
      latestObservedAt: '2026-11-01T10:00:00.000Z',
      observationCount: 2,
      elapsedHours: 1,
      status: 'available',
    });
    expect(rows.find((row) => row.itemId === 'offset-conflict')).toMatchObject({
      status: 'ambiguous-observations',
      observationCount: 1,
      latestValue: null,
      perHour: null,
    });
  });

  it('keeps different methods, source references, and instance scopes in separate streams', () => {
    const rows = summarizeBriefingPulse([
      {
        ...metric('public', 'same-item', 'mastodon', 'favorites', 10, '2026-11-01T10:00:00.000Z'),
        method: 'public-adapter' as const,
        scope: 'instance:home',
        sourceRef: 'https://home.example/@a/1',
      },
      {
        ...metric(
          'reported',
          'same-item',
          'mastodon',
          'favorites',
          100,
          '2026-11-01T11:00:00.000Z',
        ),
        method: 'caller-reported' as const,
        scope: 'instance:home',
        sourceRef: 'https://home.example/@a/1',
      },
      {
        ...metric(
          'other-instance',
          'same-item',
          'mastodon',
          'favorites',
          1000,
          '2026-11-01T12:00:00.000Z',
        ),
        method: 'public-adapter' as const,
        scope: 'instance:other',
        sourceRef: 'https://other.example/@a/1',
      },
      {
        ...metric(
          'same-stream',
          'same-item',
          'mastodon',
          'favorites',
          20,
          '2026-11-01T12:00:00.000Z',
        ),
        method: 'public-adapter' as const,
        scope: 'instance:home',
        sourceRef: 'https://home.example/@a/1',
      },
    ]);
    expect(rows).toHaveLength(3);
    expect(
      rows.find((row) => row.scope === 'instance:home' && row.method === 'public-adapter'),
    ).toMatchObject({
      observationCount: 2,
      status: 'available',
      sourceRef: 'https://home.example/@a/1',
    });
    expect(rows.filter((row) => row.status === 'insufficient-observations')).toHaveLength(2);
  });
});
