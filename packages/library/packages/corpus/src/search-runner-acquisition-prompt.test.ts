import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as OsModule from 'node:os';
import type * as ChildModule from 'node:child_process';
const state = vi.hoisted(() => ({
  home: '',
  prompt: '',
  configured: { hits: [] as unknown[], gaps: [] as string[], searches: 0, modelCalls: 0 },
  followed: { sources: [] as unknown[], gaps: [] as string[], modelCalls: 0 },
  scannedSettings: null as SearchSettings | null,
}));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof OsModule>()),
  homedir: () => state.home,
}));
vi.mock('./search-acquisition.js', async (original) => ({
  ...(await original()),
  acquireConfigured: async () => state.configured,
}));
vi.mock('./search-sources.js', async (original) => ({
  ...(await original()),
  scanSourcesForResearch: async (settings: SearchSettings) => {
    state.scannedSettings = settings;
    return state.followed;
  },
}));
vi.mock('./search-reuse.js', () => ({
  researchCorpusSlice: async () => ({ records: [], gaps: [] }),
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof ChildModule>()),
  spawn: () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: Object.assign(new EventEmitter(), { destroy: () => {} }),
      stderr: Object.assign(new EventEmitter(), { destroy: () => {} }),
      pid: undefined,
      kill: () => true,
      stdin: {
        end: (prompt: string) => {
          state.prompt = prompt;
          queueMicrotask(() => {
            child.stdout.emit(
              'data',
              Buffer.from(
                JSON.stringify({
                  type: 'item.completed',
                  item: { type: 'agent_message', text: 'Authored public answer.' },
                }) + '\n',
              ),
            );
            child.stdout.emit('data', Buffer.from('{"type":"turn.completed"}\n'));
            child.emit('close', 0, null);
          });
        },
        destroy: () => {},
      },
    });
    return child;
  },
}));
import { codexRunner } from './search-runner.js';
import { defaultSettings, type SearchSettings } from './search-settings.js';

it.each(['empty', 'access-gaps', 'locators', 'charged-empty-search'])(
  'passes meaningful acquisition context without empty provider boilerplate: %s',
  async (kind) => {
    state.home = await realpath(await mkdtemp(join(tmpdir(), 'signals-prompt-')));
    state.configured = { hits: [], gaps: [], searches: 0, modelCalls: 0 };
    state.followed = { sources: [], gaps: [], modelCalls: 0 };
    if (kind === 'access-gaps') {
      state.configured.gaps.push('Public provider access denied.');
      state.followed.gaps.push('Requested source unavailable.');
    } else if (kind === 'locators') {
      state.configured.hits.push({
        uri: 'https://example.com/provider',
        title: 'Unassessed locator',
      });
      state.followed.sources.push({ uri: 'https://example.com/followed', status: 'changed' });
    } else if (kind === 'charged-empty-search') state.configured.searches = 1;
    try {
      const snapshot = { ...structuredClone(defaultSettings), model: 'snapshot-model' };
      const result = await codexRunner('gpt-6.1-sol', 'high', {
        root: state.home,
        settings: snapshot,
        naturalAnswer: true,
        task: 'Public question, no authority expansion.',
      }).discover(
        { query: 'Public resources', profile: 'quick', cache: 'memory' },
        new AbortController().signal,
        () => {},
      );
      expect(result.proposal).toEqual({ answer: 'Authored public answer.' });
      expect(state.scannedSettings).toEqual(snapshot);
      expect(state.prompt).toContain('Public question, no authority expansion.');
      if (kind === 'empty') {
        expect(state.prompt).not.toContain('Configured acquisition');
        expect(state.prompt).not.toContain('Followed-source scans');
      } else if (kind === 'access-gaps') {
        expect(state.prompt).toContain('Public provider access denied.');
        expect(state.prompt).toContain('Requested source unavailable.');
      } else if (kind === 'locators') {
        expect(state.prompt).toContain('https://example.com/provider');
        expect(state.prompt).toContain('https://example.com/followed');
        expect(state.prompt).toContain('untrusted locators');
      } else {
        expect(state.prompt).toContain('"searches":1');
        expect(result.searches).toBe(1);
        expect(state.prompt).not.toContain('Followed-source scans');
      }
    } finally {
      await rm(state.home, { recursive: true, force: true });
    }
  },
);
