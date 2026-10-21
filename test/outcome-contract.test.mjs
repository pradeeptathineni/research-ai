import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { researchQuestion, withCodexWorkspace, sessionCompleted } from '../src/index.mjs';
import { fakeCodex, message, search } from './fake-codex.mjs';

let fixture;
beforeEach(async () => {
  fixture = await fakeCodex();
  assert.equal(process.env.HOME, fixture.home);
  assert.equal(process.env.PATH, fixture.env.PATH);
  assert.equal(process.env.CODEX_HOME, undefined);
});
afterEach(async () => { await fixture.cleanup(); });
const exact = '  Café ✓ 😀\n\nFallible evidence.\n';
const success = { type: 'turn.completed' };
const supplied = () => [{ uri: 'https://example.org/frozen', text: 'Naïve ✓ 😀\nCaptured text.\n', observedAt: 'caller note', omissions: ['coverage unknown'] }];
const run = (options = {}) => researchQuestion('Synthetic outcome contract', { lease: fixture.lease, model: 'fixture-model', effort: 'high', ...options });
const session = (options = {}) => withCodexWorkspace({ lease: fixture.lease, prefix: 'research-outcome-' },
  ws => ws.run({ prompt: 'Synthetic lower-level contract', live: true,
    budget: { searches: 1, documents: 1, seconds: 2 }, signal: new AbortController().signal, ...options }));
const absent = path => access(path).then(() => false, () => true);
const partition = counts => assert.equal(counts.completed, Object.entries(counts).filter(([key]) => key !== 'completed').reduce((sum, [, value]) => sum + value, 0));

describe('research-outcome-v1', () => {
  for (const [name, tail, code, status, failure] of [
    ['complete', [success], 0, 'complete', undefined],
    ['turn failure with nonzero exit', [{ type: 'turn.failed' }], 2, 'partial', 'runner_turn_failed'],
    ['protocol failure with nonzero exit', [{ type: 'error', message: 'synthetic protocol failure' }], 3, 'partial', 'runner_protocol_error'],
    ['malformed protocol with nonzero exit', ['{'], 4, 'partial', 'invalid_runner_event'],
  ]) {
    it(`preserves exact ${name} result and independent termination/cause`, async () => {
      await fixture.scenario({ events: [message(exact), ...tail], exitCode: code });
      const result = await run({ sources: supplied() });
      assert.equal(result.status, status);
      assert.equal(result.answer, exact);
      assert.equal(result.receipt.mode, 'frozen');
      assert.equal(result.receipt.failure, failure);
      assert.equal(result.receipt.termination.exitCode, code);
      assert.equal(result.receipt.model, 'fixture-model');
      assert.equal(result.receipt.effort, 'high');
      assert.equal(result.receipt.provider, null);
      assert.equal(result.receipt.nativeSessions, 1);
      assert.deepEqual(result.receipt.source, supplied().map(({ text, ...metadata }) => ({ ...metadata, sha256: createHash('sha256').update(text).digest('hex') })));
      partition(result.receipt.actionCounts.messages);
      assert.equal(await absent(fixture.lease), true);
      const { args } = await fixture.record();
      assert.ok(args.includes('web_search="disabled"'));
      assert.equal(await absent(args[args.indexOf('--cd') + 1]), true);
    });
  }
  it('retains legacy live mode, unknown usage and host-default selection without inventing usage', async () => {
    await fixture.scenario({ events: [message(exact), success] });
    const result = await run({ model: undefined, effort: undefined });
    assert.equal(result.receipt.mode, undefined);
    assert.equal('source' in result.receipt, false);
    assert.equal(result.receipt.provider, null);
    assert.equal(result.receipt.model, 'host-default');
    assert.equal(result.receipt.effort, 'host-default');
    assert.equal(result.answer, exact);
  });
  for (const type of ['reasoning', 'command_execution', 'mcp_tool_call']) {
    it(`never admits raw ${type} text as an answer`, async () => {
      await fixture.scenario({ events: [{ type: 'item.completed', item: { type, text: 'RAW_TOOL_SENTINEL' } }, success] });
      const result = await run();
      assert.equal(result.status, 'failed');
      assert.equal(result.answer, '');
      assert.equal(JSON.stringify(result).includes('RAW_TOOL_SENTINEL'), false);
      partition(result.receipt.actionCounts.messages);
    });
  }
  it('rejects frozen web activity and preserves the earlier note', async () => {
    await fixture.scenario({ events: [message(exact), search(), success] });
    const result = await run({ sources: supplied() });
    assert.equal(result.status, 'partial');
    assert.equal(result.answer, exact);
    assert.equal(result.receipt.failure, 'forbidden_runner_tool');
    assert.equal(result.receipt.mode, 'frozen');
  });
  it('rejects over-budget frozen material before touching an existing lease or dispatching', async () => {
    await mkdir(fixture.lease);
    const owner = JSON.stringify({ pid: process.pid, childPid: null });
    await writeFile(join(fixture.lease, 'owner.json'), owner);
    await assert.rejects(run({ sources: [{ uri: 'https://example.org', text: 'x'.repeat(48001) }] }), /invalid_sources/);
    assert.equal(await readFile(join(fixture.lease, 'owner.json'), 'utf8'), owner);
    assert.equal(await fixture.launched(), false);
    assert.deepEqual(await fixture.probes(), []);
  });
  it('keeps cancellation separate after receiving the final frame', async () => {
    await fixture.scenario({ events: [message(exact), success], hang: true });
    const controller = new AbortController();
    const result = await run({ signal: controller.signal, onCheckpoint: () => { setTimeout(() => controller.abort(), 20); } });
    assert.equal(result.receipt.terminal.completed, 1);
    assert.equal(result.status, 'partial');
    assert.equal(result.answer, exact);
    assert.equal(result.receipt.failure, 'cancelled');
    assert.equal(result.receipt.termination.trigger, 'request_aborted');
    assert.equal(result.receipt.termination.signal, 'SIGKILL');
  });
});

