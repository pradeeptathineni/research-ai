#!/usr/bin/env node

import { importTableCsv } from '../src/table-csv.mjs';

const MAX_INPUT_BYTES = 1_000_000;

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return null;
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!['--parser-root', '--label'].includes(option) || !value || Object.hasOwn(result, option))
      throw new Error('invalid_usage');
    result[option] = value;
  }
  if (Object.keys(result).length !== 2 || !result['--parser-root']?.startsWith('/'))
    throw new Error('invalid_usage');
  return { parserRoot: result['--parser-root'], label: result['--label'] };
}

async function readStdin() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MAX_INPUT_BYTES) throw new Error('limit_exceeded');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options === null) {
    await new Promise((resolve) => process.stdout.write(
      'Usage: research-table-csv --parser-root ABSOLUTE_HOST_CONFIGURED_PACKAGE_PATH --label DISPLAY_LABEL < input.csv\n', resolve,
    ));
  } else {
    const result = await importTableCsv(await readStdin(), options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} catch (error) {
  const code = typeof error?.code === 'string' && /^[a-z_]{1,48}$/u.test(error.code)
    ? error.code
    : typeof error?.message === 'string' && /^[a-z_]{1,48}$/u.test(error.message)
      ? error.message
      : 'invalid_csv';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
