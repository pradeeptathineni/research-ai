import { expect, it } from 'vitest';
import { mkdtemp, realpath, readdir, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  githubSearch,
  memoryGitHubCache,
  privateGitHubCache,
  parseGitHubPlans,
} from './search-github.js';
import { fetchEvidence, FetchHttpError } from './search-fetch.js';
import { directSearch } from './search-direct.js';

const row = (id: number) => ({
  id,
  html_url: `https://github.com/example/resource-${id}`,
  full_name: `example/resource-${id}`,
  stargazers_count: id * 10,
  archived: false,
  disabled: false,
  description: 'A candidate locator',
  topics: ['documents'],
  created_at: '2025-10-01T00:00:00Z',
  pushed_at: '2026-10-01T00:00:00Z',
  license: { spdx_id: 'MIT' },
});
const body = (ids: number[], total = ids.length, incomplete = false) => ({
  items: ids.map(row),
  total_count: total,
  incomplete_results: incomplete,
});
const reply = (uri: string, json: unknown, link?: string) => ({
  uri,
  text: '',
  digest: 'a'.repeat(64),
  json,
  response: { status: 200, ...(link ? { link } : {}) },
});

it('narrows explicit lanes to the request scope and excludes unexpected returned repositories', async () => {
  const calls: URL[] = [];
  const result = await directSearch(
    {
      query: 'documents',
      sources: ['github'],
      supplementalSites: ['https://github.com/example/resource-1'],
    },
    undefined,
    async (uri) => {
      calls.push(new URL(uri));
      return reply(uri, body([1, 2]));
    },
    { plans: [{ lane: 'topic-established', topic: 'documents', maxPages: 1 }] },
  );
  expect(calls[0]!.searchParams.get('q')).toContain('repo:example/resource-1');
  expect(result.hits.map((hit) => hit.uri)).toEqual(['https://github.com/example/resource-1']);
  expect(result.gaps).toContain('github/topic-established: out-of-scope repository omitted');
  expect(() =>
    parseGitHubPlans([
      {
        lane: 'topic-established',
        topic: 'documents',
        scope: 'https://github.com/example/tool/tree/main',
      },
    ]),
  ).toThrow('unsupported_github_scope');
});

it('executes explicit star-sorted topic pages and deduplicates stable repository identities', async () => {
  const calls: URL[] = [];
  const result = await githubSearch(
    [{ lane: 'topic-established', topic: 'documents', perPage: 2, maxPages: 2 }],
    {
      fetch: async (uri) => {
        const url = new URL(uri);
        calls.push(url);
        if (url.searchParams.get('page') === '1') {
          const next = new URL(url);
          next.searchParams.set('page', '2');
          return reply(uri, body([1, 2], 3), `<${next}>; rel="next"`);
        }
        return reply(uri, body([2, 3], 3));
      },
    },
  );
  expect(calls).toHaveLength(2);
  expect(calls[0]!.searchParams.get('q')).toBe('topic:documents archived:false');
  expect(calls[0]!.searchParams.get('sort')).toBe('stars');
  expect(calls[0]!.searchParams.get('order')).toBe('desc');
  expect(result.hits.map((hit) => hit.repositoryId)).toEqual([1, 2, 3]);
  expect(result.hits[1]!.discovery.map((trail) => trail.page)).toEqual([1, 2]);
  expect(result.pages[0]!.repositoryIds).toEqual([1, 2]);
  expect(result.hits[0]).toMatchObject({
    licenseHint: 'MIT',
    topics: ['documents'],
    popularity: { stars: 10 },
  });
  expect(result.hits[0]).not.toHaveProperty('observations');
  expect(result.pages[1]!.coverageBoundary).toContain('result set exhausted');
  expect(result.searches).toBe(2);
  expect(result.modelCalls).toBe(0);
});

it('keeps acquired hits while rejecting unsafe, changed, repeated and ambiguous next links', async () => {
  for (const kind of ['host', 'path', 'query', 'repeat', 'ambiguous']) {
    let calls = 0;
    const result = await githubSearch([{ lane: 'topic-established', topic: 'documents' }], {
      fetch: async (uri) => {
        calls++;
        const next = new URL(uri);
        next.searchParams.set('page', '2');
        if (kind === 'host') next.hostname = '127.0.0.1';
        if (kind === 'path') next.pathname = '/repos/example/private';
        if (kind === 'query') next.searchParams.set('q', 'changed');
        if (kind === 'repeat') next.searchParams.set('page', '1');
        return reply(
          uri,
          body([1], 30),
          `<${next}>; rel="next"${kind === 'ambiguous' ? `, <${next}>; rel="next"` : ''}`,
        );
      },
    });
    expect(calls).toBe(1);
    expect(result.hits).toHaveLength(1);
    expect(result.gaps.join()).toContain('github/pagination:');
  }
});

