import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { importTableCsv, inspectCsvColumns } from '../src/table-csv.mjs';
import { registerTable } from '../src/table-analysis.mjs';

const parserRoot = process.env.RESEARCH_TABLE_TEST_PARSER_ROOT;
const label = 'Synthetic survey export';
const csvHash = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('CSV import preserves BOM-bound bytes, quoted fields, CRLF, embedded newlines, and formula text', { skip: !parserRoot }, async () => {
  const csv = '\uFEFFName,Count,Notes\r\n"A, ""quoted""",7,"line one\r\nline two"\r\n"=SUM(1,2)",,literal text\r\n';
  const bytes = Buffer.from(csv, 'utf8');
  const result = await importTableCsv(csv, { parserRoot, label });
  assert.equal(result.import.version, 'research-table-csv-v1');
  assert.equal(result.import.csv_sha256, csvHash(bytes));
  assert.equal(result.import.table_sha256, result.table.sha256);
  assert.deepEqual(result.import.parser, { name: 'csv-parse', version: '7.0.3' });
  assert.equal(result.import.headers, 'first-row');
  assert.equal(result.import.values, 'text');
  assert.deepEqual(result.table.columns, [
    { id: 'c0', label: 'Name', type: 'text' },
    { id: 'c1', label: 'Count', type: 'text' },
    { id: 'c2', label: 'Notes', type: 'text' },
  ]);
  assert.deepEqual(result.table.rows, [
    ['A, "quoted"', '7', 'line one\r\nline two'],
    ['=SUM(1,2)', '', 'literal text'],
  ]);
  assert.deepEqual(result.table.origin, { type: 'caller-supplied', label });
  const { sha256, ...rawTable } = result.table;
  assert.equal(registerTable(rawTable).sha256, sha256);
});

test('CSV syntax, header, and record-shape errors refuse without a partial table', { skip: !parserRoot }, async () => {
  const invalid = [
    ['', /header row/u],
    ['a,a\n1,2\n', /unique/u],
    ['a, \n1,2\n', /nonempty/u],
    ['a,b\n"unclosed,1\n', /syntax or record/u],
    ['a,b\n1\n', /syntax or record|same number/u],
    ['a\u0001,b\n1,2\n', /plain text/u],
  ];
  for (const [csv, message] of invalid) await assert.rejects(importTableCsv(csv, { parserRoot, label }), message);
  await assert.rejects(importTableCsv(Buffer.from([0x61, 0x2c, 0x62, 0x0a, 0x31, 0xff]), { parserRoot, label }), /valid UTF-8/u);
  await assert.rejects(importTableCsv('a\n\ud800\n', { parserRoot, label }), /unmatched surrogate/u);
});

test('CSV count, column, field and byte caps refuse instead of truncating', { skip: !parserRoot }, async () => {
  const rows = Array.from({ length: 1001 }, () => 'x');
  await assert.rejects(importTableCsv(`value\n${rows.join('\n')}\n`, { parserRoot, label }), /more than 1,000/u);
  await assert.rejects(importTableCsv(`value\n${rows.join('\n')}\n"unclosed`, { parserRoot, label }), /more than 1,000/u);
  await assert.rejects(importTableCsv(`${Array.from({ length: 17 }, (_, index) => `h${index}`).join(',')}\n`, { parserRoot, label }), /1 through 16/u);
  await assert.rejects(importTableCsv(`value\n${'x'.repeat(65 * 1024)}\n`, { parserRoot, label }), /syntax or record/u);
  await assert.rejects(importTableCsv('x'.repeat(1_000_001), { parserRoot, label }), /exceeds 1,000,000 bytes/u);
});

test('parser configuration is host-only, fixed-version, and labels cannot smuggle paths', async () => {
  await assert.rejects(importTableCsv('h\nv\n', { parserRoot: '/private/missing-csv-package', label }), /unavailable/u);
  await assert.rejects(importTableCsv('h\nv\n', { parserRoot: '/private/missing-csv-package', label: '/private/name.csv' }), /path-free/u);
  await assert.rejects(importTableCsv('h\nv\n', { parserRoot: '/private/missing-csv-package', label: 'C:\\name.csv' }), /path-free/u);
  const wrongParser = process.env.RESEARCH_TABLE_TEST_WRONG_PARSER_ROOT;
  if (wrongParser) await assert.rejects(importTableCsv('h\nv\n', { parserRoot: wrongParser, label }), /qualified package/u);
});

