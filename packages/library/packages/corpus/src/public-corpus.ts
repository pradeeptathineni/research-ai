import { readFile, realpath, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { relative, resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { default as formats } from 'ajv-formats';
import { readPublicRecord } from './public-record.js';
import { assessSignalQuality, signalReviewSchema } from '../../domain/src/signal-quality.js';
import {
  projectPublicOptions,
  type PublicAdmission,
  type PublicOption,
} from '../../domain/src/public-corpus.js';

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'admissions'],
  properties: {
    schemaVersion: { const: 1 },
    admissions: {
      type: 'array',
      maxItems: 1000,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'file',
          'digest',
          'category',
          'reviewedAt',
          'reviewer',
          'rationale',
          'claimReviews',
        ],
        properties: {
          file: { type: 'string', pattern: '^(?:[a-z0-9-]+/){0,3}[a-z0-9-]+\\.(?:json|md)$' },
          digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          category: { type: 'string', minLength: 1, maxLength: 120 },
          reviewedAt: { type: 'string', format: 'date-time' },
          reviewer: { enum: ['human', 'agent-reviewed'] },
          rationale: { type: 'string', minLength: 1, maxLength: 2000 },
          claimReviews: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['claimId', 'basis', 'reviewAfterDays'],
              properties: {
                claimId: { type: 'string', minLength: 1 },
                basis: { enum: ['stable', 'volatile', 'unknown'] },
                reviewAfterDays: { type: ['integer', 'null'], minimum: 1, maximum: 3650 },
              },
            },
          },
          state: { enum: ['admitted', 'withdrawn'] },
          quality: signalReviewSchema,
        },
      },
    },
  },
};
const ajv = new Ajv2020({ allErrors: true, strict: true });
(formats as unknown as (instance: Ajv2020) => void)(ajv);
const validate = ajv.compile<{ schemaVersion: 1; admissions: PublicAdmission[] }>(schema);
const defaultRoot = fileURLToPath(new URL('../../../signals/', import.meta.url));

export async function loadPublicCorpus(root = defaultRoot, asOf = new Date().toISOString()) {
  if (!Number.isFinite(Date.parse(asOf))) throw new Error('Invalid freshness evaluation date.');
  const rootPath = await realpath(root);
  const records = new Map<string, Awaited<ReturnType<typeof readPublicRecord>>>();
  async function collect(directory: string, depth = 0) {
    if (depth > 1)
      throw new Error('Signals use one type folder; domains and tags belong in metadata.');
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error('Record escapes Corpus or introduces an ambiguous symlink.');
      if (entry.isDirectory()) {
        if (!/^[a-z][a-z0-9-]{0,39}$/.test(entry.name))
          throw new Error('Invalid signal type folder.');
        await collect(path, depth + 1);
      } else if (depth === 1 && entry.name.endsWith('.json')) {
        if (records.size >= 1000) throw new Error('Corpus exceeds record limit.');
        const file = relative(rootPath, path).replace(/\\/g, '/');
        if (file.startsWith('entities/')) continue;
        records.set(file, await readPublicRecord(await readFile(path, 'utf8'), file));
      } else if (!(directory === rootPath && entry.name === 'README.md')) {
        throw new Error('Unexpected Corpus file; drafts stay outside the public collection.');
      }
    }
  }
  await collect(rootPath);
  if (!records.size) throw new Error('Empty canonical Corpus cannot replace published knowledge.');
  const manifest: unknown = {
    schemaVersion: 1,
    admissions: [...records.values()].map((record) => record.admission),
  };
  if (!validate(manifest)) throw new Error('Public admission manifest schema mismatch.');
  const bundles = [];
  const options: PublicOption[] = [];
  const identities = new Set<string>();
  const files = new Set<string>();
  for (const admission of manifest.admissions) {
    if (files.has(admission.file)) throw new Error('Duplicate public admission.');
    files.add(admission.file);
    const { bytes, bundle } = records.get(admission.file)!;
    if (!/^[a-zA-Z0-9-]+$/.test(bundle.bundle_id)) throw new Error('Unsafe public download name.');
    // The interchange permits inert metadata; the public collection does not.
    // Review plus this closed field boundary replaces regex-only publication checks.
    if (bundle.extensions || bundle.candidates.some((candidate) => candidate.signal))
      throw new Error('Public fields disallow extensions and candidate signals.');
    if (bundle.need.constraints?.length)
      throw new Error('Consumer constraints are not public Corpus fields.');
    if (identities.has(bundle.bundle_id)) throw new Error('Duplicate public bundle identity.');
    identities.add(bundle.bundle_id);
    const reviews = admission.claimReviews;
    if (
      new Set(reviews.map((r) => r.claimId)).size !== reviews.length ||
      reviews.length !== bundle.claims.length ||
      reviews.some(
        (r) =>
          !bundle.claims.some((c) => c.id === r.claimId) ||
          (r.basis === 'volatile' ? r.reviewAfterDays === null : r.reviewAfterDays !== null),
      )
    )
      throw new Error('Every claim requires one consistent freshness assessment.');
    if (Date.parse(admission.reviewedAt) > Date.parse(asOf))
      throw new Error('Public review date is in the future.');
    for (const candidate of bundle.candidates) {
      if (identities.has(candidate.id)) throw new Error('Duplicate public option identity.');
      identities.add(candidate.id);
    }
    bundles.push({ bundle, admission, bytes });
    const quality = admission.quality
      ? assessSignalQuality(bundle, admission.digest, admission.quality)
      : null;
    if (admission.quality && Date.parse(admission.quality.reviewedAt) > Date.parse(asOf))
      throw new Error('Signal review date is in the future.');
    if (admission.state !== 'withdrawn') {
      const projected = projectPublicOptions(bundle, admission, asOf);
      if (!quality || quality.some((option) => option.level !== 'high'))
        throw new Error(
          'Automatic Corpus admission requires a separate high-signal review of every option.',
        );
      options.push(
        ...projected.map((option) => ({
          ...option,
          ...(quality ? { quality: quality.find((item) => item.optionId === option.id)! } : {}),
        })),
      );
    }
  }
  return { bundles, options };
}
