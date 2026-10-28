import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import type * as Fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { loadPublicCorpus } from './public-corpus.js';
import { publishPublicData } from './public-export.js';
import { parsePublicIndex } from '../../domain/src/public-index.js';
import { refreshPublicFreshness } from '../../domain/src/public-corpus.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof Fs>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
const directories: string[] = [];
afterEach(async () => {
  vi.mocked(writeFile).mockReset();
  const actual = await vi.importActual<typeof Fs>('node:fs/promises');
  vi.mocked(writeFile).mockImplementation(actual.writeFile);
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

it('keeps the prior exact export if a sidecar write fails halfway through staging', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'signals-export-test-'));
  directories.push(directory);
  const corpus = await loadPublicCorpus();
  await publishPublicData(corpus, directory);
  const pointer = join(directory, 'public-data');
  const prior = await realpath(pointer);
  const bytes = await readFile(join(pointer, 'corpus.json'), 'utf8');
  const actual = await vi.importActual<typeof Fs>('node:fs/promises');
  vi.mocked(writeFile).mockImplementation(async (path, data, options) => {
    if (typeof path === 'string' && path.endsWith('.sha256'))
      throw new Error('Injected interrupted sidecar write');
    return actual.writeFile(path, data, options);
  });
  await expect(publishPublicData(corpus, directory)).rejects.toThrow('interrupted');
  expect(await realpath(pointer)).toBe(prior);
  expect(await readFile(join(pointer, 'corpus.json'), 'utf8')).toBe(bytes);
  expect(parsePublicIndex(JSON.parse(bytes)).map((o) => o.id)).toEqual(
    corpus.options.map((o) => o.id),
  );
});

it('rejects incomplete, private, unsafe and mismatched public projections', async () => {
  const { options } = await loadPublicCorpus();
  for (const update of [
    { concepts: undefined },
    { workspace: 'not a public field' },
    { uri: 'javascript:alert(1)' },
    { bundleId: 'unsafe/name' },
    { claims: [{ ...options[0]!.claims[0], source_ids: ['missing'] }] },
  ])
    expect(() => parsePublicIndex([{ ...options[0], ...update }])).toThrow();
  expect(() => parsePublicIndex([options[0], options[0]])).toThrow('Duplicate');
  expect(() =>
    parsePublicIndex([{ ...options[0], quality: { ...options[0]!.quality!, score: 100 } }]),
  ).toThrow('calculation');
  expect(() =>
    parsePublicIndex([{ ...options[0], quality: { ...options[0]!.quality!, optionId: 'other' } }]),
  ).toThrow('binding');
  expect(
    refreshPublicFreshness(options, '2030-01-01T00:00:00Z').find(
      (o) => o.id === 'option-test-isolation-revision2',
    )!.claims[0]!.freshness,
  ).toBe('due');
});

it('preserves an existing directory rather than attempting a non-atomic conversion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'signals-export-existing-'));
  directories.push(directory);
  await mkdir(join(directory, 'public-data'));
  await writeFile(join(directory, 'public-data', 'prior.json'), 'retained output');
  await expect(publishPublicData(await loadPublicCorpus(), directory)).rejects.toThrow(
    'preserved or moved',
  );
  expect(await readFile(join(directory, 'public-data', 'prior.json'), 'utf8')).toBe(
    'retained output',
  );
});

it('builds the library only from approved public inputs, independently of private collection state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'signals-public-library-'));
  directories.push(directory);
  await mkdir(join(directory, '.signals'));
  await writeFile(
    join(directory, '.signals', 'library-state.json'),
    JSON.stringify({
      secret: 'PRIVATE NOTE AND PROJECT CONTEXT',
    }),
  );
  const corpus = await loadPublicCorpus();
  await publishPublicData(corpus, directory);
  const bytes = await readFile(join(directory, 'public-data', 'library.json'), 'utf8');
  const library = JSON.parse(bytes) as { id: string; origin: { destination: string } }[];
  expect(library.map((finding) => finding.id)).toEqual(corpus.options.map((option) => option.id));
  expect(library.every((finding) => finding.origin.destination === 'public')).toBe(true);
  expect(bytes).not.toContain('PRIVATE NOTE');
  expect(bytes).not.toContain('.signals');
});
