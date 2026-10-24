import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';

const TABLE_VERSION = 'research-table-v1';
const RESULT_VERSION = 'research-table-result-v1';
const ENGINE_VERSION = '2.0.0-r.1';
const MAX_ROWS = 1_000;
const MAX_COLUMNS = 16;
const MAX_BYTES = 1_000_000;
const MAX_GROUPS = 1_000;
const MAX_TIMEOUT_MS = 2_000;
const CLEANUP_GRACE_MS = 300;
const MAX_OUTPUT_BYTES = 2_000_000;
const SAFE_WORKER_ERRORS = new Set([
  'engine_unavailable', 'engine_package_mismatch', 'engine_sandbox_settings_mismatch',
  'worker_input_limit', 'invalid_worker_input', 'group_limit_exceeded',
  'numeric_precision_exceeded', 'engine_execution_failed', 'worker_output_limit',
  'engine_worker_start_failed', 'engine_worker_failed', 'engine_worker_invalid_response',
  'engine_worker_binding_mismatch',
]);
const WORKER = fileURLToPath(new URL('./table-analysis-worker.mjs', import.meta.url));
const TYPES = new Set(['text', 'number', 'boolean']);
const AGGREGATES = new Set(['count', 'sum', 'avg', 'min', 'max']);

function fail(code, message) {
  throw Object.assign(new TypeError(message), { code });
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function closed(value, keys, name) {
  if (!plain(value)) fail('invalid_input', `${name} must be an object.`);
  if (Object.getOwnPropertySymbols(value).length) fail('invalid_input', `${name} has unsupported properties.`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key)))
    fail('invalid_input', `${name} has missing or unsupported fields.`);
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value'))
      fail('invalid_input', `${name} fields must be plain values.`);
  }
}

function text(value, name, max = 120) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value))
    fail('invalid_input', `${name} is invalid.`);
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function digest(value) {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function safeArray(value, name) {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length || Object.getOwnPropertySymbols(value).length)
    fail('invalid_input', `${name} must be a dense array.`);
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value'))
      fail('invalid_input', `${name} entries must be plain values.`);
  }
}

function typeMatches(value, type, name) {
  if (value === null) return;
  if (type === 'text' && typeof value === 'string') return;
  if (type === 'boolean' && typeof value === 'boolean') return;
  if (type === 'number' && typeof value === 'number' && Number.isFinite(value) &&
      (!Number.isInteger(value) || Number.isSafeInteger(value))) return;
  fail('invalid_input', `${name} does not match its declared type.`);
}

function coreTable(table) {
  return {
    version: table.version,
    id: table.id,
    columns: table.columns,
    rows: table.rows,
    origin: table.origin,
  };
}

function freezeTree(value) {
  if (Array.isArray(value)) {
    for (const item of value) freezeTree(item);
  } else if (plain(value)) {
    for (const item of Object.values(value)) freezeTree(item);
  }
  return Object.freeze(value);
}

function validateRawTable(table) {
  closed(table, ['version', 'id', 'columns', 'rows', 'origin'], 'table');
  if (table.version !== TABLE_VERSION) fail('invalid_input', 'Unsupported table version.');
  if (typeof table.id !== 'string' || !/^table-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(table.id))
    fail('invalid_input', 'Table ID must be a table-prefixed UUID.');
  safeArray(table.columns, 'columns');
  if (table.columns.length < 1 || table.columns.length > MAX_COLUMNS)
    fail('limit_exceeded', 'Column count is outside the allowed range.');
  const columnIds = new Set();
  for (const [index, column] of table.columns.entries()) {
    closed(column, ['id', 'label', 'type'], `columns[${index}]`);
    text(column.id, `columns[${index}].id`, 80);
    text(column.label, `columns[${index}].label`);
    if (!TYPES.has(column.type)) fail('invalid_input', `columns[${index}].type is unsupported.`);
    if (columnIds.has(column.id)) fail('invalid_input', 'Column IDs must be unique.');
    columnIds.add(column.id);
  }
  safeArray(table.rows, 'rows');
  if (table.rows.length > MAX_ROWS) fail('limit_exceeded', 'Row count exceeds 1,000.');
  for (const [rowIndex, row] of table.rows.entries()) {
    safeArray(row, `rows[${rowIndex}]`);
    if (row.length !== table.columns.length) fail('invalid_input', `rows[${rowIndex}] has the wrong width.`);
    row.forEach((value, columnIndex) => typeMatches(value, table.columns[columnIndex].type, `rows[${rowIndex}][${columnIndex}]`));
  }
  closed(table.origin, ['type', 'label'], 'origin');
  if (table.origin.type !== 'caller-authored') fail('invalid_input', 'Only caller-authored tables are accepted.');
  text(table.origin.label, 'origin.label');
  const canonicalInput = canonical(coreTable(table));
  if (Buffer.byteLength(canonicalInput, 'utf8') > MAX_BYTES)
    fail('limit_exceeded', 'Canonical table input exceeds 1 MiB.');
  return JSON.parse(canonicalInput);
}

