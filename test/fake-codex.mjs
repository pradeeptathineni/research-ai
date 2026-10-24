// Synthetic stand-in for the Codex CLI. No model, network or credentials: it replays an
// authored scenario and records what the executor sent. Imported by tests; defines no tests.
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = `#!${process.execPath}
'use strict';
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const home = process.env.HOME;
const args = process.argv.slice(2);
const authored = JSON.parse(readFileSync(join(home, 'scenario.json'), 'utf8'));
let scenario = authored;
appendFileSync(join(home, 'probes.jsonl'), JSON.stringify(args) + '\\n');
const signalExit = (signal) => {
  if (!signal) return;
  process.stdout.write('', () => process.kill(process.pid, signal));
  setInterval(() => {}, 1000);
};
if (args[0] === '--version') {
  process.stdout.write(scenario.versionStdout ?? 'codex-cli 0.160.0\\n');
  if (scenario.versionStderr) process.stderr.write(scenario.versionStderr);
  process.exitCode = scenario.versionExitCode ?? 0;
  if (scenario.versionHang) setInterval(() => {}, 1000);
  signalExit(scenario.versionSignal);
} else if (args[0] === 'login') {
  process.stdout.write(scenario.authStdout ?? (scenario.loggedIn === false ? 'Not logged in\\n' : 'Logged in using ChatGPT\\n'));
  if (scenario.authStderr) process.stderr.write(scenario.authStderr);
  process.exitCode = scenario.authExitCode ?? 0;
  if (scenario.authHang) setInterval(() => {}, 1000);
  signalExit(scenario.authSignal);
} else if (args[0] === 'exec' && args[1] === '--help') {
  process.stdout.write(scenario.profileStdout ??
    'Usage: codex exec [OPTIONS] [PROMPT]\\nOptions:\\n  --ignore-user-config --ignore-rules --ephemeral --skip-git-repo-check --sandbox --json --output-schema --cd --model --config\\n');
  if (scenario.profileStderr) process.stderr.write(scenario.profileStderr);
  process.exitCode = scenario.profileExitCode ?? 0;
  if (scenario.profileHang) setInterval(() => {}, 1000);
  signalExit(scenario.profileSignal);
} else {
  // Optional per-session overrides, in exec order, for multi-session callers
  let count = 0;
  if (authored.sessions) {
    try { count = Number(readFileSync(join(home, 'exec-count'), 'utf8')); } catch {}
    writeFileSync(join(home, 'exec-count'), String(count + 1));
    scenario = { ...authored, ...authored.sessions[Math.min(count, authored.sessions.length - 1)] };
  }
  let prompt = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (prompt += chunk));
  process.stdin.on('end', () => {
    writeFileSync(join(home, 'record.json'), JSON.stringify({ args, env: process.env, prompt }));
    if (authored.sessions) writeFileSync(join(home, 'record-' + count + '.json'), JSON.stringify({ args, prompt }));
    const lines = (scenario.events ?? []).map((event) =>
      typeof event === 'string' ? event : JSON.stringify(event));
    const wire = Buffer.concat([
      Buffer.from(lines.join('\\n') + (lines.length && !scenario.noFinalNewline ? '\\n' : '')),
      Buffer.from(scenario.rawSuffixBase64 ?? '', 'base64'),
    ]);
    let offset = 0;
    const finish = () => {
      if (scenario.stderr) process.stderr.write(scenario.stderr);
      if (scenario.hang) setInterval(() => {}, 1000);
      else process.exitCode = scenario.exitCode ?? 0;
    };
    // Optional paced replay: one complete line per delay, so observers can act mid-session.
    if (scenario.lineDelayMs) {
      const paced = lines.slice();
      const next = () => {
        if (!paced.length) return finish();
        process.stdout.write(paced.shift() + '\\n');
        setTimeout(next, scenario.lineDelayMs);
      };
      return next();
    }
    const emit = () => {
      if (offset < wire.length) {
        const end = Math.min(wire.length, offset + (scenario.chunkBytes ?? wire.length));
        process.stdout.write(wire.subarray(offset, end));
        offset = end;
        setImmediate(emit);
      } else finish();
    };
    emit();
  });
}
`;

export const message = (text) => ({
  type: 'item.completed',
  item: { type: 'agent_message', text },
});
export const search = () => ({
  type: 'item.completed',
  item: { type: 'web_search', action: { type: 'search' } },
});

/**
 * Isolates HOME, TMPDIR and PATH for one test. PATH contains only the fake, so a real
 * Codex binary cannot be resolved even if one is installed next to node.
 */
export async function fakeCodex(scenario = {}) {
  const root = await mkdtemp(join(tmpdir(), 'research-ai-test-'));
  const bin = join(root, 'bin'),
    home = join(root, 'home'),
    tmp = join(root, 'tmp');
  await Promise.all([mkdir(bin), mkdir(home), mkdir(tmp)]);
  await writeFile(join(bin, 'codex'), script);
  await chmod(join(bin, 'codex'), 0o755);
  const saved = { ...process.env };
  const env = { PATH: bin, HOME: home, TMPDIR: tmp };
  Object.assign(process.env, env, { RESEARCH_AI_TEST_SECRET: 'must-not-reach-child' });
  delete process.env.CODEX_HOME;
  const fixture = {
    root,
    home,
    tmp,
    env,
    lease: join(root, 'lease'),
    scenario: (next) => writeFile(join(home, 'scenario.json'), JSON.stringify(next)),
    record: async () => JSON.parse(await readFile(join(home, 'record.json'), 'utf8')),
    session: async (n) => JSON.parse(await readFile(join(home, `record-${n}.json`), 'utf8')),
    probes: async () => (await readFile(join(home, 'probes.jsonl'), 'utf8').catch(() => ''))
      .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    launched: () =>
      readFile(join(home, 'record.json')).then(
        () => true,
        () => false,
      ),
    async cleanup() {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      await rm(root, { recursive: true, force: true });
    },
  };
  await fixture.scenario(scenario);
  return fixture;
}