test('CSV CLI consumes stdin bytes, emits the same receipt, and never reads a filename', { skip: !parserRoot }, () => {
  const cli = fileURLToPath(new URL('../bin/research-table-csv.mjs', import.meta.url));
  const csv = '\uFEFFkind,value\r\nalpha,1\r\nbeta,2\r\n';
  const run = spawnSync(process.execPath, [cli, '--parser-root', parserRoot, '--label', label], {
    input: Buffer.from(csv), encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' },
  });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout);
  assert.deepEqual(output.table.rows, [['alpha', '1'], ['beta', '2']]);
  assert.equal(output.import.csv_sha256, csvHash(Buffer.from(csv)));
  const invalid = spawnSync(process.execPath, [cli, '--parser-root', parserRoot, '--label', label], {
    input: 'a,b\nshort\n', encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' },
  });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
  assert.doesNotMatch(invalid.stderr, /\/Users\/|research\/|runtime\//u);
});

const usgsHeaders = ['time', 'latitude', 'longitude', 'depth', 'mag', 'magType', 'nst', 'gap', 'dmin', 'rms', 'net', 'id',
  'updated', 'place', 'type', 'horizontalError', 'depthError', 'magError', 'magNst', 'status', 'locationSource', 'magSource'];
const selectedColumns = ['time', 'mag', 'net', 'type', 'status', 'id'];
const wideRow = (row) => usgsHeaders.map((header) => (header === 'place' ? `"${row} km N of Example, CA"` : `${header}-${row}`)).join(',');
const wideCsv = `${usgsHeaders.join(',')}\r\n${Array.from({ length: 48 }, (_, row) => wideRow(row)).join('\r\n')}\r\n`;
const missingParser = '/private/missing-csv-package';

test('wide CSV inspection and explicit projection retain the exact source identity', { skip: !parserRoot }, async () => {
  const bytes = Buffer.from(wideCsv, 'utf8');
  const columns = await inspectCsvColumns(bytes, { parserRoot });
  assert.deepEqual(columns, {
    version: 'research-table-csv-columns-v1',
    csv_sha256: csvHash(bytes),
    headers: usgsHeaders,
    headers_sha256: csvHash(JSON.stringify(usgsHeaders)),
    row_count: 48,
    parser: { name: 'csv-parse', version: '7.0.3' },
  });
  await assert.rejects(importTableCsv(bytes, { parserRoot, label }), { code: 'limit_exceeded', message: /1 through 16/u });
  const result = await importTableCsv(bytes, { parserRoot, label, selectedColumns });
  assert.deepEqual(result.import, {
    version: 'research-table-csv-v2',
    csv_sha256: columns.csv_sha256,
    table_sha256: result.table.sha256,
    parser: { name: 'csv-parse', version: '7.0.3' },
    headers: 'first-row',
    values: 'text',
    source_headers: { count: 22, sha256: columns.headers_sha256 },
    selected_columns: [
      { index: 0, label: 'time' }, { index: 4, label: 'mag' }, { index: 10, label: 'net' },
      { index: 14, label: 'type' }, { index: 19, label: 'status' }, { index: 11, label: 'id' },
    ],
  });
  assert.deepEqual(result.table.columns, selectedColumns.map((name, index) => ({ id: `c${index}`, label: name, type: 'text' })));
  assert.deepEqual(result.table.rows, Array.from({ length: 48 }, (_, row) => selectedColumns.map((name) => `${name}-${row}`)));
  assert.deepEqual(result.table.origin, { type: 'caller-supplied', label });
  const { sha256, ...rawTable } = result.table;
  assert.equal(registerTable(rawTable).sha256, sha256);
  const again = await importTableCsv(wideCsv, { parserRoot, label, selectedColumns });
  assert.equal(again.import.csv_sha256, columns.csv_sha256);
  assert.deepEqual([again.table.columns, again.table.rows, again.import.selected_columns],
    [result.table.columns, result.table.rows, result.import.selected_columns]);
});

