import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  advanceInvestigationPlan,
  createInvestigation,
  planInvestigation,
  projectInvestigationClaimReviews,
  projectInvestigationMethodProgress,
  renderInvestigation,
  reviseInvestigation,
  reviewInvestigationClaim,
  resumeInvestigation,
  validateInvestigation,
} from '../src/index.mjs';
import { fakeCodex, message } from './fake-codex.mjs';

const sourceText = 'The retained capture records 17 units for the measured yield.';
const span = '17 units';
const start = sourceText.indexOf(span);
const source = { uri: 'https://example.org/yield-capture', text: sourceText };
const result = {
  findings: ['The retained capture reports a yield of 17 units.'],
  gaps: ['The capture does not identify the measurement date.'],
  sources: [{ uri: source.uri }],
  answer: 'The answer reports 17 units, with a measurement-date gap.',
};

test('adaptive method progress and exact source-to-claim review survive cold reopen and turn historical on source drift', async () => {
  const fixture = await fakeCodex({ sessions: [{ events: [message(JSON.stringify(result)), { type: 'turn.completed' }] }] });
  try {
    const initial = createInvestigation('What yield does the capture report?', {
      goal: 'Inspect the retained yield claim',
      questions: [{ id: 'yield', parentId: null, question: 'What measured yield is stated?' }],
      sources: [source],
      budget: { searches: 0, documents: 1, seconds: 20, calls: 3 },
    });
    const baseline = planInvestigation(initial);
    assert.equal(baseline.methodProgress.baseline.completedBranches, 0);
    assert.deepEqual(baseline.methodProgress.branches.map(branch => branch.status), ['unstarted']);

    let investigated = await advanceInvestigationPlan(initial, baseline, {
      confirmedPlanDigest: baseline.digest,
      action: 'investigate',
      branchIds: ['yield'],
      lease: fixture.lease,
    });
    const progressed = planInvestigation(investigated);
    assert.equal(progressed.methodProgress.current.completedBranches, 1);
    assert.equal(progressed.methodProgress.current.findings, 1);
    assert.equal(progressed.methodProgress.current.reviewedFindings, 0);
    assert.equal(progressed.methodProgress.current.reportedGaps, 1);
    assert.equal(progressed.remaining.calls, 2);

    assert.throws(() => reviewInvestigationClaim(investigated, {
      attemptId: 'a1', findingIndex: 0, assessment: 'supports', rationale: 'Bad span is refused.',
      citations: [{ sourceIndex: 0, start, end: start + span.length, quote: '17 tons' }],
    }), /citation does not match/);
    investigated = reviewInvestigationClaim(investigated, {
      attemptId: 'a1',
      findingIndex: 0,
      assessment: 'supports',
      rationale: 'The selected quote contains the same numeric yield phrase; this is a caller assessment, not an entailment decision.',
      citations: [{ sourceIndex: 0, start, end: start + span.length, quote: span }],
    });
    const cold = validateInvestigation(JSON.parse(JSON.stringify(investigated)));
    const review = projectInvestigationClaimReviews(cold)[0];
    assert.equal(review.status, 'current');
    assert.equal(review.citations[0].sourceUri, source.uri);
    assert.equal(review.citations[0].sourceSha256, createHash('sha256').update(sourceText).digest('hex'));
    assert.equal(review.citations[0].quote, span);
    const reviewedPlan = planInvestigation(cold);
    assert.equal(reviewedPlan.methodProgress.current.reviewedFindings, 1);
    assert.equal(reviewedPlan.remaining.calls, 2, 'review does not consume or reset execution budget');
    assert.notEqual(reviewedPlan.digest, progressed.digest, 'review state is part of the next versioned checkpoint');
    await assert.rejects(resumeInvestigation(cold, progressed, { action: 'investigate', branchIds: ['yield'], lease: fixture.lease }), /stale or mismatched/);
    assert.match(renderInvestigation(cold), /Finding-to-source reviews/);
    assert.match(renderInvestigation(cold), /UTF-16/);
    assert.match(renderInvestigation(cold), /Caller-authored source-span review/);

    const drifted = reviseInvestigation(cold, { sources: [{ ...source, text: `${sourceText} The capture is now revised.` }] });
    const reopenedDrift = validateInvestigation(JSON.parse(JSON.stringify(drifted)));
    assert.equal(projectInvestigationClaimReviews(reopenedDrift)[0].status, 'historical');
    assert.equal(projectInvestigationMethodProgress(reopenedDrift).current.completedBranches, 0);
    assert.equal(planInvestigation(reopenedDrift).remaining.calls, 2);
    assert.throws(() => reviewInvestigationClaim(reopenedDrift, {
      attemptId: 'a1', findingIndex: 0, assessment: 'supports', rationale: 'Attempt to reuse stale source span.',
      citations: [{ sourceIndex: 0, start, end: start + span.length, quote: span }],
    }), /not a current completed investigation result/);
    assert.equal((await fixture.probes()).filter(args => args[0] === 'exec').length, 1);
  } finally {
    await fixture.cleanup();
  }
});
