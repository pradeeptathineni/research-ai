import { it, expect } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings, saveSettings, loadSettings } from './search-settings.js';

it('follows exact public resource URLs while supplemental search scopes stay query-free', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-follow-url-')));
  const settings = {
    ...structuredClone(defaultSettings),
    followedSources: [
      {
        uri: 'https://news.ycombinator.com/item?id=42',
        label: 'Public discussion',
        enabled: true,
        interests: [],
      },
    ],
  };
  try {
    await saveSettings(settings, root);
    expect((await loadSettings(root)).followedSources?.[0]?.uri).toBe(
      'https://news.ycombinator.com/item?id=42',
    );
    await expect(
      saveSettings({ ...settings, supplementalSites: ['https://example.org/search?q=42'] }, root),
    ).rejects.toThrow('invalid_supplemental_site');
    for (const uri of [
      'https://localhost/item?id=42',
      'https://127.0.0.1/item?id=42',
      'https://user:secret@example.org/feed?q=42',
      'http://example.org/feed?q=42',
      'https://example.org/feed?api_key=not-a-real-credential',
    ]) {
      await expect(
        saveSettings(
          { ...settings, followedSources: [{ ...settings.followedSources[0]!, uri }] },
          root,
        ),
      ).rejects.toThrow();
    }
    expect((await loadSettings(root)).followedSources?.[0]?.uri).toBe(
      settings.followedSources[0]!.uri,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