/** Validate a caller-authored table and bind its exact canonical JSON digest. */
export function registerTable(table) {
  const value = validateRawTable(table);
  return freezeTree({ ...value, sha256: digest(value) });
}

function verifyTable(table) {
  closed(table, ['version', 'id', 'columns', 'rows', 'origin', 'sha256'], 'registered table');
  const validated = validateRawTable(coreTable(table));
  if (table.sha256 !== digest(validated)) fail('table_digest_mismatch', 'Registered table digest does not match its contents.');
  return { ...validated, sha256: table.sha256 };
}

function validateQuery(query, table) {
  if (!plain(query)) fail('invalid_input', 'query must be an object.');
  const keys = Object.keys(query);
  if (keys.some((key) => !['aggregate', 'column_id', 'group_by', 'where'].includes(key)) ||
      !Object.hasOwn(query, 'aggregate')) fail('invalid_input', 'query has missing or unsupported fields.');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(query, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('invalid_input', 'query fields must be plain values.');
  }
  if (Object.getOwnPropertySymbols(query).length || !AGGREGATES.has(query.aggregate))
    fail('invalid_input', 'Aggregate operation is unsupported.');
  const columns = new Map(table.columns.map((column, index) => [column.id, { ...column, index }]));
  const column = query.column_id === undefined ? null : columns.get(query.column_id);
  const group = query.group_by === undefined ? null : columns.get(query.group_by);
  if (query.column_id !== undefined && !column) fail('invalid_input', 'Aggregate column is unknown.');
  if (query.group_by !== undefined && !group) fail('invalid_input', 'Group column is unknown.');
  if (query.aggregate !== 'count' && !column) fail('invalid_input', 'This aggregate requires a column.');
  if (['sum', 'avg'].includes(query.aggregate) && column.type !== 'number')
    fail('invalid_input', `${query.aggregate} requires a number column.`);
  let where = null;
  if (query.where !== undefined) {
    closed(query.where, ['column_id', 'op', 'value'], 'where');
    const filterColumn = columns.get(query.where.column_id);
    if (!filterColumn || query.where.op !== 'eq') fail('invalid_input', 'Filter must use an existing column and eq.');
    typeMatches(query.where.value, filterColumn.type, 'where.value');
    where = { column: filterColumn, value: query.where.value };
  }
  const normalized = {
    aggregate: query.aggregate,
    ...(query.column_id === undefined ? {} : { column_id: query.column_id }),
    ...(query.group_by === undefined ? {} : { group_by: query.group_by }),
    ...(query.where === undefined ? {} : { where: { column_id: query.where.column_id, op: 'eq', value: query.where.value } }),
  };
  return { normalized, column, group, where };
}

function failure(code) {
  return { version: RESULT_VERSION, status: 'failed', error: code };
}

function unknown(code) {
  return { version: RESULT_VERSION, status: 'unknown', reason: code };
}

function validWorkerResult(value, tableDigest, queryDigest) {
  if (!plain(value) || value.version !== RESULT_VERSION ||
      !['complete', 'failed', 'unknown'].includes(value.status)) return null;
  if (value.status === 'failed') {
    if (Object.keys(value).some((key) => !['version', 'status', 'error', 'input_digest', 'query_digest'].includes(key)) ||
        typeof value.error !== 'string' || !SAFE_WORKER_ERRORS.has(value.error)) return null;
    return { version: RESULT_VERSION, status: 'failed', error: value.error, input_digest: tableDigest, query_digest: queryDigest };
  }
  if (value.status === 'unknown') {
    if (Object.keys(value).some((key) => !['version', 'status', 'reason', 'input_digest', 'query_digest'].includes(key)) ||
        typeof value.reason !== 'string' || !['deadline', 'aborted', 'worker_cleanup_unconfirmed'].includes(value.reason)) return null;
    return { version: RESULT_VERSION, status: 'unknown', reason: value.reason, input_digest: tableDigest, query_digest: queryDigest };
  }
  const keys = ['version', 'status', 'input_digest', 'query_digest', 'engine', 'columns', 'rows', 'qualifications'];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key)) ||
      value.input_digest !== tableDigest || value.query_digest !== queryDigest || !plain(value.engine) ||
      Object.keys(value.engine).length !== 3 || value.engine.package !== '@duckdb/node-api' ||
      value.engine.version !== ENGINE_VERSION || typeof value.engine.nativeVersion !== 'string' ||
      value.engine.nativeVersion.length > 80 || !Array.isArray(value.columns) ||
      value.columns.length < 1 || value.columns.length > 2 || !Array.isArray(value.rows) ||
      value.rows.length > MAX_GROUPS || !Array.isArray(value.qualifications) ||
      value.qualifications.length > 8 || value.qualifications.some((item) => typeof item !== 'string' || item.length > 300)) return null;
  const validTypes = new Set(['text', 'number', 'boolean', 'integer']);
  for (const column of value.columns) {
    if (!plain(column) || Object.keys(column).length !== 3 || typeof column.id !== 'string' ||
        typeof column.label !== 'string' || column.label.length > 160 || !validTypes.has(column.type)) return null;
  }
  for (const row of value.rows) {
    if (!Array.isArray(row) || row.length !== value.columns.length) return null;
    for (let index = 0; index < row.length; index++) {
      const item = row[index];
      if (item === null) continue;
      const type = value.columns[index].type;
      if (type === 'text' && typeof item !== 'string') return null;
      if (type === 'boolean' && typeof item !== 'boolean') return null;
      if (type === 'number' && (typeof item !== 'number' || !Number.isFinite(item) ||
          (Number.isInteger(item) && !Number.isSafeInteger(item)))) return null;
      if (type === 'integer' && !(Number.isSafeInteger(item) || (typeof item === 'string' && /^-?\d+$/u.test(item)))) return null;
    }
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_OUTPUT_BYTES) return null;
  return value;
}

