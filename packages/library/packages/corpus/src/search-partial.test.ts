import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type * as Os from 'node:os';
import type * as Child from 'node:child_process';
import { codexRunner, RunnerFailure, type SearchRunner } from './search-runner.js';
import { signalSearch } from './signal-search.js';
import { loadRun } from './search-store.js';
import { frozenFollowupMaterial } from './search-followup.js';
import { budgets } from '../../domain/src/search-contract.js';
import { digest } from './search-fetch.js';

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: () => void };
};
const state = vi.hoisted<{ home: string; pid?: number; script: (child: FakeChild) => void }>(
  () => ({
    home: '',
    script: () => {},
  }),
);
vi.mock('node:os', async (original) => ({
  ...(await original<typeof Os>()),
  homedir: () => state.home,
}));
// Fake process events only. No CLI, model, source fetch or authentication command.
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof Child>()),
  spawn: () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: Object.assign(new EventEmitter(), { destroy: () => {} }),
      stderr: Object.assign(new EventEmitter(), { destroy: () => {} }),
      pid: state.pid,
      unref: () => {},
      kill: () => {
        queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
        return true;
      },
      stdin: {
        end: () =>
          queueMicrotask(() => {
            state.script(child);
            // A producer stop resolves only after the child close is observed.
            queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
          }),
        destroy: () => {},
      },
    });
    return child;
  },
}));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, promise };
};
const emit = (child: FakeChild, text: string, type = 'agent_message') =>
  child.stdout.emit(
    'data',
    Buffer.from(JSON.stringify({ type: 'item.completed', item: { type, text } }) + '\n'),
  );
const answer = 'Inspect the [guide](https://example.org/guide). Independent use is unresolved.';
const request = {
  query: 'portable notes',
  profile: 'quick' as const,
  save: 'never' as const,
  cache: 'private' as const,
  review: false,
};
const ready = async () => ({
  available: true,
  broadSearch: true,
  runner: 'fixture',
  reason: 'fixture only',
});
const fixtureRunner = () => {
  const runner = codexRunner('fixture-model', 'high', { root: state.home, live: false });
  return { readiness: ready, discover: runner.discover.bind(runner) };
};
beforeEach(async () => {
  state.home = await realpath(await mkdtemp('/tmp/signals-partial-'));
  state.script = () => {};
  state.pid = undefined;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(state.home, { recursive: true, force: true });
  await rm(join('/tmp', `signals-ai-${digest(state.home).slice(0, 24)}.ai-lease`), {
    recursive: true,
    force: true,
  });
});

it('retains a note and the failed cleanup evidence when group absence cannot be confirmed', async () => {
  state.pid = 900001;
  const kill = process.kill.bind(process);
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === -state.pid!)
      throw Object.assign(new Error('denied group probe'), { code: 'EPERM' });
    return kill(pid, signal);
  });
  state.script = (child) => {
    emit(child, answer);
    child.stdout.emit('data', Buffer.from('{"type":"turn.completed"}\n'));
    child.emit('close', 0, null);
  };
  const result = await signalSearch(request, { root: state.home, runner: fixtureRunner() });
  expect(result.status).toBe('failed');
  expect(result.brief?.text).toBe(answer);
  expect(result.answerReceipt).toBeUndefined();
  expect(result.usage.providerUsage).toMatchObject({
    cleanup: { complete: false, error: 'process_group_cleanup_failed' },
    terminal: { completed: 1 },
  });
});

it('accounts for received narrative exclusions without retaining dropped message text', async () => {
  const controller = new AbortController();
  state.script = (child) => {
    emit(child, answer);
    emit(child, answer);
    emit(child, '{"unfinished":[');
    emit(child, 'Reasoning is not a completed narrative.', 'reasoning');
    controller.abort();
    emit(child, 'UNRETAINED_AFTER_STOP');
  };
  const result = await signalSearch(request, {
    root: state.home,
    signal: controller.signal,
    runner: fixtureRunner(),
  });
  expect(result.brief?.text).toBe(answer);
  expect(result.usage.providerUsage).toMatchObject({
    actionCounts: {
      messages: {
        completed: 4,
        checkpointed: 1,
        duplicate: 1,
        unreadable: 1,
        afterStop: 1,
        limited: 0,
        schema: 0,
      },
    },
    stages: { nativeSessionMonotonicMs: expect.any(Number) },
  });
  expect(result.usage.stop).toMatchObject({ reason: 'external' });
  expect(JSON.stringify(result)).not.toContain('UNRETAINED_AFTER_STOP');
  expect(JSON.stringify(result)).not.toContain('unfinished');
  const before = await readFile(join(state.home, '.signals/runs', result.runId + '.json'));
  expect(await loadRun(result.runId, state.home)).toEqual(result);
  expect(await readFile(join(state.home, '.signals/runs', result.runId + '.json'))).toEqual(before);
});

