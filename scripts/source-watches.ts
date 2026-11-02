#!/usr/bin/env node

import { resolve } from 'node:path';
import {
  checkSourceWatch,
  createSourceWatch,
  listSourceWatches,
  readSourceWatch,
} from '../packages/corpus/src/source-watches.js';

const args = process.argv.slice(2);
const usage = `Usage:
  npm run source-watches -- --root PRIVATE_ROOT list
  npm run source-watches -- --root PRIVATE_ROOT create REQUEST_JSON
  npm run source-watches -- --root PRIVATE_ROOT read WATCH_UUID
  npm run source-watches -- --root PRIVATE_ROOT check WATCH_REF_JSON NEW_CAPTURE_REF_JSON

Create requires exact baseline capture ref, literal unique section markers, and exact ignore_lines.
Check reads retained captures only; it never fetches the source or judges semantic importance.`;
const parse = (value: string | undefined): unknown => {
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
  if (args.shift() !== '--root' || !args[0]) throw new Error('explicit_root_required');
  const root = resolve(args.shift()!);
  const command = args.shift();
  let result: unknown;
  if (command === 'list' && args.length === 0) result = await listSourceWatches(root);
  else if (command === 'create' && args.length === 1)
    result = await createSourceWatch(root, parse(args[0]));
  else if (command === 'read' && args.length === 1) result = await readSourceWatch(root, args[0]!);
  else if (command === 'check' && args.length === 2)
    result = await checkSourceWatch(root, parse(args[0]), parse(args[1]));
  else throw new Error('invalid_command');
  console.log(JSON.stringify(result, null, 2));
} catch (failure) {
  const error = failure instanceof Error ? failure : new Error('source_watch_failed');
  console.error(
    JSON.stringify({
      code: error.message,
      reason:
        'Inspect the exact watch, selected capture refs, and private history; no automatic retry or repair was performed.',
    }),
  );
  if (error.message === 'invalid_command') console.error(usage);
  process.exitCode = 1;
}
