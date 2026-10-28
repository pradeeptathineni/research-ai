#!/usr/bin/env node

// scripts/private-reader.ts - Reopen, revise and select retained private PDF passages.
// Usage: npm run private-reader -- --root PRIVATE_ROOT list|open|create|revise|select ...

// --

import { readFile } from 'node:fs/promises';
import { privateCommand } from './private-cli.js';
import {
  createPrivateReader,
  listPrivateReaders,
  openPrivateReader,
  revisePrivateReader,
  selectPrivateReaderAnnotations,
  PrivateReaderError,
} from '../packages/corpus/src/private-reader.js';

const args = process.argv.slice(2);
const usage = `Usage:
  npm run private-reader -- --root PRIVATE_ROOT list
  npm run private-reader -- --root PRIVATE_ROOT open READER_UUID
  npm run private-reader -- --root PRIVATE_ROOT create REQUEST.json
  npm run private-reader -- --root PRIVATE_ROOT revise REQUEST.json
  npm run private-reader -- --root PRIVATE_ROOT select REQUEST.json --origin http://127.0.0.1:PORT`;
const readRequest = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as unknown;
try {
  if (args[0] === '--help' || args[0] === '-h') {
    console.log(usage);
    process.exit(0);
  }
  const { root, command } = privateCommand(args);
  let result: unknown;
  if (command === 'list' && args.length === 0) result = await listPrivateReaders(root);
  else if (command === 'open' && args.length === 1)
    result = await openPrivateReader(root, args[0]!);
  else if (command === 'create' && args.length === 1)
    result = await createPrivateReader(root, await readRequest(args[0]!));
  else if (command === 'revise' && args.length === 1)
    result = await revisePrivateReader(root, await readRequest(args[0]!));
  else if (command === 'select' && args.length === 3 && args[1] === '--origin')
    result = await selectPrivateReaderAnnotations(
      root,
      await readRequest(args[0]!),
      args.at(2) ?? '',
    );
  else throw new Error('unknown_command');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const failure = error instanceof Error ? error : new Error('private_reader_failed');
  console.error(
    JSON.stringify({
      code: failure instanceof PrivateReaderError ? failure.code : failure.message,
      reason:
        failure instanceof PrivateReaderError
          ? failure.reason
          : 'Inspect the exact reader request and private owner state; no automatic retry or repair was performed.',
    }),
  );
  if (failure.message === 'unknown_command') console.error(usage);
  process.exitCode = 1;
}
