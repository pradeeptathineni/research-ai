import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings, saveSettings } from '../search-settings.js';
import { createBriefingApi, retainBriefingRecords } from './store.js';
import { briefingRoute } from './http.js';
import type { Item, Story } from './schema.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe('Briefing matched-interest term feedback', () => {
  it('mutes derived terms without rewriting Story records, then cold-reopens after exact undo', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-briefing-term-feedback-')));
    roots.push(root);
    const feedUri = 'https://example.test/systems.xml';
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
          { uri: feedUri, label: 'Systems feed', enabled: true, interests: ['systems-design'] },
        ],
      },
      root,
    );
    const source = (await createBriefingApi(root).listSources())[0]!.record;
    const item: Item = {
      id: 'item-systems-design',
      sourceId: source.id,
      canonicalUrl: 'https://example.test/story/systems-design',
      title: 'A systems design practice for reliable services',
      author: 'Ada',
      publishedAt: '2026-10-28T08:00:00.000Z',
      observedAt: '2026-10-28T09:00:00.000Z',
      contentDigest: 'a'.repeat(64),
      excerpt: 'An engineering discussion.',
      metrics: [],
      interestIds: ['systems-design'],
      storyId: 'story-systems-design',
    };
    const story: Story = {
      id: 'story-systems-design',
      itemIds: [item.id],
      representativeItemId: item.id,
      firstSeen: item.observedAt,
      lastSeen: item.observedAt,
      relation: 'single',
      groupingEvidence: [],
      interestMatches: [],
    };
    const unrelatedItem: Item = {
      ...item,
      id: 'item-unrelated-release',
      canonicalUrl: 'https://example.test/story/unrelated-release',
      title: 'A packaging release for a small service',
      contentDigest: 'b'.repeat(64),
      storyId: 'story-unrelated-release',
    };
    const unrelatedStory: Story = {
      ...story,
      id: 'story-unrelated-release',
      itemIds: [unrelatedItem.id],
      representativeItemId: unrelatedItem.id,
    };
    await retainBriefingRecords(root, {
      items: [item, unrelatedItem],
      stories: [story, unrelatedStory],
    });

    const beforeReference = (await createBriefingApi(root).listStories()).find(
      ({ record }) => record.id === story.id,
    )!.reference;
    const firstWorkbench = (await briefingRoute(root, 'briefing/workbench', false, undefined, 0))!;
    const firstRanked = (
      firstWorkbench.body as {
        ranked: Array<{
          input: { story: Story };
          matchedTerms: Array<{ interestId: string; terms: string[] }>;
          explanation: { components: { relevance: { value: number | null } } };
        }>;
      }
    ).ranked;
    expect(firstRanked).toHaveLength(2);
    const matchedRow = firstRanked.find(({ input }) => input.story.id === story.id)!;
    const unrelatedRow = firstRanked.find(({ input }) => input.story.id === unrelatedStory.id)!;
    expect(matchedRow.input.story.interestMatches).toEqual([]);
    expect(matchedRow.matchedTerms).toEqual([
      { interestId: 'systems-design', terms: ['systems design'] },
    ]);
    expect(matchedRow.explanation.components.relevance.value).toBe(100);
    expect(unrelatedRow.matchedTerms).toEqual([]);

    const request = {
      requestId: '2da997c5-a849-4d4c-94e8-cd3e7a6c40ab',
      targetKind: 'term',
      targetId: 'systems design',
      action: 'mute-term',
    } as const;
    const mute = await briefingRoute(root, 'briefing/feedback', true, request, 0);
    expect(mute).toMatchObject({
      status: 201,
      body: { feedback: { action: 'mute-term' }, replayed: false },
    });
    expect(await briefingRoute(root, 'briefing/feedback', true, request, 0)).toMatchObject({
      body: { feedback: { id: request.requestId }, replayed: true },
    });
    const mutedWorkbench = await briefingRoute(root, 'briefing/workbench', false, undefined, 0);
    expect(
      (mutedWorkbench?.body as { ranked: Array<{ input: { story: Story } }> }).ranked.map(
        ({ input }) => input.story.id,
      ),
    ).toEqual([unrelatedStory.id]);
    expect(
      (
        await briefingRoute(
          root,
          'briefing/preferences/ranking-preview',
          true,
          { velocityWeight: 0.05 },
          0,
        )
      )?.body,
    ).toMatchObject({ stories: [{ storyId: unrelatedStory.id }] });
    expect(
      (await createBriefingApi(root).listStories()).find(({ record }) => record.id === story.id)!
        .reference,
    ).toEqual(beforeReference);

    const undo = await briefingRoute(
      root,
      'briefing/feedback/undo',
      true,
      {
        requestId: '2da997c5-a849-4d4c-94e8-cd3e7a6c40ac',
        feedbackId: request.requestId,
      },
      0,
    );
    expect(undo).toMatchObject({
      status: 201,
      body: {
        feedback: { action: 'undo', undoesFeedbackId: request.requestId },
        replayed: false,
      },
    });

    const coldApi = createBriefingApi(root);
    expect((await coldApi.listFeedback()).map(({ action }) => action)).toEqual([
      'mute-term',
      'undo',
    ]);
    expect(
      (await coldApi.listStories()).find(({ record }) => record.id === story.id)!.reference,
    ).toEqual(beforeReference);
    const reopened = (await briefingRoute(root, 'briefing/workbench', false, undefined, 0))!;
    const reopenedRanked = (
      reopened.body as typeof firstWorkbench.body as {
        ranked: Array<{
          input: { story: Story };
          matchedTerms: Array<{ interestId: string; terms: string[] }>;
        }>;
      }
    ).ranked;
    expect(reopenedRanked).toHaveLength(2);
    expect(reopenedRanked.find(({ input }) => input.story.id === story.id)?.matchedTerms).toEqual([
      { interestId: 'systems-design', terms: ['systems design'] },
    ]);
  });
});
