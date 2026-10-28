import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { researchQuestion, withCodexWorkspace, sessionCompleted, researchActivity } from '../src/index.mjs';
import { fakeCodex, message, search } from './fake-codex.mjs';

let fixture;
beforeEach(async () => { fixture = await fakeCodex(); });
afterEach(async () => { await fixture.cleanup(); });

const success = { type: 'turn.completed', usage: { input_tokens: 1 } };
const answer = 'Fallible answer ANSWER_CANARY';
const canaries = ['PROMPT_CANARY', 'THREAD_CANARY', 'QUERY_CANARY', 'PATTERN_CANARY', 'ANALYSIS_CANARY',
  'EXTENSION_CANARY', 'ANSWER_CANARY', 'SCHEMA_CANARY', 'token=', 'user:pass', 'DIAGNOSTIC_CANARY'];
const web = (action) => ({ type: 'item.completed', item: { type: 'web_search', query: 'QUERY_CANARY', action } });
const started = { type: 'item.started', item: { type: 'web_search', query: 'QUERY_CANARY' } };
const absent = path => access(path).then(() => false, () => true);
const session = (options = {}) => withCodexWorkspace({ lease: fixture.lease, prefix: 'research-activity-' },
  ws => ws.run({ prompt: 'PROMPT_CANARY synthetic', live: true,
    budget: { searches: 4, documents: 4, seconds: 5 }, signal: new AbortController().signal, ...options }));
const kinds = events => events.map(event => event.kind);
const settledOf = events => events.at(-1).detail;
const leaks = events => canaries.filter(canary => JSON.stringify(events).includes(canary));

