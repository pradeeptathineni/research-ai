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
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import {
  buildAnalysisRun,
  chartSeries,
  createAnalysis,
  importTableCsv,
  prepareAnalysisQuery,
  registerTable,
  runAnalysisTarget,
  validateAnalysis,
  validateAnalysisRun,
  type AnalysisTarget,
  type ResearchAnalysisRun,
  type ResearchTable,
  type ResearchTableAnalysis,
  type ResearchTableAnalysisInput,
  type ResearchTableCsvImport,
  type TableQueryComplete,
  type TableQueryResult,
} from '@pradeeptathineni/research-ai';

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
      | 'dataset_corrupt'
      | 'dataset_table_not_parsed'
      | 'dataset_table_changed'
      | 'csv_parser_unavailable'
      | 'invalid_csv'
      | 'invalid_csv_headers'
      | 'invalid_csv_utf8'
      | 'limit_exceeded'
      | 'analysis_not_found'
      | 'analysis_head_changed'
      | 'analysis_corrupt'
      | 'table_engine_unavailable',
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
    throw new DatasetStoreError(
      'invalid_dataset_bytes',
      'Dataset must contain 1 to 1,000,000 bytes.',
    );
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

async function existingDirectory(path: string) {
  const target = resolve(path);
  const root = parse(target).root;
  let current = root;
  for (const component of target.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT')
        throw new DatasetStoreError('dataset_not_found', 'Dataset version was not found.');
      throw error;
    });
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

function refFromRecord(value: unknown): {
  ref: DatasetVersionRef;
  metadata: DatasetMetadata;
  byteLength: number;
} {
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
  await existingDirectory(root);
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
    throw new DatasetStoreError(
      'dataset_head_changed',
      'Dataset reference does not match stored version.',
    );
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
    throw new DatasetStoreError(
      'dataset_corrupt',
      'Stored dataset bytes failed their digest check.',
    );
  return { ...actualRef, ref: actualRef, metadata, bytes };
}

async function currentRefs(folder: string, datasetId: string): Promise<DatasetVersionRef[]> {
  const folderStat = await lstat(folder).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!folderStat) return [];
  if (
    !folderStat.isDirectory() ||
    folderStat.isSymbolicLink() ||
    (await realpath(folder)) !== folder
  )
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
    throw new DatasetStoreError(
      'dataset_corrupt',
      'Dataset history contains an orphaned version file.',
    );
  const refs: DatasetVersionRef[] = [];
  for (const name of metadataNames) {
    const path = join(folder, name);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new DatasetStoreError('dataset_corrupt', 'Dataset metadata must not follow symlinks.');
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    const { ref } = refFromRecord(parsed);
    if (ref.datasetId !== datasetId || recordName(ref.version) !== name)
      throw new DatasetStoreError(
        'dataset_corrupt',
        'Dataset history contains an invalid version.',
      );
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
      JSON.stringify({ schemaVersion: 1, ref, byteLength: bytes.byteLength, metadata }, null, 2) +
        '\n',
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
      throw new DatasetStoreError(
        'dataset_head_changed',
        'Dataset already has a concurrent version update.',
      );
    throw error;
  }
  try {
    const refs = await currentRefs(folder, expectedHead.datasetId);
    const head = refs.at(-1);
    if (!head || head.version !== expectedHead.version || head.sha256 !== expectedHead.sha256)
      throw new DatasetStoreError(
        'dataset_head_changed',
        'Dataset changed since the expected head was read.',
      );
    if (head.version >= MAX_VERSIONS)
      throw new DatasetStoreError(
        'dataset_version_limit',
        'Dataset reached its 20-version history limit.',
      );
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
  return readStored(validateDatasetVersionRef(ref), resolve(root));
}

function validateDatasetVersionRef(value: unknown): DatasetVersionRef {
  if (
    !plain(value) ||
    Object.keys(value).sort().join(',') !== 'datasetId,name,schemaVersion,sha256,version' ||
    value.schemaVersion !== 1 ||
    typeof value.datasetId !== 'string' ||
    !idPattern.test(value.datasetId) ||
    !Number.isSafeInteger(value.version) ||
    typeof value.version !== 'number' ||
    value.version < 1 ||
    value.version > MAX_VERSIONS ||
    typeof value.sha256 !== 'string' ||
    !digestPattern.test(value.sha256) ||
    typeof value.name !== 'string'
  )
    invalid('An exact dataset version reference is required.');
  validateName(value.name);
  return value as unknown as DatasetVersionRef;
}

