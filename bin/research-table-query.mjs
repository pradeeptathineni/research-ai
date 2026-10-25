#!/usr/bin/env node

import { prepareTableQuery, queryTables, tableQueryLimits } from '../src/table-query.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: research-table-query [--preview] [--engine-root ABSOLUTE_PACKAGE_PATH]\nRead {tables:[{name,table}],query:{sql,parameters}} JSON from stdin.\nPreview starts no engine; run accepts one SELECT over supplied tables.');
  process.exit(0);
}
let preview = false, engineRoot;
try {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--preview' && !preview) preview = true;
    else if (args[i] === '--engine-root' && engineRoot === undefined && args[i + 1]) engineRoot = args[++i];
    else throw Object.assign(new Error('Use --help for supported options.'), { code: 'invalid_options' });
  }
  let bytes = 0; const chunks = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > tableQueryLimits.inputBytes) throw Object.assign(new Error('Input exceeds the query byte cap.'), { code: 'limit_exceeded' });
    chunks.push(chunk);
  }
  const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  if (!input || Object.keys(input).sort().join(',') !== 'query,tables') throw Object.assign(new Error('stdin must contain only tables and query.'), { code: 'invalid_input' });
  const result = preview ? prepareTableQuery(input.tables, input.query) : await queryTables(input.tables, input.query, { engineRoot });
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.status === 'unknown' ? 2 : result.status === 'failed' ? 1 : 0;
} catch (error) {
  process.stdout.write(JSON.stringify({ version: 'research-table-query-error-v1', status: 'failed', error: error?.code ?? 'invalid_input', message: error instanceof SyntaxError ? 'stdin must contain valid UTF-8 JSON.' : String(error.message) }) + '\n');
  process.exitCode = 1;
}
