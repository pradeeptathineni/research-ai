import { describe, expect, it } from 'vitest';
import { isStoryHidden } from './briefing-feedback.js';
import type { Feedback, Item, Story } from './briefing/schema.js';

const story: Story = {
  id: 'story-one',
  itemIds: ['item-one'],
  representativeItemId: 'item-one',
  firstSeen: '2026-10-28T10:00:00Z',
  lastSeen: '2026-10-28T10:00:00Z',
  relation: 'single',
  groupingEvidence: [],
  interestMatches: [{ interestId: 'ai', matchedTerms: ['AI'] }],
};
const item: Item = {
  id: 'item-one',
  sourceId: 'source-one',
  canonicalUrl: 'https://example.test',
  title: 'AI',
  author: null,
  publishedAt: null,
  observedAt: '2026-10-28T10:00:00Z',
  contentDigest: 'a'.repeat(64),
  excerpt: '',
  metrics: [],
  interestIds: ['ai'],
  storyId: 'story-one',
};
const mute: Feedback = {
  id: '20000000-0000-4000-8000-000000000001',
  requestId: '20000000-0000-4000-8000-000000000002',
  targetKind: 'source',
  targetId: 'source-one',
  action: 'mute-source',
  createdAt: '2026-10-28T10:00:00Z',
};
const undo: Feedback = {
  id: '20000000-0000-4000-8000-000000000003',
  requestId: '20000000-0000-4000-8000-000000000004',
  targetKind: 'source',
  targetId: 'source-one',
  action: 'undo',
  undoesFeedbackId: mute.id,
  createdAt: '2026-10-28T10:01:00Z',
};

describe('Briefing reversible filtering', () => {
  it('hides a muted source and restores it only when an exact undo references that mute', () => {
    expect(isStoryHidden([mute], story, item, Date.parse('2026-10-28T10:02:00Z'))).toBe(true);
    expect(isStoryHidden([mute, undo], story, item, Date.parse('2026-10-28T10:02:00Z'))).toBe(
      false,
    );
  });

  it('expires snooze by its recorded instant and keeps dismissals until exact undo', () => {
    const snooze: Feedback = {
      ...mute,
      targetKind: 'story',
      targetId: story.id,
      action: 'snooze',
      until: '2026-10-28T11:00:00Z',
    };
    expect(isStoryHidden([snooze], story, item, Date.parse('2026-10-28T10:30:00Z'))).toBe(true);
    expect(isStoryHidden([snooze], story, item, Date.parse('2026-10-28T11:00:00Z'))).toBe(false);
  });
});