it('separates the host deadline from wall-clock jumps without changing narrative or memory privacy', async () => {
  const originalTimer = globalThis.setTimeout;
  let deadline: (() => void) | undefined;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((...args) => {
    if (args[1] === budgets.quick.seconds * 1000 && typeof args[0] === 'function')
      deadline = args[0];
    return originalTimer(...args);
  });
  const start = Date.now();
  const result = await signalSearch(
    { ...request, cache: 'memory' },
    {
      root: state.home,
      runner: {
        readiness: ready,
        discover: async (_request, signal, _progress, _hints, brief) => {
          brief?.({ format: 'markdown', text: answer });
          vi.spyOn(Date, 'now').mockReturnValue(start + 120000);
          deadline?.();
          expect(signal.aborted).toBe(true);
          expect(signal.reason).toBeInstanceOf(DOMException);
          throw new RunnerFailure('fixture stopped', 0, null);
        },
      },
    },
  );
  expect(result.status).toBe('cancelled');
  expect(result.brief?.text).toBe(answer);
  expect(result.usage.elapsedMs).toBeGreaterThanOrEqual(119000);
  expect(result.usage.stop).toMatchObject({ reason: 'deadline' });
  expect(result.usage.stop!.elapsedMonotonicMs).toBeLessThan(1000);
  expect(await readdir(state.home)).toEqual([]);
});

it('delivers useful output before process close and retains it after timeout and reopen', async () => {
  const arrived = deferred(),
    controller = new AbortController(),
    notes = vi.fn<(brief: { format: 'markdown'; text: string }) => void>();
  let settled = false;
  state.script = (child) => {
    emit(child, answer);
    arrived.resolve();
  };
  const pending = signalSearch(request, {
    root: state.home,
    signal: controller.signal,
    runner: fixtureRunner(),
    brief: notes,
  }).then((result) => {
    settled = true;
    return result;
  });
  await arrived.promise;
  expect(settled).toBe(false);
  expect(notes).toHaveBeenCalledWith({ format: 'markdown', text: answer });
  controller.abort();
  const result = await pending;
  expect(result.status).toBe('cancelled');
  expect(result.brief?.text).toBe(answer);
  expect(result.answerReceipt).toBeUndefined();
  expect(result.items).toEqual([]);
  expect(result.gaps.join(' ')).toContain('unassessed');
  const before = await readFile(join(state.home, '.signals/runs', result.runId + '.json'));
  expect((await loadRun(result.runId, state.home)).brief?.text).toBe(answer);
  expect(await readFile(join(state.home, '.signals/runs', result.runId + '.json'))).toEqual(before);
});

it('preserves the latest readable message across a later incomplete structured record', async () => {
  const arrived = deferred(),
    controller = new AbortController(),
    notes = vi.fn<(brief: { format: 'markdown'; text: string }) => void>();
  state.script = (child) => {
    emit(child, 'Earlier note.');
    emit(child, answer);
    emit(child, '{"version":7,"sources":[');
    arrived.resolve();
  };
  const pending = fixtureRunner()
    .discover(request, controller.signal, () => {}, undefined, notes)
    .catch((e: unknown) => e);
  await arrived.promise;
  controller.abort();
  const failure = await pending;
  expect(failure).toBeInstanceOf(RunnerFailure);
  if (!(failure instanceof RunnerFailure)) throw new Error('expected runner failure');
  expect(failure.brief?.text).toBe('Earlier note.\n\n---\n\n' + answer);
  expect(notes.mock.calls.map(([brief]) => brief.text)).toEqual([
    'Earlier note.',
    'Earlier note.\n\n---\n\n' + answer,
  ]);
});

