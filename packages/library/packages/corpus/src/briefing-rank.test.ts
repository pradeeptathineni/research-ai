import { describe, expect, it } from 'vitest';
import { isRankingExplanation, type BriefingRankInput } from './briefing/schema.js';
import { rankBriefingStory } from './briefing-rank.js';

const digest = 'a'.repeat(64);
const reference = (kind: 'briefing-story' | 'briefing-item' | 'briefing-source') => ({
  owner: 'signals-ai' as const,
  kind,
  id: `${kind}-one`,
  revision: `sha256:${digest}`,
});
const base: BriefingRankInput = {
  story: {
    id: 'story-one',
    itemIds: ['item-one'],
    representativeItemId: 'item-one',
    firstSeen: '2026-10-28T10:00:00.000Z',
    lastSeen: '2026-10-28T10:00:00.000Z',
    relation: 'single',
    groupingEvidence: [],
    interestMatches: [{ interestId: 'ai', matchedTerms: ['ai'] }],
  },
  storyReference: reference('briefing-story'),
  items: [
    {
      item: {
        id: 'item-one',
        sourceId: 'source-one',
        canonicalUrl: 'https://example.test/a',
        title: 'AI research',
        author: null,
        publishedAt: null,
        observedAt: '2026-10-28T10:00:00.000Z',
        contentDigest: digest,
        excerpt: 'A new AI paper',
        metrics: [],
        interestIds: ['ai'],
        storyId: 'story-one',
      },
      itemReference: reference('briefing-item'),
      source: {
        id: 'source-one',
        kind: 'rss',
        url: 'https://example.test/feed',
        attribution: 'Example',
        termsRef: null,
        priority: 0,
        interestIds: ['ai'],
        health: {
          status: 'unknown',
          lastGoodAt: null,
          lastAttemptAt: null,
          lastAttemptStatus: null,
          lastSuccessfulLinkCount: null,
          failureClass: null,
          expectedIntervalSec: null,
        },
      },
      sourceReference: reference('briefing-source'),
      interests: [
        {
          id: 'ai',
          label: 'AI',
          includeTerms: ['AI', 'research'],
          excludeTerms: [],
          enabled: true,
          weight: 1,
          halfLifeDays: 0.75,
          sources: [],
          cadenceRef: null,
          revision: digest,
        },
      ],
      seen: {
        status: 'not-seen-since-capture',
        trackingStartedAt: '2026-10-28T09:00:00.000Z',
        capturedAt: '2026-10-28T10:00:00.000Z',
      },
    },
  ],
  metrics: [
    {
      id: 'm1',
      itemId: 'item-one',
      platform: 'hn',
      name: 'points',
      value: 10,
      observedAt: '2026-10-28T09:00:00.000Z',
      scope: 'item',
      method: 'feed',
      sourceRef: null,
    },
    {
      id: 'm2',
      itemId: 'item-one',
      platform: 'hn',
      name: 'points',
      value: 20,
      observedAt: '2026-10-28T10:00:00.000Z',
      scope: 'item',
      method: 'feed',
      sourceRef: null,
    },
  ],
  feedback: [],
};

describe('briefing story ranking', () => {
  it('produces a digest-bound, transparent score with normalized adjustable weights', async () => {
    const result = await rankBriefingStory(base, { now: '2026-10-28T10:00:00.000Z' });
    expect(result.components.relevance.value).toBe(100);
    expect(result.components.novelty.value).toBe(100);
    expect(result.components.velocity.status).toBe('available');
    expect(result.weights.velocity).toBe(0.05);
    expect(Object.values(result.weights).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
    expect(result.inputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.total).toBeGreaterThan(0);
    expect(isRankingExplanation(result)).toBe(true);
  });

  it('does not combine one observation from separate platforms into a velocity trend', async () => {
    const input = {
      ...base,
      metrics: [
        { ...base.metrics[0]!, platform: 'hn' },
        { ...base.metrics[1]!, platform: 'reddit' },
      ],
    };
    const result = await rankBriefingStory(input, { now: '2026-10-28T10:00:00.000Z' });
    expect(result.components.velocity.status).toBe('insufficient-observations');
    expect(result.components.velocity.value).toBeNull();
    expect(result.completeness).toBe('partial');
  });

  it('uses a plausible source date for freshness and falls back to host observation for future dates', async () => {
    const now = '2026-10-28T10:00:00.000Z';
    const withPublishedAt = (publishedAt: string | null): BriefingRankInput => ({
      ...base,
      items: [
        {
          ...base.items[0]!,
          item: { ...base.items[0]!.item, publishedAt },
        },
      ],
    });
    const observedOnly = await rankBriefingStory(withPublishedAt(null), { now });
    const olderSourceDate = await rankBriefingStory(withPublishedAt('2026-10-28T04:00:00.000Z'), {
      now,
    });
    const futureSourceDate = await rankBriefingStory(withPublishedAt('2026-10-28T11:00:00.000Z'), {
      now,
    });
    expect(olderSourceDate.components.freshness.value).toBeLessThan(
      observedOnly.components.freshness.value!,
    );
    expect(olderSourceDate.total).toBeLessThan(observedOnly.total);
    expect(olderSourceDate.components.freshness.reason).toContain('not independently verified');
    expect(futureSourceDate.components.freshness).toEqual(observedOnly.components.freshness);
    expect(futureSourceDate.total).toBe(observedOnly.total);
    expect(olderSourceDate.inputDigest).not.toBe(observedOnly.inputDigest);
    expect(isRankingExplanation(olderSourceDate)).toBe(true);
  });

  it('preserves explicit seen uncertainty and rejects a velocity weight outside policy', async () => {
    const input = {
      ...base,
      items: [
        {
          ...base.items[0]!,
          seen: { status: 'unknown' as const, reason: 'before-tracking' as const },
        },
      ],
    };
    const result = await rankBriefingStory(input, { now: '2026-10-28T10:00:00.000Z' });
    expect(result.components.novelty.status).toBe('unknown');
    await expect(rankBriefingStory(base, { velocityWeight: 0.3 })).rejects.toThrow(
      /between 0 and 0.25/,
    );
  });

  it('applies explicit more feedback and removes it when the exact record is undone', async () => {
    const more = {
      id: '30000000-0000-4000-8000-000000000001',
      requestId: '30000000-0000-4000-8000-000000000002',
      targetKind: 'story' as const,
      targetId: base.story.id,
      action: 'less' as const,
      createdAt: '2026-10-28T10:00:00.000Z',
    };
    const undone = {
      id: '30000000-0000-4000-8000-000000000003',
      requestId: '30000000-0000-4000-8000-000000000004',
      targetKind: 'story' as const,
      targetId: base.story.id,
      action: 'undo' as const,
      undoesFeedbackId: more.id,
      createdAt: '2026-10-28T10:01:00.000Z',
    };
    const baseline = await rankBriefingStory(base, { now: '2026-10-28T10:00:00.000Z' });
    const reduced = await rankBriefingStory(
      { ...base, feedback: [more] },
      { now: '2026-10-28T10:00:00.000Z' },
    );
    const restored = await rankBriefingStory(
      { ...base, feedback: [more, undone] },
      { now: '2026-10-28T10:00:00.000Z' },
    );
    expect(reduced.components.relevance.value).toBe(90);
    expect(reduced.total).toBeLessThan(baseline.total);
    expect(restored.total).toBe(baseline.total);
  });
});
