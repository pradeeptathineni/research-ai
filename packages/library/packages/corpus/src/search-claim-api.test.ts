import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { searchApi } from './search-api.js';
import { signalSearch } from './signal-search.js';
import { libraryPreferences } from './library-meaning.js';
import { digest } from './search-fetch.js';
import type { SearchResult } from '../../domain/src/search-contract.js';
import type * as RunnerModule from './search-runner.js';

const uri = 'https://example.org/policy';
const text = 'Allows metadata reuse. Images have separate rights.';
vi.mock('./search-runner.js', async (original) => ({
  ...(await original<typeof RunnerModule>()),
  codexRunner: vi.fn((_model: unknown, _effort: unknown, operation?: { schema?: unknown }) => ({
    readiness: async () => ({
      available: true,
      broadSearch: true,
      runner: 'fixture',
      reason: 'No model',
    }),
    discover: async () => ({
      searches: 0,
      usage: null,
      proposal: operation?.schema
        ? {
            verdict: 'supported',
            reason: 'Scoped public fixture.',
            nextCheck: 'Inspect separate image rights.',
            findings: [
              {
                sourceIndex: 0,
                quote: 'Allows metadata reuse.',
                status: 'supported',
                decisive: true,
                reason: 'Literal scope.',
              },
            ],
            gaps: [],
          }
        : { answer: '[Policy](https://example.org/policy) remains unassessed.' },
    }),
  })),
}));
async function files(root: string, prefix = ''): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) {
      output[`${path}/`] = 'directory';
      Object.assign(output, await files(root, path));
    } else output[path] = digest(await readFile(join(root, path), 'utf8'));
  }
  return output;
}
it.each([
  ['memory', false],
  ['private', false],
  ['memory', true],
  ['private', true],
] as const)(
  'real HTTP %s claim (direct=%s) respects history authority even with automatic saving enabled',
  async (cache, direct) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-claim-api-')));
    const parent = direct
      ? null
      : await signalSearch(
          { query: 'Public original need.', method: 'answer-first', cache: 'private' },
          { root },
        );
    await libraryPreferences(root, {
      meaningMatching: false,
      automaticSaving: { enabled: true, signalThreshold: 75, relevanceThreshold: 75 },
    });
    const before = await files(root);
    const api = searchApi(root, (input, dependencies) =>
      signalSearch(input, {
        ...dependencies,
        fetch: async (uri) => ({ uri, text, digest: digest(text), normalizer: 'text-v2' }),
      }),
    );
    const server = createServer((request, response) => {
      void api(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no_port');
    const base = `http://127.0.0.1:${address.port}/signals-ai/__signals/api/`;
    try {
      const { token } = (await (await fetch(`${base}session`)).json()) as { token: string };
      const started = await fetch(`${base}capture`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-signals-token': token },
        body: JSON.stringify({
          query: parent?.query ?? 'Direct public original need.',
          ...(parent
            ? { assessmentOf: parent.runId }
            : { claimOrigin: 'request', profile: 'quick' }),
          captureUrls: [uri],
          claimText: 'Allows metadata reuse.',
          cache,
          save: 'never',
        }),
      });
      expect(started.status).toBe(202);
      const { id } = (await started.json()) as { id: string };
      let result!: SearchResult;
      await vi.waitFor(async () => {
        const state = (await (await fetch(`${base}runs/${id}`)).json()) as {
          result: SearchResult | null;
        };
        expect(state.result, JSON.stringify(state)).toBeTruthy();
        result = state.result!;
      });
      expect(result.gaps.join(' ')).not.toContain('Local persistence failed');
      expect(result.claimCheck?.historySaved).toBe(cache === 'private');
      const after = await files(root);
      if (cache === 'memory') expect(after).toEqual(before);
      else
        expect(Object.keys(after).filter((path) => !Object.hasOwn(before, path))).toEqual([
          ...(direct ? [join('.signals/runs') + '/'] : []),
          join('.signals/runs', `${result.runId}.json`),
        ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
