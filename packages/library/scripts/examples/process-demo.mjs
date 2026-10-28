import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { URL, fileURLToPath } from 'node:url';
const { fetch } = globalThis;

const exec = promisify(execFile);
const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-process-demo-')));
const children = [];
const fixture = fileURLToPath(
  new URL('../../tests/fixtures/process-observation-server.ts', import.meta.url),
);
const consumer = fileURLToPath(new URL('./process-consumer.mjs', import.meta.url));
const envelope = (key) => ({
  schema_version: '1.0',
  request_id: `question-${key}`,
  idempotency_key: key,
  query: `Offline fixture ${key}`,
  method: 'answer-first',
  profile: 'quick',
  cache: 'none',
  save: 'never',
  project_ref: null,
  authority_ref: {
    owner: 'signals-ai',
    kind: 'authority',
    id: 'local',
    revision: '1',
    digest: null,
  },
});
const callbacks = async () =>
  (await readFile(join(root, 'callbacks.jsonl'), 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const waitFor = async (read, accept) => {
  for (let i = 0; i < 200; i++) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('fixture_condition_timeout');
};
const stop = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((done) => child.once('close', done));
  child.kill('SIGKILL');
  await closed;
};
const launch = async (mode) => {
  const child = spawn(process.execPath, ['--import', 'tsx', fixture, root, mode], {
    env: {
      PATH: `${join(root, 'bin')}:${process.execPath.slice(0, process.execPath.lastIndexOf('/'))}:/usr/bin:/bin`,
      HOME: root,
      TMPDIR: root,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.push(child);
  let errors = '';
  child.stderr.on('data', (data) => {
    errors += data.toString();
  });
  const port = await new Promise((done, reject) => {
    child.on('message', (message) => {
      if (message.type === 'ready') done(message.port);
    });
    child.once('exit', (code) => reject(new Error(`server_exit_${code}:${errors}`)));
    child.once('error', reject);
  });
  const base = `http://127.0.0.1:${port}/signals-ai/__signals/api/`;
  const { token } = await (await fetch(base + 'session')).json();
  return {
    child,
    port,
    base,
    headers: { 'content-type': 'application/json', 'x-signals-token': token },
  };
};
const post = async (owner, route, body, epoch) => {
  const reply = await fetch(owner.base + route, {
    method: 'POST',
    headers: { ...owner.headers, 'x-signals-owner-epoch': epoch },
    body: JSON.stringify(body),
  });
  if (![200, 202].includes(reply.status))
    throw new Error(`${route}: ${reply.status} ${await reply.text()}`);
  return reply.json();
};
const observe = async (owner, scope) => {
  const { stdout } = await exec(
    process.execPath,
    [consumer, owner.base, scope.identity, scope.epoch],
    {
      timeout: 8000,
      maxBuffer: 3_000_000,
    },
  );
  return JSON.parse(stdout);
};
const row = (snapshot, id) => {
  const found = snapshot.processes.find((entry) => entry.ref.id === id);
  assert(found, `Missing exact job ${id}`);
  return found;
};
try {
  await readFile('dist/public-site/index.html');
  await mkdir(join(root, 'bin'));
  await writeFile(
    join(root, 'bin/codex'),
    '#!/bin/sh\ncase "$*" in\n --version) echo "codex offline fixture" ;;\n "login status") echo "Logged in using fixture" ;;\n *) exit 91 ;;\nesac\n',
    { mode: 0o700 },
  );
  const first = await launch('hold');
  const built = await fetch(`http://127.0.0.1:${first.port}/signals-ai/`);
  assert.equal(built.status, 200);
  const scope = await post(first, 'request-scope', {});
  const unbound = await fetch(first.base + 'provider/processes');
  assert.equal(unbound.status, 428);
  const wrongOwner = await fetch(first.base + 'provider/processes', {
    headers: { 'x-signals-instance-id': 'wrong-owner', 'x-signals-owner-epoch': scope.epoch },
  });
  assert.equal(wrongOwner.status, 409);
  const started = await post(first, 'search', envelope('restart'), scope.epoch);
  await waitFor(
    () => callbacks(),
    (rows) => rows.length === 1,
  );
  const live = await observe(first, scope);
  assert.equal(row(live, started.id).lifecycle, 'running');
  assert.match(row(live, started.id).progress.label, /inspected one source/);
  await stop(first.child);

  const second = await launch('hold');
  const restarted = await observe(second, scope);
  assert.notEqual(restarted.store_epoch, live.store_epoch);
  assert.equal(row(restarted, started.id).lifecycle, 'unknown');
  assert.equal(row(restarted, started.id).heartbeat_at, null);
  const retry = await post(
    second,
    'search',
    { ...envelope('restart'), request_id: 'transport-retry' },
    scope.epoch,
  );
  assert.equal(retry.id, started.id);
  assert.equal((await callbacks()).length, 1);

  const cancelled = await post(second, 'search', envelope('cancel'), scope.epoch);
  await waitFor(
    () => callbacks(),
    (rows) => rows.length === 2,
  );
  const beforeSilence = await observe(second, scope);
  const evidenceAt = row(beforeSilence, cancelled.id).heartbeat_at;
  await new Promise((done) => setTimeout(done, 31_000));
  const silent = await observe(second, scope);
  assert.equal(row(silent, cancelled.id).lifecycle, 'running');
  assert.equal(row(silent, cancelled.id).heartbeat_at, evidenceAt);
  assert(Date.now() - Date.parse(evidenceAt) > 30_000);
  const cancelReply = await post(second, `cancel/${cancelled.id}`, {}, scope.epoch);
  assert.equal(cancelReply.cancelled, true);
  const pending = await observe(second, scope);
  assert.equal(row(pending, cancelled.id).lifecycle, 'running');
  assert.match(row(pending, cancelled.id).wait_reason, /outcome pending/);
  const stopped = await waitFor(
    () => observe(second, scope),
    (snap) => row(snap, cancelled.id).lifecycle === 'cancelled',
  );
  await stop(second.child);

  const third = await launch('partial');
  const partial = await post(third, 'search', envelope('partial'), scope.epoch);
  const partialSnapshot = await waitFor(
    () => observe(third, scope),
    (snap) => row(snap, partial.id).lifecycle === 'succeeded',
  );
  assert.match(row(partialSnapshot, partial.id).progress.label, /Result available/);
  await stop(third.child);
  const fourth = await launch('fatal');
  const failed = await post(fourth, 'search', envelope('failed'), scope.epoch);
  const failedSnapshot = await waitFor(
    () => observe(fourth, scope),
    (snap) => row(snap, failed.id).lifecycle === 'failed',
  );
  const count = (await callbacks()).length;
  assert.equal(count, 4);
  process.stdout.write(
    JSON.stringify(
      {
        fixture: 'real-built-assets-and-searchApi-http-with-authored-offline-callback',
        built_http_status: built.status,
        unbound_observer_status: unbound.status,
        wrong_owner_status: wrongOwner.status,
        ids: {
          restarted: started.id,
          cancelled: cancelled.id,
          partial: partial.id,
          failed: failed.id,
        },
        snapshots: {
          live,
          restarted,
          beforeSilence,
          silent,
          pending,
          stopped,
          partialSnapshot,
          failedSnapshot,
        },
        actual_callback_count: count,
        redispatch_after_restart: false,
        native_model_calls: 0,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  for (const child of children) await stop(child);
  await rm(root, { recursive: true, force: true });
}