/** List all retained versions in deterministic order; this is metadata-only and does not parse datasets. */
export async function listDatasets(
  root = resolve('.signals/datasets'),
): Promise<DatasetVersionRef[]> {
  await directory(root);
  const ids = (await readdir(root)).filter((item) => idPattern.test(item)).sort();
  if (ids.length > MAX_DATASETS)
    throw new DatasetStoreError('dataset_corrupt', 'Dataset storage exceeds its item limit.');
  const refs = (await Promise.all(ids.map((id) => currentRefs(join(root, id), id)))).flat();
  return refs.sort(
    (left, right) => left.datasetId.localeCompare(right.datasetId) || left.version - right.version,
  );
}

export interface ParsedDatasetTable {
  datasetRef: DatasetVersionRef;
  table: ResearchTable;
  import: ResearchTableCsvImport;
  metadata: DatasetMetadata;
}

interface ParsedTableRecord {
  schemaVersion: 1;
  datasetRef: DatasetVersionRef;
  table: ResearchTable;
  import: ResearchTableCsvImport;
}

function tableRecordPath(ref: DatasetVersionRef, root: string) {
  return join(folderFor(root, ref.datasetId), 'parsed', `${recordName(ref.version)}.json`);
}

function verifyRegisteredTable(value: unknown): ResearchTable {
  if (!plain(value) || typeof value.sha256 !== 'string' || !digestPattern.test(value.sha256))
    throw new DatasetStoreError('dataset_table_changed', 'Saved parsed table is malformed.');
  const { sha256, ...input } = value;
  let table: ResearchTable;
  try {
    table = registerTable(input as Omit<ResearchTable, 'sha256'>);
  } catch {
    throw new DatasetStoreError(
      'dataset_table_changed',
      'Saved parsed table failed Methods validation.',
    );
  }
  if (table.sha256 !== sha256)
    throw new DatasetStoreError('dataset_table_changed', 'Saved parsed table digest changed.');
  return table;
}

function validateParsedRecord(value: unknown, ref: DatasetVersionRef): ParsedTableRecord {
  if (
    !plain(value) ||
    Object.keys(value).sort().join(',') !== 'datasetRef,import,schemaVersion,table' ||
    value.schemaVersion !== 1 ||
    !plain(value.datasetRef) ||
    value.datasetRef.datasetId !== ref.datasetId ||
    value.datasetRef.version !== ref.version ||
    value.datasetRef.sha256 !== ref.sha256 ||
    value.datasetRef.name !== ref.name ||
    !plain(value.import) ||
    value.import.version !== 'research-table-csv-v1' ||
    value.import.csv_sha256 !== ref.sha256 ||
    !plain(value.import.parser) ||
    value.import.parser.name !== 'csv-parse' ||
    value.import.parser.version !== '7.0.3' ||
    value.import.headers !== 'first-row' ||
    value.import.values !== 'text'
  )
    throw new DatasetStoreError(
      'dataset_table_changed',
      'Saved table no longer binds to these exact CSV bytes.',
    );
  const table = verifyRegisteredTable(value.table);
  if (value.import.table_sha256 !== table.sha256)
    throw new DatasetStoreError(
      'dataset_table_changed',
      'Saved table receipt does not match the registered table.',
    );
  return {
    schemaVersion: 1,
    datasetRef: ref,
    table,
    import: value.import as unknown as ResearchTableCsvImport,
  };
}

