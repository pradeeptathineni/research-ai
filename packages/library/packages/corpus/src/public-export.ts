import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rename, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { loadPublicCorpus } from './public-corpus.js';
import { parsePublicIndex } from '../../domain/src/public-index.js';
import { parseEvidenceBundle } from '../../domain/src/evidence-exchange.js';
import { validateEntity, type StoredEntity } from './search-store.js';
import { projectLegacyLibrary, projectNativeLibrary } from '../../domain/src/library-search.js';

const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.keys(value)
          .sort()
          .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
          .map(
            (key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
          )
          .join(',')}}`
      : JSON.stringify(value);
const previewQualifications = [
  'Preview inputs are the validated public Corpus object and the explicit saved-entity array only.',
  'Private annotations, project records, credentials, caches and local .signals state are not read by this workflow.',
  'Source occurrence, claim truth, freshness beyond the supplied policy result, and legal publication rights are not certified here.',
  'Inspect the included bytes and qualifications before reviewing this exact digest; review is a caller assertion, not authenticated identity.',
];

interface PublicArtifact {
  path: string;
  bytes: string;
  sha256: string;
  byteLength: number;
  sourceRefs: string[];
  qualification: string;
}
type PublicArtifactDraft = Pick<PublicArtifact, 'path' | 'bytes' | 'sourceRefs' | 'qualification'>;

export interface PublicDataPreview {
  format: 'signals-public-data-preview-v1';
  artifacts: PublicArtifact[];
  qualifications: string[];
  sha256: string;
}

export interface PublicDataReview {
  format: 'signals-public-data-review-v1';
  previewSha256: string;
  reviewer: string;
  reviewedAt: string;
  sha256: string;
}

function validateEntities(entities: StoredEntity[]): StoredEntity[] {
  if (!Array.isArray(entities)) throw new Error('Public entities must be an explicit array.');
  const ids = new Set<string>();
  return entities.map((record) => {
    if (
      !record ||
      typeof record !== 'object' ||
      Array.isArray(record) ||
      Object.keys(record).sort().join(',') !== 'entity,recordVersion,state' ||
      record.recordVersion !== 2 ||
      !['user-saved', 'eligible-saved'].includes(record.state)
    )
      throw new Error('Invalid public entity record.');
    const entity = validateEntity(record.entity);
    if (ids.has(entity.id)) throw new Error('Duplicate public entity identity.');
    ids.add(entity.id);
    return { recordVersion: 2, state: record.state, entity };
  });
}

function publicArtifacts(
  corpus: Awaited<ReturnType<typeof loadPublicCorpus>>,
  entityInput: StoredEntity[],
): PublicArtifact[] {
  parsePublicIndex(corpus.options);
  const entities = validateEntities(entityInput);
  const bundles = corpus.bundles.map(({ bundle, admission, bytes }) => {
    if (!/^[a-zA-Z0-9-]+$/.test(bundle.bundle_id)) throw new Error('Unsafe public download name.');
    const parsed = parseEvidenceBundle(bytes, admission.digest);
    if (parsed.bundle_id !== bundle.bundle_id)
      throw new Error('Public bundle bytes do not match their identity.');
    return { bundle, admission, bytes };
  });
  const library = [
    ...entities.map((record) => projectNativeLibrary(record, 'public')),
    ...corpus.options.map(projectLegacyLibrary),
  ];
  const artifacts: PublicArtifactDraft[] = [
    {
      path: 'corpus.json',
      bytes: `${JSON.stringify(corpus.options, null, 2)}\n`,
      sourceRefs: corpus.options.map((option) => `public-option:${option.id}`),
      qualification:
        'Derived only from the validated public Corpus option projection; freshness and claim qualifications remain as supplied.',
    },
    {
      path: 'entities.json',
      bytes: `${JSON.stringify(entities, null, 2)}\n`,
      sourceRefs: entities.map(({ entity }) => `native-entity:${entity.id}`),
      qualification:
        'Contains only the explicitly supplied, closed-schema saved entity records; no private annotations, project records, or .signals directory is read.',
    },
    {
      path: 'library.json',
      bytes: `${JSON.stringify(library, null, 2)}\n`,
      sourceRefs: library.map((finding) => finding.key),
      qualification:
        'Derived only from the validated public Corpus options and explicitly supplied saved entities; no private annotation or project projection is included.',
    },
  ];
  for (const { bundle, admission, bytes } of bundles) {
    const base = `bundles/${bundle.bundle_id}.json`;
    const refs = [
      `public-bundle:${bundle.bundle_id}@${admission.digest}`,
      ...bundle.sources.map((source) => `source:${source.id}`),
      ...bundle.claims.map((claim) => `claim:${claim.id}`),
    ];
    artifacts.push({
      path: base,
      bytes,
      sourceRefs: refs,
      qualification:
        'Exact validated public bundle bytes; cited source metadata and claims are retained as authored and are not independently certified by export.',
    });
    artifacts.push({
      path: `${base}.sha256`,
      bytes: `${admission.digest}\n`,
      sourceRefs: [`public-bundle:${bundle.bundle_id}@${admission.digest}`],
      qualification: 'Digest sidecar from the public admission record.',
    });
  }
  const paths = new Set<string>();
  return artifacts.map((artifact) => {
    if (paths.has(artifact.path)) throw new Error('Duplicate public artifact path.');
    paths.add(artifact.path);
    return {
      ...artifact,
      sha256: hash(artifact.bytes),
      byteLength: Buffer.byteLength(artifact.bytes, 'utf8'),
    };
  });
}

function previewDigest(value: Omit<PublicDataPreview, 'sha256'>): string {
  return hash(
    canonical({
      format: value.format,
      artifacts: value.artifacts.map(({ path, sha256, byteLength, sourceRefs, qualification }) => ({
        path,
        sha256,
        byteLength,
        sourceRefs,
        qualification,
      })),
      qualifications: value.qualifications,
    }),
  );
}

function verifyPreview(preview: PublicDataPreview) {
  if (
    !preview ||
    preview.format !== 'signals-public-data-preview-v1' ||
    !Array.isArray(preview.artifacts) ||
    !Array.isArray(preview.qualifications) ||
    !/^[a-f0-9]{64}$/.test(preview.sha256) ||
    preview.artifacts.some(
      (artifact) =>
        hash(artifact.bytes) !== artifact.sha256 ||
        Buffer.byteLength(artifact.bytes, 'utf8') !== artifact.byteLength,
    ) ||
    previewDigest(preview) !== preview.sha256
  )
    throw new Error('Invalid or modified public preview.');
}

/** Exact deterministic output bytes and their source/privacy qualifications, without filesystem writes. */
export function previewPublicData(
  corpus: Awaited<ReturnType<typeof loadPublicCorpus>>,
  entities: StoredEntity[] = [],
): PublicDataPreview {
  const value = {
    format: 'signals-public-data-preview-v1' as const,
    artifacts: publicArtifacts(corpus, entities),
    qualifications: previewQualifications,
  };
  return { ...value, sha256: previewDigest(value) };
}

/** Records explicit acknowledgement of the precise bytes and qualifications shown in a preview. */
export function reviewPublicDataPreview(
  preview: PublicDataPreview,
  input: { confirmedSha256: string; reviewer: string; reviewedAt: string },
): PublicDataReview {
  verifyPreview(preview);
  if (
    !input ||
    input.confirmedSha256 !== preview.sha256 ||
    typeof input.reviewer !== 'string' ||
    !input.reviewer.trim() ||
    input.reviewer.length > 120 ||
    /[\r\n\p{Cc}]/u.test(input.reviewer) ||
    typeof input.reviewedAt !== 'string' ||
    !Number.isFinite(Date.parse(input.reviewedAt))
  )
    throw new Error(
      'Review must identify the exact preview digest, reviewer label and valid review time.',
    );
  const value = {
    format: 'signals-public-data-review-v1' as const,
    previewSha256: preview.sha256,
    reviewer: input.reviewer,
    reviewedAt: input.reviewedAt,
  };
  return { ...value, sha256: hash(canonical(value)) };
}

async function writePublicArtifacts(artifacts: PublicArtifact[], directory: string) {
  await mkdir(directory, { recursive: true });
  const pointer = join(resolve(directory), 'public-data');
  const prior = await lstat(pointer).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (prior && !prior.isSymbolicLink())
    throw new Error('Existing public-data directory must be preserved or moved before building.');
  const staging = await mkdtemp(join(resolve(directory), 'public-snapshot-'));
  await mkdir(join(staging, 'bundles'));
  for (const artifact of artifacts) {
    const path = join(staging, artifact.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, artifact.bytes);
  }
  const next = `${staging}.pointer`;
  await symlink(staging, next, 'dir');
  await rename(next, pointer);
}

/** Local reviewed export of precisely the same bytes shown in preview; no Git or remote action occurs. */
export async function exportReviewedPublicData(
  corpus: Awaited<ReturnType<typeof loadPublicCorpus>>,
  directory: string,
  entities: StoredEntity[],
  review: PublicDataReview,
) {
  if (
    !review ||
    review.format !== 'signals-public-data-review-v1' ||
    Object.keys(review).sort().join(',') !== 'format,previewSha256,reviewedAt,reviewer,sha256' ||
    !/^[a-f0-9]{64}$/.test(review.previewSha256) ||
    !/^[a-f0-9]{64}$/.test(review.sha256) ||
    typeof review.reviewer !== 'string' ||
    !review.reviewer.trim() ||
    review.reviewer.length > 120 ||
    /[\r\n\p{Cc}]/u.test(review.reviewer) ||
    typeof review.reviewedAt !== 'string' ||
    !Number.isFinite(Date.parse(review.reviewedAt)) ||
    hash(
      canonical(Object.fromEntries(Object.entries(review).filter(([key]) => key !== 'sha256'))),
    ) !== review.sha256
  )
    throw new Error('Invalid public review receipt.');
  const artifacts = publicArtifacts(corpus, entities);
  const value = {
    format: 'signals-public-data-preview-v1' as const,
    artifacts,
    qualifications: previewQualifications,
  };
  const currentSha256 = previewDigest(value);
  if (currentSha256 !== review.previewSha256)
    throw new Error('Public inputs changed after review.');
  await writePublicArtifacts(artifacts, directory);
  return {
    exported: true as const,
    previewSha256: currentSha256,
    artifacts: artifacts.map(({ path, sha256, byteLength }) => ({ path, sha256, byteLength })),
  };
}

/** Compatibility path retained for the existing build command. */
export async function publishPublicData(
  corpus: Awaited<ReturnType<typeof loadPublicCorpus>>,
  directory = 'dist',
  entities: StoredEntity[] = [],
) {
  await writePublicArtifacts(publicArtifacts(corpus, entities), directory);
}