test('omitting selectedColumns keeps the v1 receipt; any explicit selection is v2', { skip: !parserRoot }, async () => {
  const csv = 'kind,value,note\nalpha,1,"x, y"\n';
  const v1 = await importTableCsv(csv, { parserRoot, label });
  assert.deepEqual(Object.keys(v1.import), ['version', 'csv_sha256', 'table_sha256', 'parser', 'headers', 'values']);
  assert.equal(v1.import.version, 'research-table-csv-v1');
  const v2 = await importTableCsv(csv, { parserRoot, label, selectedColumns: ['note', 'kind'] });
  assert.equal(v2.import.version, 'research-table-csv-v2');
  assert.equal(v2.import.csv_sha256, v1.import.csv_sha256);
  assert.deepEqual(v2.import.selected_columns, [{ index: 2, label: 'note' }, { index: 0, label: 'kind' }]);
  assert.deepEqual(v2.table.rows, [['x, y', 'alpha']]);
});

test('malformed selections and options refuse with stable codes before the parser loads', async () => {
  const sparse = ['time'];
  sparse.length = 2;
  const accessor = ['time'];
  Object.defineProperty(accessor, 0, { get: () => 'time', enumerable: true });
  const tooMany = Array.from({ length: 17 }, (_, index) => `h${index}`);
  for (const selection of [undefined, null, 'time', {}, [], tooMany, ['time', 'time'], ['time', 7], [''], ['x'.repeat(121)], sparse, accessor])
    await assert.rejects(importTableCsv('h\nv\n', { parserRoot: missingParser, label, selectedColumns: selection }), { code: 'invalid_column_selection' });
  await assert.rejects(importTableCsv('h\nv\n', { parserRoot: missingParser, label, selected: ['h'] }), { code: 'invalid_options' });
  await assert.rejects(inspectCsvColumns('h\nv\n', { parserRoot: missingParser, label }), { code: 'invalid_options' });
  await assert.rejects(inspectCsvColumns('h\nv\n', { parserRoot: 'relative/csv-parse' }), { code: 'invalid_options' });
  await assert.rejects(inspectCsvColumns('h\nv\n', { parserRoot: missingParser }), { code: 'parser_unavailable' });
});

test('selections match exact headers and wide sources stay bounded at 64 columns', { skip: !parserRoot }, async () => {
  for (const selection of [['Time'], ['time '], ['missing']])
    await assert.rejects(importTableCsv(wideCsv, { parserRoot, label, selectedColumns: selection }), { code: 'invalid_column_selection' });
  const header = (count) => Array.from({ length: count }, (_, index) => `h${index}`).join(',');
  const columns = await inspectCsvColumns(`${header(64)}\n${header(64)}\n`, { parserRoot });
  assert.equal(columns.headers.length, 64);
  assert.equal(columns.row_count, 1);
  const projected = await importTableCsv(`${header(64)}\n${header(64)}\n`, { parserRoot, label, selectedColumns: ['h63'] });
  assert.deepEqual(projected.import.selected_columns, [{ index: 63, label: 'h63' }]);
  assert.deepEqual(projected.table.rows, [['h63']]);
  await assert.rejects(inspectCsvColumns(`${header(65)}\n`, { parserRoot }), { code: 'limit_exceeded', message: /1 through 64/u });
  await assert.rejects(importTableCsv(`${header(65)}\n`, { parserRoot, label, selectedColumns: ['h0'] }), { code: 'limit_exceeded' });
  await assert.rejects(inspectCsvColumns('a,b\n1\n', { parserRoot }), { code: 'invalid_csv' });
  await assert.rejects(inspectCsvColumns(`value\n${Array.from({ length: 1001 }, () => 'x').join('\n')}\n`, { parserRoot }), { code: 'limit_exceeded' });
  await assert.rejects(inspectCsvColumns(Buffer.from([0x61, 0x0a, 0xff]), { parserRoot }), { code: 'invalid_csv_utf8' });
});