/** Parse exact retained CSV bytes through the pinned Methods parser and keep its typed-table receipt. */
export async function importDatasetTable(
  ref: DatasetVersionRef,
  parserRoot: string | undefined,
  root = resolve('.signals/datasets'),
): Promise<ParsedDatasetTable> {
  const existing = await readDatasetTable(ref, root).catch((failure: unknown) => {
    if (failure instanceof DatasetStoreError && failure.code === 'dataset_table_not_parsed')
      return null;
    throw failure;
  });
  if (existing) return existing;
  if (!parserRoot || !isAbsolute(parserRoot))
    throw new DatasetStoreError(
      'csv_parser_unavailable',
      'The host has not configured the qualified CSV parser.',
    );
  const source = await readDataset(ref, root);
  const label = source.ref.name
    .replace(/[\u0000-\u001f\u007f/:\\]/gu, '_')
    .slice(0, 120)
    .trim();
  let parsed: Awaited<ReturnType<typeof importTableCsv>>;
  try {
    parsed = await importTableCsv(source.bytes, { parserRoot, label });
  } catch (failure) {
    const code =
      failure && typeof failure === 'object' && 'code' in failure
        ? String((failure as { code: unknown }).code)
        : '';
    if (code === 'parser_unavailable' || code === 'parser_version_mismatch')
      throw new DatasetStoreError(
        'csv_parser_unavailable',
        'The configured CSV parser is unavailable or not qualified.',
      );
    if (code === 'invalid_csv_headers')
      throw new DatasetStoreError(
        'invalid_csv_headers',
        'CSV headers do not meet Methods import rules.',
      );
    if (code === 'limit_exceeded')
      throw new DatasetStoreError('limit_exceeded', 'CSV exceeds Methods import limits.');
    if (code === 'invalid_csv_utf8')
      throw new DatasetStoreError('invalid_csv_utf8', 'CSV is not valid UTF-8.');
    throw new DatasetStoreError('invalid_csv', 'CSV syntax or record shape is invalid.');
  }
  if (
    parsed.import.csv_sha256 !== source.ref.sha256 ||
    parsed.import.table_sha256 !== parsed.table.sha256
  )
    throw new DatasetStoreError(
      'dataset_table_changed',
      'Methods parser receipt does not match the saved dataset.',
    );
  const record: ParsedTableRecord = {
    schemaVersion: 1,
    datasetRef: source.ref,
    table: parsed.table,
    import: parsed.import,
  };
  const path = tableRecordPath(ref, resolve(root));
  try {
    await immutableWrite(dirname(path), basename(path), JSON.stringify(record, null, 2) + '\n');
  } catch (failure) {
    if (failure instanceof DatasetStoreError && failure.code === 'dataset_head_changed')
      return readDatasetTable(ref, root);
    throw failure;
  }
  return {
    datasetRef: source.ref,
    table: parsed.table,
    import: parsed.import,
    metadata: source.metadata,
  };
}

/** Reopen the exact Methods table after rechecking the source-byte and table digests. */
export async function readDatasetTable(
  ref: DatasetVersionRef,
  root = resolve('.signals/datasets'),
): Promise<ParsedDatasetTable> {
  const source = await readDataset(ref, root);
  const path = tableRecordPath(ref, resolve(root));
  await existingDirectory(dirname(path)).catch((failure: unknown) => {
    if (failure instanceof DatasetStoreError && failure.code === 'dataset_not_found')
      throw new DatasetStoreError(
        'dataset_table_not_parsed',
        'This exact dataset version has no parsed table yet.',
      );
    throw failure;
  });
  const stat = await lstat(path).catch((failure: NodeJS.ErrnoException) => {
    if (failure.code === 'ENOENT')
      throw new DatasetStoreError(
        'dataset_table_not_parsed',
        'This exact dataset version has no parsed table yet.',
      );
    throw failure;
  });
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new DatasetStoreError(
      'dataset_corrupt',
      'Parsed dataset table must not follow symlinks.',
    );
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new DatasetStoreError('dataset_corrupt', 'Saved parsed table is not valid JSON.');
  }
  const record = validateParsedRecord(value, source.ref);
  return { ...record, metadata: source.metadata };
}

export interface DatasetAnalysisRef {
  schemaVersion: 1;
  analysisId: string;
  revision: number;
  analysisDigest: string;
  datasetRef: DatasetVersionRef;
  tableId: string;
  tableSha256: string;
}

export interface DatasetAnalysisVersion {
  ref: DatasetAnalysisRef;
  analysis: ResearchTableAnalysis;
}

export interface DatasetAnalysisInput {
  datasetRef: DatasetVersionRef;
  tableSha256: string;
  tableName: string;
  title: string;
  steps: ResearchTableAnalysisInput['steps'];
  chart?: ResearchTableAnalysisInput['chart'];
}

export interface DatasetAnalysisExpectedHead {
  schemaVersion: 1;
  analysisId: string;
  revision: number;
  analysisDigest: string;
  datasetRef: DatasetVersionRef;
  tableId: string;
  tableSha256: string;
}

