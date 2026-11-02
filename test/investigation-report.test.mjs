import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  advanceInvestigationPlan, createInvestigation, createInvestigationReportBasis, createReport,
  exportReportHtml, planInvestigation, projectReportClaimRegister, renderReport,
  reviseReport, reviewInvestigationClaim, validateInvestigationReportBasis, validateReport,
} from '../src/index.mjs';
import { fakeCodex, message } from './fake-codex.mjs';

const text = 'The retained capture records 17 units. It does not report the measurement date.';
const source = { uri: 'https://example.org/yield-capture', text };
const result = {
  findings: [
    'The retained capture reports 17 units.',
    'The measurement date is absent from this capture.',
    'Independent replication is supported by this capture.',
    'The capture gives context for a broader comparison.',
    'A second source confirms the reported yield.',
  ],
  gaps: ['No independent source was included.'],
  sources: [{ uri: source.uri }],
  answer: 'The capture reports 17 units; independent replication remains unknown.',
};
const span = value => {
  const start = text.indexOf(value);
  return { sourceIndex: 0, start, end: start + value.length, quote: value };
};

test('projects a reviewed Investigation into a cold-open cited report and exports only the revised current revision', async () => {
  const fixture = await fakeCodex({ sessions: [{ events: [message(JSON.stringify(result)), { type: 'turn.completed' }] }] });
  try {
    const initial = createInvestigation('What does the capture establish?', {
      questions: [{ id: 'yield', parentId: null, question: 'What yield and qualification are stated?' }],
      sources: [source],
      budget: { searches: 0, documents: 1, seconds: 20, calls: 2 },
    });
    const checkpoint = planInvestigation(initial);
    let investigated = await advanceInvestigationPlan(initial, checkpoint, {
      confirmedPlanDigest: checkpoint.digest, action: 'investigate', branchIds: ['yield'], lease: fixture.lease,
    });
    investigated = reviewInvestigationClaim(investigated, {
      attemptId: 'a1', findingIndex: 0, assessment: 'supports',
      rationale: 'The caller judges the retained numeric phrase consistent with this finding.',
      citations: [span('17 units')],
    });
    investigated = reviewInvestigationClaim(investigated, {
      attemptId: 'a1', findingIndex: 1, assessment: 'unresolved',
      rationale: 'Absence in this capture does not establish absence elsewhere.',
      citations: [span('measurement date')],
    });
    investigated = reviewInvestigationClaim(investigated, {
      attemptId: 'a1', findingIndex: 2, assessment: 'contradicts',
      rationale: 'The source does not establish independent replication.',
      citations: [span('17 units')],
    });
    investigated = reviewInvestigationClaim(investigated, {
      attemptId: 'a1', findingIndex: 3, assessment: 'context',
      rationale: 'This quote is only relevant background for the comparison.',
      citations: [span('measurement date')],
    });

    const basis = createInvestigationReportBasis(investigated, 'yield', 'a1');
    assert.deepEqual(validateInvestigationReportBasis(investigated, 'yield', 'a1', JSON.parse(JSON.stringify(basis))), basis);
    const tamperedBasis = JSON.parse(JSON.stringify(basis));
    tamperedBasis.sections[0].gaps[0] = 'Removed caller qualification.';
    assert.throws(() => validateInvestigationReportBasis(investigated, 'yield', 'a1', tamperedBasis), /differs from the selected Investigation/);
    const changedReviews = reviewInvestigationClaim(investigated, {
      attemptId: 'a1', findingIndex: 0, assessment: 'supports',
      rationale: 'A later duplicate review requires explicit reconciliation.',
      citations: [span('17 units')],
    });
    assert.throws(() => validateInvestigationReportBasis(changedReviews, 'yield', 'a1', basis), /caller-review snapshot/);
    assert.equal(basis.topic, 'What yield and qualification are stated?');
    assert.match(basis.sources[0].uri, /research-ai\.invalid\/investigation-source/);
    assert.match(basis.sources[0].uri, /questionSha256=/);
    const projectedPoints = basis.sections.flatMap(section => section.points).map(point => point.text).join('\n');
    assert.match(projectedPoints, /Caller review \(supports\)/);
    const gaps = basis.sections.flatMap(section => section.gaps).join('\n');
    assert.match(gaps, /No independent source was included/);
    assert.match(gaps, /caller review unresolved/);
    assert.match(gaps, /caller review contradicts/);
    assert.match(gaps, /caller review context/);
    assert.match(gaps, /not explicitly reviewed/);
    assert.doesNotMatch(projectedPoints, /measurement date is absent|Independent replication|broader comparison|second source/);
    const withoutReviews = { ...investigated };
    delete withoutReviews.claimReviews;
    const unknownOnly = createInvestigationReportBasis(withoutReviews, 'yield', 'a1');
    assert.equal(unknownOnly.sections.flatMap(section => section.points).length, 0);
    assert.match(unknownOnly.sources[0].uri, /uri=https%3A%2F%2Fexample.org%2Fyield-capture/);
    assert.ok(unknownOnly.limits.some(limit => /no evidence citation is asserted/.test(limit)));
    const unknownReport = createReport(unknownOnly);
    assert.equal(projectReportClaimRegister(unknownReport).citedClaims.length, 0);
    assert.ok(projectReportClaimRegister(unknownReport).unresolvedClaims.length > 0);

    const draft = createReport(basis);
    const initialRegister = projectReportClaimRegister(draft);
    assert.equal(initialRegister.citedClaims.length, 1, 'contradicts, context, unresolved and missing reviews are not cited claims');
    assert.match(initialRegister.citedClaims[0].text, /Caller review \(supports\)/);
    assert.equal(initialRegister.unresolvedClaims.length, 5, 'source gaps and each non-support finding stay explicit');
    const first = basis.sections[0];
    const reviewed = reviseReport(draft, {
      sectionId: first.id,
      paragraphs: [{ text: 'Reviewed wording: the retained capture records 17 units.', citations: first.points[0].citations }],
    });
    const cold = validateReport(JSON.parse(JSON.stringify(reviewed)));
    const register = projectReportClaimRegister(cold);
    assert.equal(register.revision, reviewed.revision);
    assert.equal(register.citedClaims[0].text, 'Reviewed wording: the retained capture records 17 units.');
    assert.ok(register.unresolvedClaims.some(claim => /replication|measurement date|not explicitly reviewed/i.test(claim.text)));
    const html = exportReportHtml(cold);
    assert.equal(exportReportHtml(reviewed), html);
    assert.equal(renderReport(cold), renderReport(reviewed));
    assert.match(html, /Reviewed wording: the retained capture records 17 units\./);
    assert.match(html, /caller review unresolved/);
    assert.match(html, /No independent source was included/);
    assert.match(html, /17 units/);
    assert.match(html, new RegExp(createHash('sha256').update(JSON.stringify(cold)).digest('hex')));
    assert.equal((await fixture.probes()).filter(args => args[0] === 'exec').length, 1, 'projection, edits, reopen and export do not rerun research');
  } finally {
    await fixture.cleanup();
  }
});