it('reports empty, incomplete, bounded and ceiling coverage distinctly', async () => {
  const plan = { lane: 'capability-established' as const, terms: 'table reading', maxPages: 1 };
  const empty = await githubSearch([plan], { fetch: async (uri) => reply(uri, body([])) });
  expect(empty.pages[0]).toMatchObject({ returned: 0, total: 0, incomplete: false });
  expect(empty.pages[0]!.coverageBoundary).toContain('exhausted');
  const incomplete = await githubSearch([plan], {
    fetch: async (uri) => reply(uri, body([1], 700, true)),
  });
  expect(incomplete.pages[0]!.coverageBoundary).toContain('incomplete');
  const ceiling = await githubSearch([plan], { fetch: async (uri) => reply(uri, body([1], 1200)) });
  expect(ceiling.pages[0]!.coverageBoundary).toContain('ceiling');
  const bounded = await githubSearch([plan], {
    fetch: async (uri) => {
      const next = new URL(uri);
      next.searchParams.set('page', '2');
      return reply(uri, body([1], 30), `<${next}>; rel="next"`);
    },
  });
  expect(bounded.pages[0]!.coverageBoundary).toContain('bounded pages');
});

it('preserves rate/reset metadata, stops further lanes and never retries denied requests', async () => {
  let calls = 0;
  const result = await githubSearch(
    [
      { lane: 'topic-established', topic: 'documents' },
      { lane: 'low-attention-neighbors', topic: 'documents' },
    ],
    {
      fetch: async () => {
        calls++;
        throw new FetchHttpError('source_denied_403', {
          status: 403,
          rateRemaining: '0',
          rateReset: '1800000000',
          retryAfter: '60',
        });
      },
    },
  );
  expect(calls).toBe(1);
  expect(result.pages[0]).toMatchObject({
    sourceStatus: 'rate-limited',
    response: { rateReset: '1800000000', retryAfter: '60' },
  });
  expect(result.gaps.join()).toContain('1 later lanes unsearched');
});

it('reuses orientation cache and conditionally validates expired pages without renewing source claims', async () => {
  const cache = memoryGitHubCache();
  let now = Date.parse('2026-10-01T00:00:00Z'),
    calls = 0;
  const options = {
    cache,
    now: () => now,
    fetch: (async (uri, _signal, _redirects, _pdf, conditional) => {
      calls++;
      if (calls === 1)
        return { ...reply(uri, body([1])), response: { status: 200, etag: '"page-v1"' } };
      expect(conditional).toEqual({
        allowNotModified: true,
        conditional: { etag: '"page-v1"', lastModified: undefined },
      });
      return { uri, text: '', digest: 'b'.repeat(64), response: { status: 304 } };
    }) as typeof fetchEvidence,
  };
  const plan = [{ lane: 'global-established-orientation' as const }];
  const first = await githubSearch(plan, options);
  now += 1000;
  const cached = await githubSearch(plan, options);
  expect(cached.pages[0]!.sourceStatus).toBe('cached');
  expect(cached.searches).toBe(0);
  now += 86400000;
  const checked = await githubSearch(plan, options);
  expect(checked.pages[0]!.sourceStatus).toBe('not-modified');
  expect(checked.pages[0]!.retrievedAt).toBe(first.pages[0]!.retrievedAt);
  expect(checked.pages[0]!.checkedAt).not.toBe(first.pages[0]!.checkedAt);
  expect(checked.hits).toEqual(first.hits);
  expect(calls).toBe(2);
});

it('validates recipes before any network call and preserves unfamiliar low-attention metadata', async () => {
  let calls = 0;
  const fetch: typeof fetchEvidence = async (uri) => {
    calls++;
    return reply(uri, body([1]));
  };
  await expect(githubSearch([{ lane: 'topic-established' }], { fetch })).rejects.toThrow(
    'missing_github_lane_input',
  );
  await expect(
    githubSearch([{ lane: 'emerging', terms: 'documents', windowStart: '2026-02-31' }], { fetch }),
  ).rejects.toThrow('invalid_github_window');
  await expect(
    githubSearch([{ lane: 'global-established-orientation', starBand: [10, 1] }], { fetch }),
  ).rejects.toThrow('invalid_github_star_band');
  expect(calls).toBe(0);
  const result = await githubSearch([{ lane: 'low-attention-neighbors', topic: 'documents' }], {
    fetch,
  });
  expect(result.pages[0]!.query).toBe('topic:documents stars:0..999 archived:false');
  expect(result.pages[0]!.sort).toBe('updated');
  expect(result.hits).toHaveLength(1);
});

