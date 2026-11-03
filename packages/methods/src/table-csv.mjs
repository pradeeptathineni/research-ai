import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerTable } from './table-analysis.mjs';

const CSV_VERSION = 'research-table-csv-v1';
const CSV_PROJECTION_VERSION = 'research-table-csv-v2';
const CSV_COLUMNS_VERSION = 'research-table-csv-columns-v1';
const PARSER_NAME = 'csv-parse';
const PARSER_VERSION = '7.0.3';
const MAX_CSV_BYTES = 1_000_000;
const MAX_RECORD_SIZE = 64 * 1024;
const MAX_ROWS = 1_000;
const MAX_COLUMNS = 16;
const MAX_SOURCE_COLUMNS = 64;
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

function validateOptionKeys(options, kind, required, optional) {
  const names = plain(options) && !Object.getOwnPropertySymbols(options).length ? Object.getOwnPropertyNames(options) : null;
  if (!names || required.some((key) => !names.includes(key)) ||
      names.some((key) => !required.includes(key) && !optional.includes(key)))
    fail('invalid_options', `CSV ${kind} options must contain ${required.join(' and ')}.`);
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('invalid_options', `CSV ${kind} options must be plain values.`);
  }
  if (typeof options.parserRoot !== 'string' || !isAbsolute(options.parserRoot))
    fail('invalid_options', 'parserRoot must be an absolute host-configured package path.');
}

function validateSelection(selection) {
  const count = Array.isArray(selection) ? selection.length : 0;
  if (count < 1 || count > MAX_COLUMNS)
    fail('invalid_column_selection', 'selectedColumns must list 1 through 16 column names.');
  const names = [];
  for (let index = 0; index < count; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(selection, index);
    const name = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    if (typeof name !== 'string' || !name || name.length > HEADER_MAX)
      fail('invalid_column_selection', 'selectedColumns must contain plain header-name strings.');
    if (names.includes(name)) fail('invalid_column_selection', 'selectedColumns must be unique.');
    names.push(name);
  }
  return names;
}

function validateImportOptions(options) {
  validateOptionKeys(options, 'import', ['parserRoot', 'label'], ['selectedColumns']);
  if (typeof options.label !== 'string' || options.label.trim().length < 1 || options.label.length > HEADER_MAX ||
      options.label === '.' || options.label === '..' || hasLoneSurrogate(options.label) ||
      /[\u0000-\u001f\u007f/\\:]/u.test(options.label))
    fail('invalid_options', 'label must be a short path-free display label.');
  return Object.hasOwn(options, 'selectedColumns') ? validateSelection(options.selectedColumns) : null;
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

function validateHeaders(headers, maxColumns) {
  if (!Array.isArray(headers) || headers.length < 1 || headers.length > maxColumns)
    fail(headers?.length > maxColumns ? 'limit_exceeded' : 'invalid_csv_headers', `CSV must have 1 through ${maxColumns} header columns.`);
  const seen = new Set();
  for (const header of headers) {
    if (typeof header !== 'string' || header.length > HEADER_MAX || !header.trim() || /[\u0000-\u001f\u007f]/u.test(header))
      fail('invalid_csv_headers', 'CSV headers must be nonempty plain text no longer than 120 characters.');
    if (seen.has(header)) fail('invalid_csv_headers', 'CSV headers must be unique.');
    seen.add(header);
  }
}

function parseRecords(parse, bytes, maxColumns) {
  let records;
  let hasHeader = false;
  let dataRows = 0;
  try {
    records = parse(bytes, {
      bom: true,
      cast: false,
      columns: false,
      max_record_size: MAX_RECORD_SIZE,
      on_record(record) {
        if (!hasHeader) {
          validateHeaders(record, maxColumns);
          hasHeader = true;
        } else {
          dataRows++;
          if (dataRows > MAX_ROWS) fail('limit_exceeded', 'CSV contains more than 1,000 data rows.');
        }
        return record;
      },
      relax_column_count: false,
      relax_quotes: false,
      skip_empty_lines: false,
      skip_records_with_error: false,
    });
  } catch (error) {
    if (error?.code === 'limit_exceeded' || error?.code === 'invalid_csv_headers') throw error;
    fail('invalid_csv', 'CSV syntax or record shape is invalid.');
  }
  if (!Array.isArray(records) || records.length === 0 || !hasHeader)
    fail('invalid_csv_headers', 'CSV must contain a header row.');
  const headers = records[0];
  const rows = records.slice(1);
  if (rows.some((row) => !Array.isArray(row) || row.length !== headers.length))
    fail('invalid_csv', 'CSV records must have the same number of fields as the header.');
  return { headers, rows };
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
/** SHA-256 of the UTF-8 JSON array of exact source header strings. */
const headersSha256 = (headers) => sha256(JSON.stringify(headers));

function importProjection(bytes, headers, rows, selection, label) {
  const mapping = selection.map((name) => {
    const index = headers.indexOf(name);
    if (index < 0) fail('invalid_column_selection', 'selectedColumns must name exact CSV headers.');
    return { index, label: name };
  });
  const table = registerTable({
    version: 'research-table-v1',
    id: `table-${randomUUID()}`,
    columns: mapping.map((column, position) => ({ id: `c${position}`, label: column.label, type: 'text' })),
    rows: rows.map((row) => mapping.map((column) => row[column.index])),
    origin: { type: 'caller-supplied', label },
  });
  return {
    table,
    import: {
      version: CSV_PROJECTION_VERSION,
      csv_sha256: sha256(bytes),
      table_sha256: table.sha256,
      parser: { name: PARSER_NAME, version: PARSER_VERSION },
      headers: 'first-row',
      values: 'text',
      source_headers: { count: headers.length, sha256: headersSha256(headers) },
      selected_columns: mapping,
    },
  };
}

/** Inspect a bounded wide CSV's exact header order and row count without importing a table. */
export async function inspectCsvColumns(csv, options) {
  validateOptionKeys(options, 'inspect', ['parserRoot'], []);
  const bytes = csvBytes(csv);
  const parse = await loadParser(options.parserRoot);
  const { headers, rows } = parseRecords(parse, bytes, MAX_SOURCE_COLUMNS);
  return {
    version: CSV_COLUMNS_VERSION,
    csv_sha256: sha256(bytes),
    headers,
    headers_sha256: headersSha256(headers),
    row_count: rows.length,
    parser: { name: PARSER_NAME, version: PARSER_VERSION },
  };
}

/** Parse bounded CSV bytes into an exact text-only Research table, optionally projecting selected columns. */
export async function importTableCsv(csv, options) {
  const selection = validateImportOptions(options);
  const bytes = csvBytes(csv);
  const parse = await loadParser(options.parserRoot);
  const { headers, rows } = parseRecords(parse, bytes, selection ? MAX_SOURCE_COLUMNS : MAX_COLUMNS);
  if (selection) return importProjection(bytes, headers, rows, selection, options.label);

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
