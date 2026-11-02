import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  advanceInvestigationPlan, createInvestigation, createInvestigationReportBasis, createReport,
  exportReportHtml, planInvestigation, projectReportClaimRegister, renderReport,
  reviseReport, reviewInvestigationClaim, validateReport,
} from '../src/index.mjs';
import { fakeCodex, message } from './fake-codex.mjs';

const text = 'The retained capture records 17 units. It does not report the measurement date.';
const source = { uri: 'https://example.org/yield-capture', text };
const result = {
  findings: [
    'The retained capture reports 17 units.',
    'The measurement date is absent from this capture.',
    'Independent replication is not established.',
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

    const basis = createInvestigationReportBasis(investigated, 'yield', 'a1');
    assert.equal(basis.topic, 'What yield and qualification are stated?');
    assert.match(basis.sources[0].uri, /research-ai\.invalid\/investigation-source/);
    assert.match(basis.sources[0].uri, /questionSha256=/);
    assert.match(basis.sections.flatMap(section => section.points).map(point => point.text).join('\n'), /Human review \(supports\)/);
    const gaps = basis.sections.flatMap(section => section.gaps).join('\n');
    assert.match(gaps, /No independent source was included/);
    assert.match(gaps, /caller review unresolved/);
    assert.match(gaps, /not explicitly reviewed/);
    assert.doesNotMatch(basis.sections.flatMap(section => section.points).map(point => point.text).join('\n'), /measurement date is absent/);

    const draft = createReport(basis);
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
