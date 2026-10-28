#!/usr/bin/env node

// scripts/private-collection.ts - Search, reopen and select private document passages.
// Usage: npm run private-collection -- --root PRIVATE_ROOT preview REQUEST.json

// --

import { privateCommand } from './private-cli.js';
import {
  listPrivateCollection,
  openPrivateCollection,
  previewPrivateCollection,
  selectPrivateCollection,
  PrivateCollectionError,
} from '../packages/corpus/src/private-collection.js';

const args = process.argv.slice(2);
const usage = `Usage:
  npm run private-collection -- --root PRIVATE_ROOT preview REQUEST.json
  npm run private-collection -- --root PRIVATE_ROOT list
  npm run private-collection -- --root PRIVATE_ROOT open QUERY_UUID
  npm run private-collection -- --root PRIVATE_ROOT select REQUEST.json --origin http://127.0.0.1:PORT`;
const parse = (value: string | undefined) => {
  try {
    return JSON.parse(value ?? '') as unknown;
  } catch {
    throw new Error('invalid_json_argument');
  }
};
try {
  if (args[0] === '--help' || args[0] === '-h') {
    console.log(usage);
    process.exit(0);
  }
  const { root, command } = privateCommand(args);
  let result: unknown;
  if (command === 'preview' && args.length === 1)
    result = await previewPrivateCollection(root, parse(args[0]));
  else if (command === 'list' && args.length === 0) result = await listPrivateCollection(root);
  else if (command === 'open' && args.length === 1)
    result = await openPrivateCollection(root, args[0]!);
  else if (command === 'select' && args.length === 3 && args[1] === '--origin')
    result = await selectPrivateCollection(root, parse(args[0]), args[2]!);
  else throw new Error('unknown_command');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const failure = error instanceof Error ? error : new Error('private_collection_failed');
  console.error(
    JSON.stringify({
      code: failure instanceof PrivateCollectionError ? failure.code : failure.message,
      reason:
        failure instanceof PrivateCollectionError
          ? failure.reason
          : 'Inspect the exact query, selection and private owner state; no automatic retry or repair was performed.',
    }),
  );
  if (failure.message === 'unknown_command') console.error(usage);
  process.exitCode = 1;
}
