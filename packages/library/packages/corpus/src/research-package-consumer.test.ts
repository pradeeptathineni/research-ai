import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type * as Os from 'node:os';
import { researchQuestion } from '@pradeeptathineni/research-ai';
import { claimReviewOperation, codexRunner } from './search-runner.js';
import { signalSearch } from './signal-search.js';

let root: string;
let previousPath: string | undefined;
const state = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof Os>()),
  homedir: () => state.home,
}));
const answer = 'A provisional [guide](https://example.org/guide) has unverified fit.';
const event = (value: unknown) => JSON.stringify(value);
async function cli(mode: 'complete' | 'fatal' | 'cancel' | 'denied' | 'native' | 'review') {
  const bin = join(root, 'bin');
  await mkdir(bin, { recursive: true });
  const executable = join(bin, 'codex');
  const final =
    mode === 'native'
      ? JSON.stringify({
          version: 3,
          answer,
          sources: [],
          candidates: [],
          coverage: [],
          gaps: ['No supported assessment.'],
        })
      : mode === 'review'
        ? JSON.stringify({ answer: 'Unknown from supplied text.' })
        : answer;
  const message = event({ type: 'item.completed', item: { type: 'agent_message', text: final } });
  const terminal = event({ type: mode === 'fatal' ? 'turn.failed' : 'turn.completed' });
  const script = `#!/bin/sh
if [ "$1" = --version ]; then printf '%s\\n' 'codex-cli 0.160.0'; exit 0; fi
if [ "$1" = login ]; then ${mode === 'denied' ? "printf '%s\\n' 'Not logged in'; exit 1" : "printf '%s\\n' 'Logged in'; exit 0"}; fi
if [ "$1" = exec ] && [ "$2" = --help ]; then
  printf '%s\\n' 'Usage: codex exec --ignore-user-config --ignore-rules --ephemeral --skip-git-repo-check --sandbox --json --output-schema --cd --model --config'
  exit 0
fi
printf '%s\\n' exec >> '${join(root, 'invocations')}'
printf '%s\\n' '${message}'
${mode === 'cancel' ? 'sleep 10' : `printf '%s\\n' '${terminal}'`}
exit ${mode === 'fatal' ? 2 : 0}
`;
  await writeFile(executable, script, { mode: 0o700 });
  await chmod(executable, 0o700);
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
}
async function calls() {
  return (await readFile(join(root, 'invocations'), 'utf8').catch(() => ''))
    .trim()
    .split('\n')
    .filter(Boolean).length;
}
function runner() {
  return codexRunner('fixture-model', 'low', {
    root,
    live: false,
    naturalAnswer: true,
    task: 'Answer the authored public fixture without web access.',
  });
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'signals-r04-consumer-')));
  state.home = root;
  previousPath = process.env.PATH;
});
afterEach(async () => {
  process.env.PATH = previousPath;
  await rm(root, { recursive: true, force: true });
});

it('resolves the extracted accepted archive and maps one completed producer session into an unassessed answer', async () => {
  const installed = await realpath(resolve('node_modules/@pradeeptathineni/research-ai'));
  expect(installed).toContain('node_modules/@pradeeptathineni/research-ai');
  expect(JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).version).toBe(
    '0.4.0-rc.1',
  );
  await cli('complete');
  const result = await signalSearch(
    { query: 'public fixture', method: 'answer-first', cache: 'memory', save: 'never' },
    { root, runner: runner() },
  );
  expect(await calls()).toBe(1);
  expect(result.status).toBe('completed');
  expect(result.brief?.text).toBe(answer);
  expect(result.answerReceipt).toMatchObject({ state: 'unassessed', confidence: 'unknown' });
  expect(result.usage.providerUsage).toMatchObject({
    cleanup: { complete: true, error: null },
    terminal: { completed: 1, failed: 0 },
  });
});

