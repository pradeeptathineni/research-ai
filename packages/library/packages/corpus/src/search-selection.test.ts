import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { searchApi } from './search-api.js';
import { loadEntities } from './search-store.js';
import { selectSavedEntity } from './search-selection.js';
import { budgets, type SearchResult } from '../../domain/src/search-contract.js';
import type * as RunnerModule from './search-runner.js';

vi.mock('./search-runner.js', async (original) => ({
  ...(await original<typeof RunnerModule>()),
  codexRunner: () => ({
    readiness: async () => ({
      available: false,
      broadSearch: false,
      runner: 'fixture',
      reason: 'No model is used by this selection regression.',
    }),
  }),
}));

it('checks a scoped CLI identity without a query while ordinary retrieval still requires one', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-check-cli-')));
  const script = resolve('scripts/signal-search.ts');
  const run = (args: string[]) =>
    spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), script, ...args], {
      cwd: root,
      encoding: 'utf8',
    });
  try {
    const checked = run([
      '--check-primary',
      'entity-000000000000000000000000',
      '--destination',
      'private',
    ]);
    expect(checked.status).toBe(1);
    expect(JSON.parse(checked.stdout)).toEqual({ status: 'failed', code: 'unknown_entity' });
    const retrieval = run(['--corpus-only']);
    expect(JSON.parse(retrieval.stdout)).toEqual({ status: 'failed', code: 'invalid_request' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

it('requires scope for duplicate saved identities and checks/refreshes the selected private copy', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-store-selection-')));
  const [original] = await loadEntities();
  if (!original) throw new Error('missing_public_entity');
  const paths = {
    public: join(root, 'signals/entities', `${original.entity.id}.json`),
    private: join(root, '.signals/corpus/entities', `${original.entity.id}.json`),
  };
  const privateRecord = structuredClone(original);
  privateRecord.entity.name = 'Private selected copy';
  await mkdir(join(root, 'signals/entities'), { recursive: true });
  await mkdir(join(root, '.signals/corpus/entities'), { recursive: true });
  await writeFile(paths.public, JSON.stringify(original));
  await writeFile(paths.private, JSON.stringify(privateRecord));
  const publicBefore = await readFile(paths.public, 'utf8');
  let checks = 0;
  let searches = 0;
  const api = searchApi(
    root,
    async (input): Promise<SearchResult> => {
      searches++;
      expect(input).toMatchObject({ query: expect.stringContaining('Private selected copy') });
      const refreshed = structuredClone(privateRecord.entity);
      refreshed.name = 'Private refreshed copy';
      refreshed.aliases.push('Scoped refresh fixture alias');
      return {
        schemaVersion: 2,
        runId: randomUUID(),
        query: 'Scoped refresh fixture',
        status: 'completed',
        items: [
          {
            entity: refreshed,
            match: { level: 'direct', reason: 'fixture', sources: [] },
            eligible: false,
            reasons: [],
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
    },
    undefined,
    undefined,
    async (entity) => {
      checks++;
      expect(entity.name).toBe('Private selected copy');
      return {
        kind: 'primary-material-check',
        entityId: entity.id,
        source: null,
        checkedAt: new Date().toISOString(),
        claimsRenewed: false,
        independentChangesChecked: false,
        modelCalls: 0,
        status: 'not-checkable',
        reason: 'Scoped fixture check.',
        material: null,
      };
    },
  );
  const server = createServer((request, response) => void api(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no_port');
  const base = `http://127.0.0.1:${address.port}/signals-ai/__signals/api/`;
  try {
    await expect(selectSavedEntity(original.entity.id, root)).rejects.toThrow(
      'ambiguous_entity_destination',
    );
    const { token } = (await (await fetch(`${base}session`)).json()) as { token: string };
    const post = (route: string, body: unknown, includeToken = true) =>
      fetch(`${base}${route}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(includeToken ? { 'x-signals-token': token } : {}),
        },
        body: JSON.stringify(body),
      });
    for (const route of ['primary-check', 'refresh']) {
      const unscoped = await post(route, { id: original.entity.id });
      expect(unscoped.status).toBe(400);
      expect(await unscoped.json()).toEqual({ code: 'ambiguous_entity_destination' });
      expect((await post(route, { id: original.entity.id, destination: 'other' })).status).toBe(
        400,
      );
      expect(
        (await post(route, { id: original.entity.id, destination: 'private', extra: true })).status,
      ).toBe(400);
      expect(
        (await post(route, { id: original.entity.id, destination: 'private' }, false)).status,
      ).toBe(403);
    }
    expect(checks).toBe(0);
    expect(searches).toBe(0);
    expect(
      (await post('primary-check', { id: original.entity.id, destination: 'private' })).status,
    ).toBe(200);
    expect(checks).toBe(1);
    const started = await post('refresh', { id: original.entity.id, destination: 'private' });
    expect(started.status).toBe(202);
    const { id } = (await started.json()) as { id: string };
    await vi.waitFor(async () => {
      const run = await (await fetch(`${base}runs/${id}`)).json();
      expect(run.result?.status).toBe('completed');
    });
    expect(searches).toBe(1);
    expect((await selectSavedEntity(original.entity.id, root, 'private')).record.entity.name).toBe(
      'Private refreshed copy',
    );
    expect(await readFile(paths.public, 'utf8')).toBe(publicBefore);
    await rm(paths.public);
    expect((await selectSavedEntity(original.entity.id, root)).destination).toBe('private');
    await expect(selectSavedEntity(original.entity.id, root, 'public')).rejects.toThrow(
      'unknown_entity',
    );
    await expect(selectSavedEntity('entity-invalid', root)).rejects.toThrow('invalid_entity_id');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
