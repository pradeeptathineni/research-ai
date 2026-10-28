import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerTable } from '../src/table-analysis.mjs';
import { prepareTableQuery, queryTables, validateTableQueryResult } from '../src/table-query.mjs';

const engineRoot = process.env.RESEARCH_TABLE_TEST_ENGINE_ROOT;
const native = { skip: !engineRoot };
const table = (rows, labels = ['Project', 'Value']) => registerTable({ version: 'research-table-v1', id: `table-${randomUUID()}`, columns: labels.map((label, i) => ({ id: `c${i}`, label, type: i ? 'number' : 'text' })), rows, origin: { type: 'caller-supplied', label: 'Synthetic research inputs' } });
const bindings = () => [{ name: 'projects', table: table([['a', 10], ['b', 20], ['c', 30]]) }, { name: 'trials', table: table([['a', 3], ['c', 5], ['d', 9]]) }];
const query = sql => ({ sql, parameters: [] });
const canon = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canon).join(',')}]` : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canon(value[k])}`).join(',')}}`;

test('preview binds exact table and query identity without starting an engine', () => {
  const b = bindings(), q = query('SELECT * FROM projects'); const original = structuredClone(b);
  const p = prepareTableQuery(b, q);
  assert.equal(p.version, 'research-table-query-preview-v1'); assert.equal(p.inputs[0].columns[0].sql_name, 'c0');
  assert.deepEqual(prepareTableQuery(b, q), p); assert.deepEqual(b, original);
  assert.notEqual(prepareTableQuery(b, query('SELECT * FROM projects ')).query_digest, p.query_digest);
  const modified = structuredClone(b); modified[0].table.rows[0][1] = 99;
  assert.throws(() => prepareTableQuery(modified, q), /digest does not match/);
  assert.throws(() => prepareTableQuery([{ name: 'x; DROP TABLE x', table: b[0].table }], q), /Table names/);
  assert.throws(() => prepareTableQuery(b, { ...q, parameters: [Infinity] }), /primitive parameters/);
  const getter = []; Object.defineProperty(getter, '0', { enumerable: true, get() { throw new Error('getter ran'); } });
  assert.throws(() => prepareTableQuery(getter, q), /dense plain array/);
});

test('real DuckDB joins datasets and calculates a window without losing source-row mapping', native, async () => {
  const b = bindings(), before = structuredClone(b);
  const q = { sql: 'SELECT p._row AS project_row, t._row AS trial_row, p.c0 AS project, t.c1 AS latency, ROW_NUMBER() OVER (ORDER BY p.c0) AS rank FROM projects p LEFT JOIN trials t ON p.c0=t.c0 WHERE p.c1 >= ? ORDER BY p.c0', parameters: [10] };
  const r = await queryTables(b, q, { engineRoot });
  assert.equal(r.status, 'complete', JSON.stringify(r));
  assert.deepEqual(r.rows, [[0, 0, 'a', 3, '1'], [1, null, 'b', null, '2'], [2, 1, 'c', 5, '3']]);
  const p = prepareTableQuery(b, q); assert.equal(r.input_digest, p.input_digest); assert.equal(r.query_digest, p.query_digest);
  assert.equal(r.inputs[1].sha256, b[1].table.sha256); assert.deepEqual(b, before);
  const { result_sha256, ...raw } = r; assert.equal(result_sha256, createHash('sha256').update(canon(raw)).digest('hex'));
});

test('SQL supports grouped comparisons, nulls and empty results with parameters kept as data', native, async () => {
  const b = bindings();
  let r = await queryTables(b, { sql: 'SELECT COUNT(*) AS n FROM projects p JOIN trials t ON p.c0=t.c0 WHERE p.c0=?', parameters: ["a' OR true --"] }, { engineRoot });
  assert.equal(r.status, 'complete'); assert.deepEqual(r.rows, [['0']]);
  r = await queryTables(b, query('SELECT p.c0, SUM(t.c1) AS sum FROM projects p JOIN trials t ON p.c0=t.c0 GROUP BY p.c0 ORDER BY p.c0'), { engineRoot });
  assert.equal(r.status, 'complete'); assert.deepEqual(r.rows, [['a', 3], ['c', 5]]);
  r = await queryTables(b, query('SELECT c0 FROM projects WHERE false'), { engineRoot }); assert.equal(r.status, 'complete'); assert.deepEqual(r.rows, []);
});

test('big integer and decimal result values stay exact, floating overflow and rich result types refuse', native, async () => {
  let r = await queryTables(bindings(), query("SELECT 9223372036854775807::BIGINT AS big, 1.20::DECIMAL(20,2) AS exact, NULL AS missing"), { engineRoot });
  assert.equal(r.status, 'complete', JSON.stringify(r)); assert.deepEqual(r.rows, [['9223372036854775807', '1.20', null]]);
  assert.equal(r.columns[0].representation, 'integer-string'); assert.equal(r.columns[1].representation, 'decimal-string');
  r = await queryTables(bindings(), query('SELECT 1.0/0 AS bad'), { engineRoot }); assert.equal(r.status, 'failed'); assert.equal(r.error, 'numeric_precision_exceeded');
  r = await queryTables(bindings(), query('SELECT [1,2] AS rich'), { engineRoot }); assert.equal(r.status, 'failed'); assert.equal(r.error, 'result_type_unsupported');
});

test('read-only parser admission rejects multiple statements and mutations, external reads and extensions remain unavailable', native, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'research-query-'));
  try {
    const source = join(dir, 'synthetic.txt'), output = join(dir, 'must-not-exist.csv'); await writeFile(source, 'synthetic canary');
    for (const sql of ['SELECT 1; SELECT 2', 'DROP TABLE projects', "INSTALL httpfs", 'SET enable_external_access=true', `SELECT * FROM read_text('${source}')`, `SELECT 1; COPY projects TO '${output}'`]) {
      const r = await queryTables(bindings(), query(sql), { engineRoot }); assert.equal(r.status, 'failed', sql); assert.equal(r.rows, undefined);
    }
    assert.equal(await readFile(source, 'utf8'), 'synthetic canary'); await assert.rejects(access(output));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('overlarge joins refuse whole results and abort/deadline never return partial rows', native, async () => {
  const b = [{ name: 'lefts', table: table(Array.from({ length: 40 }, () => ['x', 1])) }, { name: 'rights', table: table(Array.from({ length: 40 }, () => ['x', 2])) }];
  let r = await queryTables(b, query('SELECT l.c0 FROM lefts l JOIN rights r ON l.c0=r.c0'), { engineRoot }); assert.equal(r.status, 'failed'); assert.equal(r.error, 'result_limit'); assert.equal(r.rows, undefined);
  const controller = new AbortController(); controller.abort(); r = await queryTables(bindings(), query('SELECT 1'), { engineRoot, signal: controller.signal }); assert.equal(r.status, 'unknown'); assert.equal(r.reason, 'aborted');
  r = await queryTables(bindings(), query('SELECT 1'), { engineRoot, timeoutMs: 1 }); assert.equal(r.status, 'unknown'); assert.ok(['deadline', 'worker_cleanup_unconfirmed'].includes(r.reason)); assert.equal(r.rows, undefined);
});

test('CLI preview and actual query follow the same standalone contract', native, () => {
  const input = JSON.stringify({ tables: bindings(), query: query('SELECT p.c0 FROM projects p JOIN trials t ON p.c0=t.c0 ORDER BY p.c0') });
  const cli = new URL('../bin/research-table-query.mjs', import.meta.url);
  let run = spawnSync(process.execPath, [cli.pathname, '--preview'], { input, encoding: 'utf8' }); assert.equal(run.status, 0, run.stdout); const preview = JSON.parse(run.stdout);
  run = spawnSync(process.execPath, [cli.pathname, '--engine-root', engineRoot], { input, encoding: 'utf8' }); assert.equal(run.status, 0, run.stdout); const result = JSON.parse(run.stdout);
  assert.deepEqual(result.rows, [['a'], ['c']]); assert.equal(result.input_digest, preview.input_digest);
});


test('completed result replay is pure and checks query, result and original dataset bindings', native, async () => {
  const b = bindings(), q = query('SELECT _row, c0 FROM projects ORDER BY c0');
  const result = await queryTables(b, q, { engineRoot }); assert.equal(result.status, 'complete');
  const saved = JSON.parse(JSON.stringify(result));
  assert.deepEqual(validateTableQueryResult(saved), saved);
  assert.deepEqual(validateTableQueryResult(saved, { tables: b }), saved);
  const changed = structuredClone(saved); changed.rows[0][1] = 'changed';
  assert.throws(() => validateTableQueryResult(changed), /result digest changed/);
  const withoutLimits = structuredClone(saved); withoutLimits.qualifications = [];
  assert.throws(() => validateTableQueryResult(withoutLimits), /shape or value/);
  const wrongQuery = structuredClone(saved); wrongQuery.query.sql += ' ';
  assert.throws(() => validateTableQueryResult(wrongQuery), /query binding changed/);
  const other = bindings(); assert.throws(() => validateTableQueryResult(saved, { tables: other }), /do not match/);
  assert.throws(() => validateTableQueryResult({ ...saved, status: 'unknown' }), /completed/);
  assert.throws(() => validateTableQueryResult(saved, { engineRoot }), /Only original tables/);
});

test('malformed Unicode, oversized query and mismatched parameter counts never produce a result', native, async () => {
  const b = bindings();
  const bad = table([['bad\ud800', 1]]);
  assert.throws(() => prepareTableQuery([{name:'bad',table:bad}], query('SELECT 1')), /well-formed/);
  assert.throws(() => prepareTableQuery(b, query('x'.repeat(8001))), /8,000/);
  const result = await queryTables(b, {sql:'SELECT ? AS n', parameters:[]}, {engineRoot});
  assert.equal(result.status, 'failed'); assert.equal(result.error, 'parameter_count_mismatch');
});
