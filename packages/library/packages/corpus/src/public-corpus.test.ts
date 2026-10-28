import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { evidenceDigest } from '../../domain/src/evidence-exchange.js';
import { claimFreshness, filterPublicOptions } from '../../domain/src/public-corpus.js';
import { loadPublicCorpus } from './public-corpus.js';
import { encodePublicEvidence } from './public-record.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function copyRecord(change: (bundle: Record<string, unknown>) => void = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'signals-public-test-'));
  directories.push(root);
  const corpus = await loadPublicCorpus();
  const original = corpus.bundles[0]!;
  const record = JSON.parse(await readFile(join('signals', original.admission.file), 'utf8'));
  const bundle = record.evidence;
  change(bundle);
  const bytes = await encodePublicEvidence(bundle, record.encoding);
  record.review.digest = evidenceDigest(bytes);
  record.review.quality.evidenceDigest = record.review.digest;
  const file = join(root, 'practices', 'record.json');
  await mkdir(join(root, 'practices'));
  await writeFile(file, JSON.stringify(record));
  return { root, file, record };
}

it('finds real reviewed options using combined exact filters and literal text', async () => {
  const { options } = await loadPublicCorpus();
  expect(
    filterPublicOptions(options, {
      query: 'water meter',
      category: 'Household',
      sourceClass: 'guidance',
    }).map((o) => o.id),
  ).toEqual(['option-water-leaks']);
  expect(filterPublicOptions(options, { query: 'water', category: 'Writing' })).toEqual([]);
  expect(filterPublicOptions(options, { concept: 'data.lineage' }).map((o) => o.id)).toEqual([
    'option-source-lineage',
  ]);
  expect(
    filterPublicOptions(options, { githubOnly: true }).every(
      (option) => new URL(option.uri).hostname === 'github.com',
    ),
  ).toBe(true);
});

it('rejects private metadata, fixture promotion, ambiguous identities and incomplete review', async () => {
  for (const change of [
    (b: Record<string, unknown>) => {
      b.extensions = { 'local.notes': 'Private context that no regex recognizes' };
    },
    (b: Record<string, unknown>) => {
      b.mode = 'fixture';
    },
  ]) {
    const { root } = await copyRecord(change);
    await expect(loadPublicCorpus(root)).rejects.toThrow();
  }
  const { root, file, record } = await copyRecord();
  const original = JSON.stringify(record);
  record.review.claimReviews = [];
  await writeFile(file, JSON.stringify(record));
  await expect(loadPublicCorpus(root)).rejects.toThrow('freshness assessment');
  await writeFile(file, original);
  await writeFile(join(root, 'practices', 'duplicate.json'), original);
  await expect(loadPublicCorpus(root)).rejects.toThrow('Duplicate');
});

it('rejects interrupted or tampered bytes and file paths escaping the reviewed directory', async () => {
  const { root, file, record } = await copyRecord();
  record.evidence.mode = 'fixture';
  await writeFile(file, JSON.stringify(record));
  await expect(loadPublicCorpus(root)).rejects.toThrow('digest mismatch');
  await writeFile(file, (await readFile(file, 'utf8')).slice(0, -4));
  await expect(loadPublicCorpus(root)).rejects.toThrow();
  await rm(file);
  const outside = await mkdtemp(join(tmpdir(), 'signals-public-outside-'));
  directories.push(outside);
  await writeFile(join(outside, 'record.json'), '{}');
  await symlink(join(outside, 'record.json'), file);
  await expect(loadPublicCorpus(root)).rejects.toThrow('escapes Corpus');
});

it('keeps freshness tied to source observation and claim volatility', async () => {
  const { bundles } = await loadPublicCorpus();
  const { bundle } = bundles[0]!;
  const claim = bundle.claims[0]!;
  const sources = bundle.sources.map((s) => ({ ...s, observed_at: '2020-01-01T00:00:00Z' }));
  expect(
    claimFreshness(
      claim,
      sources,
      { claimId: claim.id, basis: 'stable', reviewAfterDays: null },
      '2026-10-05T21:00:00Z',
    ),
  ).toBe('current');
  expect(
    claimFreshness(
      claim,
      sources,
      { claimId: claim.id, basis: 'volatile', reviewAfterDays: 30 },
      '2026-10-05T21:00:00Z',
    ),
  ).toBe('due');
  expect(
    claimFreshness(
      claim,
      sources.map((s) => ({ ...s, observed_at: null })),
      { claimId: claim.id, basis: 'stable', reviewAfterDays: null },
      '2026-10-05T21:00:00Z',
    ),
  ).toBe('unknown');
});

it('reads due evidence with visible dates without disabling unrelated knowledge', async () => {
  const corpus = await loadPublicCorpus(undefined, '2030-01-01T00:00:00Z');
  expect(
    corpus.options.some((option) => option.claims.some((claim) => claim.freshness === 'due')),
  ).toBe(true);
  expect(
    corpus.options.some((option) => option.claims.every((claim) => claim.freshness === 'current')),
  ).toBe(true);
});
