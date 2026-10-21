import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeCodex, message } from './fake-codex.mjs';

const bin = fileURLToPath(new URL('../bin/research-ai.mjs', import.meta.url));
let fixture;
beforeEach(async () => {
  fixture = await fakeCodex();
});
afterEach(async () => {
  await fixture.cleanup();
});

/** Runs the CLI with only the fake on PATH and an isolated HOME/TMPDIR. */
const cli = (...args) =>
  new Promise((resolve) => {
    execFile(process.execPath, [bin, ...args], { env: fixture.env }, (error, stdout, stderr) =>
      resolve({ code: error ? error.code : 0, stdout, stderr }),
    );
  });

it('prints help without probing Codex', async () => {
  const { code, stdout } = await cli('--help');
  assert.equal(code, 0);
  assert.match(stdout, /^Usage: research-ai/);
  assert.match(stdout, /not verified truth/);
});

it('rejects usage errors before any session', async () => {
  assert.equal((await cli()).code, 1);
  assert.equal((await cli('--bogus', 'q')).code, 1);
  const profile = await cli('--profile', 'huge', 'q');
  assert.equal(profile.code, 1);
  assert.match(profile.stderr, /unknown profile/);
  assert.equal(await fixture.launched(), false);
});

it('stops before a session when Codex is not logged in', async () => {
  await fixture.scenario({ loggedIn: false });
  const { code, stderr } = await cli('q');
  assert.equal(code, 1);
  assert.match(stderr, /not logged in/);
  assert.equal(await fixture.launched(), false);
});

it('reports readiness as JSON', async () => {
  const { code, stdout } = await cli('--readiness');
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), {
    installed: true,
    available: true,
    runner: 'codex-cli 0.0.0-fake',
  });
});

it('prints the answer to stdout and the receipt to stderr', async () => {
  await fixture.scenario({
    events: [message('Direct answer with [a source](https://example.org).'), { type: 'turn.completed' }],
  });
  const { code, stdout, stderr } = await cli('--model', 'fixture', 'portable', 'notes?');
  assert.equal(code, 0);
  assert.equal(stdout, 'Direct answer with [a source](https://example.org).\n');
  const receipt = JSON.parse(stderr.trim().split('\n').at(-1));
  assert.equal(receipt.status, 'complete');
  assert.equal(receipt.model, 'fixture');
  assert.equal(receipt.profile, 'quick');
  const { prompt } = await fixture.record();
  assert.ok(prompt.includes('"question":"portable notes?"'));
});

it('exits 2 with a partial answer', async () => {
  await fixture.scenario({ events: [message('Provisional note.')], exitCode: 1 });
  const { code, stdout, stderr } = await cli('q');
  assert.equal(code, 2);
  assert.equal(stdout, 'Provisional note.\n');
  assert.equal(JSON.parse(stderr.trim().split('\n').at(-1)).status, 'partial');
});

for (const [name, terminal] of [
  ['failed terminal', [{ type: 'turn.failed' }]],
  ['missing terminal', []],
]) {
  it(`exits 2 with readable ${name} even when the native process exits zero`, async () => {
    await fixture.scenario({ events: [message('Naïve ✓ 😀\nPartial evidence.'), ...terminal] });
    const { code, stdout, stderr } = await cli('q');
    assert.equal(code, 2);
    assert.equal(stdout, 'Naïve ✓ 😀\nPartial evidence.\n');
    const receipt = JSON.parse(stderr.trim().split('\n').at(-1));
    assert.equal(receipt.status, 'partial');
    assert.equal(receipt.failure, name === 'failed terminal' ? 'runner_turn_failed' : 'missing_runner_terminal');
  });
}
