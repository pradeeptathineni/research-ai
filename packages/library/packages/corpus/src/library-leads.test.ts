import { it, expect } from 'vitest';
import { mkdtemp, rm, realpath, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadLibrary, setLibrarySaved } from './library.js';
import { saveLibraryLead } from './library-leads.js';
it('retains unassessed leads privately with duplicate identity and immutable saved contexts', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-lead-retention-')));
  const runId = randomUUID();
  const lead = {
    uri: 'https://example.com/unverified',
    name: 'Interesting lead',
    description: 'Not inspected',
    limits: ['No defining evidence'],
  };
  try {
    const saved = await saveLibraryLead(root, lead, runId, 'Original private question');
    await saveLibraryLead(root, lead, runId, 'Original private question');
    await saveLibraryLead(
      root,
      { ...lead, description: 'New lead context' },
      randomUUID(),
      'Different private question',
    );
    const local = await loadLibrary(root);
    expect(local).toHaveLength(1);
    expect(local[0]!.intrinsicStrength.score).toBeNull();
    expect(local[0]!.lead!.history).toHaveLength(2);
    expect(local[0]!.lead!.history[0]!.query).toBe('Original private question');
    expect(await loadLibrary(root, { scope: 'public' })).toEqual([]);
    const bytes = await readFile(join(root, '.signals/library-leads.json'), 'utf8');
    await setLibrarySaved(root, saved.key, false, { note: 'Personal note' });
    await setLibrarySaved(root, saved.key, true);
    expect((await loadLibrary(root))[0]).toMatchObject({ saved: true, notes: 'Personal note' });
    expect(await readFile(join(root, '.signals/library-leads.json'), 'utf8')).toBe(bytes);
    expect(await readdir(root)).toEqual(['.signals']);
    await expect(
      saveLibraryLead(root, { ...lead, uri: 'file:///private/path' }, runId, 'Bad lead'),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
