import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGE = '@duckdb/node-api';
const PACKAGE_VERSION = '2.0.0-r.1';
const MAX_INPUT_BYTES = 1_050_000;
const MAX_GROUPS = 1_000;
const SAFE_ERRORS = new Set([
  'engine_unavailable', 'engine_package_mismatch', 'engine_sandbox_settings_mismatch',
  'worker_input_limit', 'invalid_worker_input', 'group_limit_exceeded',
  'numeric_precision_exceeded', 'engine_execution_failed',
]);
const CONFIG = Object.freeze({
  enable_external_access: 'false',
  autoinstall_known_extensions: 'false',
  autoload_known_extensions: 'false',
  threads: '1',
  memory_limit: '64MB',
  max_temp_directory_size: '0B',
});
const SQL_TYPES = Object.freeze({ text: 'VARCHAR', number: 'DOUBLE', boolean: 'BOOLEAN' });

function encode(value) {
  process.stdout.write(JSON.stringify(value));
}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) throw new Error('worker_input_limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function createEngine(root) {
  if (!root || !root.startsWith('/')) throw new Error('engine_unavailable');
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (metadata.name !== PACKAGE || metadata.version !== PACKAGE_VERSION || metadata.license !== 'MIT')
    throw new Error('engine_package_mismatch');
  const entry = pathToFileURL(join(root, 'lib', 'index.js')).href;
  const { DuckDBInstance } = await import(entry);
  const database = await DuckDBInstance.create(':memory:', CONFIG);
  const connection = await database.connect();
  return { database, connection };
}

function settingsMap(rows) {
  return new Map(rows.map(([name, value]) => [name, String(value)]));
}

function memoryBytes(value) {
  const match = /^(\d+(?:\.\d+)?)\s*(B|KiB|MiB|GiB|KB|MB|GB)$/u.exec(value);
  if (!match) return Infinity;
  const unit = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, KB: 1000, MB: 1000 ** 2, GB: 1000 ** 3 }[match[2]];
  return Number(match[1]) * unit;
}

async function verifySettings(connection) {
  const query = await connection.run("SELECT name, value FROM duckdb_settings() WHERE name IN ('enable_external_access','autoinstall_known_extensions','autoload_known_extensions','threads','memory_limit','max_temp_directory_size')");
  const settings = settingsMap(await query.getRowsJson());
  query.closeSync();
  if (settings.get('enable_external_access') !== 'false' ||
      settings.get('autoinstall_known_extensions') !== 'false' ||
      settings.get('autoload_known_extensions') !== 'false' ||
      settings.get('threads') !== '1' ||
      memoryBytes(settings.get('memory_limit') ?? '') > 64_000_000 ||
      settings.get('max_temp_directory_size') !== '0 bytes')
    throw new Error('engine_sandbox_settings_mismatch');
  return settings;
}

function safeIdentifier(index) {
  return `"c${index}"`;
}

async function createTable(connection, table) {
  const columns = table.columns.map((column, index) => `${safeIdentifier(index)} ${SQL_TYPES[column.type]}`);
  await connection.run(`CREATE TABLE registered_input (${columns.join(', ')})`);
  for (let start = 0; start < table.rows.length; start += 32) {
    const rows = table.rows.slice(start, start + 32);
    const placeholders = rows.map(() => `(${table.columns.map(() => '?').join(', ')})`).join(', ');
    const values = rows.flat();
    const result = await connection.run(`INSERT INTO registered_input VALUES ${placeholders}`, values);
    result.closeSync();
  }
}