describe('bounded callback observations', () => {
  it('retains checkpoint callback loss as a host stop, never malformed provider protocol', async () => {
    await fixture.scenario({ events: [message(exact), success] });
    const result = await run({ onCheckpoint: () => { throw new Error('HOST_CALLBACK_SENTINEL'); } });
    assert.equal(result.status, 'partial');
    assert.equal(result.answer, exact);
    assert.equal(result.receipt.failure, 'checkpoint_callback_failed');
    assert.equal(result.receipt.terminal.protocolFailure, null);
    assert.equal(JSON.stringify(result).includes('HOST_CALLBACK_SENTINEL'), false);
    partition(result.receipt.actionCounts.messages);
  });
  it('fails closed on a stream progress callback error before it can bypass action limits', async () => {
    await fixture.scenario({ events: [message(exact), { type: 'item.started', item: { type: 'web_search' } }, success] });
    let calls = 0;
    const outcome = await session({ progress: () => { if (++calls > 1) throw new Error('synthetic observer loss'); } });
    assert.equal(outcome.failureReason, 'progress_callback_failed');
    assert.equal(outcome.readable.text, exact);
    assert.equal(outcome.terminal.protocolFailure, null);
    assert.equal(sessionCompleted(outcome), false);
  });
  it('partitions a throwing note reader and preserves previous readable evidence', async () => {
    await fixture.scenario({ events: [message(exact), message('next'), success] });
    const outcome = await session({ readNote: text => { if (text === 'next') throw new Error('synthetic reader failure'); return { format: 'markdown', text }; } });
    assert.equal(outcome.failureReason, 'read_note_failed');
    assert.equal(outcome.readable.text, exact);
    assert.equal(outcome.terminal.protocolFailure, null);
    assert.equal(outcome.actionCounts.messages.unreadable, 1);
    partition(outcome.actionCounts.messages);
  });
  it('rejects asynchronous pre-spawn observations without dispatch and handles their rejection', async () => {
    await assert.rejects(run({ progress: async () => { throw new Error('synthetic async observation'); } }), /async_session_callback/);
    assert.equal(await fixture.launched(), false);
    assert.equal(await absent(fixture.lease), true);
  });
  it('preserves pre-spawn callback rejection and cleans the workspace', async () => {
    const failure = new Error('synthetic beforeSpawn failure');
    await assert.rejects(session({ beforeSpawn: () => { throw failure; } }), error => error === failure);
    assert.equal(await fixture.launched(), false);
    assert.equal(await absent(fixture.lease), true);
  });
});

