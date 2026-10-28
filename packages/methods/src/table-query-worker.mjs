import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGE = '@duckdb/node-api';
const ENGINE_VERSION = '2.0.0-r.1';
const MAX_INPUT_BYTES = 2_050_000;
const MAX_BYTES = 2_000_000, MAX_ROWS = 1000, MAX_COLUMNS = 32;
const ERRORS = new Set(['engine_unavailable','engine_package_mismatch','engine_settings_mismatch','query_invalid','query_not_select','query_multiple_statements','parameter_count_mismatch','result_limit','result_type_unsupported','result_schema_limit','numeric_precision_exceeded']);
const CONFIG = Object.freeze({ enable_external_access: 'false', autoinstall_known_extensions: 'false', autoload_known_extensions: 'false', threads: '1', memory_limit: '64MB', max_temp_directory_size: '0B' });
const SQL_TYPES = { text: 'VARCHAR', number: 'DOUBLE', boolean: 'BOOLEAN' };

async function readInput() {
  const chunks = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length; if (bytes > MAX_INPUT_BYTES) throw new Error('result_limit');
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}
async function createEngine(root) {
  if (!root || !root.startsWith('/')) throw new Error('engine_unavailable');
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (metadata.name !== PACKAGE || metadata.version !== ENGINE_VERSION || metadata.license !== 'MIT')
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
    throw new Error('engine_settings_mismatch');
  return settings;
}

async function addTable(connection, { name, table }) {
  // names and generated columns are validated by the owner; values are always bound
  const columns = table.columns.map((c, i) => `"c${i}" ${SQL_TYPES[c.type]}`);
  const created = await connection.run(`CREATE TABLE "${name}" ("_row" INTEGER, ${columns.join(', ')})`); created.closeSync();
  for (let start = 0; start < table.rows.length; start += 32) {
    const rows = table.rows.slice(start, start + 32).map((row, i) => [start + i, ...row]);
    const placeholders = rows.map(row => `(${row.map(() => '?').join(',')})`).join(',');
    const inserted = await connection.run(`INSERT INTO "${name}" VALUES ${placeholders}`, rows.flat()); inserted.closeSync();
  }
}
function representation(id, types) {
  if ([types.BOOLEAN].includes(id)) return 'boolean';
  if ([types.TINYINT,types.SMALLINT,types.INTEGER,types.UTINYINT,types.USMALLINT,types.UINTEGER,types.FLOAT,types.DOUBLE].includes(id)) return 'number';
  if ([types.BIGINT,types.UBIGINT,types.HUGEINT,types.UHUGEINT,types.BIGNUM].includes(id)) return 'integer-string';
  if (id === types.DECIMAL) return 'decimal-string';
  if ([types.TIMESTAMP,types.DATE,types.TIME,types.TIMESTAMP_S,types.TIMESTAMP_MS,types.TIMESTAMP_NS,types.TIME_TZ,types.TIMESTAMP_TZ,types.TIME_NS,types.TIMESTAMP_TZ_NS].includes(id)) return 'temporal-string';
  if ([types.VARCHAR,types.UUID,types.ENUM].includes(id)) return 'text';
  if (id === types.SQLNULL) return 'null';
  throw new Error('result_type_unsupported');
}
async function main(engineRoot) {
  const input = await readInput();
  if (!Array.isArray(input?.tables) || !input.tables.length || input.tables.length > 4 || input.tables.some(t => typeof t?.name !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/u.test(t.name))) throw new Error('query_invalid');
  const { database, connection } = await createEngine(engineRoot);
  let statement, result;
  try {
    await verifySettings(connection);
    for (const table of input.tables) await addTable(connection, table);
    const locked = await connection.run('SET lock_configuration = true'); locked.closeSync();
    const { StatementType, DuckDBTypeId } = await import(pathToFileURL(join(engineRoot, 'lib', 'index.js')).href);
    let extracted;
    try { extracted = await connection.extractStatements(input.query.sql); } catch { throw new Error('query_invalid'); }
    if (extracted.count !== 1) throw new Error('query_multiple_statements');
    try { statement = await extracted.prepare(0); } catch { throw new Error('query_invalid'); }
    if (statement.statementType !== StatementType.SELECT) throw new Error('query_not_select');
    if (statement.parameterCount !== input.query.parameters.length) throw new Error('parameter_count_mismatch');
    statement.bind(input.query.parameters);
    result = await statement.stream();
    if (!result.columnCount || result.columnCount > MAX_COLUMNS) throw new Error('result_schema_limit');
    const columns = Array.from({ length: result.columnCount }, (_, i) => {
      const label = result.columnName(i), sql_type = result.columnType(i).toString();
      if (!label || label.length > 160 || /[\u0000-\u001f\u007f]/u.test(label) || sql_type.length > 120) throw new Error('result_schema_limit');
      return { id: `q${i}`, label, sql_type, representation: representation(result.columnTypeId(i), DuckDBTypeId) };
    });
    const rows = [];
    for await (const batch of result.yieldRowsJson()) {
      if (rows.length + batch.length > MAX_ROWS) throw new Error('result_limit');
      for (const row of batch) for (let i = 0; i < row.length; i++) {
        const value = row[i];
        if (value !== null && columns[i].representation === 'number' && (typeof value !== 'number' || !Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) throw new Error('numeric_precision_exceeded');
      }
      rows.push(...batch);
      if (Buffer.byteLength(JSON.stringify(rows)) > MAX_BYTES) throw new Error('result_limit');
    }
    result.closeSync(); result = null;
    const version = await connection.run('SELECT version()');
    const nativeVersion = String((await version.getRowsJson())[0][0]); version.closeSync();
    return { status: 'complete', engine: { package: PACKAGE, version: ENGINE_VERSION, nativeVersion }, columns, rows, qualifications: input.qualifications };
  } finally {
    result?.closeSync(); statement?.destroySync(); connection.closeSync(); database.closeSync();
  }
}
let response;
try { response = await main(process.argv[2]); }
catch (error) { response = { status: 'failed', error: ERRORS.has(error?.message) ? error.message : 'engine_execution_failed' }; }
if (Buffer.byteLength(JSON.stringify(response)) > MAX_BYTES) response = { status: 'failed', error: 'result_limit' };
process.stdout.write(JSON.stringify(response));
