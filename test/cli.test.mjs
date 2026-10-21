import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { codexReadiness } from '../src/index.mjs';
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
  const { installed, available, runner } = JSON.parse(stdout);
  assert.deepEqual({ installed, available, runner }, {
    installed: true,
    available: true,
    runner: 'codex-cli 0.160.0',
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

describe('independent readiness observations', () => {
  const cases = [
    ['known logged out', { loggedIn: false, authExitCode: 1 }, false, true, 'not_authenticated'],
    ['auth process failure', { authStdout: '', authStderr: 'synthetic auth failure', authExitCode: 1 }, null, true, 'auth_probe_failed'],
    ['auth failure with login text', { authStdout: 'Logged in using ChatGPT\n', authExitCode: 1 }, null, true, 'auth_probe_failed'],
    ['version process failure', { versionStdout: 'codex-cli 0.160.0\n', versionExitCode: 1 }, true, true, 'version_probe_failed'],
    ['profile format drift', { profileStdout: 'different help format' }, true, null, 'profile_unrecognized'],
    ['auth format drift', { authStdout: 'session state: perhaps' }, null, true, 'auth_unrecognized'],
    ['contradictory auth', { authStdout: 'Logged in using ChatGPT\nNot logged in\n' }, null, true, 'auth_unrecognized'],
    ['unsupported old profile', { versionStdout: 'codex-cli 0.1.0\n', profileStdout: 'Usage: codex exec --json\n' }, true, false, 'unsupported_profile'],
    ['profile probe failure', { profileStdout: '', profileExitCode: 2 }, true, null, 'profile_probe_failed'],
    ['unrecognized version', { versionStdout: 'different runner build' }, true, true, 'version_unrecognized'],
  ];
  for (const [name, scenario, authenticated, supportedProfile, error] of cases) {
    it(`retains independent fields and refuses native dispatch for ${name}`, async () => {
      await fixture.scenario(scenario);
      assert.equal(process.env.PATH, fixture.env.PATH);
      assert.equal(process.env.HOME, fixture.home);
      const state = await codexReadiness();
      assert.equal(state.installed, true);
      assert.equal(state.authenticated, authenticated);
      assert.equal(state.supportedProfile, supportedProfile);
      assert.equal(state.available, false);
      assert.equal(state.error, error);
      assert.equal(typeof state.remedy, 'string');
      assert.equal(state.runner, (scenario.versionStdout ?? 'codex-cli 0.160.0').trim());
      const machine = await cli('--readiness');
      assert.equal(machine.code, 1);
      assert.equal(JSON.parse(machine.stdout).error, error);
      const human = await cli('synthetic readiness question');
      assert.equal(human.code, 1);
      assert.equal(human.stdout, '');
      assert.ok(human.stderr.includes(state.remedy));
      assert.equal(await fixture.launched(), false);
      assert.ok((await fixture.probes()).every(args =>
        args.join(' ') === '--version' || args.join(' ') === 'login status' || args.join(' ') === 'exec --help'));
    });
  }
  it('retains installed/version evidence across an auth timeout', async () => {
    await fixture.scenario({ authStdout: '', authHang: true });
    const state = await codexReadiness();
    assert.equal(state.installed, true);
    assert.equal(state.version, '0.160.0');
    assert.equal(state.authenticated, null);
    assert.equal(state.error, 'auth_probe_failed');
    assert.equal(state.probes.authentication.failure, 'timeout');
    const human = await cli('synthetic timeout question');
    assert.equal(human.code, 1);
    assert.ok(human.stderr.includes(state.remedy));
    assert.equal(state.available, false);
    assert.equal(await fixture.launched(), false);
  });
  it('separates missing executable from unknown authentication', async () => {
    process.env.PATH = fixture.tmp;
    fixture.env.PATH = fixture.tmp;
    const state = await codexReadiness();
    assert.equal(state.installed, false);
    assert.equal(state.authenticated, null);
    assert.equal(state.supportedProfile, null);
    assert.equal(state.error, 'missing_executable');
    assert.equal(state.available, false);
    assert.equal((await cli('synthetic')).code, 1);
    assert.equal(await fixture.launched(), false);
  });
  it('reports ready with source/time evidence without inference', async () => {
    const state = await codexReadiness();
    assert.equal(state.installed, true);
    assert.equal(state.authenticated, true);
    assert.equal(state.supportedProfile, true);
    assert.equal(state.available, true);
    assert.equal(state.version, '0.160.0');
    assert.equal(state.error, null);
    assert.equal(state.remedy, null);
    assert.equal(state.profile, 'codex-exec-json-v1');
    for (const observation of Object.values(state.probes)) {
      assert.ok(Number.isFinite(Date.parse(observation.observedAt)));
      assert.equal(observation.failure, null);
      assert.equal(observation.exitCode, 0);
      assert.match(observation.source, /^codex /);
    }
    assert.equal(await fixture.launched(), false);
  });
  it('accepts a recognized stderr login observation without exposing it', async () => {
    await fixture.scenario({ authStdout: '', authStderr: 'Logged in using ChatGPT\n' });
    const state = await codexReadiness();
    assert.equal(state.authenticated, true);
    assert.equal(state.available, true);
    assert.equal(JSON.stringify(state).includes('Logged in using'), false);
    assert.equal(await fixture.launched(), false);
  });
  it('bounds auth output and leaves the result unknown without retaining probe text', async () => {
    await fixture.scenario({ authStdout: 'AUTH_TEXT_SENTINEL'.repeat(5000) });
    const state = await codexReadiness();
    assert.equal(state.installed, true);
    assert.equal(state.authenticated, null);
    assert.equal(state.error, 'auth_probe_failed');
    assert.equal(state.probes.authentication.failure, 'output_limit');
    assert.equal(JSON.stringify(state).includes('AUTH_TEXT_SENTINEL'), false);
    assert.equal(await fixture.launched(), false);
  });

});
