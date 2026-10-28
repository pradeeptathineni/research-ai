import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type * as StoreModule from './search-request-store.js';
import type * as RunnerModule from './search-runner.js';
import { budgets } from '../../domain/src/search-contract.js';

const state = vi.hoisted(() => ({
  barrier: null as (() => Promise<void>) | null,
  runners: [] as {
    model?: string;
    effort?: string;
    operation: Parameters<typeof RunnerModule.codexRunner>[2];
  }[],
}));
vi.mock('./search-request-store.js', async (original) => {
  const actual = await original<typeof StoreModule>();
  return {
    ...actual,
    requestStore: (root: string) => {
      const store = actual.requestStore(root);
      return {
        ...store,
        admit: async (...args: Parameters<typeof store.admit>) => {
          const admitted = await store.admit(...args);
          await state.barrier?.();
          return admitted;
        },
      };
    },
  };
});
vi.mock('./search-runner.js', async (original) => {
  const actual = await original<typeof RunnerModule>();
  return {
    ...actual,
    codexRunner: (
      model?: string,
      effort?: string,
      operation: Parameters<typeof actual.codexRunner>[2] = {},
    ) => {
      state.runners.push({ model, effort, operation });
      return {
        readiness: async () => ({
          available: true,
          broadSearch: true,
          runner: 'fixture',
          reason: 'fake readiness only',
        }),
      };
    },
  };
});
import { searchApi } from './search-api.js';
import { atomicJson } from './search-store.js';

it('binds execution before admission and keeps that snapshot through authenticated settings drift and retries', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'request-config-barrier-')));
  let release!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>((done) => {
    release = done;
  });
  const admission = new Promise<void>((done) => {
    entered = done;
  });
  let calls = 0;
  const api = searchApi(root, async () => {
    calls++;
    return {
      schemaVersion: 2,
      runId: randomUUID(),
      query: 'configuration snapshot',
      status: 'completed',
      items: [],
      sources: [],
      coverage: [],
      gaps: [],
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
    };
  });
  const server = createServer((request, response) => {
    void api(request, response);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no_port');
  const base = `http://127.0.0.1:${address.port}/signals-ai/__signals/api/`;
  try {
    const { token } = (await (await fetch(base + 'session')).json()) as { token: string };
    const headers = { 'content-type': 'application/json', 'x-signals-token': token };
    const settings = (await (await fetch(base + 'settings')).json()) as Record<string, unknown>;
    const update = (model: string) =>
      fetch(base + 'settings', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...settings,
          model,
          effort: model.endsWith('before') ? 'low' : 'high',
        }),
      });
    expect((await update('fixture-model-before')).status).toBe(200);
    await atomicJson(join(root, '.signals/providers.json'), { publicApis: false });
    const scope = (await (
      await fetch(base + 'request-scope', { method: 'POST', headers, body: '{}' })
    ).json()) as { epoch: string };
    const owned = { ...headers, 'x-signals-owner-epoch': scope.epoch };
    const advertised = (await (await fetch(base + 'request-configuration')).json()) as {
      digest: string;
    };
    expect(Object.keys(advertised).sort()).toEqual([
      'digest',
      'digest_algorithm',
      'schema_version',
    ]);
    const envelope = {
      schema_version: '1.0',
      request_id: 'transport-1',
      idempotency_key: 'bound-config',
      query: 'configuration snapshot',
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
    state.runners = [];
    state.barrier = async () => {
      state.barrier = null;
      entered();
      await paused;
    };
    const starting = fetch(base + 'search', {
      method: 'POST',
      headers: { ...owned, 'x-signals-execution-digest': advertised.digest },
      body: JSON.stringify(envelope),
    });
    await admission;
    expect((await update('fixture-model-after')).status).toBe(200);
    await atomicJson(join(root, '.signals/providers.json'), { publicApis: true });
    release();
    const response = await starting;
    expect(response.status).toBe(202);
    const accepted = (await response.json()) as {
      id: string;
      execution_configuration: { digest: string };
    };
    const execution = state.runners.find((runner) => runner.operation?.root === root);
    expect(execution?.model).toBe('fixture-model-before');
    expect(execution?.effort).toBe('low');
    expect(execution?.operation?.acquisition).toEqual({ publicApis: false });
    expect(accepted.execution_configuration.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(accepted.execution_configuration.digest).toBe(advertised.digest);
    for (let i = 0; i < 200; i++) {
      const row = (await (
        await fetch(base + 'requests/bound-config', { headers: owned })
      ).json()) as { receipt?: { state: string } };
      if (row.receipt?.state === 'complete') break;
      await new Promise((done) => setTimeout(done, 10));
    }
    const retry = await fetch(base + 'search', {
      method: 'POST',
      headers: { ...owned, 'x-signals-execution-digest': accepted.execution_configuration.digest },
      body: JSON.stringify({ ...envelope, request_id: 'transport-2' }),
    });
    expect(retry.status).toBe(202);
    const same = (await retry.json()) as typeof accepted;
    expect(same.id).toBe(accepted.id);
    expect(same.execution_configuration).toEqual(accepted.execution_configuration);
    expect(calls).toBe(1);
    const changed = await fetch(base + 'search', {
      method: 'POST',
      headers: { ...owned, 'x-signals-execution-digest': advertised.digest },
      body: JSON.stringify({ ...envelope, idempotency_key: 'unadmitted-config-change' }),
    });
    expect(changed.status).toBe(409);
    expect((await changed.json()) as { code: string }).toEqual({
      code: 'request_configuration_changed',
    });
    expect(
      (await fetch(base + 'requests/unadmitted-config-change', { headers: owned })).status,
    ).toBe(404);
    expect(calls).toBe(1);
    expect(
      (
        await fetch(base + 'search', {
          method: 'POST',
          headers: { ...owned, 'x-signals-execution-digest': 'f'.repeat(64) },
          body: JSON.stringify(envelope),
        })
      ).status,
    ).toBe(409);
    const ledger = await readFile(join(root, '.signals/requests/ledger.json'), 'utf8');
    expect(ledger).not.toContain('fixture-model-before');
    expect(ledger).not.toContain('fixture-model-after');
  } finally {
    release();
    state.barrier = null;
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