describe('bounded cleanup and guards', () => {
  it('never displaces a live orphan referenced by a stale owner', async () => {
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    await mkdir(fixture.lease);
    const owner = JSON.stringify({ pid: dead, childPid: process.pid });
    await writeFile(join(fixture.lease, 'owner.json'), owner);
    await assert.rejects(run(), /runner_orphan_still_active/);
    assert.equal(await readFile(join(fixture.lease, 'owner.json'), 'utf8'), owner);
    assert.equal(await fixture.launched(), false);
  });
  for (const [name, scenario, overrides, trigger] of [
    ['deadline', { events: [message(exact)], hang: true }, { budget: { searches: 1, documents: 1, seconds: 1.5 } }, 'native_deadline'],
    ['response cap', { events: [message(exact), message('😀'.repeat(100)), success] }, { maxResponseBytes: 80 }, 'response_byte_limit'],
    ['action cap', { events: [message(exact), search(), success] }, { budget: { searches: 0, documents: 0, seconds: 2 } }, 'action_limit'],
  ]) {
    it(`keeps earlier partial evidence and cleanup for ${name}`, async () => {
      await fixture.scenario(scenario);
      const outcome = await session(overrides);
      assert.equal(sessionCompleted(outcome), false);
      assert.equal(outcome.readable.text, exact);
      assert.equal(outcome.termination.trigger, trigger);
      assert.equal(outcome.failureReason, trigger);
      assert.equal(await absent(fixture.lease), true);
      partition(outcome.actionCounts.messages);
    });
  }
});

it('keeps a capped UTF-8 final prefix within the actual byte cap', async () => {
  await fixture.scenario({ events: [message('✓'), message('😀'.repeat(40)), success] });
  const outcome = await session({ maxResponseBytes: 21 });
  assert.equal(outcome.termination.trigger, 'response_byte_limit');
  assert.equal(outcome.final, '😀'.repeat(5));
  assert.equal(Buffer.byteLength(outcome.final) <= 21, true);
  assert.equal(outcome.final.isWellFormed(), true);
  assert.equal(outcome.readable.text, '✓');
});

it('drains the synthetic process group including a descendant before releasing its lease', async () => {
  const executable = join(fixture.env.PATH, 'codex');
  const original = await readFile(executable, 'utf8');
  const marker = "process.stdin.on('end', () => {";
  assert.ok(original.includes(marker));
  await writeFile(executable, original.replace(marker, marker + `
    const descendant = require('node:child_process').spawn(process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    writeFileSync(join(home, 'descendant.json'), JSON.stringify({ pid: descendant.pid }));`));
  await fixture.scenario({ events: [message(exact)], hang: true });
  const controller = new AbortController();
  let descendantPid, checkpoint = false;
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
  try {
    const outcome = await withCodexWorkspace({ lease: fixture.lease, prefix: 'research-group-' }, async ws => {
      const pending = ws.run({ prompt: 'Synthetic process-group lifecycle', live: false,
        budget: { searches: 0, documents: 0, seconds: 5 }, signal: controller.signal,
        onCheckpoint: () => { checkpoint = true; } });
      for (let n = 0; n < 200; n++) {
        const raw = await readFile(join(fixture.home, 'descendant.json'), 'utf8').catch(() => '');
        if (raw) descendantPid = JSON.parse(raw).pid;
        if (descendantPid && checkpoint) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(descendantPid && checkpoint, 'synthetic group reached its checkpoint');
      assert.equal(alive(descendantPid), true);
      controller.abort();
      return await pending;
    });
    assert.equal(outcome.failureReason, 'cancelled');
    assert.equal(outcome.readable.text, exact);
    for (let n = 0; n < 200 && alive(descendantPid); n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(alive(descendantPid), false);
    assert.equal(await absent(fixture.lease), true);
  } finally {
    controller.abort();
    if (descendantPid && alive(descendantPid)) process.kill(descendantPid, 'SIGKILL');
  }
});

it('preserves terminal-order evidence alongside the stronger frozen-tool stop', async () => {
  await fixture.scenario({ events: [message(exact), success, search()] });
  const outcome = await session({ live: false });
  assert.equal(sessionCompleted(outcome), false);
  assert.equal(outcome.readable.text, exact);
  assert.equal(outcome.termination.trigger, 'forbidden_runner_tool');
  assert.equal(outcome.terminal.protocolFailure, 'activity_after_runner_terminal');
});
it('rejects precharged searches beyond budget before dispatch', async () => {
  await assert.rejects(session({ initialSearches: 2, budget: { searches: 1, documents: 0, seconds: 2 } }), /invalid_session_limit/);
  assert.equal(await fixture.launched(), false);
  assert.equal(await absent(fixture.lease), true);
});
it('handles invalid and asynchronous note-reader returns without losing the message partition', async () => {
  for (const readNote of [() => ({}), async () => { throw new Error('synthetic rejected note'); }]) {
    await fixture.scenario({ events: [message(exact), success] });
    const outcome = await session({ readNote });
    assert.equal(outcome.failureReason, 'read_note_failed');
    assert.equal(outcome.actionCounts.messages.unreadable, 1);
    assert.equal(outcome.readable, undefined);
    assert.equal(outcome.terminal.protocolFailure, null);
    partition(outcome.actionCounts.messages);
  }
});
