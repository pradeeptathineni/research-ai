import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerTable, analyzeTable, tableAnalysisLimits } from '../src/table-analysis.mjs';

const engineRoot = process.env.RESEARCH_TABLE_TEST_ENGINE_ROOT;
const raw = () => ({
  version: 'research-table-v1',
  id: 'table-4f7d831d-fb2b-4a4b-89f4-c06c8cf08699',
  columns: [
    { id: 'category', label: 'Category\"; DROP TABLE registered_input; --', type: 'text' },
    { id: 'value', label: 'Value', type: 'number' },
    { id: 'include', label: 'Include', type: 'boolean' },
  ],
  rows: [['B', 2, true], ['A', 3, true], ['A', 5, false], [null, 7, true]],
  origin: { type: 'caller-authored', label: 'Synthetic values' },
});

test('registerTable binds exact typed caller-authored bytes and rejects shape/type drift', async () => {
  const input = raw();
  const registered = registerTable(input);
  assert.match(registered.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(Object.isFrozen(registered), true);
  assert.equal(Object.isFrozen(registered.rows[0]), true);
  assert.throws(() => registerTable({ ...input, sha256: '0'.repeat(64) }), /unsupported fields/u);
  assert.throws(() => registerTable({ ...input, rows: [['B', Number.MAX_SAFE_INTEGER + 1, true]] }), /declared type/u);
  assert.throws(() => registerTable({ ...input, columns: [...input.columns, ...Array.from({ length: 14 }, (_, index) => ({ id: `extra-${index}`, label: `Extra ${index}`, type: 'text' }))] }), /Column count/u);
  await assert.rejects(analyzeTable({ ...registered, rows: [['changed', 2, true]] }, { aggregate: 'count' }, { engineRoot: '/unavailable' }), /digest does not match/u);
  assert.throws(() => registerTable({ ...input, rows: Array.from({ length: 1001 }, () => ['x', 1, true]) }), /Row count/u);
  assert.throws(() => registerTable({ ...input, rows: [[`${'x'.repeat(1_000_100)}`, 1, true]] }), /Canonical table input exceeds/u);
  assert.equal(tableAnalysisLimits.rows, 1000);
});

test('invalid query values are refused before a worker or SQL is constructed', async () => {
  const table = registerTable(raw());
  await assert.rejects(analyzeTable(table, { aggregate: 'sum); DROP TABLE registered_input; --', column_id: 'value' }, { engineRoot: '/unavailable' }), /Aggregate operation/u);
  await assert.rejects(analyzeTable(table, { aggregate: 'sum', column_id: 'category' }, { engineRoot: '/unavailable' }), /requires a number/u);
  await assert.rejects(analyzeTable(table, { aggregate: 'count', where: { column_id: 'include', op: 'ne', value: true } }, { engineRoot: '/unavailable' }), /Filter must use/u);
});

test('registered table queries use actual isolated DuckDB, bound filters, and exact result digests', { skip: !engineRoot }, async () => {
  const table = registerTable(raw());
  const query = { aggregate: 'sum', column_id: 'value', group_by: 'category', where: { column_id: 'include', op: 'eq', value: true } };
  const result = await analyzeTable(table, query, { engineRoot });
  assert.equal(result.status, 'complete');
  assert.equal(result.input_digest, table.sha256);
  assert.match(result.query_digest, /^[0-9a-f]{64}$/u);
  assert.equal(result.engine.package, '@duckdb/node-api');
  assert.equal(result.engine.version, '2.0.0-r.1');
  assert.deepEqual(result.rows, [[null, 7], ['A', 3], ['B', 2]]);
  assert.equal(result.columns[0].label, raw().columns[0].label);
  assert.ok(result.qualifications.some((item) => item.includes('not independently sourced')));
  assert.ok(result.qualifications.some((item) => item.includes('binary floating-point')));
  assert.equal(JSON.stringify(result).includes('/Users/'), false);
});

test('hostile filter text is a bound value and cannot become SQL syntax', { skip: !engineRoot }, async () => {
  const table = registerTable({ ...raw(), rows: [["' OR TRUE; DROP TABLE registered_input; --", 9, true], ['ordinary', 1, true]] });
  const result = await analyzeTable(table, {
    aggregate: 'count',
    where: { column_id: 'category', op: 'eq', value: "' OR TRUE; DROP TABLE registered_input; --" },
  }, { engineRoot });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.rows, [[1]]);
  const stillThere = await analyzeTable(table, { aggregate: 'count' }, { engineRoot });
  assert.equal(stillThere.status, 'complete');
  assert.deepEqual(stillThere.rows, [[2]]);
});

