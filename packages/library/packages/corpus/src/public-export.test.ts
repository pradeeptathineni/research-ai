import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import type * as Fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { loadPublicCorpus } from './public-corpus.js';
import { publishPublicData } from './public-export.js';
import { parsePublicIndex } from '../../domain/src/public-index.js';
import { refreshPublicFreshness } from '../../domain/src/public-corpus.js';
import {
  previewPublicData,
  reviewPublicDataPreview,
  exportReviewedPublicData,
} from './public-export.js';
import { evidenceDigest } from '../../domain/src/evidence-exchange.js';
import { assessEntity } from '../../domain/src/search-score.js';
import { entityIdentity } from './signal-search.js';
import { validateEntity, type StoredEntity } from './search-store.js';

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

it('previews exact synthetic public bytes, binds review to that digest and exports byte-identically offline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'signals-public-preview-'));
  const destination = await mkdtemp(join(tmpdir(), 'signals-public-reviewed-export-'));
  directories.push(root, destination);
  await mkdir(join(root, 'practices'));
  const bundle = {
    schema_version: 1 as const,
    bundle_id: 'synthetic-preview',
    mode: 'offline-curated' as const,
    created_at: '2026-10-01T00:00:00.000Z',
    producer: {
      repository: 'https://example.org/synthetic',
      commit: 'a'.repeat(40),
      protocol: 'signals-evidence-v1',
    },
    need: { query: 'synthetic publication preview' },
    sources: [
      {
        id: 'source:synthetic',
        uri: 'https://example.org/source',
        title: 'Synthetic source',
        source_class: 'documentation',
        observed_at: '2026-10-01T00:00:00.000Z',
      },
    ],
    claims: [
      {
        id: 'claim:synthetic',
        text: 'Synthetic claim for byte preview.',
        source_ids: ['source:synthetic'],
        status: 'observed' as const,
      },
    ],
    candidates: [
      {
        id: 'option:synthetic',
        name: 'Synthetic option',
        canonical_uri: 'https://example.org/option',
        claim_ids: ['claim:synthetic'],
        disposition: 'consider' as const,
        reason: 'Synthetic-only fixture.',
        limitations: [],
      },
    ],
    limitations: ['Synthetic preview data; not a public finding.'],
  };
  const bundleBytes = `${JSON.stringify(bundle, null, 2)}\n`;
  const digest = evidenceDigest(bundleBytes);
  const record = {
    recordVersion: 1,
    encoding: 'pretty-json-v1',
    evidence: bundle,
    review: {
      digest,
      category: 'Synthetic',
      reviewedAt: '2026-10-02T00:00:00.000Z',
      reviewer: 'human',
      rationale: 'Synthetic test record.',
      claimReviews: [{ claimId: 'claim:synthetic', basis: 'unknown', reviewAfterDays: null }],
      state: 'withdrawn',
    },
  };
  await writeFile(join(root, 'practices/synthetic.json'), JSON.stringify(record));
  const publicCorpus = await loadPublicCorpus(root, '2026-10-03T00:00:00.000Z');

  const uri = 'https://example.org/synthetic-tool';
  const base = {
    id: entityIdentity(uri),
    uri,
    name: 'Synthetic saved entity',
    kind: 'software' as const,
    identity: 'resolved' as const,
    aliases: [],
    description: 'Synthetic entity body.',
    facets: {
      domains: [],
      capabilities: [],
      interfaces: [],
      deliveryForms: [],
      platforms: [],
      licenses: [],
      tags: [],
    },
    observations: [],
    limits: [],
    evidence: [],
  };
  const entity = validateEntity({
    ...base,
    assessment: assessEntity(base, '2026-10-03T00:00:00.000Z', 'signal-strength-v10'),
  });
  const entities: StoredEntity[] = [{ recordVersion: 2, state: 'user-saved', entity }];
  await mkdir(join(destination, '.signals'));
  await writeFile(
    join(destination, '.signals/private.json'),
    'PRIVATE PROJECT AND ANNOTATION SENTINEL',
  );

  const preview = previewPublicData(publicCorpus, entities);
  const paths = preview.artifacts.map(({ path }) => path);
  expect(paths).toEqual([
    'corpus.json',
    'entities.json',
    'library.json',
    'bundles/synthetic-preview.json',
    'bundles/synthetic-preview.json.sha256',
  ]);
  expect(
    preview.artifacts.every(
      (artifact) => artifact.bytes.length > 0 && /^[a-f0-9]{64}$/.test(artifact.sha256),
    ),
  ).toBe(true);
  expect(preview.artifacts.find((artifact) => artifact.path === 'entities.json')!.bytes).toContain(
    entity.id,
  );
  expect(preview.artifacts.some((artifact) => artifact.bytes.includes('PRIVATE PROJECT'))).toBe(
    false,
  );
  expect(() =>
    previewPublicData(publicCorpus, [
      {
        ...entities[0]!,
        entity: { ...entity, privateAnnotation: 'must not export' },
      } as unknown as StoredEntity,
    ]),
  ).toThrow('invalid_entity_schema');
  expect(preview.qualifications.join(' ')).toMatch(/truth|rights/);
  expect(() =>
    reviewPublicDataPreview(preview, {
      confirmedSha256: '0'.repeat(64),
      reviewer: 'human',
      reviewedAt: '2026-10-03T00:00:00Z',
    }),
  ).toThrow(/exact preview digest/);
  const review = reviewPublicDataPreview(preview, {
    confirmedSha256: preview.sha256,
    reviewer: 'synthetic reviewer',
    reviewedAt: '2026-10-03T00:00:00Z',
  });
  const changedEntity = structuredClone(entities);
  changedEntity[0]!.entity.description = 'Changed after review.';
  await expect(
    exportReviewedPublicData(publicCorpus, destination, changedEntity, review),
  ).rejects.toThrow('changed after review');

  const exported = await exportReviewedPublicData(publicCorpus, destination, entities, review);
  expect(exported.previewSha256).toBe(preview.sha256);
  const pointer = join(destination, 'public-data');
  for (const artifact of preview.artifacts) {
    const actual = await readFile(join(pointer, artifact.path), 'utf8');
    expect(actual).toBe(artifact.bytes);
    expect(evidenceDigest(actual)).toBe(artifact.sha256);
  }
  expect(await readFile(join(destination, '.signals/private.json'), 'utf8')).toContain(
    'PRIVATE PROJECT',
  );
  expect(await readFile(join(pointer, 'entities.json'), 'utf8')).not.toContain('PRIVATE PROJECT');
});