describe('research-activity-v1', () => {
  it('delivers typed native activity before a delayed session settles, then the unchanged outcome', async () => {
    await fixture.scenario({ lineDelayMs: 40, events: [
      { type: 'thread.started', thread_id: 'THREAD_CANARY' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'reasoning', text: 'ANALYSIS_CANARY' } },
      { type: 'x.extension', payload: 'EXTENSION_CANARY' },
      started, search(),
      started, web({ type: 'open_page', url: 'https://example.org/guide' }),
      started, web({ type: 'open_page', url: 'https://example.org/p?token=EXTENSION_CANARY' }),
      started, web({ type: 'find_in_page', url: 'https://user:pass@example.org/', pattern: 'PATTERN_CANARY' }),
      web({ type: 'novel_action' }), web(undefined),
      message('Provisional interim note.'),
      message(answer), success,
    ] });
    const events = [], progress = [], checkpoints = [];
    let settledAt, firstAt;
    const pending = session({
      progress: line => progress.push(line),
      onCheckpoint: note => checkpoints.push(note.text),
      activity: event => {
        if (!events.length) firstAt = { time: performance.now(), settled: settledAt !== undefined };
        events.push(event);
      },
    });
    const outcome = await pending.finally(() => { settledAt = performance.now(); });
    assert.equal(firstAt.settled, false);
    assert.ok(settledAt - firstAt.time > 200, `first event ${Math.round(settledAt - firstAt.time)}ms before settlement`);
    assert.deepEqual(kinds(events), ['session.started', 'thread.started', 'turn.started',
      'web.started', 'web.completed', 'web.started', 'web.completed', 'web.started', 'web.completed',
      'web.started', 'web.completed', 'web.completed', 'web.completed', 'checkpoint', 'checkpoint',
      'turn.completed', 'session.settled']);
    events.forEach((event, index) => {
      assert.equal(event.version, 'research-activity-v1');
      assert.equal(event.sequence, index + 1);
      assert.equal(new Date(event.observedAt).toISOString(), event.observedAt);
      assert.ok(researchActivity.kinds.includes(event.kind));
      assert.deepEqual(Object.keys(event), ['version', 'sequence', 'observedAt', 'kind', 'detail']);
      assert.ok(Object.isFrozen(event) && Object.isFrozen(event.detail));
    });
    assert.deepEqual(events[0].detail, { mode: 'live' });
    assert.deepEqual(events.filter(event => event.kind === 'web.completed').map(event => event.detail), [
      { action: 'search', url: null, urlStatus: 'absent', searches: 1, reads: 0, unclassified: 0 },
      { action: 'open_page', url: 'https://example.org/guide', urlStatus: 'reported', searches: 1, reads: 1, unclassified: 0 },
      { action: 'open_page', url: null, urlStatus: 'withheld', searches: 1, reads: 2, unclassified: 0 },
      { action: 'find_in_page', url: null, urlStatus: 'withheld', searches: 1, reads: 3, unclassified: 0 },
      { action: 'unrecognized', url: null, urlStatus: 'absent', searches: 1, reads: 4, unclassified: 0 },
      { action: 'absent', url: null, urlStatus: 'absent', searches: 1, reads: 4, unclassified: 1 },
    ]);
    assert.deepEqual(events.filter(event => event.kind === 'checkpoint').at(-1).detail,
      { notes: 2, units: checkpoints.at(-1).length, bytes: Buffer.byteLength(checkpoints.at(-1)), omitted: false });
    assert.deepEqual(settledOf(events), { completed: true, failureReason: null, cleanup: true, delivered: 16, omitted: 0 });
    assert.deepEqual(leaks(events), []);
    // Existing observations and result meanings are unchanged by the observer.
    assert.equal(sessionCompleted(outcome), true);
    assert.equal(outcome.final, answer);
    assert.equal(progress.length, 5);
    assert.match(progress[0], /^Runner: Codex;/);
    assert.equal(checkpoints.length, 2);
    assert.equal(outcome.activity, undefined);
  });

  it('keeps structured schema output out of activity and checkpoints', async () => {
    await fixture.scenario({ events: [message('{"claims":"SCHEMA_CANARY"}'), success] });
    const events = [];
    const outcome = await session({ structured: true, outputSchema: { type: 'object' }, activity: event => events.push(event) });
    assert.equal(sessionCompleted(outcome), true);
    assert.equal(outcome.actionCounts.messages.schema, 1);
    assert.deepEqual(kinds(events), ['session.started', 'turn.completed', 'session.settled']);
    assert.deepEqual(leaks(events), []);
  });

  for (const [name, tail, reason] of [
    ['malformed line', ['{', success], 'invalid_runner_event'],
    ['invalid item', [{ type: 'item.completed', item: 'x' }, success], 'invalid_runner_event'],
    ['post-terminal activity', [success, { type: 'turn.started' }], 'activity_after_runner_terminal'],
    ['native error', [{ type: 'error', message: 'DIAGNOSTIC_CANARY' }, success], 'runner_protocol_error'],
  ]) {
    it(`preserves the existing ${name} failure and reports it without provider text`, async () => {
      await fixture.scenario({ events: [message('Readable note.'), ...tail] });
      const plain = await session();
      await fixture.scenario({ events: [message('Readable note.'), ...tail] });
      const events = [];
      const observed = await withCodexWorkspace({ lease: fixture.lease, prefix: 'research-activity-' },
        ws => ws.run({ prompt: 'PROMPT_CANARY synthetic', live: true, budget: { searches: 4, documents: 4, seconds: 5 },
          signal: new AbortController().signal, activity: event => events.push(event) }));
      for (const key of ['final', 'readable', 'diagnostic', 'terminal', 'termination', 'failureReason', 'actionCounts', 'cleanup'])
        assert.deepEqual(observed[key], plain[key], key);
      assert.equal(observed.terminal.protocolFailure, reason);
      assert.deepEqual(events.filter(event => event.kind === 'protocol.failed').map(event => event.detail), [{ reason }]);
      assert.equal(settledOf(events).completed, false);
      assert.equal(settledOf(events).failureReason, plain.failureReason);
      assert.deepEqual(leaks(events), []);
    });
  }

  it('stops on a throwing observer, keeps earlier notes and makes no further calls', async () => {
    await fixture.scenario({ events: [message('Kept note.'), started, search(), message('later'), success] });
    let calls = 0;
    const outcome = await session({ activity: event => { calls++; if (event.kind === 'web.started') throw new Error('OBSERVER_CANARY'); } });
    assert.equal(calls, 3);
    assert.equal(outcome.failureReason, 'activity_callback_failed');
    assert.equal(outcome.terminal.protocolFailure, null);
    assert.equal(outcome.readable.text, 'Kept note.');
    assert.equal(outcome.cleanup.complete, true);
    assert.equal(sessionCompleted(outcome), false);
    assert.equal(JSON.stringify(outcome).includes('OBSERVER_CANARY'), false);
    assert.equal(await absent(fixture.lease), true);
  });

  it('refuses a promise-returning observer and handles its rejection', async () => {
    await fixture.scenario({ events: [message('Kept note.'), success] });
    let calls = 0;
    const outcome = await session({ activity: async () => { calls++; throw new Error('async observer'); } });
    assert.equal(calls, 1);
    assert.equal(outcome.failureReason, 'activity_callback_failed');
    assert.equal(outcome.actionCounts.messages.checkpointed, 0);
    assert.equal(sessionCompleted(outcome), false);
  });

  it('never leaves a completed result when the settlement observation fails', async () => {
    await fixture.scenario({ events: [message(answer), success] });
    const outcome = await session({ activity: event => { if (event.kind === 'session.settled') throw new Error('late'); } });
    assert.equal(outcome.final, answer);
    assert.equal(outcome.termination.trigger, 'activity_callback_failed');
    assert.equal(outcome.cleanup.complete, true);
    assert.equal(sessionCompleted(outcome), false);
  });

  it('rejects an invalid observer before dispatch and is silent before spawn', async () => {
    await assert.rejects(session({ activity: 'text' }), /invalid_session_callback/);
    const events = [];
    await assert.rejects(session({ beforeSpawn: () => { throw new Error('pre-spawn'); }, activity: event => events.push(event) }), /pre-spawn/);
    assert.deepEqual(events, []);
    assert.equal(await fixture.launched(), false);
    assert.equal(await absent(fixture.lease), true);
  });

  it('does not publish activity if the prepared executable cannot spawn', async () => {
    const events = [];
    const outcome = await session({
      beforeSpawn: () => unlinkSync(join(fixture.env.PATH, 'codex')),
      activity: event => events.push(event),
    });
    assert.equal(outcome.nativeSessions, 0);
    assert.equal(sessionCompleted(outcome), false);
    assert.deepEqual(events, []);
    assert.equal(await absent(fixture.lease), true);
  });

  it('reports the frozen web guard as a host stop, never a completion', async () => {
    await fixture.scenario({ events: [started, web({ type: 'open_page', url: 'https://example.org/x' }), message(answer), success] });
    const events = [];
    const result = await researchQuestion('Frozen guard', { lease: fixture.lease,
      sources: [{ uri: 'https://example.org/frozen', text: 'Captured.' }], activity: event => events.push(event) });
    assert.equal(result.status, 'failed');
    assert.equal(result.receipt.failure, 'forbidden_runner_tool');
    assert.deepEqual(events[0].detail, { mode: 'frozen' });
    assert.deepEqual(events.find(event => event.kind === 'session.stopped').detail, { trigger: 'forbidden_runner_tool' });
    assert.ok(kinds(events).indexOf('session.stopped') < kinds(events).indexOf('web.started'));
    assert.equal(settledOf(events).completed, false);
    assert.equal(settledOf(events).failureReason, 'forbidden_runner_tool');
    assert.equal(await absent(fixture.lease), true);
  });

  it('reports cancellation and confirmed cleanup', async () => {
    await fixture.scenario({ events: [message('Kept note.')], hang: true });
    const controller = new AbortController(), events = [];
    const outcome = await session({ signal: controller.signal, activity: event => {
      events.push(event);
      if (event.kind === 'checkpoint') setTimeout(() => controller.abort(), 20);
    } });
    assert.equal(outcome.failureReason, 'cancelled');
    assert.deepEqual(kinds(events), ['session.started', 'checkpoint', 'session.stopped', 'session.settled']);
    assert.deepEqual(events[2].detail, { trigger: 'request_aborted' });
    assert.deepEqual(settledOf(events), { completed: false, failureReason: 'cancelled', cleanup: true, delivered: 3, omitted: 0 });
    assert.equal(await absent(fixture.lease), true);
  });

  it('bounds delivery and counts omitted observations', async () => {
    await fixture.scenario({ events: [...Array.from({ length: 600 }, search), message(answer), success] });
    const events = [];
    const outcome = await session({ budget: { searches: 1000, documents: 0, seconds: 10 }, activity: event => events.push(event) });
    assert.equal(sessionCompleted(outcome), true);
    assert.equal(events.length, researchActivity.limit + 2);
    assert.equal(events.at(-2).kind, 'activity.limited');
    assert.deepEqual(settledOf(events), { completed: true, failureReason: null, cleanup: true,
      // Started plus 511 searches fill the limit; 89 searches, the checkpoint and terminal are omitted.
      delivered: researchActivity.limit + 1, omitted: 600 - (researchActivity.limit - 1) + 2 });
  });
});