interface AnalysisRecord {
  schemaVersion: 1;
  ref: DatasetAnalysisRef;
  analysis: ResearchTableAnalysis;
}

const analysisIdPattern = /^analysis-[A-Za-z0-9-]{1,60}$/;
const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function analysisFolder(ref: Pick<DatasetAnalysisRef, 'analysisId' | 'datasetRef'>, root: string) {
  if (!analysisIdPattern.test(ref.analysisId)) invalid('Invalid analysis identity.');
  return join(folderFor(root, ref.datasetRef.datasetId), 'analyses', ref.analysisId);
}

function validateAnalysisRef(value: unknown): DatasetAnalysisRef {
  if (
    !plain(value) ||
    Object.keys(value).sort().join(',') !==
      'analysisDigest,analysisId,datasetRef,revision,schemaVersion,tableId,tableSha256' ||
    value.schemaVersion !== 1 ||
    typeof value.analysisId !== 'string' ||
    !analysisIdPattern.test(value.analysisId) ||
    !Number.isSafeInteger(value.revision) ||
    typeof value.revision !== 'number' ||
    value.revision < 1 ||
    value.revision > MAX_VERSIONS ||
    typeof value.analysisDigest !== 'string' ||
    !digestPattern.test(value.analysisDigest) ||
    typeof value.tableId !== 'string' ||
    !/^table-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(value.tableId) ||
    typeof value.tableSha256 !== 'string' ||
    !digestPattern.test(value.tableSha256)
  )
    throw new DatasetStoreError(
      'analysis_head_changed',
      'An exact saved analysis reference is required.',
    );
  try {
    validateDatasetVersionRef(value.datasetRef);
  } catch {
    throw new DatasetStoreError(
      'analysis_head_changed',
      'Analysis dataset reference is malformed.',
    );
  }
  return value as unknown as DatasetAnalysisRef;
}

function analysisInputFromHead(
  input: Omit<DatasetAnalysisInput, 'datasetRef' | 'tableSha256'>,
  source: ParsedDatasetTable,
  id: string,
  revision: number,
  parentDigest: string | null,
): ResearchTableAnalysis {
  const value: ResearchTableAnalysisInput = {
    id,
    revision,
    parent_digest: parentDigest,
    title: input.title,
    tables: [{ name: input.tableName, id: source.table.id, sha256: source.table.sha256 }],
    steps: input.steps,
    ...(input.chart !== undefined ? { chart: input.chart } : {}),
  };
  return createAnalysis(value);
}

function analysisRefFor(
  analysis: ResearchTableAnalysis,
  datasetRef: DatasetVersionRef,
  table: ResearchTable,
): DatasetAnalysisRef {
  return {
    schemaVersion: 1,
    analysisId: analysis.id,
    revision: analysis.revision,
    analysisDigest: analysis.analysis_digest,
    datasetRef,
    tableId: table.id,
    tableSha256: table.sha256,
  };
}

function analysisRecordPath(folder: string, revision: number) {
  return join(folder, recordName(revision));
}

async function immutableAnalysisWrite(
  folder: string,
  ref: DatasetAnalysisRef,
  analysis: ResearchTableAnalysis,
) {
  await immutableWrite(
    folder,
    recordName(ref.revision),
    JSON.stringify({ schemaVersion: 1, ref, analysis }, null, 2) + '\n',
  );
}

async function currentAnalysisRefs(
  folder: string,
  datasetId: string,
  analysisId: string,
  expectedDatasetRef?: DatasetVersionRef,
): Promise<DatasetAnalysisRef[]> {
  await existingDirectory(folder);
  const names = (await readdir(folder)).filter((name) => /^\d{2}\.json$/u.test(name)).sort();
  const refs: DatasetAnalysisRef[] = [];
  for (const name of names) {
    const path = analysisRecordPath(folder, Number(name.slice(0, 2)));
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new DatasetStoreError('analysis_corrupt', 'Saved analysis must not follow symlinks.');
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      throw new DatasetStoreError('analysis_corrupt', 'Saved analysis revision is not valid JSON.');
    }
    const checked = validateAnalysisRecord(value);
    if (
      checked.ref.analysisId !== analysisId ||
      checked.ref.revision !== Number(name.slice(0, 2)) ||
      checked.ref.datasetRef.datasetId !== datasetId ||
      (expectedDatasetRef !== undefined &&
        (checked.ref.datasetRef.version !== expectedDatasetRef.version ||
          checked.ref.datasetRef.sha256 !== expectedDatasetRef.sha256 ||
          checked.ref.datasetRef.name !== expectedDatasetRef.name))
    )
      throw new DatasetStoreError(
        'analysis_corrupt',
        'Analysis revision has a different source identity.',
      );
    refs.push(checked.ref);
  }
  return refs;
}

