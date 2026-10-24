import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerTable } from './table-analysis.mjs';

const CSV_VERSION = 'research-table-csv-v1';
const PARSER_NAME = 'csv-parse';
const PARSER_VERSION = '7.0.3';
const MAX_CSV_BYTES = 1_000_000;
const MAX_RECORD_SIZE = 64 * 1024;
const MAX_ROWS = 1_000;
const MAX_COLUMNS = 16;
const HEADER_MAX = 120;

function fail(code, message) {
  throw Object.assign(new TypeError(message), { code });
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function validateOptions(options) {
  if (!plain(options) || Object.getOwnPropertySymbols(options).length ||
      Object.keys(options).length !== 2 || !Object.hasOwn(options, 'parserRoot') || !Object.hasOwn(options, 'label'))
    fail('invalid_options', 'CSV import options must contain parserRoot and label.');
  for (const key of Object.keys(options)) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('invalid_options', 'CSV import options must be plain values.');
  }
  if (typeof options.parserRoot !== 'string' || !isAbsolute(options.parserRoot))
    fail('invalid_options', 'parserRoot must be an absolute host-configured package path.');
  if (typeof options.label !== 'string' || options.label.trim().length < 1 || options.label.length > HEADER_MAX ||
      options.label === '.' || options.label === '..' || hasLoneSurrogate(options.label) ||
      /[\u0000-\u001f\u007f/\\:]/u.test(options.label))
    fail('invalid_options', 'label must be a short path-free display label.');
}

function csvBytes(csv) {
  if (typeof csv === 'string') {
    if (hasLoneSurrogate(csv)) fail('invalid_csv_utf8', 'CSV text contains an unmatched surrogate.');
    if (Buffer.byteLength(csv, 'utf8') > MAX_CSV_BYTES)
      fail('limit_exceeded', 'CSV input exceeds 1,000,000 bytes.');
    return Buffer.from(csv, 'utf8');
  }
  if (!(csv instanceof Uint8Array)) fail('invalid_csv', 'CSV input must be UTF-8 text or bytes.');
  if (csv.byteLength > MAX_CSV_BYTES) fail('limit_exceeded', 'CSV input exceeds 1,000,000 bytes.');
  const bytes = Buffer.from(csv);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('invalid_csv_utf8', 'CSV input is not valid UTF-8.');
  }
  return bytes;
}

async function loadParser(parserRoot) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(parserRoot, 'package.json'), 'utf8'));
  } catch {
    fail('parser_unavailable', 'Configured CSV parser is unavailable.');
  }
  if (manifest.name !== PARSER_NAME || manifest.version !== PARSER_VERSION || manifest.license !== 'MIT')
    fail('parser_version_mismatch', 'Configured CSV parser does not match the qualified package.');
  try {
    const module = await import(pathToFileURL(join(parserRoot, 'lib', 'sync.js')).href);
    if (typeof module.parse !== 'function') fail('parser_unavailable', 'Configured CSV parser is unavailable.');
    return module.parse;
  } catch (error) {
    if (error?.code === 'parser_unavailable') throw error;
    fail('parser_unavailable', 'Configured CSV parser is unavailable.');
  }
}

function validateHeaders(headers) {
  if (!Array.isArray(headers) || headers.length < 1 || headers.length > MAX_COLUMNS)
    fail(headers?.length > MAX_COLUMNS ? 'limit_exceeded' : 'invalid_csv_headers', 'CSV must have 1 through 16 header columns.');
  const seen = new Set();
  for (const header of headers) {
    if (typeof header !== 'string' || header.length > HEADER_MAX || !header.trim() || /[\u0000-\u001f\u007f]/u.test(header))
      fail('invalid_csv_headers', 'CSV headers must be nonempty plain text no longer than 120 characters.');
    if (seen.has(header)) fail('invalid_csv_headers', 'CSV headers must be unique.');
    seen.add(header);
  }
}

/** Parse bounded CSV bytes into an exact text-only Research table. */
export async function importTableCsv(csv, options) {
  validateOptions(options);
  const bytes = csvBytes(csv);
  const parse = await loadParser(options.parserRoot);
  let records;
  try {
    records = parse(bytes, {
      bom: true,
      cast: false,
      columns: false,
      max_record_size: MAX_RECORD_SIZE,
      relax_column_count: false,
      relax_quotes: false,
      skip_empty_lines: false,
      skip_records_with_error: false,
    });
  } catch {
    fail('invalid_csv', 'CSV syntax or record shape is invalid.');
  }
  if (!Array.isArray(records) || records.length === 0)
    fail('invalid_csv_headers', 'CSV must contain a header row.');
  const headers = records[0];
  validateHeaders(headers);
  const rowCount = records.length - 1;
  if (rowCount > MAX_ROWS) fail('limit_exceeded', 'CSV contains more than 1,000 data rows.');
  const rows = records.slice(1);
  if (rows.some((row) => !Array.isArray(row) || row.length !== headers.length))
    fail('invalid_csv', 'CSV records must have the same number of fields as the header.');

  const table = registerTable({
    version: 'research-table-v1',
    id: `table-${randomUUID()}`,
    columns: headers.map((label, index) => ({ id: `c${index}`, label, type: 'text' })),
    rows,
    origin: { type: 'caller-supplied', label: options.label },
  });
  return {
    table,
    import: {
      version: CSV_VERSION,
      csv_sha256: createHash('sha256').update(bytes).digest('hex'),
      table_sha256: table.sha256,
      parser: { name: PARSER_NAME, version: PARSER_VERSION },
      headers: 'first-row',
      values: 'text',
    },
  };
}
