import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
  link,
  unlink,
  rmdir,
} from 'node:fs/promises';
import { join, parse, resolve, sep } from 'node:path';

const MAX_BYTES = 1_000_000;
const MAX_VERSIONS = 20;
const MAX_DATASETS = 1_000;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digestPattern = /^[a-f0-9]{64}$/;

export interface DatasetVersionRef {
  schemaVersion: 1;
  datasetId: string;
  version: number;
  sha256: string;
  name: string;
}

export interface DatasetMetadata {
  assertions: 'caller-provided';
  source: { label: string; uri?: string };
  license: { status: 'user-provided' | 'known' | 'unknown'; name?: string; uri?: string };
  authorization: { status: 'user-confirmed'; recordedAt: string };
}

export interface DatasetVersion extends DatasetVersionRef {
  ref: DatasetVersionRef;
  metadata: DatasetMetadata;
  bytes: Uint8Array;
}

export interface DatasetExpectedHead {
  datasetId: string;
  version: number;
  sha256: string;
}

export class DatasetStoreError extends Error {
  constructor(
    readonly code:
      | 'invalid_dataset'
      | 'invalid_dataset_bytes'
      | 'dataset_not_found'
      | 'dataset_head_changed'
      | 'dataset_version_limit'
      | 'dataset_limit'
      | 'dataset_corrupt',
    message: string,
  ) {
    super(message);
    this.name = 'DatasetStoreError';
  }
}

function invalid(message: string): never {
  throw new DatasetStoreError('invalid_dataset', message);
}

function plain(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function shortText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function optionalUri(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length <= 2048);
}

function validateName(name: unknown): asserts name is string {
  if (
    !shortText(name, 120) ||
    name === '.' ||
    name === '..' ||
    /[\u0000-\u001f\u007f/\\]/u.test(name)
  )
    invalid('Dataset name must be short plain text without path characters.');
}

function validateMetadata(metadata: unknown): asserts metadata is DatasetMetadata {
  if (
    !plain(metadata) ||
    Object.keys(metadata).sort().join(',') !== 'assertions,authorization,license,source' ||
    metadata.assertions !== 'caller-provided' ||
    !plain(metadata.source) ||
    Object.keys(metadata.source).some((key) => !['label', 'uri'].includes(key)) ||
    !shortText(metadata.source.label, 500) ||
    !optionalUri(metadata.source.uri) ||
    !plain(metadata.license) ||
    Object.keys(metadata.license).some((key) => !['status', 'name', 'uri'].includes(key)) ||
    !['user-provided', 'known', 'unknown'].includes(String(metadata.license.status)) ||
    (metadata.license.name !== undefined && !shortText(metadata.license.name, 200)) ||
    !optionalUri(metadata.license.uri) ||
    !plain(metadata.authorization) ||
    Object.keys(metadata.authorization).some((key) => !['status', 'recordedAt'].includes(key)) ||
    metadata.authorization.status !== 'user-confirmed' ||
    typeof metadata.authorization.recordedAt !== 'string' ||
    Number.isNaN(Date.parse(metadata.authorization.recordedAt))
  )
    invalid('Dataset source, license and authorization must be explicit caller-provided metadata.');
}

function validateBytes(bytes: Uint8Array): Buffer {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES)
    throw new DatasetStoreError('invalid_dataset_bytes', 'Dataset must contain 1 to 1,000,000 bytes.');
  const copy = Buffer.from(bytes);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(copy);
  } catch {
    throw new DatasetStoreError('invalid_dataset_bytes', 'Dataset bytes must be valid UTF-8 text.');
  }
  return copy;
}

async function directory(path: string) {
  const target = resolve(path);
  const root = parse(target).root;
  let current = root;
  for (const component of target.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    let stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) {
      await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      stat = await lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(current)) !== current)
      throw new DatasetStoreError('dataset_corrupt', 'Dataset storage must not follow symlinks.');
  }
}

