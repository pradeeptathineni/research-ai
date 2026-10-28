import { mkdtemp, readFile, realpath, rm, writeFile, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type * as FileSystem from 'node:fs/promises';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  requestStore,
  parseResearchRequest,
  requestConfigurationDigest,
} from './search-request-store.js';

const envelope = {
  schema_version: '1.0',
  request_id: 'question-1',
  idempotency_key: 'key-1',
  query: '  Which source?  ',
  method: 'answer-first',
  profile: 'quick',
  cache: 'memory',
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

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FileSystem>();
  return { ...actual, open: vi.fn(actual.open) };
});

it('matches the independent JCS golden and binds configuration while excluding transport identities', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'request-golden-')));
  try {
    const store = requestStore(root);
    await store.initialize();
    const ledger = {
      version: 1,
      identity: '11111111-1111-4111-8111-111111111111',
      epoch: '22222222-2222-4222-8222-222222222222',
      records: [],
    };
    const checksum = createHash('sha256').update(JSON.stringify(ledger)).digest('hex');
    await writeFile(
      join(root, '.signals/requests/ledger.json'),
      JSON.stringify({ ...ledger, checksum }),
    );
    await writeFile(join(root, '.signals/requests/head'), checksum);
    const snapshot = {
      schema_version: 'signals-execution-v1',
      runner: 'codex',
      model: 'fixture-model',
      effort: 'low',
      acquisition: { publicApis: false },
      followedSources: [],
    };
    const digest = requestConfigurationDigest(snapshot);
    expect(digest).toBe('41c6f34fd9227b5187c0daf8e19c8b60ebcd54fbc33261a56b49a14b470c45da');
    expect(
      requestConfigurationDigest({
        followedSources: [],
        acquisition: { publicApis: false },
        effort: 'low',
        model: 'fixture-model',
        runner: 'codex',
        schema_version: 'signals-execution-v1',
      }),
    ).toBe(digest);
    const first = await store.admit(parseResearchRequest(envelope), ledger.epoch, digest);
    expect(first.receipt?.request_digest).toBe(
      '8514648ba0206039e21c248c8a097040449f5785758f70d0f901ee73090b2226',
    );
    const reordered = await store.admit(
      parseResearchRequest(Object.fromEntries(Object.entries(envelope).reverse())),
      ledger.epoch,
      digest,
    );
    expect(reordered.id).toBe(first.id);
    expect(reordered.receipt?.request_digest).toBe(first.receipt?.request_digest);
    const before = await readFile(join(root, '.signals/requests/ledger.json'));
    const retry = await store.admit(
      parseResearchRequest({ ...envelope, request_id: 'retry' }),
      ledger.epoch,
      'b'.repeat(64),
      digest,
    );
    expect(retry.id).toBe(first.id);
    expect(retry.execution_configuration).toEqual(first.execution_configuration);
    expect(await readFile(join(root, '.signals/requests/ledger.json'))).toEqual(before);
    await expect(
      store.admit(parseResearchRequest(envelope), ledger.epoch, digest, 'c'.repeat(64)),
    ).rejects.toThrow('request_configuration_conflict');
    await expect(
      store.admit(
        parseResearchRequest({ ...envelope, idempotency_key: 'fresh' }),
        ledger.epoch,
        'b'.repeat(64),
        digest,
      ),
    ).rejects.toThrow('request_configuration_changed');
    const otherKey = await store.admit(
      parseResearchRequest({ ...envelope, idempotency_key: 'fresh' }),
      ledger.epoch,
      digest,
    );
    expect(otherKey.receipt?.request_digest).toBe(first.receipt?.request_digest);
    const otherConfiguration = await store.admit(
      parseResearchRequest({ ...envelope, idempotency_key: 'changed-config' }),
      ledger.epoch,
      'b'.repeat(64),
    );
    expect(otherConfiguration.receipt?.request_digest).not.toBe(first.receipt?.request_digest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('durably binds concurrent identical admissions before dispatch, without retaining question text', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'request-store-')));
  try {
    const store = requestStore(root);
    const scope = await store.initialize();
    const input = parseResearchRequest(envelope);
    const admitted = await Promise.all(
      Array.from({ length: 8 }, () => store.admit(input, scope.epoch)),
    );
    expect(new Set(admitted.map((row) => row.record.id)).size).toBe(1);
    expect(admitted.filter((row) => row.created)).toHaveLength(1);
    const reopened = requestStore(root);
    expect((await reopened.lookup('key-1', scope.epoch)).receipt?.state).toBe('admitted');
    await expect(
      reopened.admit(parseResearchRequest({ ...envelope, query: 'Changed' }), scope.epoch),
    ).rejects.toThrow('request_conflict');
    expect(await readFile(join(root, '.signals/requests/ledger.json'), 'utf8')).not.toContain(
      'Which source?',
    );
    await reopened.dispatch(admitted[0]!.record.id, scope.epoch);
    expect((await requestStore(root).lookup('key-1', scope.epoch)).receipt).toMatchObject({
      state: 'unknown',
      reason: 'dispatch_may_have_started',
    });
    expect((await reopened.admit(input, scope.epoch)).created).toBe(false);
    await expect(reopened.expire(admitted[0]!.record.id, scope.epoch)).rejects.toThrow(
      'unresolved_request_cannot_expire',
    );
    for (const change of [
      { profile: 'wide' },
      { cache: 'none' },
      { authority_ref: { ...envelope.authority_ref, revision: '2' } },
    ]) {
      await expect(
        reopened.admit(parseResearchRequest({ ...envelope, ...change }), scope.epoch),
      ).rejects.toThrow('request_conflict');
    }
    const retry = await reopened.admit(
      parseResearchRequest({ ...envelope, request_id: 'another' }),
      scope.epoch,
    );
    expect(retry.id).toBe(admitted[0]!.id);
    expect(retry.receipt?.request_id).toBe('question-1');
    expect(retry.receipt?.request_digest).toBe(admitted[0]!.receipt?.request_digest);
    expect(
      (
        await reopened.admit(
          parseResearchRequest({ ...envelope, query: 'Which source?' }),
          scope.epoch,
        )
      ).created,
    ).toBe(false);
    expect(() => parseResearchRequest({ ...envelope, save: 'eligible' })).toThrow(
      'unsupported_research_request_v1',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps expired tombstones, corrupt/missing ledgers and wrong epochs unresolved without admission', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'request-store-')));
  try {
    const store = requestStore(root);
    const scope = await store.initialize();
    expect((await store.lookup('missing', scope.epoch)).code).toBe('not_found');
    await expect(store.admit(parseResearchRequest(envelope), 'wrong')).rejects.toThrow(
      'owner_epoch_mismatch',
    );
    const { record } = await store.admit(parseResearchRequest(envelope), scope.epoch);
    await store.dispatch(record.id, scope.epoch);
    await store.cancel(record.id, scope.epoch);
    expect((await store.lookup('key-1', scope.epoch)).receipt?.state).toBe('cancel_requested');
    await store.settle(record.id, scope.epoch, 'complete');
    expect((await store.lookup('key-1', scope.epoch)).receipt?.reason).toBe(
      'research_complete_result_memory_only_after_cancel_request',
    );
    await store.expire(record.id, scope.epoch);
    expect((await store.lookup('key-1', scope.epoch)).receipt).toMatchObject({
      state: 'unknown',
      reason: 'result_expired_tombstone_retained',
    });
    expect((await store.admit(parseResearchRequest(envelope), scope.epoch)).created).toBe(false);
    const path = join(root, '.signals/requests/ledger.json');
    const original = await readFile(path);
    const altered = JSON.parse(original.toString());
    altered.records = [];
    await writeFile(path, JSON.stringify(altered));
    await expect(store.lookup('key-1', scope.epoch)).rejects.toThrow('request_store_unavailable');
    await writeFile(path, '{broken');
    await expect(store.admit(parseResearchRequest(envelope), scope.epoch)).rejects.toThrow(
      'request_store_unavailable',
    );
    await writeFile(path, original);
    await rm(path);
    await expect(store.initialize()).rejects.toThrow('request_store_unavailable');
    await expect(store.lookup('key-1', scope.epoch)).rejects.toThrow('request_store_unavailable');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('fails admission and dispatch before callback entry when durable storage is full', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'request-storage-full-')));
  try {
    const store = requestStore(root);
    const scope = await store.initialize();
    const path = join(root, '.signals/requests/ledger.json');
    const original = await readFile(path);
    vi.mocked(open).mockRejectedValueOnce(
      Object.assign(new Error('disk_full'), { code: 'ENOSPC' }),
    );
    await expect(store.admit(parseResearchRequest(envelope), scope.epoch)).rejects.toThrow(
      'request_store_unavailable',
    );
    expect(await readFile(path)).toEqual(original);
    const { record } = await store.admit(parseResearchRequest(envelope), scope.epoch);
    vi.mocked(open).mockRejectedValueOnce(
      Object.assign(new Error('disk_full'), { code: 'ENOSPC' }),
    );
    await expect(store.dispatch(record.id, scope.epoch)).rejects.toThrow(
      'request_store_unavailable',
    );
    expect((await store.lookup('key-1', scope.epoch)).receipt?.state).toBe('admitted');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('refuses a valid older ledger restored without its current durable head', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'request-restore-')));
  try {
    const store = requestStore(root);
    const scope = await store.initialize();
    const path = join(root, '.signals/requests/ledger.json');
    const earlier = await readFile(path);
    await store.admit(parseResearchRequest(envelope), scope.epoch);
    await writeFile(path, earlier);
    await expect(store.lookup('key-1', scope.epoch)).rejects.toThrow('request_store_unavailable');
    await expect(store.admit(parseResearchRequest(envelope), scope.epoch)).rejects.toThrow(
      'request_store_unavailable',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const point of ['before-admission', 'after-admission', 'before-spawn', 'after-spawn']) {
  it(`survives a real worker SIGKILL ${point} without replaying an uncertain spawn`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'request-crash-')));
    const store = requestStore(root);
    const scope = await store.initialize();
    const source = new URL('./search-request-store.ts', import.meta.url).href;
    const program = `
      import { requestStore, parseResearchRequest } from ${JSON.stringify(source)};
      import { appendFile } from 'node:fs/promises';
      const root = process.argv[1], point = process.argv[2];
      const store = requestStore(root), scope = await store.scope();
      if (point !== 'before-admission') {
        const admission = await store.admit(parseResearchRequest(${JSON.stringify(envelope)}), scope.epoch);
        if (point !== 'after-admission') {
          await store.dispatch(admission.record.id, scope.epoch);
          if (point === 'after-spawn') await appendFile(root + '/dispatches', 'dispatch\\n');
        }
      }
      process.stdout.write('ready');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', program, root, point],
      {
        env: { PATH: process.env.PATH, HOME: root, TMPDIR: root },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    try {
      const ready = await Promise.race([
        once(child.stdout, 'data').then(([bytes]) => String(bytes)),
        once(child, 'exit').then(([code]) => {
          throw new Error('worker_exited_' + code);
        }),
      ]);
      expect(ready).toBe('ready');
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
      const reopened = requestStore(root);
      const found = await reopened.lookup('key-1', scope.epoch);
      if (point === 'before-admission') expect(found.code).toBe('not_found');
      else {
        expect(found.receipt?.state).toBe(point === 'after-admission' ? 'admitted' : 'unknown');
        expect((await reopened.admit(parseResearchRequest(envelope), scope.epoch)).created).toBe(
          false,
        );
      }
      expect(
        (await readFile(join(root, 'dispatches'), 'utf8').catch(() => ''))
          .split('\n')
          .filter(Boolean),
      ).toHaveLength(point === 'after-spawn' ? 1 : 0);
    } finally {
      child.kill('SIGKILL');
      await rm(root, { recursive: true, force: true });
    }
  });
}
