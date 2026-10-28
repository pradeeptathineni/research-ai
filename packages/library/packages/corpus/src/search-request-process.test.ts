import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const envelope = {
  schema_version: '1.0',
  request_id: 'transport-1',
  idempotency_key: 'process-key',
  query: 'Unique process fixture question',
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
};
const worker = fileURLToPath(
  new URL('../../../tests/fixtures/search-request-server.ts', import.meta.url),
);
const capture = async (name: string, value: unknown) => {
  const directory = process.env.S02_PROCESS_EVIDENCE;
  if (directory) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, name + '.json'), JSON.stringify(value, null, 2) + '\n');
  }
};
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const launch = async (root: string, mode: string) => {
  const bin = join(root, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, 'codex'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${root}/readiness.log'\ncase "$*" in\n  --version) echo 'codex fixture-only' ;;\n  'login status') echo 'Logged in using fixture' ;;\n  *) exit 91 ;;\nesac\n`,
    { mode: 0o700 },
  );
  const child = spawn(process.execPath, ['--import', 'tsx', worker, root, mode], {
    env: {
      PATH:
        bin + ':' + process.execPath.slice(0, process.execPath.lastIndexOf('/')) + ':/usr/bin:/bin',
      HOME: root,
      TMPDIR: root,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let errors = '';
  child.stderr!.on('data', (bytes: Buffer) => {
    errors += bytes.toString();
  });
  const port = await new Promise<number>((done, reject) => {
    child.on('message', (message: { type: string; port: number }) => {
      if (message.type === 'ready') done(message.port);
    });
    child.once('exit', (code) => reject(new Error('server_exit_' + code + ':' + errors)));
    child.once('error', reject);
  });
  const base = `http://127.0.0.1:${port}/signals-ai/__signals/api/`;
  const { token } = (await (await fetch(base + 'session')).json()) as { token: string };
  const headers = { 'content-type': 'application/json', 'x-signals-token': token };
  return { child, base, headers };
};
const kill = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGKILL');
  await closed;
};
const callbacks = async (root: string) =>
  (await readFile(join(root, 'callbacks.jsonl'), 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as { pid: number; input: { cache: string; save: string; query: string } },
    );
const waitFor = async <T>(read: () => Promise<T>, ready: (value: T) => boolean) => {
  for (let i = 0; i < 200; i++) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('fixture_condition_timeout');
};

it('loses a start reply, SIGKILLs the actual HTTP process and recovers its original job without another callback', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'request-http-restart-')));
  const children: ChildProcess[] = [];
  try {
    const first = await launch(root, 'hold-drop');
    children.push(first.child);
    const scope = (await (
      await fetch(first.base + 'request-scope', {
        method: 'POST',
        headers: first.headers,
        body: '{}',
      })
    ).json()) as { epoch: string };
    const headers = { ...first.headers, 'x-signals-owner-epoch': scope.epoch };
    await expect(
      fetch(first.base + 'search', { method: 'POST', headers, body: JSON.stringify(envelope) }),
    ).rejects.toThrow();
    expect(
      await waitFor(
        () => callbacks(root),
        (rows) => rows.length === 1,
      ),
    ).toHaveLength(1);
    const admitted = (await (
      await fetch(first.base + 'requests/process-key', { headers })
    ).json()) as { id: string };
    const before = await readFile(join(root, '.signals/requests/ledger.json'));
    const head = await readFile(join(root, '.signals/requests/head'));
    await kill(first.child);
    expect(first.child.signalCode).toBe('SIGKILL');
    const restarted = await launch(root, 'complete');
    children.push(restarted.child);
    expect(restarted.child.pid).not.toBe(first.child.pid);
    const owned = { ...restarted.headers, 'x-signals-owner-epoch': scope.epoch };
    const probes = await readFile(join(root, 'readiness.log'));
    const recovered = (await (
      await fetch(restarted.base + 'requests/process-key', { headers: owned })
    ).json()) as { id: string; receipt: { state: string } };
    expect(recovered.id).toBe(admitted.id);
    expect(recovered.receipt.state).toBe('unknown');
    expect(
      (
        await fetch(restarted.base + 'requests/process-key/reconcile', {
          method: 'POST',
          headers: owned,
          body: '{}',
        })
      ).status,
    ).toBe(200);
    const retry = await fetch(restarted.base + 'search', {
      method: 'POST',
      headers: owned,
      body: JSON.stringify({ ...envelope, request_id: 'transport-retry' }),
    });
    expect(retry.status).toBe(202);
    expect(((await retry.json()) as { id: string }).id).toBe(admitted.id);
    expect(await readFile(join(root, '.signals/requests/ledger.json'))).toEqual(before);
    expect(await readFile(join(root, '.signals/requests/head'))).toEqual(head);
    expect(await readFile(join(root, 'readiness.log'))).toEqual(probes);
    expect(await callbacks(root)).toHaveLength(1);
    await capture('http-process-restart', {
      fixture: 'actual-searchApi-server-process-v1',
      scope,
      input: envelope,
      first_pid: first.child.pid,
      first_signal: first.child.signalCode,
      restarted_pid: restarted.child.pid,
      start_response: 'socket destroyed before 202 write; fetch rejected',
      recovered,
      retry_status: retry.status,
      ledger_before_sha256: sha256(before),
      ledger_after_sha256: sha256(await readFile(join(root, '.signals/requests/ledger.json'))),
      head_before_sha256: sha256(head),
      head_after_sha256: sha256(await readFile(join(root, '.signals/requests/head'))),
      callback_entries: await callbacks(root),
      measured_callback_count: (await callbacks(root)).length,
      readiness_before_reads: probes.toString(),
      readiness_after_reads: (await readFile(join(root, 'readiness.log'))).toString(),
      native_generation:
        'Injected callback only; authored codex shim rejects every command except readiness.',
    });
    await writeFile(join(root, '.signals/requests/ledger.json'), '{corrupt');
    expect((await fetch(restarted.base + 'runs/' + admitted.id)).status).toBe(503);
  } finally {
    await Promise.all(children.map(kill));
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

it('admits a fresh cache:none request as memory/never with no private question or answer history', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'request-http-none-')));
  let child: ChildProcess | undefined;
  try {
    const server = await launch(root, 'complete');
    child = server.child;
    const scope = (await (
      await fetch(server.base + 'request-scope', {
        method: 'POST',
        headers: server.headers,
        body: '{}',
      })
    ).json()) as { epoch: string };
    const headers = { ...server.headers, 'x-signals-owner-epoch': scope.epoch };
    const started = await fetch(server.base + 'search', {
      method: 'POST',
      headers,
      body: JSON.stringify(envelope),
    });
    expect(started.status).toBe(202);
    const accepted = (await started.json()) as { id: string };
    const { id } = accepted;
    const result = await waitFor(
      async () =>
        (await (await fetch(server.base + 'runs/' + id)).json()) as {
          result: { status: string } | null;
        },
      (row) => !!row.result,
    );
    expect(result.result?.status).toBe('completed');
    expect(await callbacks(root)).toMatchObject([
      { input: { cache: 'memory', save: 'never', query: envelope.query } },
    ]);
    await waitFor(
      async () =>
        (await (await fetch(server.base + 'requests/process-key', { headers })).json()) as {
          receipt?: { state: string };
        },
      (row) => row.receipt?.state === 'complete',
    );
    expect(await readdir(join(root, '.signals'))).toEqual(['requests']);
    const ledger = await readFile(join(root, '.signals/requests/ledger.json'), 'utf8');
    expect(ledger).not.toContain(envelope.query);
    expect(ledger).not.toContain('Measured offline answer');
    await capture('http-cache-none', {
      fixture: 'actual-searchApi-server-process-v1',
      scope,
      input: envelope,
      start_status: started.status,
      id,
      accepted,
      result,
      callback_entries: await callbacks(root),
      measured_callback_count: (await callbacks(root)).length,
      private_entries: await readdir(join(root, '.signals')),
      ledger_contains_question: ledger.includes(envelope.query),
      ledger_contains_answer: ledger.includes('Measured offline answer'),
    });
  } finally {
    if (child) await kill(child);
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

it('serializes competing HTTP server processes to one measured callback', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'request-http-compete-')));
  const children: ChildProcess[] = [];
  try {
    const first = await launch(root, 'hold');
    children.push(first.child);
    const scope = (await (
      await fetch(first.base + 'request-scope', {
        method: 'POST',
        headers: first.headers,
        body: '{}',
      })
    ).json()) as { epoch: string };
    const second = await launch(root, 'hold');
    children.push(second.child);
    const replies = await Promise.all(
      [first, second].map((server) =>
        fetch(server.base + 'search', {
          method: 'POST',
          headers: { ...server.headers, 'x-signals-owner-epoch': scope.epoch },
          body: JSON.stringify(envelope),
        }),
      ),
    );
    expect(replies.map((reply) => reply.status)).toEqual([202, 202]);
    const admissions = await Promise.all(
      replies.map((reply) => reply.json() as Promise<{ id: string }>),
    );
    const ids = admissions.map((row) => row.id);
    expect(new Set(ids).size).toBe(1);
    expect(
      await waitFor(
        () => callbacks(root),
        (rows) => rows.length > 0,
      ),
    ).toHaveLength(1);
    await capture('http-competing-processes', {
      fixture: 'actual-searchApi-server-process-v1',
      scope,
      pids: children.map((child) => child.pid),
      start_statuses: replies.map((reply) => reply.status),
      ids,
      admissions,
      callback_entries: await callbacks(root),
      measured_callback_count: (await callbacks(root)).length,
    });
  } finally {
    await Promise.all(children.map(kill));
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
