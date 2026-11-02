import { expect, it, vi } from 'vitest';
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  mkdir,
  writeFile,
  symlink,
  readdir,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type * as RunnerModule from './search-runner.js';
import { budgets, type SearchResult } from '../../domain/src/search-contract.js';
import { libraryPreferences } from './library-meaning.js';
import { editLibrarySettings, readLibrarySettings } from './library-settings.js';
import { personalSaveDecision } from '../../domain/src/search-score.js';
import { acceptDiscovery } from './signal-search.js';
import { loadEntities } from './search-store.js';
import { searchApi } from './search-api.js';

const nativeCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('./search-runner.js', async (original) => ({
  ...(await original<typeof RunnerModule>()),
  codexRunner: () => ({
    readiness: async () => ({
      available: false,
      broadSearch: false,
      runner: 'fixture',
      reason: 'Offline fixture; no native process.',
    }),
    discover: () => {
      nativeCalls.count++;
      throw new Error('native_execution_forbidden');
    },
  }),
}));
const ids = [
  'automaticSaving.enabled',
  'automaticSaving.signalThreshold',
  'automaticSaving.relevanceThreshold',
];
async function fixture(work: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'library-settings-')));
  try {
    await work(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function cli(root: string, command = 'show', request?: unknown) {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'scripts/library-settings.ts',
      '--root',
      root,
      command,
      ...(request ? [JSON.stringify(request)] : []),
    ],
    { encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Awaited<ReturnType<typeof readLibrarySettings>>;
}
const update = async (root: string, updates: Record<string, unknown>, action = 'save') =>
  editLibrarySettings(root, {
    action,
    expectedRevision: (await readLibrarySettings(root)).revision,
    updates,
    resets: [],
  });

it('discovers defaults without initializing state and shares preview, persistence and grouped reset with CLI', async () => {
  await fixture(async (root) => {
    const initial = cli(root);
    expect(initial).toMatchObject({
      schema: 'owner.settings.v1',
      owner: 'research-ai',
      scope: 'private-library',
    });
    expect(initial.settings.map((row) => [row.effective, row.source])).toEqual([
      [false, 'default'],
      [75, 'default'],
      [75, 'default'],
    ]);
    expect(await readdir(root)).toEqual([]);
    const request = {
      action: 'preview',
      expectedRevision: initial.revision,
      updates: { 'automaticSaving.signalThreshold': 90 },
      resets: [],
    };
    cli(root, 'edit', request);
    expect(await readdir(root)).toEqual([]);
    await libraryPreferences(root, { meaningMatching: true });
    const current = cli(root);
    const saved = cli(root, 'edit', {
      ...request,
      action: 'save',
      expectedRevision: current.revision,
    });
    expect(saved.settings[1]?.effective).toBe(90);
    expect((await libraryPreferences(root)).meaningMatching).toBe(true);
    const reset = await editLibrarySettings(root, {
      action: 'save',
      expectedRevision: saved.revision,
      updates: {},
      resets: ids,
    });
    expect(reset.settings.every((row) => row.source === 'default')).toBe(true);
    expect(await libraryPreferences(root)).toEqual({ meaningMatching: true });
    expect(nativeCalls.count).toBe(0);
  });
}, 15000);

it('rejects stale edits after another writer changes consent, preserves that decision and canonicalizes key order', async () => {
  await fixture(async (root) => {
    const before = await readLibrarySettings(root);
    await libraryPreferences(root, { meaningMatching: true });
    await expect(
      editLibrarySettings(root, {
        action: 'save',
        expectedRevision: before.revision,
        updates: { 'automaticSaving.enabled': true },
        resets: [],
      }),
    ).rejects.toThrow('settings_changed');
    expect(await libraryPreferences(root)).toEqual({ meaningMatching: true });
    const current = await readLibrarySettings(root);
    await writeFile(
      join(root, '.signals/library-preferences.json'),
      '{ "meaningMatching" : true }\n',
    );
    expect((await readLibrarySettings(root)).revision).toBe(current.revision);
  });
});

it.each([
  { updates: { meaningMatching: true }, resets: [] },
  { updates: { 'automaticSaving.signalThreshold': 101 }, resets: [] },
  { updates: { 'automaticSaving.signalThreshold': '75' }, resets: [] },
  { updates: { 'automaticSaving.enabled': 1 }, resets: [] },
  { updates: { 'automaticSaving.relevanceThreshold': 90 }, resets: [] },
  { updates: {}, resets: [ids[0]] },
])(
  'rejects invalid or unselected controls without changing native preferences: %j',
  async (edit) => {
    await fixture(async (root) => {
      await libraryPreferences(root, { meaningMatching: false });
      const before = await readFile(join(root, '.signals/library-preferences.json'), 'utf8');
      await expect(
        editLibrarySettings(root, {
          ...edit,
          action: 'save',
          expectedRevision: (await readLibrarySettings(root)).revision,
        }),
      ).rejects.toThrow('invalid_library_settings');
      expect(await readFile(join(root, '.signals/library-preferences.json'), 'utf8')).toBe(before);
    });
  },
);

it('refuses malformed or symlink preferences and an active existing writer', async () => {
  await fixture(async (root) => {
    await mkdir(join(root, '.signals/locks'), { recursive: true });
    await writeFile(
      join(root, '.signals/locks/search-writer.json'),
      JSON.stringify({ pid: process.pid, started: Date.now() }),
    );
    await expect(update(root, { 'automaticSaving.enabled': true })).rejects.toThrow('writer_busy');
    await writeFile(join(root, 'outside.json'), '{"meaningMatching":false}');
    await symlink(join(root, 'outside.json'), join(root, '.signals/library-preferences.json'));
    await expect(readLibrarySettings(root)).rejects.toThrow('unsafe_private_state');
  });
});

async function syntheticResearch() {
  const quote = 'Inspectable work demonstrates the advertised capability.';
  const facts = [
    'defining/defines',
    'maturity/documented',
    'verification/worked-example',
    'currentness/current',
    'corroboration/applied',
    'verification/independent-applied',
  ];
  return acceptDiscovery(
    {
      version: 4,
      answer: 'Synthetic inspected candidate.',
      interpretation: {
        policy: 'query-relevance-v1',
        need: 'Inspect a useful tool.',
        constraints: [],
        resourceTypes: ['software'],
        timeWindow: null,
      },
      sources: [0, 1, 2].map((i) => ({
        uri: `https://source-${i}.example.org/resource`,
        title: `Source ${i}`,
        publisher: `Publisher ${i}`,
        origin: `origin-${i}`,
        family: 'primary',
        publishedAt: '2026-10-10T12:00:00.000Z',
      })),
      candidates: [
        {
          uri: 'https://source-0.example.org/tool',
          name: 'Synthetic tool',
          kind: 'software',
          identity: 'resolved',
          description: 'Synthetic retained candidate.',
          capabilities: ['inspection'],
          observations: facts.map((signal, i) => ({
            signal,
            source: i < 4 ? 0 : i - 3,
            independent: i >= 4,
            origin: `origin-${i < 4 ? 0 : i - 3}`,
            status: 'supported',
            statement: quote,
            quote,
          })),
          match: { level: 'direct', reason: 'Directly serves the need.', sources: [0] },
          relevance: {
            value: 100,
            reason: 'Addresses inspected constraints.',
            sources: [0],
            constraints: [],
          },
          signalJudgment: {
            rubric: 'software-v1',
            rubricReason: 'Synthetic software.',
            dimensions: {
              basis: { level: 4, reason: 'Original identity.', observations: [0] },
              work: { level: 3, reason: 'Applied operation.', observations: [1, 2, 4, 5] },
              scrutiny: { level: 3, reason: 'Separate origins.', observations: [4, 5] },
              applicability: { level: 3, reason: 'Inspected scope.', observations: [3] },
            },
            contrary: 'inspected',
            status: 'inspected',
            gaps: [],
          },
          limits: [],
        },
      ],
      coverage: [],
      gaps: [],
    },
    { query: 'Inspect a useful tool.', route: 'native', profile: 'wide' },
    {
      asOf: '2026-10-10T12:00:00.000Z',
      fetch: async (uri) => ({ uri, text: quote, digest: 'a'.repeat(64) }),
    },
  );
}

it('CLI defaults change the real saving decision while fixture evidence remains unretained', async () => {
  await fixture(async (root) => {
    const result: SearchResult = {
      ...(await syntheticResearch()),
      schemaVersion: 2,
      runId: randomUUID(),
      query: 'Synthetic configured retention.',
      status: 'completed',
      usage: {
        searches: 0,
        documents: 3,
        elapsedMs: 0,
        modelCalls: 0,
        providerUsage: null,
        cost: null,
      },
      limits: budgets.quick,
    };
    expect(
      personalSaveDecision(
        result.items[0]!.entity,
        result.items[0]!.match,
        result.items[0]!.relevance,
        75,
      ).eligible,
    ).toBe(true);
    const api = searchApi(root, async () => ({ ...structuredClone(result), runId: randomUUID() }));
    const server = createServer((req, res) => {
      void api(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing_port');
    const base = `http://127.0.0.1:${address.port}/signals-ai/__signals/api/`;
    try {
      const { token } = (await (await fetch(base + 'session')).json()) as { token: string };
      const headers = { 'content-type': 'application/json', 'x-signals-token': token };
      const run = async () => {
        const response = await fetch(base + 'search', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            query: 'Synthetic configured retention.',
            profile: 'quick',
            cache: 'private',
            save: 'never',
          }),
        });
        expect(response.status, await response.clone().text()).toBe(202);
        const started = (await response.json()) as { id: string };
        for (let i = 0; i < 100; i++) {
          const state = (await (await fetch(base + 'runs/' + started.id)).json()) as {
            result?: SearchResult;
            error?: string;
          };
          if (state.error) throw new Error(state.error);
          if (state.result) return state.result;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error('fixture_did_not_settle');
      };
      let snapshot = cli(root);
      cli(root, 'edit', {
        action: 'save',
        expectedRevision: snapshot.revision,
        updates: { 'automaticSaving.enabled': true, 'automaticSaving.signalThreshold': 100 },
        resets: [],
      });
      const excluded = await run();
      expect(excluded.status).toBe('completed');
      expect(await loadEntities(join(root, '.signals/corpus/entities'))).toHaveLength(0);
      snapshot = cli(root);
      cli(root, 'edit', {
        action: 'save',
        expectedRevision: snapshot.revision,
        updates: { 'automaticSaving.signalThreshold': 75 },
        resets: [],
      });
      const eligible = await run();
      expect(eligible.status).toBe('partial');
      expect(eligible.gaps.some((gap) => gap.includes('fixture_cannot_enter_corpus'))).toBe(true);
      expect(await loadEntities(join(root, '.signals/corpus/entities'))).toHaveLength(0);
      expect(nativeCalls.count).toBe(0);
      const rejected = await fetch(base + 'library-settings', {
        method: 'POST',
        headers: { ...headers, origin: 'https://outside.example' },
        body: '{}',
      });
      expect(rejected.status).toBe(403);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}, 20000);