function hasProcessGroup(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function terminate(child) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error.code === 'ESRCH') return;
    try { child.kill('SIGKILL'); } catch {}
  }
}

function runWorker(input, engineRoot, timeoutMs, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(unknown('aborted'));
      return;
    }
    let child;
    try {
      child = spawn(process.execPath, [WORKER, engineRoot], {
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { PATH: '/usr/bin:/bin' },
      });
    } catch {
      resolve(failure('engine_worker_start_failed'));
      return;
    }
    let stdout = Buffer.alloc(0);
    let outputOverflow = false;
    let expired = false;
    let aborted = false;
    let settled = false;
    let cleanupTimer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      signal?.removeEventListener('abort', abort);
      resolve(value);
    };
    const stopAndBoundCleanup = () => {
      terminate(child);
      if (cleanupTimer) return;
      cleanupTimer = setTimeout(() => {
        const groupRemains = process.platform !== 'win32' && child.pid !== undefined && hasProcessGroup(child.pid);
        if (groupRemains) terminate(child);
        // A blocked/unavailable close event must not pin the caller forever.
        // This returns only an unknown status; no partial stdout is accepted.
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
        child.unref();
        finish(unknown('worker_cleanup_unconfirmed'));
      }, CLEANUP_GRACE_MS);
      cleanupTimer.unref?.();
    };
    const abort = () => {
      aborted = true;
      stopAndBoundCleanup();
    };
    const timer = setTimeout(() => {
      expired = true;
      stopAndBoundCleanup();
    }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', (chunk) => {
      if (stdout.length + chunk.length > MAX_OUTPUT_BYTES) {
        outputOverflow = true;
        terminate(child);
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.on('error', () => finish(failure('engine_worker_start_failed')));
    child.on('close', (code, childSignal) => {
      if (expired || aborted || outputOverflow) {
        const groupRemains = process.platform !== 'win32' && child.pid !== undefined && hasProcessGroup(child.pid);
        finish(groupRemains ? unknown('worker_cleanup_unconfirmed') :
          outputOverflow ? failure('worker_output_limit') : unknown(aborted ? 'aborted' : 'deadline'));
        return;
      }
      if (process.platform !== 'win32' && child.pid !== undefined && hasProcessGroup(child.pid)) {
        terminate(child);
        finish(unknown('worker_cleanup_unconfirmed'));
        return;
      }
      if (code !== 0 || childSignal || stdout.length === 0) {
        finish(failure('engine_worker_failed'));
        return;
      }
      try {
        const response = JSON.parse(stdout.toString('utf8'));
        // Worker output is treated as untrusted structured data. In particular,
        // don't allow an error envelope to smuggle local paths to API callers.
        finish(response);
      } catch {
        finish(failure('engine_worker_invalid_response'));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

/** Run the closed aggregate query in a short-lived, restricted DuckDB worker. */
export async function analyzeTable(table, query, options = {}) {
  const registered = verifyTable(table);
  const parsed = validateQuery(query, registered);
  if (!plain(options) || Object.getOwnPropertySymbols(options).length ||
      Object.keys(options).some((key) => !['engineRoot', 'signal', 'timeoutMs'].includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(options, key) ?? {}, 'value')))
    fail('invalid_options', 'Analysis options are invalid.');
  if (typeof options.engineRoot !== 'string' || !isAbsolute(options.engineRoot))
    fail('invalid_options', 'engineRoot must be an absolute host-configured package path.');
  const timeoutMs = options.timeoutMs ?? MAX_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS)
    fail('invalid_options', 'timeoutMs must be an integer from 1 through 2,000.');
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    fail('invalid_options', 'signal must be an AbortSignal.');
  const queryDigest = digest(parsed.normalized);
  const result = await runWorker({ table: registered, query: parsed.normalized, queryDigest }, options.engineRoot, timeoutMs, options.signal);
  return validWorkerResult(result, registered.sha256, queryDigest) ?? {
    ...failure('engine_worker_invalid_response'), input_digest: registered.sha256, query_digest: queryDigest,
  };
}

export const tableAnalysisLimits = Object.freeze({ rows: MAX_ROWS, columns: MAX_COLUMNS, bytes: MAX_BYTES, groups: MAX_GROUPS, timeoutMs: MAX_TIMEOUT_MS });