function buildQuery(query, table) {
  const indexOf = (id) => table.columns.findIndex((column) => column.id === id);
  const aggregateIndex = query.column_id === undefined ? -1 : indexOf(query.column_id);
  const groupIndex = query.group_by === undefined ? -1 : indexOf(query.group_by);
  const aggregateValue = aggregateIndex < 0 ? '*' : safeIdentifier(aggregateIndex);
  const expression = `${query.aggregate.toUpperCase()}(${aggregateValue})`;
  const selected = groupIndex < 0
    ? `${expression} AS aggregate_value`
    : `${safeIdentifier(groupIndex)} AS group_value, ${expression} AS aggregate_value`;
  const params = [];
  let where = '';
  if (query.where) {
    const whereIndex = indexOf(query.where.column_id);
    where = query.where.value === null
      ? ` WHERE ${safeIdentifier(whereIndex)} IS NULL`
      : ` WHERE ${safeIdentifier(whereIndex)} = ?`;
    if (query.where.value !== null) params.push(query.where.value);
  }
  const group = groupIndex < 0 ? '' : ` GROUP BY ${safeIdentifier(groupIndex)} ORDER BY group_value ASC NULLS FIRST`;
  return { sql: `SELECT ${selected} FROM registered_input${where}${group} LIMIT ${MAX_GROUPS + 1}`, params, aggregateIndex, groupIndex };
}

function resultColumns(query, table, aggregateIndex, groupIndex) {
  const columns = [];
  if (groupIndex >= 0) {
    const group = table.columns[groupIndex];
    columns.push({ id: group.id, label: group.label, type: group.type });
  }
  const source = aggregateIndex >= 0 ? table.columns[aggregateIndex] : null;
  const isCount = query.aggregate === 'count';
  const type = isCount ? 'integer' : ['sum', 'avg'].includes(query.aggregate) ? 'number' : source.type;
  const subject = source?.label ?? 'rows';
  columns.push({ id: 'aggregate_value', label: `${query.aggregate}(${subject})`, type });
  return columns;
}

function normalizeRows(rows, columns) {
  return rows.map((row, rowIndex) => row.map((value, columnIndex) => {
    const type = columns[columnIndex].type;
    if (value === null) return null;
    if (type === 'integer') {
      const parsed = typeof value === 'bigint' ? value : BigInt(value);
      if (parsed <= BigInt(Number.MAX_SAFE_INTEGER) && parsed >= BigInt(Number.MIN_SAFE_INTEGER)) return Number(parsed);
      return parsed.toString();
    }
    if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))))
      throw new Error('numeric_precision_exceeded');
    if (type === 'text' && typeof value !== 'string') throw new Error(`invalid_result_${rowIndex}`);
    if (type === 'boolean' && typeof value !== 'boolean') throw new Error(`invalid_result_${rowIndex}`);
    return value;
  }));
}

async function main(engineRoot) {
  const input = await readInput();
  if (!input || !input.table || !input.query) throw new Error('invalid_worker_input');
  const { database, connection } = await createEngine(engineRoot);
  try {
    await verifySettings(connection);
    const versionQuery = await connection.run('SELECT version()');
    const nativeVersion = (await versionQuery.getRowsJson())[0]?.[0];
    versionQuery.closeSync();
    await createTable(connection, input.table);
    const built = buildQuery(input.query, input.table);
    const queryResult = await connection.run(built.sql, built.params);
    const rawRows = await queryResult.getRowsJson();
    queryResult.closeSync();
    if (rawRows.length > MAX_GROUPS) throw new Error('group_limit_exceeded');
    const columns = resultColumns(input.query, input.table, built.aggregateIndex, built.groupIndex);
    const rows = normalizeRows(rawRows, columns);
    const qualifications = ['Caller-authored values are not independently sourced or verified.'];
    if (['sum', 'avg'].includes(input.query.aggregate))
      qualifications.push('Number aggregates use binary floating-point and may round decimal values.');
    encode({
      version: 'research-table-result-v1',
      status: 'complete',
      input_digest: input.table.sha256,
      query_digest: input.queryDigest,
      engine: { package: PACKAGE, version: PACKAGE_VERSION, nativeVersion: String(nativeVersion) },
      columns,
      rows,
      qualifications,
    });
  } finally {
    connection.closeSync();
    database.closeSync();
  }
}

const engineRoot = process.argv[2];
try {
  await main(engineRoot);
} catch (error) {
  const code = SAFE_ERRORS.has(error?.message) ? error.message : 'engine_execution_failed';
  encode({ version: 'research-table-result-v1', status: 'failed', error: code });
  process.exitCode = 0;
}