function validateAnalysisRecord(value: unknown): AnalysisRecord {
  if (
    !plain(value) ||
    Object.keys(value).sort().join(',') !== 'analysis,ref,schemaVersion' ||
    value.schemaVersion !== 1 ||
    !plain(value.ref) ||
    Object.keys(value.ref).sort().join(',') !==
      'analysisDigest,analysisId,datasetRef,revision,schemaVersion,tableId,tableSha256' ||
    value.ref.schemaVersion !== 1 ||
    typeof value.ref.analysisId !== 'string' ||
    !analysisIdPattern.test(value.ref.analysisId) ||
    !Number.isSafeInteger(value.ref.revision) ||
    typeof value.ref.revision !== 'number' ||
    value.ref.revision < 1 ||
    value.ref.revision > MAX_VERSIONS ||
    typeof value.ref.analysisDigest !== 'string' ||
    !digestPattern.test(value.ref.analysisDigest) ||
    typeof value.ref.tableId !== 'string' ||
    typeof value.ref.tableSha256 !== 'string' ||
    !digestPattern.test(value.ref.tableSha256)
  )
    throw new DatasetStoreError('analysis_corrupt', 'Saved analysis identity is malformed.');
  let analysis: ResearchTableAnalysis;
  try {
    analysis = validateAnalysis(value.analysis);
  } catch {
    throw new DatasetStoreError('analysis_corrupt', 'Saved analysis failed Methods validation.');
  }
  let datasetRef: DatasetVersionRef;
  try {
    datasetRef = validateDatasetVersionRef(value.ref.datasetRef);
  } catch {
    throw new DatasetStoreError(
      'analysis_corrupt',
      'Saved analysis dataset reference is malformed.',
    );
  }
  if (
    analysis.id !== value.ref.analysisId ||
    analysis.revision !== value.ref.revision ||
    analysis.analysis_digest !== value.ref.analysisDigest ||
    analysis.tables.length !== 1 ||
    analysis.tables[0]?.id !== value.ref.tableId ||
    analysis.tables[0]?.sha256 !== value.ref.tableSha256 ||
    typeof value.ref.tableId !== 'string' ||
    !/^table-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(value.ref.tableId)
  )
    throw new DatasetStoreError(
      'analysis_corrupt',
      'Saved analysis is not bound to its exact table and dataset.',
    );
  return {
    schemaVersion: 1,
    ref: value.ref as unknown as DatasetAnalysisRef,
    analysis,
  };
}

export async function createDatasetAnalysis(
  input: DatasetAnalysisInput,
  root = resolve('.signals/datasets'),
): Promise<DatasetAnalysisVersion> {
  const source = await readDatasetTable(input.datasetRef, root);
  if (source.table.sha256 !== input.tableSha256)
    throw new DatasetStoreError(
      'dataset_table_changed',
      'Analysis must bind to the exact saved table digest.',
    );
  const id = `analysis-${randomUUID()}`;
  const analysis = analysisInputFromHead(input, source, id, 1, null);
  const ref = analysisRefFor(analysis, source.datasetRef, source.table);
  const folder = analysisFolder(ref, resolve(root));
  await directory(folder);
  await immutableAnalysisWrite(folder, ref, analysis);
  return { ref, analysis };
}

