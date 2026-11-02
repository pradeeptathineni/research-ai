import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings, saveSettings } from '../search-settings.js';
import type { Item, Story } from './schema.js';
import { createBriefingApi, retainBriefingRecords } from './store.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const corpusScript = join(repo, 'scripts/corpus.ts');
const tsxLoader = join(repo, 'node_modules/tsx/dist/loader.mjs');

describe('Briefing snapshot CLI', () => {
  it('exports exact current owner workbench refs to a new file without mutating the owner', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-briefing-snapshot-')));
    roots.push(root);
    await saveSettings(
      {
        ...defaultSettings,
        queries: [
          {
            id: 'systems-design',
            query: 'systems design',
            enabled: true,
            everyDays: 2,
            offsetMinutes: 0,
            concepts: [],
          },
        ],
        followedSources: [
          {
            uri: 'https://example.test/systems.xml',
            label: 'Systems feed',
            enabled: true,
            interests: ['systems-design'],
          },
        ],
      },
      root,
    );
    const source = (await createBriefingApi(root).listSources())[0]!.record;
    const item: Item = {
      id: 'item-snapshot-example',
      sourceId: source.id,
      canonicalUrl: 'https://example.test/story/snapshot-example',
      title: 'An example systems design note',
      author: 'Ada',
      publishedAt: '2026-10-28T08:00:00.000Z',
      observedAt: new Date().toISOString(),
      contentDigest: 'a'.repeat(64),
      excerpt: 'A synthetic retained excerpt for explicit Research selection.',
      metrics: [],
      interestIds: ['systems-design'],
      storyId: 'story-snapshot-example',
    };
    const story: Story = {
      id: 'story-snapshot-example',
      itemIds: [item.id],
      representativeItemId: item.id,
      firstSeen: item.observedAt,
      lastSeen: item.observedAt,
      relation: 'single',
      groupingEvidence: [],
      interestMatches: [],
    };
    await retainBriefingRecords(root, { items: [item], stories: [story] });
    const api = createBriefingApi(root);
    const expectedInput = (await api.listRankInputs())[0]!;
    const ownerFilesBefore = await readdir(root);
    const stateBefore = await readFile(join(root, '.signals/briefing/state.json'));
    const settingsBefore = await readFile(join(root, '.signals/settings.json'));
    const snapshotPath = join(root, 'briefing-workbench.json');

    const result = spawnSync(
      process.execPath,
      ['--import', tsxLoader, corpusScript, 'briefing', 'snapshot', snapshotPath],
      { cwd: root, encoding: 'utf8', timeout: 10_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      exported: true,
      schema: 'signals.briefing-workbench.v1',
    });
    const snapshotBytes = await readFile(snapshotPath);
    const snapshot = JSON.parse(snapshotBytes.toString('utf8')) as {
      schema: string;
      readAt: string;
      ranked: Array<{
        input: {
          storyReference: unknown;
          items: Array<{ itemReference: unknown; sourceReference: unknown }>;
        };
      }>;
      sources: Array<{
        record: { id: string; health: { status: string }; termsRef: string | null };
      }>;
      sourceTerms: unknown[];
    };
    expect(snapshot.schema).toBe('signals.briefing-workbench.v1');
    expect(Number.isFinite(Date.parse(snapshot.readAt))).toBe(true);
    expect(snapshot.ranked).toHaveLength(1);
    expect(snapshot.ranked[0]!.input.storyReference).toEqual(expectedInput.storyReference);
    expect(snapshot.ranked[0]!.input.items[0]!.itemReference).toEqual(
      expectedInput.items[0]!.itemReference,
    );
    expect(snapshot.ranked[0]!.input.items[0]!.sourceReference).toEqual(
      expectedInput.items[0]!.sourceReference,
    );
    expect(snapshot.sources[0]).toMatchObject({
      record: { id: source.id, health: { status: 'unknown' }, termsRef: null },
    });
    expect(snapshot.sourceTerms).toEqual([]);
    expect((await stat(snapshotPath)).mode & 0o777).toBe(0o600);
    expect((await readFile(join(root, '.signals/briefing/state.json'))).equals(stateBefore)).toBe(
      true,
    );
    expect((await readFile(join(root, '.signals/settings.json'))).equals(settingsBefore)).toBe(
      true,
    );
    expect((await readdir(root)).sort()).toEqual(
      [...ownerFilesBefore, 'briefing-workbench.json'].sort(),
    );

    const beforeReplay = await readFile(snapshotPath);
    const replay = spawnSync(
      process.execPath,
      ['--import', tsxLoader, corpusScript, 'briefing', 'snapshot', snapshotPath],
      { cwd: root, encoding: 'utf8', timeout: 10_000 },
    );
    expect(replay.status).not.toBe(0);
    expect((await readFile(snapshotPath)).equals(beforeReplay)).toBe(true);
    expect((await readFile(join(root, '.signals/briefing/state.json'))).equals(stateBefore)).toBe(
      true,
    );
  });
});
