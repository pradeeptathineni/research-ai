import { createServer } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { it, expect } from 'vitest';
import { searchApi } from './search-api.js';
import { loadEntities, saveEntities, retainRun } from './search-store.js';
import { updateInbox, loadInbox } from './search-inbox.js';
import { budgets, type SearchResult } from '../../domain/src/search-contract.js';

it('binds offline corpus follow-ups to selected stores and dismisses persisted inbox entries without inference', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-portal-actions-')));
  const [record] = await loadEntities();
  if (!record) throw new Error('missing_public_fixture');
  const result: SearchResult = {
    schemaVersion: 2,
    runId: randomUUID(),
    query: 'retained evidence',
    status: 'completed',
    items: [
      {
        entity: record.entity,
        match: { level: 'direct', reason: 'test retained context', sources: [] },
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
  await saveEntities(result.items, 'manual', root, 'private');
  await retainRun(result, root);
  await updateInbox(root, result, [record.entity.id]);
  let calls = 0;
  const api = searchApi(
    root,
    async () => {
      throw new Error('discovery_forbidden');
    },
    undefined,
    async (saved, question, ids) => {
      calls++;
      expect(saved.items[0]!.entity.id).toBe(record.entity.id);
      expect(saved.gaps).toContain(
        'Frozen retained evidence; no current access or independent change check.',
      );
      expect(question).toBe('What can this teach me?');
      expect(ids).toEqual([record.entity.id]);
      return {
        mode: 'frozen-evidence',
        answer: 'Bound retained context',
        statements: [],
        gaps: [],
        usage: null,
      };
    },
  );
  const server = createServer((req, res) => {
    void api(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no_port');
  const base = `http://127.0.0.1:${address.port}/signals-ai/__signals/api/`;
  try {
    const { token } = (await (await fetch(`${base}session`)).json()) as { token: string };
    const post = (path: string, body: unknown, authorized = true) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authorized ? { 'x-signals-token': token } : {}),
        },
        body: JSON.stringify(body),
      });
    const selection = {
      ids: [record.entity.id],
      destinations: ['private'],
      question: 'What can this teach me?',
    };
    expect((await post('followup', selection, false)).status).toBe(403);
    expect((await post('followup', { ...selection, destinations: [] })).status).toBe(400);
    expect((await post('followup', { ...selection, destinations: ['public'] })).status).toBe(400);
    expect((await post('followup', { ...selection, path: '/tmp/arbitrary' })).status).toBe(400);
    expect(calls).toBe(0);
    expect((await post('followup', selection)).status).toBe(200);
    expect(calls).toBe(1);
    expect((await post('inbox', { remove: [record.entity.id] }, false)).status).toBe(403);
    expect((await post('inbox', { remove: ['entity-' + '0'.repeat(24)] })).status).toBe(400);
    expect(await loadInbox(root)).toHaveLength(1);
    expect((await post('inbox', { remove: [record.entity.id] })).status).toBe(200);
    expect(await loadInbox(root)).toHaveLength(0);
    expect(calls).toBe(1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});
