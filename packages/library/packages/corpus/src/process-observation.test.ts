import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { processObservation, type ObservedRun } from './process-observation.js';
import { requestStore, parseResearchRequest } from './search-request-store.js';
import { searchApi } from './search-api.js';
import { retainRun } from './search-store.js';
import { budgets, type SearchResult } from '../../domain/src/search-contract.js';

const fixtureResult = (query: string): SearchResult => ({
  schemaVersion: 2,
  runId: randomUUID(),
  query,
  status: 'partial',
  items: [],
  sources: [],
  coverage: [],
  gaps: ['offline fixture'],
  usage: {
    searches: 0,
    documents: 0,
    elapsedMs: 0,
    modelCalls: 0,
    providerUsage: null,
    cost: null,
  },
  counts: { leads: 0, distinct: 0, duplicates: 0, omitted: 0 },
  limits: budgets.quick,
});

const httpFixture = async (root: string, work: Parameters<typeof searchApi>[1]) => {
  const api = searchApi(root, work);
  const server = createServer((request, response) => {
    void api(request, response);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no_port');
  const base = `http://127.0.0.1:${address.port}/signals-ai/__signals/api/`;
  const scope = await requestStore(root).initialize();
  const session = (await (await fetch(base + 'session')).json()) as { token: string };
  const headers = {
    'content-type': 'application/json',
    'x-signals-token': session.token,
    'x-signals-owner-epoch': scope.epoch,
  };
  const observer = {
    'x-signals-provider-version': '1.0',
    'x-signals-instance-id': scope.identity,
    'x-signals-owner-epoch': scope.epoch,
  };
  const post = async (route: string, body: unknown) => {
    const reply = await fetch(base + route, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    expect([200, 202]).toContain(reply.status);
    return reply.json() as Promise<{ id: string }>;
  };
  type HttpSnapshot = {
    snapshot_revision: string;
    processes: {
      ref: { id: string };
      artifacts: unknown[];
      lifecycle: string;
      heartbeat_at: string | null;
      progress: { evidence: { label: string; observed_at: string }[] };
    }[];
  };
  const snapshot = async (): Promise<HttpSnapshot> => {
    for (let i = 0; i < 100; i++) {
      const reply = await fetch(base + 'provider/processes', { headers: observer });
      if (reply.status === 503) {
        // The checked ledger is briefly unavailable while its owner publishes
        // a new receipt. Keep the preceding observation and retry the read.
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      expect(reply.status).toBe(200);
      return reply.json() as Promise<HttpSnapshot>;
    }
    throw new Error('owner_snapshot_unavailable');
  };
  const waitFor = async (
    id: string,
    done: (row: Awaited<ReturnType<typeof snapshot>>['processes'][number]) => boolean,
  ) => {
    for (let i = 0; i < 100; i++) {
      const value = await snapshot();
      const row = value.processes.find((entry) => entry.ref.id === id);
      if (row && done(row)) return value;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('observation_timeout');
  };
  const waitForIdle = async () => {
    for (let i = 0; i < 100; i++) {
      const current = (await (await fetch(base + 'session')).json()) as { active: boolean };
      if (!current.active) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('worker_did_not_settle');
  };
  const close = () =>
    new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
  return { post, snapshot, waitFor, waitForIdle, close };
};

it('reports live evidence, requested cancellation and restarted durable unknown without inventing a child', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-observe-')));
  try {
    const store = requestStore(root);
    const scope = await store.initialize();
    const admitted = await store.admit(
      parseResearchRequest({
        schema_version: '1.0',
        request_id: 'question-1',
        idempotency_key: 'same-effect',
        query: 'fixture question',
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
      }),
      scope.epoch,
    );
    await store.dispatch(admitted.record.id, scope.epoch);
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const run: ObservedRun = {
      requestEpoch: scope.epoch,
      events: ['Starting research…', 'One source inspected'],
      startedAt,
      lastEvidenceAt: startedAt,
      settled: false,
    };
    const runs = new Map([[admitted.record.id, run]]);
    const observer = processObservation(root, runs);
    const first = await observer.snapshot();
    expect(first.full_snapshot).toBe(true);
    expect(first.complete_coverage).toBe(true);
    expect(first.cursor).toBeNull();
    expect(first.processes).toHaveLength(1);
    expect(first.processes[0]).toMatchObject({
      ref: { id: admitted.record.id },
      task_ref: { id: 'question-1' },
      lifecycle: 'running',
      model: null,
      heartbeat_at: startedAt,
      event_cursor: null,
      progress: { label: expect.stringContaining('One source inspected') },
    });
    expect(first.processes[0]!.actions).toEqual([
      expect.objectContaining({
        kind: 'cancel',
        enabled: true,
        target: expect.objectContaining({ id: admitted.record.id }),
      }),
      expect.objectContaining({
        kind: 'reconcile',
        target: expect.objectContaining({ id: 'same-effect' }),
      }),
    ]);
    const repeated = await observer.snapshot();
    expect(repeated.snapshot_revision).toBe(first.snapshot_revision);
    expect(repeated.processes[0]!.heartbeat_at).toBe(startedAt);

    await store.cancel(admitted.record.id, scope.epoch);
    run.cancelRequestedAt = new Date().toISOString();
    observer.changed();
    const pending = await observer.snapshot();
    expect(pending.sequence).toBeGreaterThan(first.sequence);
    expect(pending.processes[0]!.lifecycle).toBe('running');
    expect(pending.processes[0]!.wait_reason).toContain('outcome pending');

    const restarted = await processObservation(root, new Map()).snapshot();
    expect(restarted.store_epoch).not.toBe(pending.store_epoch);
    expect(restarted.processes[0]).toMatchObject({ lifecycle: 'unknown', heartbeat_at: null });
    expect(restarted.processes[0]!.actions[0]).toMatchObject({ kind: 'cancel', enabled: false });
    expect(restarted.processes[0]!.progress.label).toContain('unavailable');
    await store.settle(admitted.record.id, scope.epoch, 'partial');
    const settled = await processObservation(root, new Map()).snapshot();
    expect(settled.processes[0]!.lifecycle).toBe('succeeded');
    expect(settled.processes[0]!.progress.label).toContain('unavailable');
    expect(settled.processes[0]!.artifacts).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps direct jobs bounded to the current owner and never turns silence into completion', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-observe-direct-')));
  try {
    await requestStore(root).initialize();
    const id = randomUUID().replaceAll('-', '');
    const observedAt = new Date(Date.now() - 90_000).toISOString();
    const run: ObservedRun = {
      events: ['Starting research…'],
      startedAt: observedAt,
      lastEvidenceAt: observedAt,
      settled: false,
    };
    const observer = processObservation(root, new Map([[id, run]]));
    const active = await observer.snapshot();
    expect(active.processes[0]).toMatchObject({
      lifecycle: 'running',
      heartbeat_at: observedAt,
      task_ref: null,
      scope: 'unknown',
      model: null,
    });
    expect((await observer.snapshot()).snapshot_revision).toBe(active.snapshot_revision);
    const restarted = await processObservation(root, new Map()).snapshot();
    expect(restarted.processes).toEqual([]);
    expect(restarted.owner_coverage[0]!.reason).toContain('direct jobs disappear on restart');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['durable', 'direct'])(
  'advances revision when history reopening evicts a visible %s result',
  async (mode) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), `signals-observe-prune-${mode}-`)));
    let owner: Awaited<ReturnType<typeof httpFixture>> | undefined;
    try {
      owner = await httpFixture(root, async () => fixtureResult('offline worker result'));
      const retained = fixtureResult('reopened private result');
      await retainRun(retained, root);
      const started = await owner.post(
        'search',
        mode === 'durable'
          ? {
              schema_version: '1.0',
              request_id: 'question-1',
              idempotency_key: 'prune-once',
              query: 'offline worker result',
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
            }
          : {
              query: 'offline worker result',
              method: 'answer-first',
              profile: 'quick',
              cache: 'memory',
              save: 'never',
            },
      );
      await owner.waitFor(started.id, (row) => row.artifacts.length === 1);
      await owner.waitForIdle();
      const before = await owner.snapshot();
      expect((await owner.snapshot()).snapshot_revision).toBe(before.snapshot_revision);
      for (let i = 0; i < 30; i++) await owner.post('history/open', { runId: retained.runId });
      const after = await owner.snapshot();
      const prior = before.processes.find((row) => row.ref.id === started.id)!;
      const current = after.processes.find((row) => row.ref.id === started.id);
      expect(prior.artifacts).toHaveLength(1);
      if (mode === 'durable') expect(current?.artifacts).toEqual([]);
      else expect(current).toBeUndefined();
      expect(after.snapshot_revision).not.toBe(before.snapshot_revision);
      expect((await owner.snapshot()).snapshot_revision).toBe(after.snapshot_revision);
    } finally {
      await owner?.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  },
);

it('timestamps delayed durable failure when its error is appended, then keeps that evidence stable', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-observe-failure-')));
  let owner: Awaited<ReturnType<typeof httpFixture>> | undefined;
  let releaseFailure!: () => void;
  const pendingFailure = new Promise<void>((done) => {
    releaseFailure = done;
  });
  try {
    owner = await httpFixture(root, async (_input, options) => {
      options?.progress?.('Earlier worker evidence');
      await pendingFailure;
      throw new Error('delayed_fixture_failure');
    });
    const started = await owner.post('search', {
      schema_version: '1.0',
      request_id: 'question-failure',
      idempotency_key: 'failure-once',
      query: 'offline failing worker',
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
    const before = await owner.waitFor(
      started.id,
      (row) => row.progress.evidence.at(-1)?.label === 'Earlier worker evidence',
    );
    const previous = before.processes.find((row) => row.ref.id === started.id)!.heartbeat_at!;
    await new Promise((done) => setTimeout(done, 20));
    releaseFailure();
    await owner.waitFor(started.id, (row) => row.lifecycle === 'failed');
    await owner.waitForIdle();
    const after = await owner.snapshot();
    const failed = after.processes.find((row) => row.ref.id === started.id)!;
    expect(failed.progress.evidence.at(-1)?.label).toBe('delayed_fixture_failure');
    expect(failed.progress.evidence.at(-1)?.observed_at).toBe(failed.heartbeat_at);
    expect(Date.parse(failed.heartbeat_at!)).toBeGreaterThan(Date.parse(previous));
    const repeated = await owner.snapshot();
    expect(repeated.snapshot_revision).toBe(after.snapshot_revision);
    expect(repeated.processes.find((row) => row.ref.id === started.id)!.heartbeat_at).toBe(
      failed.heartbeat_at,
    );
  } finally {
    releaseFailure();
    await owner?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
