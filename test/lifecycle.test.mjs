import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withCodexWorkspace, researchQuestion } from '../src/index.mjs';
import { fakeCodex, message } from './fake-codex.mjs';

let fixture;
beforeEach(async () => {
  fixture = await fakeCodex({ hang: true });
});
afterEach(async () => {
  await fixture.cleanup();
});
const options = () => ({
  prompt: 'Authored lifecycle fixture; no external research.',
  live: false,
  budget: { searches: 0, documents: 0, seconds: 2 },
  signal: new AbortController().signal,
});
const workspace = (body) =>
  withCodexWorkspace({ lease: fixture.lease, prefix: 'research-lifecycle-' }, body);
async function launched() {
  for (let n = 0; n < 150; n++) {
    if (await fixture.launched()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Synthetic child did not start');
}

it('rejects malformed or unbounded session options before native dispatch', async () => {
  const cases = [
    { budget: undefined },
    { budget: { searches: NaN, documents: 0, seconds: 1 } },
    { budget: { searches: 0, documents: Infinity, seconds: 1 } },
    { budget: { searches: 0, documents: 0, seconds: Infinity } },
    { budget: { searches: 0, documents: 0, seconds: -1 } },
    { maxResponseBytes: NaN },
    { maxResponseBytes: Infinity },
    { maxResponseBytes: 3000001 },
    { initialSearches: -1 },
    { signal: undefined },
    { live: 'live' },
    { prompt: '' },
    { onCheckpoint: 'text' },
  ];
  for (const invalid of cases)
    await assert.rejects(
      workspace((ws) => ws.run({ ...options(), ...invalid })),
      /invalid_session_/,
    );
  assert.equal(await fixture.launched(), false);
  await assert.rejects(access(fixture.lease));
});

it('does not dispatch a previously cancelled request', async () => {
  await assert.rejects(
    workspace((ws) => ws.run({ ...options(), signal: AbortSignal.abort() })),
    { name: 'AbortError' },
  );
  assert.equal(await fixture.launched(), false);
});

it('rejects malformed workspace configuration before creating a lease', async () => {
  await assert.rejects(
    withCodexWorkspace({ lease: fixture.lease }, async () => {}),
    /invalid_research_workspace/,
  );
  await assert.rejects(
    withCodexWorkspace({ lease: fixture.lease, prefix: '../escape' }, async () => {}),
    /invalid_research_workspace/,
  );
  await assert.rejects(access(fixture.lease));
  assert.equal(await fixture.launched(), false);
});

it('aborts and drains a discarded run before releasing its lease', async () => {
  let pending, childPid, late;
  const value = await workspace(async (ws) => {
    late = ws.run;
    pending = ws.run(options());
    await launched();
    childPid = JSON.parse(await readFile(join(fixture.lease, 'owner.json'), 'utf8')).childPid;
    return 'callback result';
  });
  assert.equal(value, 'callback result');
  const outcome = await pending;
  assert.equal(outcome.termination.trigger, 'request_aborted');
  assert.notEqual(outcome.termination.exitCode, 0);
  assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  await assert.rejects(access(fixture.lease));
  assert.throws(() => late(options()), /research_workspace_closed/);
});

it('refuses a second session and preserves callback errors after draining', async () => {
  const failure = new Error('authored callback failure');
  let pending;
  await assert.rejects(
    workspace(async (ws) => {
      pending = ws.run(options());
      assert.throws(() => ws.run(options()), /session_already_started/);
      await launched();
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal((await pending).termination.trigger, 'request_aborted');
  await assert.rejects(access(fixture.lease));
});

it('preserves complete final bytes even when the prompt length target is exceeded', async () => {
  const original = '    Literal Markdown indentation\n' + 'x'.repeat(25000) + '\n\n';
  await fixture.scenario({ events: [message(original), { type: 'turn.completed' }] });
  const result = await researchQuestion('Authored byte-preservation question', {
    lease: fixture.lease,
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.answer, original);
});

it('discloses interrupted note truncation through the existing bounded buffer', async () => {
  await fixture.scenario({
    events: [
      message('😀'.repeat(13000)),
      { type: 'item.completed', item: { type: 'command_execution' } },
    ],
    hang: true,
  });
  const result = await researchQuestion('Authored partial-note question', { lease: fixture.lease });
  assert.equal(result.status, 'partial');
  assert(result.answer.length <= 24000);
  assert.match(result.answer, /Additional completed notes omitted/);
  assert.equal(result.receipt.termination.trigger, 'forbidden_runner_tool');
});
