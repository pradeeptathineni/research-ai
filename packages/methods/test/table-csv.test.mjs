import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { importTableCsv } from '../src/table-csv.mjs';
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
