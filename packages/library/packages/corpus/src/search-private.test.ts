import { it, expect } from 'vitest';
import { mkdtemp, realpath, mkdir, writeFile, symlink, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { loadAcquisitionConfig, acquireConfigured } from './search-acquisition.js';
import { loadPersonal } from './search-personal.js';
import { privateCacheFetch } from './search-cache.js';
import { cachedMaterial } from './search-document.js';
import { loadRun, retainRun } from './search-store.js';
import { digest } from './search-fetch.js';
import type { SearchResult } from '../../domain/src/search-contract.js';

it('never creates no-save state, rejects malformed configuration and every private symlink component', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'private-read-')));
  const other = await realpath(await mkdtemp(join(tmpdir(), 'private-other-')));
  try {
    expect(await loadAcquisitionConfig(root)).toEqual({});
    expect(await loadPersonal(root)).toEqual({});
    expect(await readdir(root)).toEqual([]);
    await mkdir(resolve(root, '.signals'));
    await writeFile(resolve(root, '.signals/providers.json'), '[]');
    await expect(loadAcquisitionConfig(root)).rejects.toThrow('invalid_acquisition_config');
    await rm(resolve(root, '.signals'), { recursive: true });
    await writeFile(resolve(other, 'providers.json'), '{}');
    await symlink(other, resolve(root, '.signals'));
    await expect(loadAcquisitionConfig(root)).rejects.toThrow('unsafe_private_state');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});
it('rejects a symlinked parent before reading or retaining private cache and history bytes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'private-parent-')));
  const other = await realpath(await mkdtemp(join(tmpdir(), 'private-target-')));
  const uri = 'https://example.com/resource';
  const runId = '00000000-0000-0000-0000-000000000000';
  try {
    await mkdir(resolve(root, '.signals'));
    await writeFile(resolve(other, `${digest(uri)}.json`), '{}');
    await writeFile(resolve(other, `${runId}.json`), '{}');
    await symlink(other, resolve(root, '.signals/source-cache'));
    await symlink(other, resolve(root, '.signals/runs'));
    await expect(privateCacheFetch(root)(uri)).rejects.toThrow('symlink_source_cache');
    await expect(loadRun(runId, root)).rejects.toThrow('unsafe_run_snapshot');
    await expect(retainRun({ runId } as SearchResult, root)).rejects.toThrow('unsafe_run_snapshot');
    expect(await readdir(other)).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});
it('retains cached final identity, outlinks and reader uncertainty without another network fetch', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'document-cache-')));
  let calls = 0;
  const material = {
    text: 'A page',
    title: 'Page',
    author: null,
    publishedAt: null,
    links: [{ uri: 'https://example.com/tool', title: 'Tool' }],
    sections: [],
    extractor: 'reader',
  };
  const fetch = privateCacheFetch(root, undefined, async () => {
    calls++;
    return {
      uri: 'https://example.com/final',
      text: 'A page',
      digest: 'a'.repeat(64),
      material,
      identityUnverified: true,
    };
  });
  try {
    await fetch('https://example.com/requested');
    const cached = await fetch('https://example.com/requested');
    expect(calls).toBe(1);
    expect(cached.uri).toBe('https://example.com/final');
    expect(cached.material?.links).toEqual(material.links);
    expect(cached.identityUnverified).toBe(true);
    expect(() =>
      cachedMaterial({ ...material, links: [{ uri: 'https://127.0.0.1', title: 'Private' }] }),
    ).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('an unfunded optional provider reports a blocker while the native route remains independent', async () => {
  const result = await acquireConfigured(
    { query: 'bounded evidence' },
    {
      gptResearcher: {
        python: '/missing/python3',
        configPath: '/missing/config',
        billingAuthorized: false,
        keyEnv: [],
      },
    },
  );
  expect(result.modelCalls).toBe(0);
  expect(result.gaps[0]).toContain('missing explicitly authorized API budget');
});
