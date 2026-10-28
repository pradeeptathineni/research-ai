import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { loadPublicCorpus } from './public-corpus.js';
import { readPublicRecord } from './public-record.js';

it('retains every original pinned evidence digest across the single-record conversion', async () => {
  const { bundles, options } = await loadPublicCorpus();
  const original = [
    '97fe5e2d70ac2ae81d48db973e4ecb019e6063e2813b0c0ec535b43fbe73d483',
    '6eefcce2c06067efdeb601376502391f57a07690dc5904fb58f0abf9e164818f',
  ];
  for (const digest of original)
    expect(bundles.some((record) => record.admission.digest === digest)).toBe(true);
  expect(new Set(options.map((option) => option.type))).toEqual(
    new Set(['practices', 'standards', 'tools']),
  );
});

it('rejects extra authority fields, duplicate keys and unpinned data', async () => {
  const raw = await readFile('signals/practices/git-history.json', 'utf8');
  const record = JSON.parse(raw);
  for (const bytes of [
    JSON.stringify({ ...record, workspace: 'private' }),
    raw.replace('"recordVersion": 1', '"recordVersion": 1, "recordVersion": 1'),
    JSON.stringify({ ...record, review: { ...record.review, file: '../../outside.json' } }),
    JSON.stringify({ ...record, evidence: { ...record.evidence, mode: 'fixture' } }),
  ])
    await expect(readPublicRecord(bytes, 'practices/git-history.json')).rejects.toThrow();
});

it('refuses mixed masters, unknown files and an accidental empty publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'signals-record-boundary-'));
  try {
    await mkdir(join(root, 'practices'));
    await writeFile(
      join(root, 'practices/git.json'),
      await readFile('signals/practices/git-history.json'),
    );
    await writeFile(join(root, 'manifest.json'), '{"schemaVersion":1,"admissions":[]}');
    await expect(loadPublicCorpus(root)).rejects.toThrow('Unexpected');
    await rm(join(root, 'manifest.json'));
    await writeFile(join(root, 'draft.md'), 'Unreviewed prose.');
    await expect(loadPublicCorpus(root)).rejects.toThrow('Unexpected');
    await rm(join(root, 'draft.md'));
    await rm(join(root, 'practices/git.json'));
    await expect(loadPublicCorpus(root)).rejects.toThrow('Empty');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('withdraws visibility without changing the earlier consumer download', async () => {
  const root = await mkdtemp(join(tmpdir(), 'signals-record-withdrawal-'));
  try {
    await mkdir(join(root, 'practices'));
    const raw = await readFile('signals/practices/git-history.json', 'utf8');
    const prior = await readPublicRecord(raw, 'practices/git.json');
    const record = JSON.parse(raw);
    record.review.state = 'withdrawn';
    await writeFile(join(root, 'practices/git.json'), JSON.stringify(record));
    const withdrawn = await loadPublicCorpus(root);
    expect(withdrawn.options).toEqual([]);
    expect(withdrawn.bundles[0]!.bytes).toBe(prior.bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
