import { it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { searchApi } from './search-api.js';
import { codexRunner } from './search-runner.js';
import type * as RunnerModule from './search-runner.js';
import { defaultSettings, saveSettings } from './search-settings.js';
import { budgets } from '../../domain/src/search-contract.js';

vi.mock('./search-runner.js', async (original) => ({
  ...(await original<typeof RunnerModule>()),
  codexRunner: vi.fn(() => ({
    evidenceClass: 'fixture',
    readiness: async () => ({
      available: true,
      broadSearch: true,
      runner: 'fixture',
      reason: 'No model',
    }),
    discover: async () => ({
      proposal: { answer: 'Unassessed public fixture answer.' },
      usage: null,
      searches: 0,
    }),
  })),
}));

it('configured quick profile governs both ordinary-answer prompt and host budget when request omits profile', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-api-answer-budget-')));
  await saveSettings({ ...defaultSettings, profile: 'quick' }, root);
  const api = searchApi(root);
  const server = createServer((request, response) => {
    void api(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no_port');
  const base = `http://127.0.0.1:${address.port}/signals-ai/__signals/api/`;
  try {
    const { token } = (await (await fetch(`${base}session`)).json()) as { token: string };
    const started = await fetch(`${base}search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signals-token': token },
      body: JSON.stringify({
        query: 'public research fixture',
        method: 'answer-first',
        cache: 'memory',
      }),
    });
    expect(started.status).toBe(202);
    const { id } = (await started.json()) as { id: string };
    await vi.waitFor(async () => {
      const state = await (await fetch(`${base}runs/${id}`)).json();
      expect(state.result?.limits).toEqual(budgets.quick);
    });
    const task = vi
      .mocked(codexRunner)
      .mock.calls.find((call) => call[2]?.naturalAnswer)?.[2]?.task;
    expect(task).toContain(JSON.stringify(budgets.quick));
    expect(task).not.toContain(JSON.stringify(budgets.wide));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