test('empty tables distinguish zero count from undefined numeric aggregates and preserve text min/max', { skip: !engineRoot }, async () => {
  const empty = registerTable({ ...raw(), rows: [] });
  const count = await analyzeTable(empty, { aggregate: 'count' }, { engineRoot });
  const sum = await analyzeTable(empty, { aggregate: 'sum', column_id: 'value' }, { engineRoot });
  assert.deepEqual(count.rows, [[0]]);
  assert.deepEqual(sum.rows, [[null]]);
  const nonempty = registerTable({ ...raw(), rows: [['z', 1, true], ['a', 2, false]] });
  assert.deepEqual((await analyzeTable(nonempty, { aggregate: 'min', column_id: 'category' }, { engineRoot })).rows, [['a']]);
  assert.deepEqual((await analyzeTable(nonempty, { aggregate: 'max', column_id: 'category' }, { engineRoot })).rows, [['z']]);
});

test('count aggregate returns an integer column without coercing small counts', { skip: !engineRoot }, async () => {
  const table = registerTable({ ...raw(), rows: [['A', 1, true]] });
  // Count over rows is an integer-valued owner result; the worker uses BigInt
  // normalization before crossing the JSON boundary.
  const result = await analyzeTable(table, { aggregate: 'count' }, { engineRoot });
  assert.equal(result.status, 'complete');
  assert.equal(result.rows[0][0], 1);
});

test('aborted native worker returns unknown only after its child group exits', { skip: !engineRoot }, async () => {
  const controller = new AbortController();
  const table = registerTable(raw());
  const pending = analyzeTable(table, { aggregate: 'sum', column_id: 'value' }, { engineRoot, signal: controller.signal });
  controller.abort();
  const result = await pending;
  assert.equal(result.status, 'unknown');
  assert.ok(['aborted', 'worker_cleanup_unconfirmed'].includes(result.reason));
  assert.equal(result.input_digest, table.sha256);
});

test('the wall-clock deadline kills a native worker and does not accept partial output', { skip: !engineRoot }, async () => {
  const table = registerTable(raw());
  const result = await analyzeTable(table, { aggregate: 'sum', column_id: 'value' }, { engineRoot, timeoutMs: 1 });
  assert.equal(result.status, 'unknown');
  assert.ok(['deadline', 'worker_cleanup_unconfirmed'].includes(result.reason));
  assert.equal(Object.hasOwn(result, 'rows'), false);
});

test('engine setup failures are generic and never disclose a configured path', { skip: !engineRoot }, async () => {
  const table = registerTable(raw());
  const result = await analyzeTable(table, { aggregate: 'count' }, { engineRoot: `${engineRoot}/missing-private-component` });
  assert.equal(result.status, 'failed');
  assert.equal(JSON.stringify(result).includes(engineRoot), false);
  assert.equal(JSON.stringify(result).includes('missing-private-component'), false);
});

test('native settings deny external reads and extension installation/loading', { skip: !engineRoot }, async () => {
  const { DuckDBInstance } = await import(pathToFileURL(join(engineRoot, 'lib', 'index.js')).href);
  const directory = await mkdtemp(join(tmpdir(), 'research-table-engine-'));
  const syntheticCsv = join(directory, 'synthetic.csv');
  await writeFile(syntheticCsv, 'value\nnot-private\n', { mode: 0o600 });
  const database = await DuckDBInstance.create(':memory:', {
    enable_external_access: 'false', autoinstall_known_extensions: 'false',
    autoload_known_extensions: 'false', threads: '1', memory_limit: '64MB',
    max_temp_directory_size: '0B',
  });
  const connection = await database.connect();
  try {
    await assert.rejects(connection.run(`SELECT * FROM read_csv_auto('${syntheticCsv}')`));
    await assert.rejects(connection.run('INSTALL httpfs'));
    await assert.rejects(connection.run('LOAD httpfs'));
  } finally {
    connection.closeSync();
    database.closeSync();
    await rm(directory, { recursive: true, force: true });
  }
});