export async function appendDatasetAnalysisRevision(
  expectedHead: DatasetAnalysisExpectedHead,
  input: Omit<DatasetAnalysisInput, 'datasetRef' | 'tableSha256'>,
  root = resolve('.signals/datasets'),
): Promise<DatasetAnalysisVersion> {
  const expected = validateAnalysisRef(expectedHead);
  const source = await readDatasetTable(expected.datasetRef, root);
  const folder = analysisFolder(expected, resolve(root));
  const lock = join(folder, '.revision-lock');
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === 'EEXIST')
      throw new DatasetStoreError(
        'analysis_head_changed',
        'Analysis has a concurrent revision update.',
      );
    throw failure;
  }
  try {
    const refs = await currentAnalysisRefs(
      folder,
      expected.datasetRef.datasetId,
      expected.analysisId,
      expected.datasetRef,
    );
    const head = refs.at(-1);
    if (
      !head ||
      head.revision !== expected.revision ||
      head.analysisDigest !== expected.analysisDigest ||
      head.datasetRef.sha256 !== expected.datasetRef.sha256 ||
      head.tableSha256 !== expected.tableSha256 ||
      head.tableId !== expected.tableId
    )
      throw new DatasetStoreError(
        'analysis_head_changed',
        'Analysis changed since its expected revision was read.',
      );
    if (head.revision >= MAX_VERSIONS)
      throw new DatasetStoreError(
        'dataset_version_limit',
        'Analysis reached its 20-revision history limit.',
      );
    const prior = await readDatasetAnalysis(head, root);
    const analysis = analysisInputFromHead(
      { ...input, tableName: input.tableName },
      source,
      prior.analysis.id,
      head.revision + 1,
      prior.analysis.analysis_digest,
    );
    const ref = analysisRefFor(analysis, source.datasetRef, source.table);
    await immutableAnalysisWrite(folder, ref, analysis);
    return { ref, analysis };
  } finally {
    await rmdir(lock);
  }
}

export async function readDatasetAnalysis(
  ref: DatasetAnalysisRef,
  root = resolve('.signals/datasets'),
): Promise<DatasetAnalysisVersion & { dataset: ParsedDatasetTable }> {
  ref = validateAnalysisRef(ref);
  const folder = analysisFolder(ref, resolve(root));
  await existingDirectory(folder);
  const path = analysisRecordPath(folder, ref.revision);
  const stat = await lstat(path).catch((failure: NodeJS.ErrnoException) => {
    if (failure.code === 'ENOENT')
      throw new DatasetStoreError('analysis_not_found', 'Analysis revision was not found.');
    throw failure;
  });
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new DatasetStoreError('analysis_corrupt', 'Saved analysis must not follow symlinks.');
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new DatasetStoreError('analysis_corrupt', 'Saved analysis revision is not valid JSON.');
  }
  const record = validateAnalysisRecord(value);
  if (
    record.ref.analysisId !== ref.analysisId ||
    record.ref.revision !== ref.revision ||
    record.ref.analysisDigest !== ref.analysisDigest ||
    record.ref.datasetRef.datasetId !== ref.datasetRef.datasetId ||
    record.ref.datasetRef.version !== ref.datasetRef.version ||
    record.ref.datasetRef.sha256 !== ref.datasetRef.sha256 ||
    record.ref.tableId !== ref.tableId ||
    record.ref.tableSha256 !== ref.tableSha256
  )
    throw new DatasetStoreError(
      'analysis_head_changed',
      'Analysis ref does not match the saved revision.',
    );
  const dataset = await readDatasetTable(ref.datasetRef, root);
  if (dataset.table.id !== ref.tableId || dataset.table.sha256 !== ref.tableSha256)
    throw new DatasetStoreError('dataset_table_changed', 'Analysis source table changed.');
  return { ref: record.ref, analysis: record.analysis, dataset };
}

export async function listDatasetAnalyses(
  root = resolve('.signals/datasets'),
): Promise<DatasetAnalysisRef[]> {
  const datasets = await listDatasets(root);
  const refs: DatasetAnalysisRef[] = [];
  const seen = new Set<string>();
  const datasetIds = [...new Set(datasets.map((datasetRef) => datasetRef.datasetId))];
  for (const datasetId of datasetIds) {
    const folder = join(folderFor(resolve(root), datasetId), 'analyses');
    const stat = await lstat(folder).catch((failure: NodeJS.ErrnoException) => {
      if (failure.code === 'ENOENT') return null;
      throw failure;
    });
    if (!stat) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(folder)) !== folder)
      throw new DatasetStoreError('analysis_corrupt', 'Analysis storage must not follow symlinks.');
    for (const analysisId of await readdir(folder)) {
      if (!analysisIdPattern.test(analysisId))
        throw new DatasetStoreError(
          'analysis_corrupt',
          'Analysis storage contains an invalid identity.',
        );
      const analysisPath = join(folder, analysisId);
      const analysisStat = await lstat(analysisPath);
      if (!analysisStat.isDirectory() || analysisStat.isSymbolicLink())
        throw new DatasetStoreError(
          'analysis_corrupt',
          'Analysis storage must not follow symlinks.',
        );
      const versionRefs = await currentAnalysisRefs(analysisPath, datasetId, analysisId);
      for (const ref of versionRefs) {
        const key = `${ref.analysisId}:${ref.revision}`;
        if (!seen.has(key)) {
          refs.push(ref);
          seen.add(key);
        }
      }
    }
  }
  return refs.sort(
    (left, right) =>
      left.analysisId.localeCompare(right.analysisId) || left.revision - right.revision,
  );
}

