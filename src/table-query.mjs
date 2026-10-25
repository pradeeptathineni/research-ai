import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerTable } from './table-analysis.mjs';

const VERSION = 'research-table-query-result-v1';
const WORKER = fileURLToPath(new URL('./table-query-worker.mjs', import.meta.url));
const ENGINE_VERSION = '2.0.0-r.1';
const QUALIFICATIONS = Object.freeze([
  'Supplied table values and query results are not independently verified evidence or confidence judgments.',
  'Result provenance binds the selected tables and exact query; it does not infer row or cell lineage. Select _row explicitly when needed.',
  'Floating-point calculations may round. Big integers and decimals use exact textual representations.',
  'Order requires an explicit ORDER BY; volatile SQL functions can change values on a new run. Reopening a retained result must not execute it again.'
]);

export const tableQueryLimits = Object.freeze({ tables: 4, inputBytes: 2_000_000, sqlUnits: 8000, parameters: 32, rows: 1000, columns: 32, resultBytes: 2_000_000, timeoutMs: 2000, cleanupGraceMs: 300 });
const ERRORS = new Set(['engine_unavailable', 'engine_package_mismatch', 'engine_settings_mismatch', 'query_invalid', 'query_not_select', 'query_multiple_statements', 'parameter_count_mismatch', 'result_limit', 'result_type_unsupported', 'result_schema_limit', 'numeric_precision_exceeded', 'engine_execution_failed', 'worker_failed', 'worker_invalid_response', 'worker_output_limit']);
const REASONS = new Set(['deadline', 'aborted', 'worker_cleanup_unconfirmed']);
const REPRESENTATIONS = new Set(['number', 'text', 'boolean', 'integer-string', 'decimal-string', 'temporal-string', 'null']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function fail(code, message) { throw Object.assign(new TypeError(message), { code }); }
function closed(value, keys, label) {
  if (!plain(value) || Object.getOwnPropertySymbols(value).length || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')))
    fail('invalid_input', `${label} must contain only ${keys.join(', ')} as plain values.`);
}
function array(value, label) {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length || Object.getOwnPropertySymbols(value).length || Array.from({ length: value.length }, (_, i) => i).some(i => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, String(i)) ?? {}, 'value')))
    fail('invalid_input', `${label} must be a dense plain array.`);
}
function primitive(value) {
  return value === null || typeof value === 'boolean' || (typeof value === 'string' && value.isWellFormed()) || (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)));
}
function validateQuery(query) {
  closed(query, ['sql', 'parameters'], 'query');
  if (typeof query.sql !== 'string' || !query.sql.trim() || !query.sql.isWellFormed() || query.sql.includes('\0') || query.sql.length > tableQueryLimits.sqlUnits) fail('invalid_input', 'SQL must be nonempty text of at most 8,000 UTF-16 units.');
  array(query.parameters, 'parameters');
  if (query.parameters.length > tableQueryLimits.parameters || query.parameters.some(value => !primitive(value) || (typeof value === 'string' && value.length > 4096))) fail('invalid_input', 'Use at most 32 primitive parameters, with strings no longer than 4,096 units.');
  return { sql: query.sql, parameters: [...query.parameters] };
}
function prepare(tables, query) {
  array(tables, 'tables');
  if (!tables.length || tables.length > tableQueryLimits.tables) fail('limit_exceeded', 'Select one through four tables.');
  const names = new Set(), identities = new Map();
  const validated = tables.map((item) => {
    closed(item, ['name', 'table'], 'table binding');
    if (typeof item.name !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/u.test(item.name) || names.has(item.name)) fail('invalid_input', 'Table names must be unique lowercase SQL identifiers, at most 32 characters.');
    names.add(item.name);
    closed(item.table, ['version', 'id', 'columns', 'rows', 'origin', 'sha256'], 'registered table');
    const { sha256, ...raw } = item.table;
    const table = registerTable(raw);
    if (table.sha256 !== sha256) fail('table_digest_mismatch', 'Registered table digest does not match its contents.');
    const texts = [table.origin.label, ...table.columns.flatMap(c => [c.id, c.label]), ...table.rows.flat().filter(v => typeof v === 'string')];
    if (texts.some(v => !v.isWellFormed())) fail('invalid_input', 'Table text must contain well-formed Unicode.');
    if (identities.has(table.id) && identities.get(table.id) !== sha256) fail('table_digest_mismatch', 'The same table ID has conflicting contents.');
    identities.set(table.id, sha256);
    return { name: item.name, table };
  });
  const exactQuery = validateQuery(query);
  const input = { tables: validated, query: exactQuery, qualifications: QUALIFICATIONS };
  if (Buffer.byteLength(JSON.stringify({ tables: validated, query: exactQuery })) > tableQueryLimits.inputBytes) fail('limit_exceeded', 'Combined query input exceeds 2,000,000 bytes.');
  const inputs = validated.map(({ name, table }) => ({ name, id: table.id, sha256: table.sha256, row_count: table.rows.length, row_column: '_row', origin: table.origin, columns: table.columns.map((column, i) => ({ ...column, sql_name: `c${i}` })) }));
  return { input, inputs, query: exactQuery, input_digest: hash(inputs), query_digest: hash(exactQuery) };
}

