import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings, saveSettings } from '../search-settings.js';
import { refreshDue } from './ingest.js';
import { createBriefingApi, githubPublicRepositoryList } from './store.js';
import { briefingRoute } from './http.js';
import { type fetchEvidence } from '../search-fetch.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

const releaseUri = 'https://api.github.com/repos/octocat/Hello-World/releases';
const tagsUri = 'https://api.github.com/repos/octocat/Hello-World/tags';

async function sourceRoot() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-github-briefing-')));
  roots.push(root);
  await saveSettings(
    {
      ...defaultSettings,
      queries: [
        {
          id: 'release-engineering',
          query: 'release engineering',
          enabled: true,
          everyDays: 2,
          offsetMinutes: 0,
          concepts: [],
        },
      ],
      followedSources: [
        {
          uri: releaseUri,
          label: 'Hello World releases',
          enabled: true,
          interests: ['release-engineering'],
        },
        {
          uri: tagsUri,
          label: 'Hello World tags',
          enabled: true,
          interests: ['release-engineering'],
        },
      ],
    },
    root,
  );
  return root;
}

const releaseFixtures = [
  {
    id: 44,
    tag_name: 'v2.0',
    name: 'Release engineering milestone',
    body: 'Release engineering update.',
    draft: false,
    prerelease: false,
    published_at: '2026-10-20T10:00:00Z',
    author: { login: 'octocat' },
  },
  {
    id: 45,
    tag_name: 'v-next',
    name: 'Unpublished draft',
    body: 'Not public.',
    draft: true,
    prerelease: false,
    published_at: null,
  },
];

const tagFixtures = [
  { name: 'v2.0', commit: { sha: 'a'.repeat(40) } },
  { name: 'feature/release-candidate', commit: { sha: 'b'.repeat(40) } },
];

function response(uri: string, json: unknown) {
  return {
    uri,
    json,
    text: JSON.stringify(json),
    digest: 'a'.repeat(64),
    contentType: 'application/json',
    response: { status: 200, etag: 'fixture-v1', lastModified: null, headers: {} },
  } as never;
}

describe('GitHub public releases and repository tags Following adapter', () => {
  it('keeps documented releases and tags distinct through retention, ranking, replay and cold read', async () => {
    expect(githubPublicRepositoryList(releaseUri)).toEqual({
      owner: 'octocat',
      repository: 'Hello-World',
      collection: 'releases',
    });
    expect(githubPublicRepositoryList(tagsUri)?.collection).toBe('tags');
    for (const invalid of [
      'http://api.github.com/repos/octocat/Hello-World/releases',
      'https://api.github.com/repos/octocat/Hello-World/releases?per_page=1000',
      'https://api.github.com.attacker.test/repos/octocat/Hello-World/tags',
      'https://user@api.github.com/repos/octocat/Hello-World/tags',
      'https://api.github.com/repos/octocat/Hello-World/commits',
    ])
      expect(githubPublicRepositoryList(invalid)).toBeNull();

    const root = await sourceRoot();
    const calls: Array<{ uri: string; githubPublicApi?: true }> = [];
    const fetch: typeof fetchEvidence = async (uri, _signal, _redirects, _allowPdf, options) => {
      calls.push({ uri, githubPublicApi: options?.githubPublicApi });
      const parsed = new URL(uri);
      expect(parsed.searchParams.get('per_page')).toBe('20');
      expect(parsed.searchParams.get('page')).toBe('1');
      if (parsed.pathname.endsWith('/releases')) return response(uri, releaseFixtures);
      if (parsed.pathname.endsWith('/tags')) return response(uri, tagFixtures);
      throw new Error('unexpected_fixture_uri');
    };
    const requestId = 'd358819f-1037-42f6-9019-d36536e88456';
    const result = await refreshDue(root, { once: true, requestId }, { fetch });
    expect(result).toMatchObject({ status: 'complete', replayed: false });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.githubPublicApi === true)).toBe(true);

    const api = createBriefingApi(root);
    const sources = await api.listSources();
    expect(sources.map(({ record }) => record.kind)).toEqual([
      'api:github-releases',
      'api:github-tags',
    ]);
    expect(sources.every(({ record }) => record.termsRef === null)).toBe(true);
    expect(sources.every(({ record }) => record.health.status === 'healthy')).toBe(true);

    const items = await api.listItems({ limit: 100 });
    const stories = await api.listStories({ limit: 100 });
    expect(items).toHaveLength(3);
    expect(stories).toHaveLength(3);
    const release = items.find(({ record }) => record.title === 'Release engineering milestone')!;
    const regularTag = items.find(({ record }) =>
      record.title.includes('feature/release-candidate'),
    )!;
    const sameNameTag = items.find(({ record }) => record.title.includes('tag v2.0'))!;
    expect(release.record).toMatchObject({
      sourceId: sources[0]?.record.id,
      canonicalUrl: 'https://github.com/octocat/Hello-World/releases/tag/v2.0',
      author: 'octocat',
      publishedAt: '2026-10-20T10:00:00.000Z',
      excerpt: 'Release engineering update.',
    });
    expect(regularTag.record).toMatchObject({
      sourceId: sources[1]?.record.id,
      canonicalUrl: 'https://github.com/octocat/Hello-World/tree/feature%2Frelease-candidate',
      excerpt: `Git tag feature/release-candidate points to commit ${'b'.repeat(40)}.`,
    });
    expect(release.record.id).not.toBe(sameNameTag.record.id);
    expect(release.record.canonicalUrl).not.toBe(sameNameTag.record.canonicalUrl);
    expect(stories.every(({ reference }) => reference.kind === 'briefing-story')).toBe(true);

    const workbench = (await briefingRoute(root, 'briefing/workbench', false, undefined, 0))!;
    const ranked = (
      workbench.body as {
        ranked: Array<{ input: { story: { id: string } }; explanation: { total: number | null } }>;
      }
    ).ranked;
    expect(ranked).toHaveLength(3);
    expect(ranked.every(({ explanation }) => typeof explanation.total === 'number')).toBe(true);
    expect(ranked.some(({ input }) => input.story.id === release.record.storyId)).toBe(true);

    const replay = await refreshDue(root, { once: true, requestId }, { fetch });
    expect(replay).toMatchObject({ status: 'complete', replayed: true });
    expect(calls).toHaveLength(2);
    expect(
      (await api.listItems({ limit: 100 })).map(({ reference }) => reference.revision),
    ).toEqual(items.map(({ reference }) => reference.revision));
  });

  it('keeps explicit source blocking authoritative for GitHub API requests', async () => {
    const root = await sourceRoot();
    const api = createBriefingApi(root);
    const sources = await api.listSources();
    await api.setSourceTermsPolicy({
      requestId: 'd358819f-1037-42f6-9019-d36536e88457',
      sourceId: sources[1]!.record.id,
      termsUrl: null,
      status: 'blocked',
    });
    const calls: string[] = [];
    const fetch: typeof fetchEvidence = async (uri) => {
      calls.push(uri);
      return response(uri, []);
    };
    const result = await refreshDue(
      root,
      { once: true, requestId: 'd358819f-1037-42f6-9019-d36536e88458' },
      { fetch },
    );
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!).pathname).toBe('/repos/octocat/Hello-World/releases');
    expect(result.result?.blockedSourceIds).toContain(sources[1]!.record.id);
    expect(
      (await api.listItems({ limit: 100 })).every(
        ({ record }) => record.sourceId === sources[0]!.record.id,
      ),
    ).toBe(true);
  });
});
