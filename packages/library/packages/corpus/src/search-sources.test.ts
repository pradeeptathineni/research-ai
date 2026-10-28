import { it, expect } from 'vitest';
import { mkdtemp, rm, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSources } from './search-sources.js';
import { defaultSettings } from './search-settings.js';
it('keeps source exposures/opportunities and missing feedback, emitting additions only once', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sources-test-')));
  const settings = {
    ...defaultSettings,
    followedSources: [
      { uri: 'https://example.com/feed', label: 'A scout', enabled: true, interests: [] },
    ],
  };
  let changed = false;
  const fetch = async (uri: string) => ({
    uri,
    digest: 'a'.repeat(64),
    text: 'Same content',
    material: {
      text: 'Same content',
      title: 'Scout',
      author: null,
      publishedAt: null,
      links: [
        { uri: 'https://example.com/tool', title: 'A' },
        ...(changed ? [{ uri: 'https://other.example.org/next', title: 'B' }] : []),
      ],
      sections: [],
      extractor: 'fixture',
    },
  });
  try {
    expect(
      (await scanSources(settings, root, { persist: true, fetch })).sources[0]?.newLinks,
    ).toHaveLength(1);
    const unchanged = (await scanSources(settings, root, { persist: true, fetch })).sources[0]!;
    expect(unchanged.delta).toBe('unchanged');
    expect(unchanged.newLinks).toHaveLength(0);
    expect(unchanged.health?.exposures).toBe(1);
    expect(unchanged.health?.scans).toBe(2);
    expect(unchanged.health?.feedback).toBeNull();
    changed = true;
    const next = (await scanSources(settings, root, { persist: true, fetch })).sources[0]!;
    expect(next.newLinks).toHaveLength(1);
    expect(next.health?.opportunities).toBe(2);
    const failed = await scanSources(settings, root, {
      persist: true,
      fetch: async () => {
        throw new Error('source_denied_403');
      },
    });
    expect(failed.sources[0]?.state).toBe('failed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('uses conditional transport, emits no duplicate links on 304 and retains the last good source after denial', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sources-conditional-')));
  const settings = {
    ...defaultSettings,
    followedSources: [
      { uri: 'https://example.com/feed', label: 'Scout', enabled: true, interests: [] },
    ],
  };
  try {
    await scanSources(settings, root, {
      persist: true,
      fetch: async (uri) => ({
        uri,
        digest: 'a'.repeat(64),
        text: 'Useful scout',
        response: { status: 200, etag: '"first"' },
        material: {
          text: 'Useful scout',
          title: 'Scout',
          author: null,
          publishedAt: null,
          links: [{ uri: 'https://example.org/artifact', title: 'Artifact' }],
          sections: [],
          extractor: 'fixture',
        },
      }),
    });
    const unchanged = await scanSources(settings, root, {
      persist: true,
      fetch: async (uri, _signal, _redirects, _allowHttp, options) => {
        expect(options?.conditional?.etag).toBe('"first"');
        expect(options?.allowNotModified).toBe(true);
        return { uri, digest: 'b'.repeat(64), text: '', response: { status: 304 } };
      },
    });
    expect(unchanged.sources[0]).toMatchObject({ delta: 'unchanged', newLinks: [] });
    await scanSources(settings, root, {
      persist: true,
      fetch: async () => {
        throw new Error('source_denied_403');
      },
    });
    const state = JSON.parse(await readFile(join(root, '.signals/source-state.json'), 'utf8'))[
      'https://example.com/feed'
    ];
    expect(state.links).toEqual(['https://example.org/artifact']);
    expect(state.state).toBe('fetched');
    expect(state.scans).toBe(3);
    expect(state.lastAttempt).toMatchObject({ status: 'failed', reason: 'source_denied_403' });
    expect(state.opportunities).toBe(1);
    expect(state.feedback).toBeNull();
    const fetchLinks = (links: string[]) => async (uri: string) => ({
      uri,
      digest: 'a'.repeat(64),
      text: 'Scout',
      material: {
        text: 'Scout',
        title: 'Scout',
        author: null,
        publishedAt: null,
        links: links.map((uri) => ({ uri, title: 'Artifact' })),
        sections: [],
        extractor: 'fixture',
      },
    });
    await scanSources(settings, root, { persist: true, fetch: fetchLinks([]) });
    const reintroduced = await scanSources(settings, root, {
      persist: true,
      fetch: fetchLinks(['https://example.org/artifact']),
    });
    expect(reintroduced.sources[0]!.newLinks).toEqual([]);
    expect(reintroduced.sources[0]!.health?.opportunities).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