/** Inspect the exact selected inputs and query without starting an engine. */
export function prepareTableQuery(tables, query) {
  const { inputs, query: exact, input_digest, query_digest } = prepare(tables, query);
  return { version: 'research-table-query-preview-v1', input_digest, query_digest, inputs, query: exact, limits: tableQueryLimits };
}
function stop(child) {
  if (!child.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
}
function groupRemains(child) {
  if (!child.pid || process.platform === 'win32') return false;
  try { process.kill(-child.pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function run(input, engineRoot, timeoutMs, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve({ status: 'unknown', reason: 'aborted' }); return; }
    let child, settled = false, reason = null, overflow = false, bytes = Buffer.alloc(0), cleanupTimer;
    let timer;
    const finish = value => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(cleanupTimer); signal?.removeEventListener('abort', abort); resolve(value);
    };
    const halt = value => {
      reason ??= value; stop(child);
      if (!cleanupTimer) {
        cleanupTimer = setTimeout(() => {
          stop(child); child.stdout?.destroy(); child.stdin?.destroy(); child.unref();
          finish({ status: 'unknown', reason: 'worker_cleanup_unconfirmed' });
        }, tableQueryLimits.cleanupGraceMs);
      }
    };
    const abort = () => halt('aborted');
    try {
      child = spawn(process.execPath, ['--max-old-space-size=128', WORKER, engineRoot], { detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin' } });
    } catch { finish({ status: 'failed', error: 'worker_failed' }); return; }
    timer = setTimeout(() => halt('deadline'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      if (bytes.length + chunk.length > tableQueryLimits.resultBytes) { overflow = true; halt('output_limit'); return; }
      if (!overflow) bytes = Buffer.concat([bytes, chunk]);
    });
    child.on('error', () => { if (child.pid) halt('worker_error'); else finish({ status: 'failed', error: 'worker_failed' }); });
    child.on('close', code => {
      if (settled) return;
      const remains = groupRemains(child); if (remains) stop(child);
      if (remains) { finish({ status: 'unknown', reason: 'worker_cleanup_unconfirmed' }); return; }
      if (overflow) { finish({ status: 'failed', error: 'worker_output_limit' }); return; }
      if (reason) { finish(REASONS.has(reason) ? { status: 'unknown', reason } : { status: 'failed', error: 'worker_failed' }); return; }
      if (code !== 0) { finish({ status: 'failed', error: 'worker_failed' }); return; }
      try { finish(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); } catch { finish({ status: 'failed', error: 'worker_invalid_response' }); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
function valid(value) {
  try {
    if (!plain(value)) return false;
    if (value.status === 'failed') { closed(value, ['status', 'error'], 'worker'); return ERRORS.has(value.error); }
    if (value.status === 'unknown') { closed(value, ['status', 'reason'], 'worker'); return REASONS.has(value.reason); }
    closed(value, ['status', 'engine', 'columns', 'rows', 'qualifications'], 'worker');
    if (value.status !== 'complete') return false;
    closed(value.engine, ['package', 'version', 'nativeVersion'], 'engine');
    if (value.engine.package !== '@duckdb/node-api' || value.engine.version !== ENGINE_VERSION || typeof value.engine.nativeVersion !== 'string' || value.engine.nativeVersion.length > 80) return false;
    array(value.columns, 'columns'); array(value.rows, 'rows'); array(value.qualifications, 'qualifications');
    if (!value.columns.length || value.columns.length > tableQueryLimits.columns || value.rows.length > tableQueryLimits.rows || value.qualifications.length !== QUALIFICATIONS.length || value.qualifications.some((x, i) => x !== QUALIFICATIONS[i])) return false;
    for (const [index, c] of value.columns.entries()) {
      closed(c, ['id', 'label', 'sql_type', 'representation'], 'column');
      if (c.id !== `q${index}` || typeof c.label !== 'string' || !c.label.length || !c.label.isWellFormed() || /[\u0000-\u001f\u007f]/u.test(c.label) || c.label.length > 160 || typeof c.sql_type !== 'string' || c.sql_type.length > 120 || !REPRESENTATIONS.has(c.representation)) return false;
    }
    for (const row of value.rows) {
      array(row, 'row'); if (row.length !== value.columns.length) return false;
      for (let i = 0; i < row.length; i++) {
        const v = row[i], repr = value.columns[i].representation;
        if (!primitive(v)) return false;
        if (v === null) continue;
        if (repr === 'number' && typeof v !== 'number') return false;
        if (repr === 'boolean' && typeof v !== 'boolean') return false;
        if (repr.endsWith('string') || repr === 'text') { if (typeof v !== 'string') return false; }
        if (repr === 'integer-string' && !/^-?\d+$/u.test(v)) return false;
        if (repr === 'decimal-string' && !/^-?\d+(?:\.\d+)?$/u.test(v)) return false;
        if (repr === 'null') return false;
      }
    }
    return Buffer.byteLength(JSON.stringify(value)) <= tableQueryLimits.resultBytes;
  } catch { return false; }
}

/** Validate a completed retained artifact offline, optionally against its original registered inputs. */
export function validateTableQueryResult(value, options = {}) {
  closed(value, ['version','status','input_digest','query_digest','inputs','query','engine','columns','rows','qualifications','result_sha256'], 'retained result');
  if (value.version !== VERSION || value.status !== 'complete') fail('invalid_result', 'Only completed table-query artifacts can be reopened.');
  const outcome = { status: value.status, engine: value.engine, columns: value.columns, rows: value.rows, qualifications: value.qualifications };
  if (!valid(outcome)) fail('invalid_result', 'Retained result shape or value representation is invalid.');
  array(value.inputs, 'inputs');
  if (!value.inputs.length || value.inputs.length > tableQueryLimits.tables) fail('invalid_result', 'Retained input bindings exceed their limit.');
  const names = new Set(), identities = new Map();
  for (const meta of value.inputs) {
    closed(meta, ['name','id','sha256','row_count','row_column','origin','columns'], 'input binding');
    if (typeof meta.name !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/u.test(meta.name) || names.has(meta.name) || meta.row_column !== '_row' || typeof meta.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(meta.sha256) || !Number.isInteger(meta.row_count) || meta.row_count < 0 || meta.row_count > 1000) fail('invalid_result', 'Retained input identity is invalid.');
    names.add(meta.name);
    if (identities.has(meta.id) && identities.get(meta.id) !== meta.sha256) fail('invalid_result', 'Conflicting retained table identity.');
    identities.set(meta.id, meta.sha256);
    array(meta.columns, 'input columns');
    const columns = meta.columns.map((column, i) => {
      closed(column, ['id','label','type','sql_name'], 'input column');
      if (column.sql_name !== `c${i}`) fail('invalid_result', 'Retained SQL column mapping changed.');
      const { sql_name, ...source } = column; return source;
    });
    // reuse the registered-table schema for declared metadata, without inventing source rows
    registerTable({ version: 'research-table-v1', id: meta.id, columns, rows: [], origin: meta.origin });
  }
  const exactQuery = validateQuery(value.query);
  if (value.input_digest !== hash(value.inputs) || value.query_digest !== hash(exactQuery)) fail('result_digest_mismatch', 'Retained input or query binding changed.');
  const { result_sha256, ...content } = value;
  if (result_sha256 !== hash(content)) fail('result_digest_mismatch', 'Retained result digest changed.');
  if (Buffer.byteLength(JSON.stringify(value)) > tableQueryLimits.resultBytes) fail('limit_exceeded', 'Retained result exceeds its byte cap.');
  if (!plain(options) || Object.getOwnPropertySymbols(options).length || Object.keys(options).some(key => key !== 'tables' || !Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), 'value'))) fail('invalid_options', 'Only original tables may be supplied for replay validation.');
  if (options.tables !== undefined) {
    const original = prepare(options.tables, exactQuery);
    if (original.input_digest !== value.input_digest) fail('result_digest_mismatch', 'Original registered tables do not match this result.');
  }
  return JSON.parse(JSON.stringify(value));
}

/** Run one parsed SELECT against explicit in-memory tables; it never acquires or stores data. */
export async function queryTables(tables, query, options = {}) {
  const prepared = prepare(tables, query);
  if (!plain(options) || Object.getOwnPropertySymbols(options).length || Object.keys(options).some(key => !['engineRoot', 'signal', 'timeoutMs'].includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), 'value'))) fail('invalid_options', 'Invalid table-query options.');
  if (typeof options.engineRoot !== 'string' || !isAbsolute(options.engineRoot)) fail('invalid_options', 'engineRoot must be an absolute host-configured package path.');
  const timeoutMs = options.timeoutMs ?? tableQueryLimits.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > tableQueryLimits.timeoutMs || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) fail('invalid_options', 'Use a valid AbortSignal and timeout from 1 through 2,000ms.');
  let outcome = await run(prepared.input, options.engineRoot, timeoutMs, options.signal);
  if (!valid(outcome)) outcome = { status: 'failed', error: 'worker_invalid_response' };
  const bindings = { version: VERSION, input_digest: prepared.input_digest, query_digest: prepared.query_digest };
  if (outcome.status !== 'complete') return { ...bindings, ...outcome };
  const result = { ...bindings, ...outcome, inputs: prepared.inputs, query: prepared.query };
  if (Buffer.byteLength(JSON.stringify(result)) > tableQueryLimits.resultBytes) return { ...bindings, status: 'failed', error: 'worker_output_limit' };
  const artifact = { ...result, result_sha256: hash(result) };
  if (Buffer.byteLength(JSON.stringify(artifact)) > tableQueryLimits.resultBytes) return { ...bindings, status: 'failed', error: 'worker_output_limit' };
  return artifact;
}