export interface DatasetAnalysisRunRef {
  schemaVersion: 1;
  runId: string;
  analysisRef: DatasetAnalysisRef;
  runDigest: string;
}

export interface DatasetAnalysisRun {
  runRef: DatasetAnalysisRunRef;
  analysisRef: DatasetAnalysisRef;
  run: ResearchAnalysisRun;
  chart: ReturnType<typeof chartSeries> | null;
}

interface AnalysisRunRecord {
  schemaVersion: 1;
  runRef: DatasetAnalysisRunRef;
  run: ResearchAnalysisRun;
}

function runFolder(ref: DatasetAnalysisRef, root: string) {
  return join(analysisFolder(ref, root), 'runs');
}

function chartForRun(analysis: ResearchTableAnalysis, run: ResearchAnalysisRun) {
  if (!analysis.chart) return null;
  const chartEntry = run.entries.find(
    (entry) => entry.target.kind === 'chart' && entry.state === 'complete',
  );
  if (!chartEntry?.artifact) return null;
  return chartSeries(chartEntry.artifact as TableQueryComplete, analysis.chart);
}

export async function runDatasetAnalysis(
  ref: DatasetAnalysisRef,
  engineRoot: string | undefined,
  root = resolve('.signals/datasets'),
): Promise<DatasetAnalysisRun> {
  if (!engineRoot || !isAbsolute(engineRoot))
    throw new DatasetStoreError(
      'table_engine_unavailable',
      'The host has not configured the qualified table engine.',
    );
  const opened = await readDatasetAnalysis(ref, root);
  const analysis = opened.analysis;
  const tables = [{ name: analysis.tables[0]!.name, table: opened.dataset.table }];
  const entries: Array<{ target: AnalysisTarget; result: TableQueryResult }> = [];
  const stepResults = new Map<string, TableQueryComplete>();
  for (const step of analysis.steps) {
    const target: AnalysisTarget = { kind: 'step', step: step.name, mode: 'rows' };
    const result = await runAnalysisTarget(analysis, tables, target, { engineRoot });
    entries.push({ target, result });
    if (result.status !== 'complete') break;
    stepResults.set(step.name, result);
  }
  const allStepsComplete = stepResults.size === analysis.steps.length;
  if (allStepsComplete && analysis.chart) {
    const columns = stepResults.get(analysis.chart.step)?.columns;
    if (columns) {
      const target: AnalysisTarget = { kind: 'chart', columns };
      const result = await runAnalysisTarget(analysis, tables, target, { engineRoot });
      entries.push({ target, result });
    }
  }
  const run = buildAnalysisRun(analysis, entries);
  const runRef: DatasetAnalysisRunRef = {
    schemaVersion: 1,
    runId: run.id,
    analysisRef: ref,
    runDigest: run.run_digest,
  };
  const folder = runFolder(ref, resolve(root));
  await immutableWrite(
    folder,
    `${run.id}.json`,
    JSON.stringify({ schemaVersion: 1, runRef, run }, null, 2) + '\n',
  );
  return { runRef, analysisRef: ref, run, chart: chartForRun(analysis, run) };
}

function validateRunRef(value: unknown): DatasetAnalysisRunRef {
  if (
    !plain(value) ||
    Object.keys(value).sort().join(',') !== 'analysisRef,runDigest,runId,schemaVersion' ||
    value.schemaVersion !== 1 ||
    typeof value.runId !== 'string' ||
    !runIdPattern.test(value.runId) ||
    typeof value.runDigest !== 'string' ||
    !digestPattern.test(value.runDigest)
  )
    throw new DatasetStoreError('analysis_corrupt', 'Saved run identity is malformed.');
  const analysisRef = validateAnalysisRef(value.analysisRef);
  return { schemaVersion: 1, runId: value.runId, analysisRef, runDigest: value.runDigest };
}