it('keeps source and prerequisite notes when later completed output is only progress', async () => {
  const arrived = deferred(),
    controller = new AbortController();
  const sourced =
    '[Primary guide](https://example.org/guide): requires permission; suitability is unresolved.';
  state.script = (child) => {
    emit(child, sourced);
    emit(child, 'Still checking other options.');
    arrived.resolve();
  };
  const pending = signalSearch(request, {
    root: state.home,
    signal: controller.signal,
    runner: fixtureRunner(),
  });
  await arrived.promise;
  controller.abort();
  const result = await pending;
  expect(result.brief?.text).toBe(sourced + '\n\n---\n\nStill checking other options.');
  expect((await loadRun(result.runId, state.home)).brief).toEqual(result.brief);
  expect(result.answerReceipt).toBeUndefined();
});

it('bounds multiple notes with an explicit omission instead of silently dropping earlier work', async () => {
  const arrived = deferred(),
    controller = new AbortController();
  const first = 'x'.repeat(16000),
    later = 'y'.repeat(16000);
  state.script = (child) => {
    emit(child, first);
    emit(child, later);
    arrived.resolve();
  };
  const pending = signalSearch(request, {
    root: state.home,
    signal: controller.signal,
    runner: fixtureRunner(),
  });
  await arrived.promise;
  controller.abort();
  const result = await pending;
  expect(result.brief?.text.startsWith(first)).toBe(true);
  expect(result.brief?.text).toContain('Additional completed notes omitted');
  expect(result.brief!.text.length).toBeLessThanOrEqual(24000);
  expect(result.usage.providerUsage).toMatchObject({
    actionCounts: { messages: { completed: 2, checkpointed: 1, limited: 1 } },
  });
});

it('counts note-limit exclusions while preserving the existing 64-note boundary', async () => {
  const controller = new AbortController();
  state.script = (child) => {
    for (let index = 0; index < 66; index++) emit(child, `Completed note ${index}.`);
    controller.abort();
  };
  const result = await signalSearch(request, {
    root: state.home,
    signal: controller.signal,
    runner: fixtureRunner(),
  });
  expect(result.brief?.text).toContain('Completed note 63.');
  expect(result.brief?.text).not.toContain('Completed note 64.');
  expect(result.brief?.text).toContain('Additional completed notes omitted');
  expect(result.usage.providerUsage).toMatchObject({
    actionCounts: {
      messages: {
        completed: 66,
        checkpointed: 64,
        limited: 2,
        unreadable: 0,
        duplicate: 0,
        afterStop: 0,
        schema: 0,
      },
    },
  });
});

it('closes stored callbacks before a completed final answer is returned', async () => {
  let late: Parameters<SearchRunner['discover']>[4];
  const result = await signalSearch(
    { ...request, method: 'answer-first' },
    {
      root: state.home,
      runner: {
        readiness: ready,
        discover: (_request, _signal, _progress, _hints, brief) => {
          late = brief;
          return Promise.resolve({ proposal: { answer }, usage: null, searches: 0 });
        },
      },
    },
  );
  const receipt = result.answerReceipt;
  late?.({ format: 'markdown', text: 'Late stale result.' });
  expect(result.brief?.text).toBe(answer);
  expect(result.answerReceipt).toEqual(receipt);
  expect((await loadRun(result.runId, state.home)).brief?.text).toBe(answer);
});

it('does not invent an answer from reasoning or tool chatter when timeout precedes narrative', async () => {
  const arrived = deferred(),
    controller = new AbortController(),
    notes = vi.fn();
  state.script = (child) => {
    emit(child, 'Unclassified text', 'reasoning');
    arrived.resolve();
  };
  const pending = signalSearch(request, {
    root: state.home,
    signal: controller.signal,
    runner: fixtureRunner(),
    brief: notes,
  });
  await arrived.promise;
  controller.abort();
  const result = await pending;
  expect(notes).not.toHaveBeenCalled();
  expect(result.brief).toBeUndefined();
  expect(result.answerReceipt).toBeUndefined();
  expect(result.gaps.join(' ')).toContain('No answer or verified result was recovered');
  expect(frozenFollowupMaterial(result, []).priorSynthesis).toBeUndefined();
});

it('does not let a late callback replace retained work after cancellation', async () => {
  const controller = new AbortController();
  const late = { format: 'markdown' as const, text: 'Superseded late output.' };
  const result = await signalSearch(request, {
    root: state.home,
    signal: controller.signal,
    runner: {
      readiness: ready,
      discover: async (_request, _signal, _progress, _hints, brief) => {
        brief?.({ format: 'markdown', text: answer });
        controller.abort();
        brief?.(late);
        throw new RunnerFailure('cancelled', 0, null, late);
      },
    },
  });
  expect(result.status).toBe('cancelled');
  expect(result.brief?.text).toBe(answer);
  expect((await loadRun(result.runId, state.home)).brief?.text).toBe(answer);
});

