import { createServer, request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { it, expect } from 'vitest';
import { searchApi } from './search-api.js';
import { resolvePublicUrl, publicTransportUrl } from './search-fetch.js';
import { signalSearch } from './signal-search.js';
import { loadEntities, retainRun } from './search-store.js';
import { budgets, type SearchResult } from '../../domain/src/search-contract.js';
import { frozenFollowupMaterial } from './search-followup.js';
import { loadLibrary } from './library.js';
import { randomUUID } from 'node:crypto';

it('keeps durable v1 identity through lost replies, concurrent retry and API restart without replay', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-durable-api-')));
  let dispatches = 0;
  let release!: () => void;
  const pending = new Promise<void>((done) => {
    release = done;
  });
  const runner = async (): Promise<SearchResult> => {
    dispatches++;
    await pending;
    return {
      schemaVersion: 2,
      runId: randomUUID(),
      query: 'durable question',
      status: 'partial',
      brief: { format: 'markdown', text: 'Stopped partial answer.' },
      items: [],
      sources: [],
      coverage: [],
      gaps: ['synthetic partial'],
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
  };
  let handler = searchApi(root, runner);
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no_port');
  const base = `http://127.0.0.1:${address.port}/signals-ai/__signals/api/`;
  const envelope = {
    schema_version: '1.0',
    request_id: 'question-1',
    idempotency_key: 'retry-1',
    query: 'durable question',
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
  try {
    // D01 depends on this exact pre-effect refusal even for malformed/oversized bodies.
    const refused = await fetch(base + 'search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad',
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ code: 'csrf_token_required' });
    await expect(readFile(join(root, '.signals/requests/ledger.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const { token } = await (await fetch(base + 'session')).json();
    const headers = { 'content-type': 'application/json', 'x-signals-token': token };
    const initialized = await fetch(base + 'request-scope', {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(initialized.status).toBe(200);
    const scope = await initialized.json();
    const owned = { ...headers, 'x-signals-owner-epoch': scope.epoch };
    const post = (body = envelope) =>
      fetch(base + 'search', { method: 'POST', headers: owned, body: JSON.stringify(body) });
    // Consume no start response content: emulate a lost 202 after admission.
    const first = await post();
    expect(first.status).toBe(202);
    const retries = await Promise.all([post(), post(), post()]);
    const receipts = await Promise.all(
      retries.map((reply) => reply.json() as Promise<{ id: string }>),
    );
    const originalId = receipts[0]!.id;
    expect(new Set(receipts.map((row) => row.id)).size).toBe(1);
    expect(dispatches).toBe(1);
    expect((await post({ ...envelope, query: 'different' })).status).toBe(409);
    expect((await post({ ...envelope, profile: 'wide' })).status).toBe(409);
    const before = await readFile(join(root, '.signals/requests/ledger.json'));
    handler = searchApi(root, runner);
    const recovered = await (
      await fetch(base + 'requests/retry-1', { headers: { 'x-signals-owner-epoch': scope.epoch } })
    ).json();
    expect(recovered.id).toBe(originalId);
    expect(recovered.receipt.state).toBe('unknown');
    expect(recovered.receipt.reason).toBe('dispatch_may_have_started');
    expect(await readFile(join(root, '.signals/requests/ledger.json'))).toEqual(before);
    const renewed = await (await fetch(base + 'session')).json();
    const repeated = await fetch(base + 'search', {
      method: 'POST',
      headers: { ...owned, 'x-signals-token': renewed.token },
      body: JSON.stringify(envelope),
    });
    expect(repeated.status).toBe(202);
    expect((await repeated.json()).id).toBe(originalId);
    expect(dispatches).toBe(1);
    release();
    for (let attempt = 0; attempt < 100; attempt++) {
      const settled = await (
        await fetch(base + 'requests/retry-1', {
          headers: { 'x-signals-owner-epoch': scope.epoch },
        })
      ).json();
      if (settled.receipt?.state === 'partial') break;
      await new Promise((done) => setTimeout(done, 10));
    }
    const settled = await (
      await fetch(base + 'requests/retry-1', { headers: { 'x-signals-owner-epoch': scope.epoch } })
    ).json();
    expect(settled.receipt.state).toBe('partial');
    const reopened = await (await fetch(base + 'runs/' + originalId)).json();
    expect(reopened.result).toBeNull();
    expect(reopened.receipt.state).toBe('partial');
    const settledBytes = await readFile(join(root, '.signals/requests/ledger.json'));
    const reconciled = await fetch(base + 'requests/retry-1/reconcile', {
      method: 'POST',
      headers: { ...owned, 'x-signals-token': renewed.token },
      body: '{}',
    });
    expect(reconciled.status).toBe(200);
    expect((await reconciled.json()).id).toBe(originalId);
    expect(await readFile(join(root, '.signals/requests/ledger.json'))).toEqual(settledBytes);
    expect(dispatches).toBe(1);
  } finally {
    release();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    await rm(root, { recursive: true, force: true });
  }
});

it('explicitly reopens an interrupted private run for frozen continuation without restarting research', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-partial-api-')));
  const result: SearchResult = {
    schemaVersion: 2,
    runId: randomUUID(),
    query: 'unfinished source comparison',
    status: 'cancelled',
    brief: {
      format: 'markdown',
      text: 'Earlier source reported a conditional capability; present status is unknown.',
    },
    items: [],
    sources: [],
    coverage: [],
    gaps: ['Verification stopped.'],
    usage: {
      searches: 1,
      documents: 0,
      elapsedMs: 5,
      modelCalls: 0,
      providerUsage: null,
      cost: null,
    },
    counts: { leads: 0, distinct: 0, duplicates: 0, omitted: 0 },
    limits: budgets.quick,
  };
  await retainRun(result, root);
  const path = join(root, '.signals/runs', result.runId + '.json');
  const bytes = await readFile(path);
  let continuations = 0;
  const api = searchApi(
    root,
    async () => {
      throw new Error('research_must_not_restart');
    },
    undefined,
    async (parent) => {
      continuations++;
      const frozen = frozenFollowupMaterial(parent, []);
      expect(parent.status).toBe('cancelled');
      expect(parent.answerReceipt).toBeUndefined();
      expect(frozen.material).toEqual([]);
      expect(frozen.priorSynthesis).toBe(result.brief!.text);
      expect(frozen.gaps.join(' ')).toContain(
        'currentness and contradictions have not been renewed',
      );
      return {
        mode: 'frozen-evidence-replay',
        answer: 'Current status requires a separate source check.',
        statements: [],
        gaps: frozen.gaps,
        usage: null,
      };
    },
  );
  const server = createServer((request, response) => {
    void api(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no_port');
  const base = `http://127.0.0.1:${address.port}/signals-ai/__signals/api/`;
  try {
    const { token } = await (await fetch(base + 'session')).json();
    const headers = { 'content-type': 'application/json', 'x-signals-token': token };
    const body = JSON.stringify({
      runId: result.runId,
      ids: [],
      question: 'The source may have changed; what remains unresolved?',
    });
    expect((await fetch(base + 'followup', { method: 'POST', headers, body })).status).toBe(400);
    expect(continuations).toBe(0);
    expect(
      (
        await fetch(base + 'history/open', {
          method: 'POST',
          headers,
          body: JSON.stringify({ runId: result.runId }),
        })
      ).status,
    ).toBe(200);
    const followup = await fetch(base + 'followup', { method: 'POST', headers, body });
    expect(followup.status).toBe(200);
    const reply = (await followup.json()) as { gaps: string[] };
    expect(reply.gaps.join(' ')).toContain('incomplete, unassessed context');
    expect(continuations).toBe(1);
    expect(await readFile(path)).toEqual(bytes);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});

it('saves only the private question input without requiring a Corpus or invoking research', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-question-api-')));
  const api = searchApi(root, async () => {
    throw new Error('research_must_not_run');
  });
  const server = createServer((request, response) => {
    void api(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no_port');
  const base = `http://127.0.0.1:${address.port}/signals-ai/__signals/api/`;
  try {
    const { token } = (await (await fetch(`${base}session`)).json()) as { token: string };
    const response = await fetch(`${base}question`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signals-token': token },
      body: JSON.stringify({ question: 'What would be useful to learn?' }),
    });
    expect(response.status).toBe(200);
    const { id } = (await response.json()) as { id: string };
    expect(id).toMatch(/^[a-f0-9-]+\.json$/);
    const saved = JSON.parse(await readFile(join(root, '.signals/queries', id), 'utf8'));
    expect(saved).toMatchObject({ recordVersion: 1 });
    expect(saved.result).toEqual({ question: 'What would be useful to learn?' });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps replay follow-ups behind mutation and retained-identity guards without invoking discovery', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-followup-api-')));
  const [record] = await loadEntities();
  if (!record) throw new Error('missing_public_entity');
  const result: SearchResult = {
    schemaVersion: 2,
    runId: randomUUID(),
    query: 'retained public evidence',
    status: 'completed',
    items: [
      {
        entity: record.entity,
        match: { level: 'direct', reason: 'API guard test', sources: [] },
        eligible: false,
        reasons: ['manual_only'],
      },
    ],
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
    counts: { leads: 1, distinct: 1, duplicates: 0, omitted: 0 },
    limits: budgets.quick,
  };
  await retainRun(result, root);
  let reads = 0;
  const api = searchApi(
    root,
    async () => {
      throw new Error('discovery_must_not_run');
    },
    undefined,
    async (frozen, question, ids) => {
      reads++;
      expect(frozen.runId).toBe(result.runId);
      expect(question).toBe('What is supported?');
      expect(ids).toEqual([record.entity.id]);
      return {
        mode: 'frozen-evidence-replay',
        answer: 'Test replay; no model call.',
        statements: [],
        gaps: [],
        usage: null,
      };
    },
  );
  const server = createServer((request, response) => {
    void api(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no_port');
  const base = `http://127.0.0.1:${address.port}/signals-ai/__signals/api/`;
  try {
    const { token } = (await (await fetch(`${base}session`)).json()) as { token: string };
    const headers = { 'content-type': 'application/json', 'x-signals-token': token };
    expect(
      (
        await fetch(`${base}primary-check`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: record.entity.id }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${base}primary-check`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ id: record.entity.id, extra: 'invalid' }),
        })
      ).status,
    ).toBe(400);
    const body = JSON.stringify({
      runId: result.runId,
      ids: [record.entity.id],
      question: 'What is supported?',
    });
    expect(
      (
        await fetch(`${base}followup`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
      ).status,
    ).toBe(403);
    expect((await fetch(`${base}followup`, { method: 'POST', headers, body })).status).toBe(400);
    expect(reads).toBe(0);
    expect(
      (
        await fetch(`${base}history/open`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ runId: result.runId }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${base}followup`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            runId: result.runId,
            ids: ['entity-000000000000000000000000'],
            question: 'What is supported?',
          }),
        })
      ).status,
    ).toBe(400);
    expect(reads).toBe(0);
    const reply = await fetch(`${base}followup`, { method: 'POST', headers, body });
    expect(reply.status).toBe(200);
    expect(await reply.json()).toMatchObject({ mode: 'frozen-evidence-replay' });
    expect(reads).toBe(1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});

it('finishes a rejected search with a visible error and allows the next request', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-api-failure-')));
  const api = searchApi(root, async () => {
    throw new Error('injected_runner_failure');
  });
  const server = createServer((request, response) => {
    void api(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no_port');
  const base = `http://127.0.0.1:${address.port}/signals-ai/__signals/api/`;
  try {
    const { token } = (await (await fetch(`${base}session`)).json()) as { token: string };
    const headers = { 'content-type': 'application/json', 'x-signals-token': token };
    const start = () =>
      fetch(`${base}search`, { method: 'POST', headers, body: '{"query":"ordinary question"}' });
    const first = await start();
    expect(first.status).toBe(202);
    const { id } = (await first.json()) as { id: string };
    const state = (await (await fetch(`${base}runs/${id}`)).json()) as { error: string };
    expect(state.error).toBe('injected_runner_failure');
    expect((await start()).status).toBe(202);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});

it('shares one AI lease across jobs and frozen answers without leaking it on failed preparation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-api-lease-')));
  const parent: SearchResult = {
    schemaVersion: 2,
    runId: randomUUID(),
    query: 'stopped comparison',
    status: 'cancelled',
    items: [],
    sources: [],
    coverage: [],
    gaps: ['Verification stopped.'],
    usage: {
      searches: 0,
      documents: 0,
      elapsedMs: 1,
      modelCalls: 0,
      providerUsage: null,
      cost: null,
    },
    counts: { leads: 0, distinct: 0, duplicates: 0, omitted: 0 },
    limits: budgets.quick,
  };
  await retainRun(parent, root);
  const [record] = await loadEntities(resolve('signals/entities'));
  await mkdir(join(root, 'signals/entities'), { recursive: true });
  await writeFile(
    join(root, 'signals/entities', `${record!.entity.id}.json`),
    JSON.stringify(record, null, 2) + '\n',
  );
  const [finding] = await loadLibrary(root);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let searches = 0;
  let answers = 0;
  const api = searchApi(
    root,
    async () => {
      searches++;
      await gate;
      throw new Error('injected_after_gate');
    },
    undefined,
    async () => {
      answers++;
      return {
        mode: 'frozen-evidence-replay',
        answer: 'Frozen.',
        statements: [],
        gaps: [],
        usage: null,
      };
    },
  );
  const server = createServer((request, response) => {
    void api(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no_port');
  const base = `http://127.0.0.1:${address.port}/signals-ai/__signals/api/`;
  try {
    const { token } = (await (await fetch(`${base}session`)).json()) as { token: string };
    const post = (route: string, body: unknown) =>
      fetch(base + route, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-signals-token': token },
        body: JSON.stringify(body),
      });
    const providers = join(root, '.signals/providers.json');
    await writeFile(providers, '[]');
    const unprepared = await post('search', { query: 'ordinary question' });
    expect(unprepared.status).toBe(400);
    expect(await unprepared.json()).toEqual({ code: 'invalid_acquisition_config' });
    await rm(providers);
    expect(searches).toBe(0);

    const starts = await Promise.all([
      post('search', { query: 'first question' }),
      post('search', { query: 'second question' }),
    ]);
    expect(starts.map((response) => response.status).sort()).toEqual([202, 409]);
    const started = starts.find((response) => response.status === 202)!;
    expect(await starts.find((response) => response.status === 409)!.json()).toEqual({
      code: 'runner_busy',
    });
    expect(searches).toBe(1);

    expect((await post('history/open', { runId: parent.runId })).status).toBe(200);
    const followup = { runId: parent.runId, ids: [], question: 'What remains unresolved?' };
    for (const [route, body] of [
      ['followup', followup],
      ['library-discussion', { keys: [finding!.key], question: 'What remains unresolved?' }],
      ['run-due', {}],
      ['run-list', {}],
    ] as const) {
      const busy = await post(route, body);
      expect(busy.status).toBe(409);
      expect(await busy.json()).toEqual({ code: 'runner_busy' });
    }
    expect(answers).toBe(0);

    const failed = async (job: Response) => {
      const { id } = (await job.json()) as { id: string };
      let state = { error: null as string | null, events: [] as string[] };
      for (let attempt = 0; attempt < 100 && !state.error; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        state = (await (await fetch(`${base}runs/${id}`)).json()) as typeof state;
      }
      return state;
    };
    release();
    const searchState = await failed(started);
    expect(searchState.error).toBe('injected_after_gate');
    expect(searchState.events.at(-1)).toBe('injected_after_gate');
    expect((await post('followup', followup)).status).toBe(200);
    expect(answers).toBe(1);
    expect(searches).toBe(1);

    // Query-list failures are visible like search failures and also release the lease.
    for (let attempt = 0; attempt < 2; attempt++) {
      const listed = await post('run-list', { ids: ['missing-interest'] });
      expect(listed.status).toBe(202);
      const listState = await failed(listed);
      expect(listState.error).toBe('unknown_query_id');
      expect(listState.events).toEqual([
        'Starting explicit query-list research…',
        'unknown_query_id',
      ]);
    }
    expect(searches).toBe(1);
  } finally {
    release();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects remote origins, missing mutation tokens, oversized and arbitrary execution requests', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-api-')));
  let invoked = 0;
  const api = searchApi(root, async (...args) => {
    invoked++;
    return signalSearch(...args);
  });
  const server = createServer((request, response) => {
    void api(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no_port');
  const base = `http://127.0.0.1:${address.port}/signals-ai/__signals/api/`;
  try {
    expect(
      (await fetch(`${base}session`, { headers: { Origin: 'https://untrusted.example' } })).status,
    ).toBe(403);
    const rejectedHost = await new Promise<number | undefined>((resolveStatus, reject) => {
      const request = httpRequest(
        `${base}session`,
        { headers: { Host: 'evil.example' } },
        (response) => {
          response.resume();
          resolveStatus(response.statusCode);
        },
      );
      request.on('error', reject);
      request.end();
    });
    expect(rejectedHost).toBe(403);
    expect(
      (
        await fetch(`${base}search`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"query":"x"}',
        })
      ).status,
    ).toBe(403);
    const session = (await (await fetch(`${base}session`)).json()) as { token: string };
    const headers = { 'content-type': 'application/json', 'x-signals-token': session.token };
    expect(
      (
        await fetch(`${base}search`, {
          method: 'POST',
          headers,
          body: '{"query":"x","command":"touch owned"}',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${base}search`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ query: 'x'.repeat(130000) }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${base}settings`, {
          method: 'POST',
          headers,
          body: '{"model":"secret","path":"/tmp/arbitrary"}',
        })
      ).status,
    ).toBe(400);
    expect(invoked).toBe(0);
    const sites = Array.from({ length: 16 }, (_, i) => `https://scope${i}.example`);
    expect(
      (
        await fetch(`${base}search`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ query: 'ordinary question', supplementalSites: sites }),
        })
      ).status,
    ).toBe(400);
    expect(invoked).toBe(0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});

it('locates unassessed sources without invoking AI and enforces mutation guards', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-source-api-')));
  let aiCalls = 0,
    sourceCalls = 0;
  const api = searchApi(
    root,
    async () => {
      aiCalls++;
      throw new Error('AI must not run');
    },
    async (request) => {
      sourceCalls++;
      expect(
        request.supplementalSites?.some((site) => new URL(site).hostname === 'github.com'),
      ).toBe(true);
      return {
        schemaVersion: 1,
        query: request.query,
        kind: 'unassessed-source-hits',
        hits: [],
        gaps: [],
        searches: 3,
        modelCalls: 0,
      };
    },
  );
  const server = createServer((request, response) => {
    void api(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no_port');
  const base = `http://127.0.0.1:${address.port}/signals-ai/__signals/api/`;
  try {
    const { token } = (await (await fetch(`${base}session`)).json()) as { token: string };
    const body = JSON.stringify({ query: 'portable observability' });
    expect(
      (
        await fetch(`${base}sources`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
      ).status,
    ).toBe(403);
    const headers = { 'content-type': 'application/json', 'x-signals-token': token };
    expect(
      (
        await fetch(`${base}sources`, {
          method: 'POST',
          headers: { ...headers, origin: 'https://example.com' },
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${base}sources`, {
          method: 'POST',
          headers,
          body: '{"query":"x","unexpected":true}',
        })
      ).status,
    ).toBe(400);
    const response = await fetch(`${base}sources`, { method: 'POST', headers, body });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: 'unassessed-source-hits',
      modelCalls: 0,
      searches: 3,
    });
    expect(sourceCalls).toBe(1);
    expect(aiCalls).toBe(0);
    expect(await (await fetch(`${base}corpus`)).json()).toEqual([]);
    expect(await (await fetch(`${base}history`)).json()).toMatchObject({ runs: [] });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});

it('blocks local, private, mapped and metadata fetch destinations before connecting', async () => {
  expect(publicTransportUrl('https://example.org/docs/').pathname).toBe('/docs/');
  for (const uri of [
    'https://127.0.0.1/',
    'https://10.0.0.1/',
    'https://169.254.169.254/',
    'https://[::ffff:127.0.0.1]/',
    'https://localhost/',
    'https://user:pass@example.com/',
    'http://example.com/',
    'https://example.com:8443/',
  ])
    await expect(resolvePublicUrl(uri)).rejects.toThrow();
});