it('rejects unsafe metadata identities and does not mistake a licence hint for inspection', async () => {
  const result = await githubSearch(
    [{ lane: 'capability-established', terms: 'document reading' }],
    {
      fetch: async (uri) =>
        reply(uri, {
          ...body([1, 2]),
          items: [row(1), { ...row(2), html_url: 'https://127.0.0.1/private' }],
        }),
    },
  );
  expect(result.hits).toHaveLength(1);
  expect(result.pages[0]!.excluded).toBe(1);
  expect(result.metadataWarning).toContain('inspected licenses');
});

it('uses private caching only explicitly and rejects linked private cache files', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'github-cache-')));
  try {
    const plans = [{ lane: 'topic-established' as const, topic: 'documents' }];
    await githubSearch(plans, {
      cache: memoryGitHubCache(),
      fetch: async (uri) => reply(uri, body([1])),
    });
    expect(await readdir(root)).toEqual([]);
    const cache = privateGitHubCache(root);
    await githubSearch(plans, { cache, fetch: async (uri) => reply(uri, body([1])) });
    expect(await readdir(join(root, '.signals'))).toContain('github-acquisition.json');
    const reused = await githubSearch(plans, {
      cache,
      fetch: async () => {
        throw new Error('must use cache');
      },
    });
    expect(reused.searches).toBe(0);
    await rm(join(root, '.signals/github-acquisition.json'));
    await mkdir(join(root, 'outside'));
    await writeFile(join(root, 'outside/private.json'), '{}');
    await symlink(
      join(root, 'outside/private.json'),
      join(root, '.signals/github-acquisition.json'),
    );
    const guarded = await githubSearch(plans, {
      cache,
      fetch: async (uri) => reply(uri, body([1])),
    });
    expect(guarded.hits).toHaveLength(1);
    expect(guarded.gaps.join()).toContain('github/cache:');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('honours explicit source selection when recipe acquisition is passed through direct entrypoint', async () => {
  let githubCalls = 0;
  const result = await directSearch(
    { query: 'a useful public lesson', sources: ['open-web'] },
    undefined,
    async (uri) => {
      if (new URL(uri).hostname === 'api.github.com') githubCalls++;
      return reply(uri, { query: { search: [] } });
    },
    { plans: [{ lane: 'topic-established', topic: 'documents' }] },
  );
  expect(githubCalls).toBe(0);
  expect(result.pages).toEqual([]);
});

it('rejects conditional header injection before resolving or contacting any source', async () => {
  await expect(
    fetchEvidence('https://example.com', undefined, 0, false, { conditional: { etag: 'a\r\nb' } }),
  ).rejects.toThrow('invalid_conditional_header');
});

it('closes the plan parser and reports failed cache data without exposing its unsafe locators', async () => {
  expect(() =>
    parseGitHubPlans([{ lane: 'topic-established', topic: 'documents', shell: 'execute' }]),
  ).toThrow('invalid_github_plans');
  expect(() =>
    parseGitHubPlans(
      Array.from({ length: 4 }, () => ({ lane: 'topic-established', topic: 'documents' })),
    ),
  ).toThrow('invalid_github_plans');
  expect(() =>
    parseGitHubPlans([
      { lane: 'topic-established', topic: 'documents', maxPages: 4 },
      { lane: 'capability-established', terms: 'document tools', maxPages: 3 },
    ]),
  ).toThrow('github_page_budget_exceeded');
  const result = await githubSearch([{ lane: 'topic-established', topic: 'documents' }], {
    cache: {
      async get() {
        return { hits: [{ uri: 'https://127.0.0.1/private' }] };
      },
      async set() {},
    },
    fetch: async (uri) => reply(uri, body([1])),
  });
  expect(result.hits).toHaveLength(1);
  expect(result.hits[0]!.uri).toBe('https://github.com/example/resource-1');
  expect(result.gaps.join()).toContain('invalid_github_cache_page');
});

it('stops after successful quota exhaustion and honours cancellation before a new page', async () => {
  let calls = 0;
  const exhausted = await githubSearch([{ lane: 'topic-established', topic: 'documents' }], {
    fetch: async (uri) => {
      calls++;
      const next = new URL(uri);
      next.searchParams.set('page', '2');
      return {
        ...reply(uri, body([1], 50), `<${next}>; rel="next"`),
        response: { status: 200, rateRemaining: '0', link: `<${next}>; rel="next"` },
      };
    },
  });
  expect(calls).toBe(1);
  expect(exhausted.hits).toHaveLength(1);
  expect(exhausted.pages[0]!.coverageBoundary).toContain('quota exhausted');
  const controller = new AbortController();
  controller.abort();
  await expect(
    githubSearch([{ lane: 'topic-established', topic: 'documents' }], {
      signal: controller.signal,
      fetch: async (uri) => {
        calls++;
        return reply(uri, body([1]));
      },
    }),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});
