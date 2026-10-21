// Synthetic stand-in for the Codex CLI. No model, network or credentials: it replays an
// authored scenario and records what the executor sent. Imported by tests; defines no tests.
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = `#!${process.execPath}
'use strict';
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const home = process.env.HOME;
const args = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(join(home, 'scenario.json'), 'utf8'));
if (args[0] === '--version') {
  process.stdout.write('codex-cli 0.0.0-fake\\n');
} else if (args[0] === 'login') {
  process.stdout.write(scenario.loggedIn === false ? 'Not logged in\\n' : 'Logged in (fake)\\n');
} else {
  let prompt = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (prompt += chunk));
  process.stdin.on('end', () => {
    writeFileSync(join(home, 'record.json'), JSON.stringify({ args, env: process.env, prompt }));
    const lines = (scenario.events ?? []).map((event) =>
      typeof event === 'string' ? event : JSON.stringify(event));
    const wire = Buffer.concat([
      Buffer.from(lines.join('\\n') + (lines.length && !scenario.noFinalNewline ? '\\n' : '')),
      Buffer.from(scenario.rawSuffixBase64 ?? '', 'base64'),
    ]);
    let offset = 0;
    const emit = () => {
      if (offset < wire.length) {
        const end = Math.min(wire.length, offset + (scenario.chunkBytes ?? wire.length));
        process.stdout.write(wire.subarray(offset, end));
        offset = end;
        setImmediate(emit);
      } else {
        if (scenario.stderr) process.stderr.write(scenario.stderr);
        if (scenario.hang) setInterval(() => {}, 1000);
        else process.exitCode = scenario.exitCode ?? 0;
      }
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