async function immutableWrite(folder: string, name: string, bytes: Uint8Array | string) {
  await directory(folder);
  const temporary = join(folder, `.pending-${randomUUID()}`);
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try {
    await link(temporary, join(folder, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new DatasetStoreError('dataset_head_changed', 'Dataset version already exists.');
    throw error;
  } finally {
    await unlink(temporary);
  }
}

function folderFor(root: string, datasetId: string) {
  if (!idPattern.test(datasetId)) invalid('Invalid dataset identity.');
  return join(root, datasetId);
}

function recordName(version: number) {
  if (!Number.isSafeInteger(version) || version < 1 || version > MAX_VERSIONS)
    invalid('Dataset version is outside the supported range.');
  return `${String(version).padStart(2, '0')}.json`;
}

function bytesName(version: number) {
  return recordName(version).replace(/\.json$/u, '.csv');
}

function refFromRecord(value: unknown): { ref: DatasetVersionRef; metadata: DatasetMetadata; byteLength: number } {
  if (
    !plain(value) ||
    value.schemaVersion !== 1 ||
    !plain(value.ref) ||
    value.ref.schemaVersion !== 1 ||
    typeof value.ref.datasetId !== 'string' ||
    !idPattern.test(value.ref.datasetId) ||
    !Number.isSafeInteger(value.ref.version) ||
    typeof value.ref.version !== 'number' ||
    value.ref.version < 1 ||
    value.ref.version > MAX_VERSIONS ||
    typeof value.ref.sha256 !== 'string' ||
    !digestPattern.test(value.ref.sha256) ||
    typeof value.ref.name !== 'string' ||
    !Number.isSafeInteger(value.byteLength) ||
    typeof value.byteLength !== 'number' ||
    value.byteLength < 1 ||
    value.byteLength > MAX_BYTES
  )
    throw new DatasetStoreError('dataset_corrupt', 'Stored dataset metadata is invalid.');
  validateName(value.ref.name);
  validateMetadata(value.metadata);
  return {
    ref: value.ref as unknown as DatasetVersionRef,
    metadata: value.metadata,
    byteLength: value.byteLength,
  };
}

async function readStored(ref: DatasetVersionRef, root: string): Promise<DatasetVersion> {
  const folder = folderFor(root, ref.datasetId);
  const file = join(folder, recordName(ref.version));
  const folderStat = await lstat(folder).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      throw new DatasetStoreError('dataset_not_found', 'Dataset version was not found.');
    throw error;
  });
  const fileStat = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      throw new DatasetStoreError('dataset_not_found', 'Dataset version was not found.');
    throw error;
  });
  if (
    !folderStat.isDirectory() ||
    folderStat.isSymbolicLink() ||
    (await realpath(folder)) !== folder ||
    !fileStat.isFile() ||
    fileStat.isSymbolicLink()
  )
    throw new DatasetStoreError('dataset_corrupt', 'Dataset metadata must not follow symlinks.');
  const metaRaw = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      throw new DatasetStoreError('dataset_not_found', 'Dataset version was not found.');
    throw error;
  });
  let stored: unknown;
  try {
    stored = JSON.parse(metaRaw);
  } catch {
    throw new DatasetStoreError('dataset_corrupt', 'Stored dataset metadata is not valid JSON.');
  }
  const { ref: actualRef, metadata, byteLength } = refFromRecord(stored);
  if (
    actualRef.datasetId !== ref.datasetId ||
    actualRef.version !== ref.version ||
    actualRef.sha256 !== ref.sha256 ||
    actualRef.name !== ref.name
  )
    throw new DatasetStoreError('dataset_head_changed', 'Dataset reference does not match stored version.');
  const bytesPath = join(folder, bytesName(ref.version));
  const bytesStat = await lstat(bytesPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      throw new DatasetStoreError('dataset_corrupt', 'Stored dataset bytes are missing.');
    throw error;
  });
  if (!bytesStat.isFile() || bytesStat.isSymbolicLink())
    throw new DatasetStoreError('dataset_corrupt', 'Dataset bytes must not follow symlinks.');
  const bytes = await readFile(bytesPath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== byteLength || sha256 !== actualRef.sha256)
    throw new DatasetStoreError('dataset_corrupt', 'Stored dataset bytes failed their digest check.');
  return { ...actualRef, ref: actualRef, metadata, bytes };
}

async function currentRefs(folder: string, datasetId: string): Promise<DatasetVersionRef[]> {
  const folderStat = await lstat(folder).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!folderStat) return [];
  if (!folderStat.isDirectory() || folderStat.isSymbolicLink() || (await realpath(folder)) !== folder)
    throw new DatasetStoreError('dataset_corrupt', 'Dataset storage must not follow symlinks.');
  const names = await readdir(folder).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const versionFiles = names.filter((item) => /^\d{2}\.(?:json|csv)$/u.test(item));
  const metadataNames = versionFiles.filter((item) => item.endsWith('.json')).sort();
  const byteNames = new Set(versionFiles.filter((item) => item.endsWith('.csv')));
  if (
    metadataNames.some((name) => !byteNames.has(name.replace(/\.json$/u, '.csv'))) ||
    [...byteNames].some((name) => !metadataNames.includes(name.replace(/\.csv$/u, '.json')))
  )
    throw new DatasetStoreError('dataset_corrupt', 'Dataset history contains an orphaned version file.');
  const refs: DatasetVersionRef[] = [];
  for (const name of metadataNames) {
    const path = join(folder, name);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new DatasetStoreError('dataset_corrupt', 'Dataset metadata must not follow symlinks.');
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    const { ref } = refFromRecord(parsed);
    if (ref.datasetId !== datasetId || recordName(ref.version) !== name)
      throw new DatasetStoreError('dataset_corrupt', 'Dataset history contains an invalid version.');
    const bytePath = join(folder, bytesName(ref.version));
    const byteStat = await lstat(bytePath);
    if (!byteStat.isFile() || byteStat.isSymbolicLink())
      throw new DatasetStoreError('dataset_corrupt', 'Dataset bytes must not follow symlinks.');
    refs.push(ref);
  }
  return refs;
}

