import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  listPreview,
  previewSnapshot,
  previewSnapshotByteLimit,
  selectPreview,
  selectPagePreview,
} from '../packages/corpus/src/search-material-preview.js';

const usage = `Usage:
  material-preview list --snapshot FILE [--offset N] [--window N] [--windows N] [--source-uri HTTPS_URL]
  material-preview select --snapshot FILE --sha256 TEXT_SHA256 --start N --end N [--source-uri HTTPS_URL]
  material-preview pages --snapshot EXTRACTION_JSON --input-sha256 SHA --source-sha256 SHA --text-sha256 SHA --source-uri HTTPS_URL --claim TEXT --anchors JSON_ARRAY [--pages JSON_ARRAY]
Reads one explicit DocumentMaterial or PDF extraction JSON file and writes a preview to stdout. Nothing is fetched or saved.`;

const commands = {
  list: { required: ['snapshot'], optional: ['offset', 'window', 'windows', 'source-uri'] },
  select: { required: ['snapshot', 'sha256', 'start', 'end'], optional: ['source-uri'] },
  pages: {
    required: [
      'snapshot',
      'input-sha256',
      'source-sha256',
      'text-sha256',
      'source-uri',
      'claim',
      'anchors',
    ],
    optional: ['pages'],
  },
} as const;

/** Explicit bounded read of one regular file; size is refused before any bytes are parsed. */
export function readPreviewFile(path: string, limit = previewSnapshotByteLimit) {
  if (!lstatSync(path).isFile()) throw new Error('preview_snapshot_not_regular_file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('preview_snapshot_not_regular_file');
    if (stat.size > limit) throw new Error('preview_input_too_large');
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length !== stat.size) throw new Error('preview_snapshot_changed');
    return buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

function parse(argv: string[]) {
  const [command, ...rest] = argv;
  if (command !== 'list' && command !== 'select' && command !== 'pages')
    throw new Error('missing or unknown command');
  const { required, optional } = commands[command];
  const names: string[] = [...required, ...optional];
  const parsed = parseArgs({
    args: rest,
    options: Object.fromEntries(names.map((name) => [name, { type: 'string' as const }])),
    strict: true,
    allowPositionals: false,
    tokens: true,
  });
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) throw new Error(`--${token.name} given more than once`);
    seen.add(token.name);
  }
  const values = parsed.values as Record<string, string | undefined>;
  for (const name of required)
    if (!values[name]) throw new Error(`--${name} is required for ${command}`);
  // Digits only; range and safe-integer limits are enforced by the preview itself.
  const number = (name: string) => {
    const value = values[name];
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value)) throw new Error(`--${name} must be a non-negative integer`);
    return Number(value);
  };
  // Required options were checked above, so the assertions below cannot fail.
  const snapshot = values.snapshot!;
  const sourceUri = values['source-uri'];
  if (command === 'pages') {
    const anchors: unknown = JSON.parse(values.anchors!);
    const contextPages: unknown = values.pages === undefined ? [] : JSON.parse(values.pages);
    if (
      !Array.isArray(anchors) ||
      !anchors.every((item): item is string => typeof item === 'string')
    )
      throw new Error('--anchors must be a JSON array of strings');
    if (
      !Array.isArray(contextPages) ||
      !contextPages.every((item): item is number => typeof item === 'number')
    )
      throw new Error('--pages must be a JSON array of numbers');
    return {
      command: 'pages' as const,
      snapshot,
      selection: {
        expectedInputSha256: values['input-sha256']!,
        expectedSourceSha256: values['source-sha256']!,
        expectedTextSha256: values['text-sha256']!,
        sourceUri: sourceUri!,
        claim: values.claim!,
        anchors,
        contextPages,
      },
    };
  }
  if (command === 'list') {
    const options = {
      offset: number('offset'),
      windowUnits: number('window'),
      windows: number('windows'),
    };
    return { command: 'list' as const, snapshot, sourceUri, options };
  }
  const selection = {
    expectedTextSha256: values.sha256!,
    start: number('start')!,
    end: number('end')!,
  };
  return { command: 'select' as const, snapshot, sourceUri, selection };
}

/** One explicitly named snapshot in, one JSON preview returned for stdout; no network or file output. */
export function materialPreviewCli(argv: string[]) {
  let request: ReturnType<typeof parse>;
  try {
    request = parse(argv);
  } catch (error) {
    const stderr = `material-preview: ${(error as Error).message}\n${usage}\n`;
    return { code: 2, stdout: '', stderr };
  }
  try {
    if (request.command === 'pages') {
      const result = selectPagePreview(
        readPreviewFile(request.snapshot, 1000000),
        request.selection,
      );
      return { code: 0, stdout: `${JSON.stringify(result)}\n`, stderr: '' };
    }
    const snapshot = previewSnapshot(readPreviewFile(request.snapshot), request.sourceUri);
    const result =
      request.command === 'list'
        ? listPreview(snapshot, request.options)
        : selectPreview(snapshot, request.selection);
    return { code: 0, stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: '' };
  } catch (error) {
    return { code: 1, stdout: '', stderr: `material-preview: ${(error as Error).message}\n` };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { code, stdout, stderr } = materialPreviewCli(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
