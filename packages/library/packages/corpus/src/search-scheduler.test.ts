import { it, expect } from 'vitest';
import { mkdtemp, realpath, rm, readFile, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runDueOnce, acquireResearchLease } from './search-scheduler.js';
import { runQueryListOnce } from './search-query-list.js';
import { atomicJson, loadEntities } from './search-store.js';
import { defaultSettings, type SearchSettings } from './search-settings.js';
import { budgets, parseRequest, type SearchResult } from '../../domain/src/search-contract.js';
import type { checkPrimaryMaterial } from './search-reuse.js';

function result(input: unknown): SearchResult {
  return {
    schemaVersion: 2,
    runId: randomUUID(),
    query: parseRequest(input).query,
    status: 'completed',
    items: [],
    sources: [],
    coverage: [],
    gaps: [],
    counts: { leads: 0, distinct: 0, duplicates: 0, omitted: 0 },
    limits: budgets.quick,
    usage: {
      searches: 0,
      documents: 0,
      elapsedMs: 0,
      modelCalls: 0,
      providerUsage: null,
      cost: null,
    },
  };
}
async function fixture(operation: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-maintenance-')));
  try {
    await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function check(status: 'unchanged' | 'changed' | 'failed'): typeof checkPrimaryMaterial {
  return async (entity) => {
    const base = {
      kind: 'primary-material-check',
      entityId: entity.id,
      source: null,
      checkedAt: new Date().toISOString(),
      claimsRenewed: false,
      independentChangesChecked: false,
      modelCalls: 0,
      reason:
        status === 'failed' ? 'source_denied_403' : `${status} representation; claims not renewed`,
    } as const;
    if (status === 'failed') return { ...base, status, material: null };
    return {
      ...base,
      status,
      material: { uri: entity.uri, text: 'Fixture changed text', digest: 'a'.repeat(64) },
    };
  };
}

it('performs finite unchanged and denied maintenance without inference or rewriting retained evidence', async () => {
  await fixture(async (root) => {
    const [record] = await loadEntities();
    if (!record) throw new Error('missing_fixture_entity');
    const path = join(root, '.signals/corpus/entities', `${record.entity.id}.json`);
    await atomicJson(path, record);
    const before = await readFile(path, 'utf8');
    const settings = {
      ...structuredClone(defaultSettings),
      corpusDiscovery: true,
      profile: 'quick' as const,
    };
    let calls = 0;
    const search = async (input: unknown) => {
      calls++;
      return result(input);
    };
    const now = Date.parse('2026-10-08T12:00:00Z');
    const unchanged = await runDueOnce({ root, settings, now, search, check: check('unchanged') });
    expect(unchanged.jobs[0]!.status).toBe('completed');
    expect(
      (await runDueOnce({ root, settings, now, search, check: check('changed') })).jobs,
    ).toHaveLength(0);
    const denied = await runDueOnce({
      root,
      settings,
      now: now + 15 * 86400000,
      search,
      check: check('failed'),
    });
    expect(denied.jobs[0]).toMatchObject({ status: 'failed', reason: 'source_denied_403' });
    expect(calls).toBe(0);
    expect(await readFile(path, 'utf8')).toBe(before);
    const state = JSON.parse(await readFile(join(root, '.signals/discovery-state.json'), 'utf8'));
    expect(state[denied.jobs[0]!.key].primaryCheck.status).toBe('failed');
    const changed = await runDueOnce({
      root,
      settings,
      now: now + 30 * 86400000,
      search,
      check: check('changed'),
    });
    expect(calls).toBe(1);
    expect(changed.jobs[0]).toMatchObject({ status: 'failed', reason: 'refresh_target_missing' });
    expect(await readFile(path, 'utf8')).toBe(before);
  });
});

it('shares identical due requests and never repeats an interrupted slot implicitly', async () => {
  await fixture(async (root) => {
    const settings: SearchSettings = {
      ...structuredClone(defaultSettings),
      queryDiscovery: true,
      queries: ['one', 'two'].map((id) => ({
        id,
        query: 'Shared exact need',
        enabled: true,
        everyDays: 7,
        offsetMinutes: 0,
        concepts: [],
      })),
    };
    let calls = 0;
    const search = async (input: unknown) => {
      calls++;
      return result(input);
    };
    const now = Date.parse('2026-10-08T12:00:00Z');
    const first = await runDueOnce({ root, settings, now, search });
    expect(calls).toBe(1);
    expect(first.jobs).toHaveLength(2);
    expect(first.jobs[0]!.runId).toBe(first.jobs[1]!.runId);
    const path = join(root, '.signals/discovery-state.json');
    const state = JSON.parse(await readFile(path, 'utf8'));
    state[first.jobs[0]!.key].status = 'running';
    await atomicJson(path, state);
    const resumed = await runDueOnce({ root, settings, now, search });
    expect(resumed.jobs[0]!.status).toBe('uncertain');
    expect(
      (await runDueOnce({ root, settings, now: now + 8 * 86400000, search })).jobs,
    ).toHaveLength(1);
    // The second completed interest is newly due; the uncertain first interest is held.
    expect(calls).toBe(2);
    expect(
      (await runDueOnce({ root, settings, now: now + 8 * 86400000, search })).jobs,
    ).toHaveLength(0);
    expect(calls).toBe(2);
  });
});

it('uses one lease for different finite batches and due activation, and releases it on cancellation', async () => {
  await fixture(async (root) => {
    const settings: SearchSettings = {
      ...structuredClone(defaultSettings),
      queryDiscovery: true,
      queries: [
        { id: 'one', query: 'A need', enabled: true, everyDays: 7, offsetMinutes: 0, concepts: [] },
      ],
    };
    const release = await acquireResearchLease(root);
    expect(release).not.toBeNull();
    expect(await runDueOnce({ root, settings })).toMatchObject({ busy: true, jobs: [] });
    await expect(runQueryListOnce({ root, settings })).rejects.toThrow('research_busy');
    await release!();
    const controller = new AbortController();
    const activation = await runDueOnce({
      root,
      settings,
      signal: controller.signal,
      search: async () => {
        controller.abort();
        throw new Error('interrupted');
      },
    });
    expect(activation.jobs[0]!.status).toBe('cancelled');
    const next = await acquireResearchLease(root);
    expect(next).not.toBeNull();
    await next!();
  });
});

it('rejects linked leases and malformed state before invoking research', async () => {
  await fixture(async (root) => {
    const outside = join(root, 'outside.json');
    await writeFile(outside, JSON.stringify({ pid: process.pid }));
    await mkdir(join(root, '.signals'));
    const lease = join(root, '.signals/discovery-lease.json');
    await symlink(outside, lease);
    await expect(acquireResearchLease(root)).rejects.toThrow('unsafe_private_state');
    await rm(lease);
    await atomicJson(join(root, '.signals/discovery-state.json'), {
      injected: { status: 'completed', slot: 'invalid' },
    });
    let calls = 0;
    await expect(
      runDueOnce({
        root,
        settings: { ...defaultSettings, queryDiscovery: true },
        search: async (input) => {
          calls++;
          return result(input);
        },
      }),
    ).rejects.toThrow('invalid_discovery_state');
    expect(calls).toBe(0);
  });
});