it('keeps producer checkpoint and cause after a fatal terminal, without completing or retrying', async () => {
  await cli('fatal');
  const result = await signalSearch(
    { query: 'public fixture', method: 'answer-first', cache: 'memory', save: 'never' },
    { root, runner: runner() },
  );
  expect(await calls()).toBe(1);
  expect(result.status).toBe('failed');
  expect(result.brief?.text).toBe(answer);
  expect(result.answerReceipt).toBeUndefined();
  expect(result.usage.providerUsage).toMatchObject({
    terminal: { failed: 1 },
    termination: { exitCode: 2 },
    cleanup: { complete: true },
  });
});

it('retains the original partial note on cancellation without a second producer call', async () => {
  await cli('cancel');
  const controller = new AbortController();
  const result = await signalSearch(
    { query: 'public fixture', method: 'answer-first', cache: 'memory', save: 'never' },
    { root, runner: runner(), signal: controller.signal, brief: () => controller.abort() },
  );
  expect(await calls()).toBe(1);
  expect(result.status).toBe('cancelled');
  expect(result.brief?.text).toBe(answer);
  expect(result.answerReceipt).toBeUndefined();
  expect(result.usage.providerUsage).toMatchObject({ termination: { trigger: 'request_aborted' } });
});

it('refuses denied readiness before a producer execution', async () => {
  await cli('denied');
  const result = await signalSearch(
    { query: 'public fixture', method: 'answer-first', cache: 'memory', save: 'never' },
    { root, runner: runner() },
  );
  expect(result.status).toBe('not_configured');
  expect(await calls()).toBe(0);
});

it('reports an absent executable before producer dispatch', async () => {
  process.env.PATH = root;
  const result = await signalSearch(
    { query: 'public fixture', method: 'answer-first', cache: 'memory', save: 'never' },
    { root, runner: runner() },
  );
  expect(result.status).toBe('not_configured');
  expect(await calls()).toBe(0);
});

it('rejects invalid frozen material before dispatch and binds valid supplied text to SHA-256', async () => {
  await cli('complete');
  const lease = join(root, 'frozen-lease');
  await expect(
    researchQuestion('check material', {
      sources: [{ uri: 'file:///tmp/private', text: 'not a citation URL' }],
      lease,
    }),
  ).rejects.toThrow('invalid_sources');
  expect(await calls()).toBe(0);
  const text = 'Public authored source, not verified by this fixture.\nΩ';
  const result = await researchQuestion('check material', {
    sources: [{ uri: 'https://example.org/source', text }],
    lease,
    model: 'fixture-model',
    effort: 'low',
  });
  expect(await calls()).toBe(1);
  expect(result.status).toBe('complete');
  expect(result.receipt).toMatchObject({
    mode: 'frozen',
    cleanup: { complete: true },
    source: [
      {
        uri: 'https://example.org/source',
        sha256: createHash('sha256').update(text).digest('hex'),
      },
    ],
  });
});

it('uses the installed executor for Signals native assessment and schema-bound frozen review', async () => {
  await cli('native');
  const assessed = await signalSearch(
    { query: 'assess public fixture', method: 'native', cache: 'memory', save: 'never' },
    { root, runner: codexRunner('fixture-model', 'low', { root, live: false }) },
  );
  expect(await calls()).toBe(1);
  expect(assessed.status).toBe('partial');
  expect(assessed.gaps).toContain('No supported assessment.');
  expect(assessed.usage.providerUsage).toMatchObject({ cleanup: { complete: true } });
  await cli('review');
  const review = await codexRunner(
    'fixture-model',
    'low',
    claimReviewOperation(root, 'Review only caller-supplied source text.', {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    }),
  ).discover(
    { query: 'frozen fixture', profile: 'quick', cache: 'memory' },
    new AbortController().signal,
    () => {},
  );
  expect(await calls()).toBe(2);
  expect(review.proposal).toEqual({ answer: 'Unknown from supplied text.' });
  expect(review.usage).toMatchObject({ cleanup: { complete: true }, terminal: { completed: 1 } });
});
