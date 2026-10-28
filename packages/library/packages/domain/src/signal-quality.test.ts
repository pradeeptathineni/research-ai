import { expect, it } from 'vitest';
import { evidenceExample } from '../../test-fixtures/src/evidence.js';
import { assessSignalQuality, type SignalReview } from './signal-quality.js';

function review(): SignalReview {
  return {
    policyVersion: 'signal-review-v1',
    evidenceDigest: 'a'.repeat(64),
    researchRunId: 'research-run',
    reviewRunId: 'separate-review-run',
    reviewer: 'review-agent',
    reviewedAt: '2026-10-05T21:00:00Z',
    options: [
      {
        optionId: 'candidate',
        ratings: { relevance: 3, evidence: 3, usefulness: 3, clarity: 3 },
        reasons: {
          relevance: 'Directly addresses this exact stated need.',
          evidence: 'Primary source directly supports the narrow claim.',
          usefulness: 'A concrete next step and applicability limits are present.',
          clarity: 'Facts and proposed use are separated with explicit limits.',
        },
        blockers: [],
      },
    ],
  };
}
it('holds an attractive option when any dimension or material claim is weak', () => {
  const bundle = evidenceExample('agent-assisted');
  const assessment = review();
  expect(assessSignalQuality(bundle, 'a'.repeat(64), assessment)[0]?.level).toBe('high');
  assessment.options[0]!.ratings.evidence = 2;
  expect(assessSignalQuality(bundle, 'a'.repeat(64), assessment)[0]).toMatchObject({
    score: 50,
    level: 'held',
  });
  assessment.options[0]!.ratings.evidence = 4;
  bundle.claims[0]!.status = 'inferred';
  expect(assessSignalQuality(bundle, 'a'.repeat(64), assessment)[0]?.level).toBe('held');
  bundle.claims[0]!.status = 'supported';
  assessment.options[0]!.blockers = ['Private material remains in the proposed public need.'];
  expect(assessSignalQuality(bundle, 'a'.repeat(64), assessment)[0]?.level).toBe('held');
});
it('rejects mismatched pins, incomplete option review, duplicate IDs and self-review', () => {
  const bundle = evidenceExample('agent-assisted');
  const assessment = review();
  expect(() => assessSignalQuality(bundle, 'b'.repeat(64), assessment)).toThrow('exact bytes');
  assessment.researchRunId = assessment.reviewRunId;
  expect(() => assessSignalQuality(bundle, 'a'.repeat(64), assessment)).toThrow('separate');
  assessment.researchRunId = 'research-run';
  assessment.options.push(assessment.options[0]!);
  expect(() => assessSignalQuality(bundle, 'a'.repeat(64), assessment)).toThrow('every option');
  assessment.options = [];
  expect(() => assessSignalQuality(bundle, 'a'.repeat(64), assessment)).toThrow('closed');
});
it('never admits fixture knowledge or an unsupported empty claim set', () => {
  const bundle = evidenceExample();
  expect(assessSignalQuality(bundle, 'a'.repeat(64), review())[0]?.level).toBe('held');
  bundle.mode = 'agent-assisted';
  bundle.candidates[0]!.claim_ids = [];
  expect(assessSignalQuality(bundle, 'a'.repeat(64), review())[0]?.level).toBe('held');
});
