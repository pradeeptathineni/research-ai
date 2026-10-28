import { expect, it } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
  realpath,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadLibrary, setLibrarySaved } from './library.js';
import { loadEntities, saveEntities, retainRun } from './search-store.js';
import { updatePersonal, loadPersonal } from './search-personal.js';
import { scanSources } from './search-sources.js';
import { defaultSettings, saveSettings } from './search-settings.js';
import { budgets, type SearchResult, type SearchItem } from '../../domain/src/search-contract.js';
import { searchLibrary } from '../../domain/src/library-search.js';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'library-boundary-')));
  const [record] = await loadEntities(resolve('signals/entities'));
  const nativeBytes = JSON.stringify(record, null, 2) + '\n';
  const nativeName = record!.entity.id + '.json';
  for (const directory of ['signals/entities', '.signals/corpus/entities', 'signals/practices'])
    await mkdir(join(root, directory), { recursive: true });
  await writeFile(join(root, 'signals/entities', nativeName), nativeBytes);
  await writeFile(join(root, '.signals/corpus/entities', nativeName), nativeBytes);
  await writeFile(
    join(root, 'signals/practices/git-history.json'),
    await readFile('signals/practices/git-history.json'),
  );
  return { root, record: record!, nativeBytes, nativeName };
}
it('retrieves an empty corpus without settings, authentication, model access or creating private state', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'library-empty-')));
  try {
    expect(await loadLibrary(root)).toEqual([]);
    expect(await loadLibrary(root, { scope: 'public' })).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('loads public/native, private/native and eligible historical facts; public scope cannot inspect local notes or collection state', async () => {
  const { root, record } = await fixture();
  try {
    await updatePersonal(root, record.entity.id, {
      note: 'privatecanaryzephyr',
      feedback: 'none',
      novelty: 'unknown',
      seenAt: '2026-10-01T00:00:00Z',
    });
    const local = await loadLibrary(root);
    const published = await loadLibrary(root, { scope: 'public' });
    expect(local.filter((row) => row.origin.format === 'native')).toHaveLength(2);
    expect(local.some((row) => row.origin.format === 'legacy')).toBe(true);
    expect(searchLibrary(local, 'privatecanaryzephyr')).toHaveLength(2);
    expect(JSON.stringify(published)).not.toContain('privatecanaryzephyr');
    expect(
      published.every(
        (row) => row.origin.destination === 'public' && !('notes' in row) && !('feedback' in row),
      ),
    ).toBe(true);
    await writeFile(join(root, '.signals/library-state.json'), '{"untrusted":true}');
    await expect(loadLibrary(root)).rejects.toThrow('invalid_library_collection');
    expect(await loadLibrary(root, { scope: 'public' })).toEqual(published);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('unsaves and resaves native and legacy IDs through private sidecars without deleting facts, losing notes, or mutating public visibility', async () => {
  const { root, nativeBytes, nativeName } = await fixture();
  try {
    const rows = await loadLibrary(root);
    const native = rows.find(
      (row) => row.origin.format === 'native' && row.origin.destination === 'private',
    )!;
    const legacy = rows.find((row) => row.origin.format === 'legacy')!;
    await setLibrarySaved(root, native.key, false, {
      note: 'Native note',
      feedback: 'skip',
      novelty: 'known',
    });
    await setLibrarySaved(root, legacy.key, false, {
      note: 'legacycanaryquartz',
      feedback: 'none',
    });
    expect(searchLibrary(await loadLibrary(root), 'legacycanaryquartz')[0]!.finding.key).toBe(
      legacy.key,
    );
    expect((await loadLibrary(root)).filter((row) => !row.saved)).toHaveLength(2);
    await setLibrarySaved(root, native.key, true);
    await setLibrarySaved(root, legacy.key, true);
    const restored = (await loadLibrary(root)).find((row) => row.key === native.key)!;
    expect(restored).toMatchObject({
      saved: true,
      notes: 'Native note',
      feedback: 'skip',
      novelty: 'known',
    });
    expect((await loadPersonal(root))[native.id]).toMatchObject({
      note: 'Native note',
      feedback: 'skip',
      novelty: 'known',
    });
    expect(
      JSON.parse(await readFile(join(root, '.signals/library-state.json'), 'utf8')).collection[
        native.key
      ],
    ).not.toHaveProperty('feedback');
    expect(await readFile(join(root, '.signals/corpus/entities', nativeName), 'utf8')).toBe(
      nativeBytes,
    );
    expect(await readFile(join(root, 'signals/entities', nativeName), 'utf8')).toBe(nativeBytes);
    expect(
      (await loadLibrary(root, { scope: 'public' })).every((row) => row.saved && !('notes' in row)),
    ).toBe(true);
    const state = await readFile(join(root, '.signals/library-state.json'), 'utf8');
    await expect(setLibrarySaved(root, 'native:private:unknown', false)).rejects.toThrow(
      'unknown_library_finding',
    );
    await expect(
      setLibrarySaved(root, native.key, false, { note: 'x'.repeat(4001) }),
    ).rejects.toThrow('invalid_library_collection_change');
    expect(await readFile(join(root, '.signals/library-state.json'), 'utf8')).toBe(state);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('binds explicit native votes to retained verified configured-source trails in the selected store; notes and unsave never invent credit', async () => {
  const { root, record } = await fixture();
  const parent = 'https://example.com/scout';
  try {
    const settings = {
      ...defaultSettings,
      followedSources: [{ uri: parent, label: 'Fixture scout', enabled: true, interests: [] }],
    };
    await saveSettings(settings, root);
    await scanSources(settings, root, {
      persist: true,
      fetch: async (uri) => ({
        uri,
        text: 'Fixture scout',
        digest: 'a'.repeat(64),
        material: {
          text: 'Fixture scout',
          title: 'Scout',
          author: null,
          publishedAt: null,
          links: [{ uri: record.entity.uri, title: record.entity.name }],
          sections: [],
          extractor: 'fixture',
        },
      }),
    });
    const key = `native:private:${record.entity.id}`;
    const source = async () =>
      (
        JSON.parse(await readFile(join(root, '.signals/source-state.json'), 'utf8')) as Record<
          string,
          { feedback: number | null }
        >
      )[parent]!;
    async function selected(destination: 'public' | 'private', verified: boolean) {
      const item: SearchItem = {
        entity: record.entity,
        match: { level: 'direct', reason: 'Controlled retained binding fixture', sources: [] },
        eligible: false,
        reasons: [],
        discovery: {
          introducedBy: 'followed-source',
          parentUri: parent,
          linkVerified: verified,
          provenanceBasis: verified ? 'configured-source' : 'model-report',
        },
      };
      const run: SearchResult = {
        schemaVersion: 2,
        runId: randomUUID(),
        query: 'Controlled source feedback binding',
        status: 'completed',
        items: [item],
        sources: [],
        coverage: [],
        gaps: ['Fixture, not live discovery.'],
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
      await retainRun(run, root);
      await saveEntities([item], 'manual', root, destination, 75, false, {
        runId: run.runId,
        query: run.query,
        kind: 'one-off',
      });
    }
    await selected('public', true);
    await setLibrarySaved(root, key, true, { feedback: 'useful' });
    expect((await source()).feedback).toBeNull();
    await selected('private', false);
    await setLibrarySaved(root, key, true, { feedback: 'useful' });
    expect((await source()).feedback).toBeNull();
    await selected('private', true);
    await setLibrarySaved(root, key, true, { feedback: 'useful', novelty: 'known' });
    expect((await source()).feedback).toBe(1);
    await setLibrarySaved(root, key, true, { feedback: 'useful' });
    expect((await source()).feedback).toBe(1);
    const before = await readFile(join(root, '.signals/source-state.json'), 'utf8');
    await setLibrarySaved(root, key, false, { note: 'Explicit native annotation' });
    await setLibrarySaved(root, key, true);
    expect(await readFile(join(root, '.signals/source-state.json'), 'utf8')).toBe(before);
    expect((await loadPersonal(root))[record.entity.id]).toMatchObject({
      feedback: 'useful',
      novelty: 'known',
      note: 'Explicit native annotation',
    });
    const legacy = (await loadLibrary(root)).find((row) => row.origin.format === 'legacy')!;
    await setLibrarySaved(root, legacy.key, false, {
      feedback: 'useful',
      note: 'Scoped legacy note',
    });
    expect(await readFile(join(root, '.signals/source-state.json'), 'utf8')).toBe(before);
    expect((await loadPersonal(root))[legacy.id]).toBeUndefined();
    await expect(setLibrarySaved(root, key, true, { parentUri: parent } as never)).rejects.toThrow(
      'invalid_library_collection_change',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('excludes withdrawn historical findings without rewriting their evidence and rejects private sidecar symlinks', async () => {
  const { root } = await fixture();
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'library-outside-')));
  try {
    const legacy = (await loadLibrary(root)).find((row) => row.origin.format === 'legacy')!;
    const path = join(root, 'signals/practices/git-history.json');
    const record = JSON.parse(await readFile(path, 'utf8'));
    const evidence = JSON.stringify(record.evidence);
    record.review.state = 'withdrawn';
    await writeFile(path, JSON.stringify(record));
    expect(
      (await loadLibrary(root, { scope: 'public' })).every((row) => row.origin.format === 'native'),
    ).toBe(true);
    await expect(setLibrarySaved(root, legacy.key, true)).rejects.toThrow(
      'unknown_library_finding',
    );
    expect(JSON.stringify(JSON.parse(await readFile(path, 'utf8')).evidence)).toBe(evidence);
    await writeFile(join(outside, 'library-state.json'), '{"version":1,"collection":{}}');
    await symlink(join(outside, 'library-state.json'), join(root, '.signals/library-state.json'));
    await expect(loadLibrary(root)).rejects.toThrow('unsafe_private_state');
    expect(await loadLibrary(root, { scope: 'public' })).toHaveLength(1);
    expect(await readdir(outside)).toEqual(['library-state.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
