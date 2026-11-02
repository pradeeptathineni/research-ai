#!/usr/bin/env node

import { resolve } from 'node:path';
import {
  createSourceChangeReview,
  listSourceChangeReviews,
  previewSourceChange,
  readSourceChangeReview,
} from '../packages/corpus/src/source-change-reviews.js';

const args = process.argv.slice(2);
const usage = `Usage:
  npm run source-change-reviews -- --root PRIVATE_ROOT list
  npm run source-change-reviews -- --root PRIVATE_ROOT preview PRIOR_CAPTURE_UUID NEW_CAPTURE_UUID
  npm run source-change-reviews -- --root PRIVATE_ROOT create REQUEST_JSON
  npm run source-change-reviews -- --root PRIVATE_ROOT open REVIEW_UUID

Create accepts a closed JSON request with exact version and confidence-observation refs.
Use the returned UUID with open after uncertain delivery; do not resubmit a lost request.`;
const parse = (value: string | undefined): unknown => {
  try {
    return JSON.parse(value ?? '');
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
  if (command === 'list' && args.length === 0) result = await listSourceChangeReviews(root);
  else if (command === 'preview' && args.length === 2) {
    const priorId = args[0] ?? '';
    const nextId = args[1] ?? '';
    result = await previewSourceChange(root, priorId, nextId);
  } else if (command === 'create' && args.length === 1)
    result = await createSourceChangeReview(root, parse(args[0]));
  else if (command === 'open' && args.length === 1)
    result = await readSourceChangeReview(root, args[0]);
  else throw new Error('invalid_command');
  console.log(JSON.stringify(result, null, 2));
} catch (failure) {
  const error = failure instanceof Error ? failure : new Error('source_change_review_failed');
  console.error(
    JSON.stringify({
      code: error.message,
      reason: 'Inspect the exact retained UUID and inputs; no automatic retry was performed.',
    }),
  );
  if (error.message === 'invalid_command') console.error(usage);
  process.exitCode = 1;
}
