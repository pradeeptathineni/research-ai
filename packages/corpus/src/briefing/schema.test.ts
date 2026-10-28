import { describe, expect, it } from 'vitest';
import { Value } from 'typebox/value';
import {
  AllDayEventSchema,
  BriefingRecordReferenceSchema,
  EventSchema,
  FeedbackSchema,
  BriefingRankInputSchema,
  InterestSchema,
  InterestPreferenceSchema,
  ItemSchema,
  isRankingExplanation,
  MetricObservationSchema,
  RankingExplanationSchema,
  SeenStateSchema,
  SourceSchema,
  SourcePreferenceSchema,
  StorySchema,
  TimedEventSchema,
  scoreFromContributions,
} from './schema.js';
import {
  allDayEventFixture,
  feedbackFixture,
  interestPreferenceFixture,
  interestFixture,
  itemFixture,
  itemReferenceFixture,
  metricObservationFixture,
  rankingExplanationFixture,
  rankInputFixture,
  seenStateFixture,
  sourceFixture,
  sourcePreferenceFixture,
  storyFixture,
  timedEventFixture,
  undoFixture,
  unknownSeenStateFixture,
} from './fixtures.js';

describe('Briefing S0 schemas', () => {
  it('keeps all day dates distinct from zoned UTC events', () => {
    expect(Value.Check(InterestSchema, interestFixture)).toBe(true);
    expect(Value.Check(SourceSchema, sourceFixture)).toBe(true);
    expect(Value.Check(ItemSchema, itemFixture)).toBe(true);
    expect(Value.Check(StorySchema, storyFixture)).toBe(true);
    expect(Value.Check(TimedEventSchema, timedEventFixture)).toBe(true);
    expect(Value.Check(AllDayEventSchema, allDayEventFixture)).toBe(true);
    expect(Value.Check(EventSchema, allDayEventFixture)).toBe(true);
    expect(Value.Check(EventSchema, timedEventFixture)).toBe(true);
  });

  it('supports append-only feedback and exact undo references', () => {
    expect(Value.Check(FeedbackSchema, feedbackFixture)).toBe(true);
    expect(Value.Check(FeedbackSchema, undoFixture)).toBe(true);
    expect(Value.Check(BriefingRecordReferenceSchema, itemReferenceFixture)).toBe(true);
    expect(Value.Check(FeedbackSchema, { ...undoFixture, undoesFeedbackId: undefined })).toBe(
      false,
    );
  });

  it('retains the exact ranking inputs and explanation components', () => {
    expect(Value.Check(BriefingRankInputSchema, rankInputFixture)).toBe(true);
    expect(Value.Check(MetricObservationSchema, metricObservationFixture)).toBe(true);
    expect(Value.Check(SeenStateSchema, seenStateFixture)).toBe(true);
    expect(Value.Check(SeenStateSchema, unknownSeenStateFixture)).toBe(true);
    expect(Value.Check(InterestPreferenceSchema, interestPreferenceFixture)).toBe(true);
    expect(Value.Check(SourcePreferenceSchema, sourcePreferenceFixture)).toBe(true);
    expect(Value.Check(RankingExplanationSchema, rankingExplanationFixture)).toBe(true);
    expect(isRankingExplanation(rankingExplanationFixture)).toBe(true);
    expect(
      isRankingExplanation({ ...rankingExplanationFixture, score: 71 }),
    ).toBe(false);
    expect(
      scoreFromContributions(
        rankingExplanationFixture.baseScore,
        rankingExplanationFixture.contributions,
      ),
    ).toBe(rankingExplanationFixture.score);
  });
});