it('does not emit structured claim-operation output as an interim research answer', async () => {
  const notes = vi.fn();
  state.script = (child) => {
    emit(child, '{"answer":"private check result"}');
    child.stdout.emit('data', Buffer.from('{"type":"turn.completed"}\n'));
    child.emit('close', 0, null);
  };
  const result = await codexRunner('fixture', 'high', {
    root: state.home,
    live: false,
    task: 'fixture custom operation',
    schema: { type: 'object', properties: {} },
  }).discover(request, new AbortController().signal, () => {}, undefined, notes);
  expect(notes).not.toHaveBeenCalled();
  expect(result.usage).toMatchObject({
    actionCounts: { messages: { completed: 1, checkpointed: 0, schema: 1 } },
  });
});

it('keeps only the exact completed final answer in its answer receipt', async () => {
  const notes = vi.fn();
  state.script = (child) => {
    emit(child, 'Interim only.');
    emit(child, answer);
    child.stdout.emit('data', Buffer.from('{"type":"turn.completed"}\n'));
    child.emit('close', 0, null);
  };
  const native = codexRunner('fixture', 'high', {
    root: state.home,
    live: false,
    naturalAnswer: true,
    task: 'fixture ordinary answer',
  });
  const runner = {
    readiness: ready,
    discover: native.discover.bind(native),
  };
  const result = await signalSearch(
    { ...request, method: 'answer-first' },
    { root: state.home, runner, brief: notes },
  );
  expect(result.status).toBe('completed');
  expect(result.brief?.text).toBe(answer);
  expect(result.answerReceipt?.state).toBe('unassessed');
  expect((await loadRun(result.runId, state.home)).answerReceipt).toEqual(result.answerReceipt);
  expect(result.items).toEqual([]);
});

it('keeps memory-only cancellation out of private history', async () => {
  const controller = new AbortController(),
    arrived = deferred();
  state.script = (child) => {
    emit(child, answer);
    arrived.resolve();
  };
  const pending = signalSearch(
    { ...request, cache: 'memory' },
    { root: state.home, signal: controller.signal, runner: fixtureRunner() },
  );
  await arrived.promise;
  controller.abort();
  const result = await pending;
  expect(result.brief?.text).toBe(answer);
  expect(result.persistence).toBeUndefined();
  expect(await readdir(state.home)).not.toContain('.signals');
});

it('retains narrative and unassessed pointers when verification is interrupted', async () => {
  const controller = new AbortController();
  const result = await signalSearch(request, {
    root: state.home,
    signal: controller.signal,
    runner: {
      readiness: ready,
      discover: async () => ({
        searches: 0,
        usage: null,
        proposal: {
          version: 3,
          answer,
          sources: [
            {
              uri: 'https://example.org/guide',
              title: 'Guide',
              publisher: 'Author',
              family: 'primary',
              publishedAt: null,
              origin: 'author',
            },
          ],
          candidates: [
            {
              uri: 'https://example.org/guide',
              name: 'Guide',
              kind: 'learning-resource',
              identity: 'resolved',
              description: 'A guide.',
              capabilities: [],
              match: { level: 'direct', reason: 'Addresses the need.', sources: [0] },
              limits: [],
              observations: [],
            },
          ],
          coverage: [],
          gaps: [],
        },
      }),
    },
    fetch: async () => {
      controller.abort();
      throw new Error('fixture verification interrupted');
    },
  });
  expect(result.status).toBe('cancelled');
  expect(result.brief?.text).toBe(answer);
  expect(result.provisionalLeads?.[0]?.uri).toBe('https://example.org/guide');
  expect(result.items.every((item) => item.entity.assessment.state === 'unassessed')).toBe(true);
  expect(
    result.items.every((item) => item.entity.assessment.score === null && !item.eligible),
  ).toBe(true);
  expect(result.sources.every((source) => source.state === 'failed')).toBe(true);
  expect(result.gaps.join(' ')).toContain('stopped before completion');
  expect(result.answerReceipt).toBeUndefined();
  const reopened = await loadRun(result.runId, state.home);
  const frozen = frozenFollowupMaterial(reopened, []);
  expect(frozen.priorSynthesis).toBe(answer);
  expect(frozen.material).toEqual([]);
  expect(frozen.gaps.join(' ')).toContain('no source was fetched again');
  expect(frozen.gaps.join(' ')).toContain('contradictions have not been renewed');
});