export async function listDatasetAnalysisRuns(
  ref: DatasetAnalysisRef,
  root = resolve('.signals/datasets'),
): Promise<DatasetAnalysisRunRef[]> {
  await readDatasetAnalysis(ref, root);
  const folder = runFolder(ref, resolve(root));
  const stat = await lstat(folder).catch((failure: NodeJS.ErrnoException) => {
    if (failure.code === 'ENOENT') return null;
    throw failure;
  });
  if (!stat) return [];
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(folder)) !== folder)
    throw new DatasetStoreError(
      'analysis_corrupt',
      'Analysis run storage must not follow symlinks.',
    );
  const refs: DatasetAnalysisRunRef[] = [];
  for (const name of (await readdir(folder)).sort()) {
    if (!runIdPattern.test(name.replace(/\.json$/u, '')) || !name.endsWith('.json'))
      throw new DatasetStoreError('analysis_corrupt', 'Run storage contains an invalid identity.');
    const path = join(folder, name);
    const recordStat = await lstat(path);
    if (!recordStat.isFile() || recordStat.isSymbolicLink())
      throw new DatasetStoreError('analysis_corrupt', 'Saved run must not follow symlinks.');
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!plain(value) || value.schemaVersion !== 1 || !plain(value.runRef))
      throw new DatasetStoreError('analysis_corrupt', 'Saved run record is malformed.');
    const runRef = validateRunRef(value.runRef);
    if (
      runRef.runId !== name.slice(0, -5) ||
      runRef.analysisRef.analysisId !== ref.analysisId ||
      runRef.analysisRef.revision !== ref.revision ||
      runRef.analysisRef.analysisDigest !== ref.analysisDigest
    )
      throw new DatasetStoreError(
        'analysis_corrupt',
        'Saved run belongs to a different analysis revision.',
      );
    refs.push(runRef);
  }
  return refs;
}

export async function readDatasetAnalysisRun(
  ref: DatasetAnalysisRunRef,
  root = resolve('.signals/datasets'),
): Promise<DatasetAnalysisRun> {
  ref = validateRunRef(ref);
  const opened = await readDatasetAnalysis(ref.analysisRef, root);
  const folder = runFolder(ref.analysisRef, resolve(root));
  await existingDirectory(folder);
  const path = join(folder, `${ref.runId}.json`);
  const stat = await lstat(path).catch((failure: NodeJS.ErrnoException) => {
    if (failure.code === 'ENOENT')
      throw new DatasetStoreError('analysis_not_found', 'Analysis run was not found.');
    throw failure;
  });
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new DatasetStoreError('analysis_corrupt', 'Saved run must not follow symlinks.');
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new DatasetStoreError('analysis_corrupt', 'Saved run is not valid JSON.');
  }
  if (!plain(value) || value.schemaVersion !== 1)
    throw new DatasetStoreError('analysis_corrupt', 'Saved run record is malformed.');
  const runRef = validateRunRef(value.runRef);
  let run: ResearchAnalysisRun;
  try {
    run = validateAnalysisRun(value.run, {
      analysis: opened.analysis,
      tables: [{ name: opened.analysis.tables[0]!.name, table: opened.dataset.table }],
    });
  } catch {
    throw new DatasetStoreError('analysis_corrupt', 'Saved run failed Methods validation.');
  }
  if (
    runRef.runId !== ref.runId ||
    runRef.runDigest !== run.run_digest ||
    runRef.analysisRef.analysisId !== opened.ref.analysisId ||
    runRef.analysisRef.revision !== opened.ref.revision ||
    runRef.analysisRef.analysisDigest !== opened.ref.analysisDigest
  )
    throw new DatasetStoreError('analysis_head_changed', 'Run ref does not match the saved run.');
  return {
    runRef,
    analysisRef: opened.ref,
    run,
    chart: chartForRun(opened.analysis, run),
  };
}

export const datasetStoreLimits = Object.freeze({
  bytes: MAX_BYTES,
  versions: MAX_VERSIONS,
  datasets: MAX_DATASETS,
});
