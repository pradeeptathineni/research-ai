import test from 'node:test';
import assert from 'node:assert/strict';
import { createInvestigation, reviseInvestigation, advanceInvestigation, planInvestigation,
  resumeInvestigation, getInvestigationIncompleteCandidate } from '../src/index.mjs';
import { fakeCodex, message } from './fake-codex.mjs';

const completed = { type: 'turn.completed' };
const failed = { type: 'turn.failed', error: { message: 'synthetic incomplete native turn' } };
const event = (value, terminal = completed) => ({ events: [message(JSON.stringify(value)), terminal] });
const source = { uri: 'https://example.org/frozen', text: 'Synthetic frozen source text.' };
const candidateOutput = {
  findings: ['Candidate-only sentinel: the source mentions export.'],
  gaps: ['Candidate coverage is unfinished.'],
  sources: [{ uri: source.uri }],
  answer: 'Candidate-only sentinel answer.',
};

test('unfinished compatible final is projected without acceptance or budget reset, and completion remains unchanged', async () => {
  const fixture = await fakeCodex({ sessions: [event(candidateOutput, failed), event({
    findings: ['A completed follow-up finding.'], gaps: [], sources: [{ uri: source.uri }], answer: 'Completed follow-up.',
  })] });
  try {
    const initial = createInvestigation('Synthetic topic', {
      questions: [{ id: 'q1', parentId: null, question: 'What is in the frozen source?' }],
      sources: [source], budget: { searches: 4, documents: 4, seconds: 60, calls: 3 },
    });
    const partial = await advanceInvestigation(initial, { action: 'investigate', branchIds: ['q1'], lease: fixture.lease });
    assert.equal(partial.history[0].status, 'failed');
    assert.equal(partial.history[0].reason, 'runner_turn_failed');
    assert.deepEqual(partial.history[0].findings, []);
    assert.equal(partial.history[0].answer, '');
    const before = structuredClone(partial);
    const priorPlan = planInvestigation(partial);
    const projected = getInvestigationIncompleteCandidate(partial, partial.history[0].id);
    assert.deepEqual(projected, {
      schema: 'research-investigation-incomplete-candidate-v1',
      attemptId: partial.history[0].id,
      executionStatus: 'failed',
      reason: partial.history[0].reason,
      candidate: candidateOutput,
      qualification: 'Unfinished session output. Not accepted findings and not supplied automatically to later research.',
    });
    assert.deepEqual(partial, before, 'projection must not mutate the persisted investigation');
    assert.equal(planInvestigation(partial).digest, priorPlan.digest, 'projection must not alter budget or checkpoint');
    assert.equal(priorPlan.remaining.calls, 2);

    const resumed = await resumeInvestigation(partial, priorPlan, { action: 'investigate', branchIds: ['q1'], lease: fixture.lease });
    assert.equal(resumed.used.calls, 2, 'the failed native call remains charged');
    assert.equal(resumed.history[0].findings.length, 0, 'candidate output is never promoted to accepted findings');
    assert.doesNotMatch((await fixture.session(1)).prompt, /Candidate-only sentinel/,
      'candidate output is not silently supplied to a later investigation');
    assert.equal(getInvestigationIncompleteCandidate(resumed, resumed.history[1].id), null,
      'a complete attempt has no incomplete candidate projection');
    assert.equal((await fixture.probes()).filter(args => args[0] === 'exec').length, 2);
  } finally { await fixture.cleanup(); }
});

test('invalid, absent, non-investigate and stale-context output returns null', async () => {
  const fixture = await fakeCodex({ sessions: [
    event({ findings: [7], gaps: [], sources: [], answer: 'Schema-invalid candidate.' }, failed),
    { events: [failed] },
    { events: [message('not JSON'), failed] },
    event({ questions: ['Clarification candidate.'] }, failed),
  ] });
  try {
    const initial = createInvestigation('Synthetic topic', {
      questions: [{ id: 'q1', parentId: null, question: 'Original question?' }], sources: [source],
    });
    const invalidState = await advanceInvestigation(initial, { action: 'investigate', branchIds: ['q1'], lease: fixture.lease });
    assert.equal(invalidState.history[0].status, 'failed');
    assert.equal(getInvestigationIncompleteCandidate(invalidState, invalidState.history[0].id), null);
    assert.equal(getInvestigationIncompleteCandidate(invalidState, 'missing-attempt'), null);
    assert.equal(getInvestigationIncompleteCandidate(invalidState, invalidState.history[0].id + '-suffix'), null);

    const noFinal = await advanceInvestigation(invalidState, { action: 'investigate', branchIds: ['q1'], lease: fixture.lease });
    assert.equal(noFinal.history.at(-1).receipt.final, '');
    assert.equal(getInvestigationIncompleteCandidate(noFinal, noFinal.history.at(-1).id), null);
    const malformed = await advanceInvestigation(noFinal, { action: 'investigate', branchIds: ['q1'], lease: fixture.lease });
    assert.equal(getInvestigationIncompleteCandidate(malformed, malformed.history.at(-1).id), null);

    const changedSources = reviseInvestigation(invalidState, {
      sources: [{ ...source, text: 'Changed frozen source bytes.' }],
    });
    assert.equal(getInvestigationIncompleteCandidate(changedSources, invalidState.history[0].id), null,
      'changed source/context closure makes historical candidate unavailable');

    const clarification = await advanceInvestigation(malformed, { action: 'clarify', lease: fixture.lease });
    assert.equal(clarification.history.at(-1).action, 'clarify');
    assert.equal(clarification.history.at(-1).status, 'failed');
    assert.equal(getInvestigationIncompleteCandidate(clarification, clarification.history.at(-1).id), null,
      'unfinished non-investigate output is out of scope');
  } finally { await fixture.cleanup(); }
});