async function writeVersion(
  datasetId: string,
  version: number,
  bytes: Buffer,
  name: string,
  metadata: DatasetMetadata,
  root: string,
): Promise<DatasetVersionRef> {
  const folder = folderFor(root, datasetId);
  await directory(folder);
  const ref: DatasetVersionRef = {
    schemaVersion: 1,
    datasetId,
    version,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    name,
  };
  await immutableWrite(folder, bytesName(version), bytes);
  try {
    await immutableWrite(
      folder,
      recordName(version),
      JSON.stringify({ schemaVersion: 1, ref, byteLength: bytes.byteLength, metadata }, null, 2) + '\n',
    );
  } catch (error) {
    await unlink(join(folder, bytesName(version))).catch(() => undefined);
    throw error;
  }
  return ref;
}

/** Save caller-supplied CSV bytes and their caller-asserted provenance as an immutable first version. */
export async function importDataset(
  bytes: Uint8Array,
  input: { name: string; metadata: DatasetMetadata },
  root = resolve('.signals/datasets'),
): Promise<DatasetVersionRef> {
  validateName(input?.name);
  validateMetadata(input?.metadata);
  const exactBytes = validateBytes(bytes);
  await directory(root);
  const entries = await readdir(root);
  const count = entries.filter((item) => idPattern.test(item)).length;
  if (count >= MAX_DATASETS)
    throw new DatasetStoreError('dataset_limit', 'Dataset storage has reached its item limit.');
  return writeVersion(randomUUID(), 1, exactBytes, input.name, input.metadata, root);
}

/** Add an immutable version only when the exact previously observed head is still current. */
export async function appendDatasetVersion(
  expectedHead: DatasetExpectedHead,
  bytes: Uint8Array,
  input: { name: string; metadata: DatasetMetadata },
  root = resolve('.signals/datasets'),
): Promise<DatasetVersionRef> {
  if (
    !plain(expectedHead) ||
    !idPattern.test(expectedHead.datasetId) ||
    !Number.isSafeInteger(expectedHead.version) ||
    expectedHead.version < 1 ||
    expectedHead.version > MAX_VERSIONS ||
    !digestPattern.test(expectedHead.sha256)
  )
    invalid('An exact expected dataset head is required.');
  validateName(input?.name);
  validateMetadata(input?.metadata);
  const exactBytes = validateBytes(bytes);
  const folder = folderFor(resolve(root), expectedHead.datasetId);
  await directory(folder);
  const lock = join(folder, '.append-lock');
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new DatasetStoreError('dataset_head_changed', 'Dataset already has a concurrent version update.');
    throw error;
  }
  try {
    const refs = await currentRefs(folder, expectedHead.datasetId);
    const head = refs.at(-1);
    if (
      !head ||
      head.version !== expectedHead.version ||
      head.sha256 !== expectedHead.sha256
    )
      throw new DatasetStoreError('dataset_head_changed', 'Dataset changed since the expected head was read.');
    if (head.version >= MAX_VERSIONS)
      throw new DatasetStoreError('dataset_version_limit', 'Dataset reached its 20-version history limit.');
    return await writeVersion(
      expectedHead.datasetId,
      head.version + 1,
      exactBytes,
      input.name,
      input.metadata,
      resolve(root),
    );
  } finally {
    await rmdir(lock);
  }
}

/** Cold-read one exact immutable version and verify both identity and source-byte digest. */
export async function readDataset(
  ref: DatasetVersionRef,
  root = resolve('.signals/datasets'),
): Promise<DatasetVersion> {
  if (
    !plain(ref) ||
    ref.schemaVersion !== 1 ||
    typeof ref.datasetId !== 'string' ||
    !idPattern.test(ref.datasetId) ||
    !Number.isSafeInteger(ref.version) ||
    ref.version < 1 ||
    ref.version > MAX_VERSIONS ||
    typeof ref.sha256 !== 'string' ||
    !digestPattern.test(ref.sha256) ||
    typeof ref.name !== 'string'
  )
    invalid('An exact dataset version reference is required.');
  return readStored(ref, resolve(root));
}

/** List all retained versions in deterministic order; this is metadata-only and does not parse datasets. */
export async function listDatasets(root = resolve('.signals/datasets')): Promise<DatasetVersionRef[]> {
  await directory(root);
  const ids = (await readdir(root)).filter((item) => idPattern.test(item)).sort();
  if (ids.length > MAX_DATASETS)
    throw new DatasetStoreError('dataset_corrupt', 'Dataset storage exceeds its item limit.');
  const refs = (await Promise.all(ids.map((id) => currentRefs(join(root, id), id)))).flat();
  return refs.sort((left, right) =>
    left.datasetId.localeCompare(right.datasetId) || left.version - right.version,
  );
}

export const datasetStoreLimits = Object.freeze({ bytes: MAX_BYTES, versions: MAX_VERSIONS, datasets: MAX_DATASETS });
