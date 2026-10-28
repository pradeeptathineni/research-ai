import { it, expect } from 'vitest';
import { mkdtemp, rm, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { privateCacheFetch } from './search-cache.js';
import { digest, normalizeSpan } from './search-fetch.js';
import { atomicJson } from './search-store.js';

it('reacquires old normalized cache representations instead of promoting stripped JSON negation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-cache-version-')));
  const uri = 'https://example.com/resource';
  const raw = '{"description":"We do <not> recommend this"}';
  const path = join(root, '.signals/source-cache', `${digest(uri)}.json`);
  try {
    await atomicJson(path, {
      uri,
      digest: digest(raw),
      text: '{"description":"We do recommend this"}',
      fetchedAt: new Date().toISOString(),
    });
    const original = await readFile(path);
    let calls = 0;
    const fetch = privateCacheFetch(root, undefined, async () => {
      calls++;
      return { uri, digest: digest(raw), text: normalizeSpan(raw) };
    });
    const first = await fetch(uri);
    expect(first.text).toContain('<not>');
    expect(first.cached).toBe(false);
    const second = await fetch(uri);
    expect(second.cached).toBe(true);
    expect(second.fetchedAt).toBe(first.fetchedAt);
    expect(calls).toBe(1);
    expect(await readFile(path)).toEqual(original);
    expect(
      JSON.parse(
        await readFile(
          join(root, '.signals/source-cache', `${digest(`${uri}:text-v2`)}.json`),
          'utf8',
        ),
      ),
    ).toHaveProperty('normalizer', 'text-v2');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
