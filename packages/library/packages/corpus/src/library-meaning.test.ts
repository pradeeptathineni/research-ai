import { expect, it, vi } from 'vitest';
import {
  projectNativeLibrary,
  createLibraryIndex,
  type LibraryFinding,
} from '../../domain/src/library-search.js';
import { loadEntities } from './search-store.js';
import { matchLibrary } from './library-meaning.js';
import type { SearchRunner } from './search-runner.js';

const capture = vi.hoisted(() => ({ task: '' }));
vi.mock('./search-runner.js', () => ({
  codexRunner: (_model: unknown, _effort: unknown, operation: { task: string }) => {
    capture.task = operation.task;
    return {
      readiness: async () => ({
        available: true,
        broadSearch: false,
        runner: 'fixture',
        reason: 'No model',
      }),
      discover: async () => ({ proposal: { matches: [] }, usage: null, searches: 0 }),
    };
  },
}));

it('recovers paraphrases outside literal hits and hydrates unchanged records with qualified identities', async () => {
  const [record] = await loadEntities();
  const finding = {
    ...projectNativeLibrary(record!, 'private'),
    title: 'Orchid',
    description: 'Coordinates autonomous workers through a visual control console',
    capabilities: [],
    tags: [],
    notes: 'PRIVATE NOTE NEVER IN MATCHING METADATA',
  };
  const query = 'that impressive agentic system with a dashboard';
  const literal = createLibraryIndex([finding]).search(query);
  expect(literal).toHaveLength(0);
  let calls = 0;
  const runner: SearchRunner = {
    readiness: async () => ({
      available: true,
      broadSearch: false,
      runner: 'fixture',
      reason: 'No model invoked',
    }),
    discover: async (request) => {
      calls++;
      expect(request).toMatchObject({ save: 'never', cache: 'memory' });
      return {
        proposal: {
          matches: [
            { key: finding.key, reason: 'Fixture paraphrase of visual worker coordination' },
          ],
        },
        usage: null,
        searches: 0,
      };
    },
  };
  const matched = await matchLibrary([finding], query, {}, { permitted: true, runner });
  expect(calls).toBe(1);
  expect(matched.state).toBe('completed');
  expect(matched.hits[0]!.finding).toBe(finding);
  expect(matched.hits[0]!.finding.native).toBe(record!.entity);
  expect(matched.hits[0]!.retrievalScore).toBe(0);
});

it('denies inference, forged identities, scope escapes and cancellation while retaining literal fallback', async () => {
  const [record] = await loadEntities();
  const finding = projectNativeLibrary(record!, 'private');
  let calls = 0;
  const runner: SearchRunner = {
    readiness: async () => ({ available: true, broadSearch: false, runner: 'fixture', reason: '' }),
    discover: async () => {
      calls++;
      return {
        proposal: { matches: [{ key: 'native:public:forged', reason: 'invented' }] },
        usage: null,
        searches: 0,
      };
    },
  };
  expect(
    (await matchLibrary([finding], finding.title, {}, { permitted: false, runner })).state,
  ).toBe('disabled');
  expect(calls).toBe(0);
  expect(
    (
      await matchLibrary(
        [finding],
        finding.title,
        { destination: 'public' },
        { permitted: true, runner },
      )
    ).hits,
  ).toEqual([]);
  expect(calls).toBe(0);
  const forged = await matchLibrary([finding], finding.title, {}, { permitted: true, runner });
  expect(forged.state).toBe('unavailable');
  expect(forged.hits[0]!.finding.key).toBe(finding.key);
  const controller = new AbortController();
  controller.abort();
  expect(
    (
      await matchLibrary(
        [finding],
        finding.title,
        {},
        { permitted: true, runner, signal: controller.signal },
      )
    ).state,
  ).toBe('cancelled');
  expect(calls).toBe(1);
});

it('exposes a query-connected late key without promoting private fields, scores or hidden metadata tails', async () => {
  const [record] = await loadEntities();
  const original = projectNativeLibrary(record!, 'public');
  const make = (
    key: string,
    title: string,
    description = 'Unrelated inventory',
  ): LibraryFinding => ({
    ...original,
    key,
    title,
    description,
    aliases: [],
    domains: [],
    capabilities: [],
    useCases: [],
    technologies: [],
    tags: [],
    sourceNames: [],
    notes: undefined,
    answerText: undefined,
  });
  const records = Array.from({ length: 250 }, (_, i) =>
    make(`a-${String(i).padStart(3, '0')}`, `Inventory ${i}`),
  );
  const target = make('z-target', 'Orchid coordination');
  const privateNote = { ...make('z-note', 'Plain note'), notes: 'Orchid coordination' };
  const wholeAnswer = { ...make('z-answer', 'Plain answer'), answerText: 'Orchid coordination' };
  const alias = { ...make('z-alias', 'Plain alias'), aliases: ['Orchid coordination'] };
  const tail = make('z-tail', 'Plain tail', 'x'.repeat(1200) + ' Orchid coordination');
  const excluded = {
    ...make('z-private', 'Orchid coordination'),
    origin: { ...original.origin, destination: 'private' as const },
  };
  records.push(target, privateNote, wholeAnswer, alias, tail, excluded);
  const before = JSON.stringify(records);
  const matched = await matchLibrary(
    records,
    target.title,
    { destination: 'public' },
    { permitted: true },
  );
  const rows = JSON.parse(capture.task.split('\nRecords: ')[1]!) as { key: string }[];
  expect(rows[0]!.key).toBe(target.key);
  for (const key of [privateNote.key, wholeAnswer.key, alias.key, tail.key, excluded.key])
    expect(rows.map((row) => row.key)).not.toContain(key);
  expect(rows).toHaveLength(200);
  expect(JSON.stringify(rows).length).toBeLessThanOrEqual(48000);
  expect(Object.keys(rows[0]!).sort()).toEqual(
    ['key', 'title', 'description', 'kind', 'capabilities', 'tags'].sort(),
  );
  expect(matched.omitted).toBe(55);
  expect(matched.hits.map((hit) => hit.finding.key)).toContain(privateNote.key);
  expect(matched.hits.map((hit) => hit.finding.key)).toContain(wholeAnswer.key);
  expect(matched.hits.map((hit) => hit.finding.key)).not.toContain(excluded.key);
  expect(matched.state).toBe('partial');
  expect(matched.reason).toContain('omitted records can include paraphrases');
  expect(JSON.stringify(records)).toBe(before);
});

it('bounds long metadata and retains all candidates in a small scoped pool', async () => {
  const [record] = await loadEntities();
  const finding = {
    ...projectNativeLibrary(record!, 'public'),
    description: 'x'.repeat(2000),
    capabilities: Array.from({ length: 20 }, (_, i) => `Capability ${i}`),
    tags: Array.from({ length: 20 }, (_, i) => `Tag ${i}`),
  };
  const matched = await matchLibrary([finding], 'No overlapping phrase', {}, { permitted: true });
  const [row] = JSON.parse(capture.task.split('\nRecords: ')[1]!);
  expect(row.description).toHaveLength(1200);
  expect(row.capabilities).toHaveLength(12);
  expect(row.tags).toHaveLength(12);
  expect(matched.omitted).toBe(0);
  expect(matched.state).toBe('completed');
});
