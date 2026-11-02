#!/usr/bin/env node

import { resolve } from 'node:path';
import {
  checkSourceWatch,
  createSourceWatch,
  listSourceWatches,
  readSourceWatch,
  SourceWatchError,
} from '../packages/corpus/src/source-watches.js';
import {
  previewSourceChange,
  SourceChangeReviewError,
} from '../packages/corpus/src/source-change-reviews.js';

const args = process.argv.slice(2);
const usage = `Usage:
  npm run source-watches -- --root PRIVATE_ROOT list
  npm run source-watches -- --root PRIVATE_ROOT create REQUEST_JSON
  npm run source-watches -- --root PRIVATE_ROOT read WATCH_UUID
  npm run source-watches -- --root PRIVATE_ROOT check WATCH_REF_JSON NEW_CAPTURE_REF_JSON
  npm run source-watches -- --root PRIVATE_ROOT review-preview WATCH_REF_JSON NEW_CAPTURE_REF_JSON

JSON arguments are literal JSON text quoted as one shell argument, not filenames.
Create requires exact baseline capture ref, literal unique section markers, and exact ignore_lines.
Check reads retained captures only; it never fetches the source or judges semantic importance.
Review-preview composes a resolved watch check with the existing full-source preview; it never writes a review.`;
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
  else if (command === 'read' && args.length === 1) result = await readSourceWatch(root, args[0]);
  else if (command === 'check' && args.length === 2)
    result = await checkSourceWatch(root, parse(args[0]), parse(args[1]));
  else if (command === 'review-preview' && args.length === 2) {
    const checked = await checkSourceWatch(root, parse(args[0]), parse(args[1]));
    if (checked.status === 'unresolved')
      throw new SourceWatchError(409, 'source_watch_unresolved', checked.reason);
    const preview = await previewSourceChange(
      root,
      checked.baseline_capture_ref.id,
      checked.new_capture_ref.id,
    );
    result = {
      schema_version: 'source-watch-review-preview-v1',
      watch_check: checked,
      full_source_review_preview: preview,
      qualification: [
        'The watch check diff uses filtered-section coordinates and honors configured exact ignored lines.',
        'The full-source review preview diff uses original normalized capture text; its line references are not watch-section coordinates.',
        'This command previews only and does not create or update a source-change review.',
      ],
    };
  } else throw new Error('invalid_command');
  console.log(JSON.stringify(result, null, 2));
} catch (failure) {
  const error = failure instanceof Error ? failure : new Error('source_watch_failed');
  console.error(
    JSON.stringify({
      code: error.message,
      reason:
        error instanceof SourceWatchError
          ? error.reason
          : error instanceof SourceChangeReviewError
            ? error.reason
            : 'Inspect the exact watch, selected capture refs, and private history; no automatic retry or repair was performed.',
    }),
  );
  if (error.message === 'invalid_command') console.error(usage);
  process.exitCode = 1;
}
