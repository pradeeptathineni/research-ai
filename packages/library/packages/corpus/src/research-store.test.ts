import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { saveQuery, admitRecord } from './research-store.js';
import { encodePublicEvidence } from './public-record.js';
import { loadPublicCorpus } from './public-corpus.js';
import type { EvidenceBundle } from '../../domain/src/evidence-exchange.js';
import type { PublicAdmission } from '../../domain/src/public-corpus.js';
import type { SignalReview } from '../../domain/src/signal-quality.js';
const folders: string[] = [];
async function temp() {
  const p = await mkdtemp(join(tmpdir(), 'signals-files-'));
  folders.push(p);
  return realpath(p);
}
afterEach(async () => {
  for (const p of folders.splice(0)) await rm(p, { recursive: true, force: true });
});
it('saves private questions without touching public knowledge and refuses symlink storage', async () => {
  const root = await temp();
  const file = await saveQuery({ question: 'Private project planning' }, join(root, 'queries'));
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
    result: { question: 'Private project planning' },
  });
  await symlink(join(root, 'queries'), join(root, 'alias'));
  await expect(saveQuery({}, join(root, 'alias'))).rejects.toThrow('symlink');
});
it('refuses unreviewed admission and preserves every old published file', async () => {
  const root = await temp();
  await mkdir(join(root, 'practices'));
  const original = await readFile('signals/practices/water-leaks.json', 'utf8');
  await writeFile(join(root, 'practices', 'existing.json'), original);
  const next = JSON.parse(original);
  next.evidence.bundle_id = 'new-draft';
  next.evidence.candidates[0].id = 'new-option';
  delete next.review.quality;
  const bytes = JSON.stringify(next.evidence, null, 2) + '\n';
  next.encoding = 'pretty-json-v1';
  next.review.digest = createHash('sha256').update(bytes).digest('hex');
  await expect(admitRecord(JSON.stringify(next), 'practices', root)).rejects.toThrow(
    'separate high-signal',
  );
  expect(await readFile(join(root, 'practices', 'existing.json'), 'utf8')).toBe(original);
});

async function successor(bundleId: string, optionId: string) {
  const record = JSON.parse(await readFile('signals/practices/water-leaks.json', 'utf8')) as {
    encoding: string;
    evidence: EvidenceBundle;
    review: PublicAdmission & { quality: SignalReview };
  };
  record.evidence.bundle_id = bundleId;
  record.evidence.candidates[0]!.id = optionId;
  record.review.digest = createHash('sha256')
    .update(await encodePublicEvidence(record.evidence, record.encoding))
    .digest('hex');
  record.review.quality.evidenceDigest = record.review.digest;
  record.review.quality.options[0]!.optionId = optionId;
  return record;
}
it('rejects cross-kind identity collisions and concurrent writers without altering old bytes', async () => {
  const root = await temp();
  await mkdir(join(root, 'practices'));
  const original = await readFile('signals/practices/water-leaks.json', 'utf8');
  await writeFile(join(root, 'practices', 'existing.json'), original);
  const existing = JSON.parse(original);
  await expect(
    admitRecord(
      JSON.stringify(await successor(existing.evidence.candidates[0].id, 'distinct-option')),
      'practices',
      root,
    ),
  ).rejects.toThrow('immutable');
  await expect(
    admitRecord(
      JSON.stringify(await successor('distinct-bundle', existing.evidence.bundle_id)),
      'practices',
      root,
    ),
  ).rejects.toThrow('immutable');
  const raw = JSON.stringify(await successor('valid-next', 'valid-next-option'));
  const results = await Promise.allSettled([
    admitRecord(raw, 'practices', root),
    admitRecord(raw, 'practices', root),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect((await loadPublicCorpus(root)).bundles).toHaveLength(2);
  expect(await readFile(join(root, 'practices', 'existing.json'), 'utf8')).toBe(original);
});
it('validates aggregate limits before publishing and refuses expired automatic admissions', async () => {
  const root = await temp();
  await mkdir(join(root, 'practices'));
  const template = await successor('template', 'template-option');
  template.encoding = 'pretty-json-v1';
  template.review.state = 'withdrawn';
  await Promise.all(
    Array.from({ length: 1000 }, async (_, i) => {
      const record = structuredClone(template);
      record.evidence.bundle_id = `old-${i}`;
      record.evidence.candidates[0]!.id = `old-option-${i}`;
      record.review.digest = createHash('sha256')
        .update(await encodePublicEvidence(record.evidence, record.encoding))
        .digest('hex');
      record.review.quality.evidenceDigest = record.review.digest;
      record.review.quality.options[0]!.optionId = `old-option-${i}`;
      await writeFile(join(root, 'practices', `${i}.json`), JSON.stringify(record));
    }),
  );
  await expect(
    admitRecord(JSON.stringify(await successor('too-many', 'too-many-option')), 'practices', root),
  ).rejects.toThrow('record limit');
  expect((await loadPublicCorpus(root)).bundles).toHaveLength(1000);
  const expired = await successor('expired', 'expired-option');
  expired.review.claimReviews[0] = {
    claimId: expired.evidence.claims[0]!.id,
    basis: 'volatile',
    reviewAfterDays: 1,
  };
  for (const source of expired.evidence.sources) source.observed_at = '2020-01-01T00:00:00Z';
  expired.review.digest = createHash('sha256')
    .update(await encodePublicEvidence(expired.evidence, expired.encoding))
    .digest('hex');
  expired.review.quality.evidenceDigest = expired.review.digest;
  const freshRoot = await temp();
  await mkdir(join(freshRoot, 'practices'));
  await writeFile(
    join(freshRoot, 'practices', 'original.json'),
    await readFile('signals/practices/water-leaks.json', 'utf8'),
  );
  await expect(admitRecord(JSON.stringify(expired), 'practices', freshRoot)).rejects.toThrow(
    'freshness',
  );
  const priorDueRoot = await temp();
  await mkdir(join(priorDueRoot, 'practices'));
  await writeFile(join(priorDueRoot, 'practices', 'old-due.json'), JSON.stringify(expired));
  expect((await loadPublicCorpus(priorDueRoot)).options[0]!.claims[0]!.freshness).toBe('due');
  await expect(
    admitRecord(
      JSON.stringify(await successor('fresh-successor', 'fresh-successor-option')),
      'practices',
      priorDueRoot,
    ),
  ).resolves.toBeTruthy();
  expect((await loadPublicCorpus(priorDueRoot)).bundles).toHaveLength(2);
}, 20_000);
