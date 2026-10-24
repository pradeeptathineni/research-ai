#!/usr/bin/env node

import { analyzeTable, registerTable } from '../src/table-analysis.mjs';

const MAX_INPUT = 1_050_000;

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return null;
  if (args.length !== 2 || args[0] !== '--engine-root' || !args[1].startsWith('/')) {
    throw new Error('usage: research-table-analysis --engine-root ABSOLUTE_HOST_CONFIGURED_PACKAGE_PATH');
  }
  return args[1];
}

async function readInput() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MAX_INPUT) throw new Error('input_limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

try {
  const engineRoot = parseArgs(process.argv.slice(2));
  if (engineRoot === null) {
    await new Promise((resolve) => process.stdout.write('Usage: research-table-analysis --engine-root ABSOLUTE_HOST_CONFIGURED_PACKAGE_PATH < table-query.json\n', resolve));
  } else {
    const input = await readInput();
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).length !== 2 || !Object.hasOwn(input, 'table') || !Object.hasOwn(input, 'query')) {
      throw new Error('invalid_input');
    }
    const table = registerTable(input.table);
    const result = await analyzeTable(table, input.query, { engineRoot });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status === 'failed') process.exitCode = 1;
    if (result.status === 'unknown') process.exitCode = 2;
  }
} catch (error) {
  const code = typeof error?.code === 'string' && /^[a-z_]{1,48}$/u.test(error.code)
    ? error.code
    : typeof error?.message === 'string' && /^[a-z_]{1,48}$/u.test(error.message)
      ? error.message
      : 'invalid_input';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
