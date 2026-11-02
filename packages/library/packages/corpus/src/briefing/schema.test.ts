import { describe, expect, it } from 'vitest';
import { Value } from 'typebox/value';
import {
  AllDayEventSchema,
  BriefingRankInputSchema,
  BriefingRecordReferenceSchema,
  EventSchema,
  FeedbackSchema,
  InterestPreferenceSchema,
  InterestSchema,
  ItemSchema,
  isRankingExplanation,
  MetricObservationSchema,
  RankingExplanationSchema,
  RankingPreferencesSchema,
  SeenStateSchema,
  SourcePreferenceSchema,
  SourceSchema,
  SourceTermsPolicySchema,
  StorySchema,
  TimedEventSchema,
  DEFAULT_INTEREST_HALF_LIFE_DAYS,
  DEFAULT_INTEREST_WEIGHT,
  DEFAULT_VELOCITY_WEIGHT,
  effectiveRankingWeights,
  rankingTotal,
} from './schema.js';
import {
  allDayEventFixture,
  eventReferenceFixture,
  feedbackFixture,
  interestFixture,
  interestPreferenceFixture,
  itemFixture,
  itemReferenceFixture,
  metricObservationFixture,
  rankInputFixture,
  rankingExplanationFixture,
  rankingPreferencesFixture,
  seenStateFixture,
  sourceFixture,
  sourcePreferenceFixture,
  sourceReferenceFixture,
  sourceTermsPolicyFixture,
  storyFixture,
  storyReferenceFixture,
  timedEventFixture,
  undoFixture,
  unknownSeenStateFixture,
} from './fixtures.js';

describe('Briefing S0′ schema agreement', () => {
  it('keeps current settings projections separate from unknown cadence and source policy', () => {
    expect(Value.Check(InterestSchema, interestFixture)).toBe(true);
    expect(Value.Check(SourceSchema, sourceFixture)).toBe(true);
    expect(Value.Check(SourceTermsPolicySchema, sourceTermsPolicyFixture)).toBe(true);
    expect(Value.Check(InterestSchema, { ...interestFixture, weight: 1.01 })).toBe(false);
    expect(interestFixture.cadenceRef).toBeNull();
    expect(sourceFixture.termsRef).toBeNull();
    expect(DEFAULT_INTEREST_WEIGHT).toBe(1);
    expect(DEFAULT_INTEREST_HALF_LIFE_DAYS * 24).toBe(18);
  });

  it('retains item/story members and gives exact record references', () => {
    expect(Value.Check(ItemSchema, itemFixture)).toBe(true);
    expect(Value.Check(StorySchema, storyFixture)).toBe(true);
    expect(Value.Check(BriefingRecordReferenceSchema, itemReferenceFixture)).toBe(true);
    expect(Value.Check(BriefingRecordReferenceSchema, storyReferenceFixture)).toBe(true);
    expect(Value.Check(BriefingRecordReferenceSchema, sourceReferenceFixture)).toBe(true);
    expect(Value.Check(BriefingRecordReferenceSchema, eventReferenceFixture)).toBe(true);
    expect(itemFixture.metrics).toEqual([metricObservationFixture]);
  });

  it('keeps timed UTC and all-day calendar dates distinct and round-trippable', () => {
    expect(Value.Check(TimedEventSchema, timedEventFixture)).toBe(true);
    expect(Value.Check(AllDayEventSchema, allDayEventFixture)).toBe(true);
    expect(Value.Check(EventSchema, allDayEventFixture)).toBe(true);
    expect(allDayEventFixture.endDate).toBe('2026-10-29');
  });

  it('uses append-only D3 feedback with exact undo identity', () => {
    expect(Value.Check(FeedbackSchema, feedbackFixture)).toBe(true);
    expect(Value.Check(FeedbackSchema, undoFixture)).toBe(true);
    const { undoesFeedbackId: omittedFeedbackId, ...invalidUndo } = undoFixture;
    expect(omittedFeedbackId).toBe(undoFixture.undoesFeedbackId);
    expect(Value.Check(FeedbackSchema, invalidUndo)).toBe(false);
  });

  it('retains measured ranking inputs and explicit unknown velocity/novelty', () => {
    expect(Value.Check(BriefingRankInputSchema, rankInputFixture)).toBe(true);
    expect(Value.Check(MetricObservationSchema, metricObservationFixture)).toBe(true);
    expect(Value.Check(SeenStateSchema, seenStateFixture)).toBe(true);
    expect(Value.Check(SeenStateSchema, unknownSeenStateFixture)).toBe(true);
    expect(Value.Check(InterestPreferenceSchema, interestPreferenceFixture)).toBe(true);
    expect(Value.Check(SourcePreferenceSchema, sourcePreferenceFixture)).toBe(true);
    expect(Value.Check(RankingPreferencesSchema, rankingPreferencesFixture)).toBe(true);
    expect(Value.Check(RankingExplanationSchema, rankingExplanationFixture)).toBe(true);
    expect(DEFAULT_VELOCITY_WEIGHT).toBe(0.05);
    expect(effectiveRankingWeights(0.1)).toEqual({
      relevance: 0.45 * (0.9 / 0.95),
      freshness: 0.25 * (0.9 / 0.95),
      sourcePriority: 0.15 * (0.9 / 0.95),
      novelty: 0.1 * (0.9 / 0.95),
      velocity: 0.1,
    });
    expect(isRankingExplanation(rankingExplanationFixture)).toBe(true);
    expect(isRankingExplanation({ ...rankingExplanationFixture, total: 71 })).toBe(false);
    expect(
      rankingTotal(rankingExplanationFixture.components, rankingExplanationFixture.weights),
    ).toBe(rankingExplanationFixture.total);
  });
});
