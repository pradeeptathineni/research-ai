import { expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { atomicJson } from './search-store.js';
import { signalSearch } from './signal-search.js';
import { codexRunner } from './search-runner.js';
import type * as RunnerModule from './search-runner.js';

vi.mock('./search-runner.js', async (original) => {
  const actual = await original<typeof RunnerModule>();
  return {
    ...actual,
    codexRunner: vi.fn(() => ({
      evidenceClass: 'fixture',
      readiness: async () => ({
        available: true,
        broadSearch: true,
        runner: 'fixture',
        reason: 'Fixture only',
      }),
      discover: async () => ({
        proposal: { sources: [], candidates: [], coverage: [], gaps: [] },
        searches: 0,
        usage: null,
      }),
    })),
  };
});

it('passes the requested root and its acquisition configuration to the default runner', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-runner-root-')));
  try {
    await atomicJson(resolve(root, '.signals/providers.json'), { publicApis: true, jina: false });
    const result = await signalSearch(
      { query: 'portable tracing', cache: 'memory', save: 'never' },
      { root },
    );
    expect(result.status).toBe('completed');
    expect(codexRunner).toHaveBeenCalledWith(undefined, undefined, {
      root,
      acquisition: { publicApis: true, jina: false },
    });
    expect(await readdir(resolve(root, '.signals'))).toEqual(['providers.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
