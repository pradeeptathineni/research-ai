#!/usr/bin/env node

import { resolve } from 'node:path';
import {
  createProjectTopicRelevance,
  listProjectTopicRelevance,
  previewProjectTopicRelevance,
  readProjectTopicRelevance,
} from '../packages/corpus/src/project-topic-relevance.js';

const args = process.argv.slice(2);
const usage = `Usage:
  npm run project-topic-relevance -- --root PRIVATE_ROOT list
  npm run project-topic-relevance -- --root PRIVATE_ROOT preview BASIS_JSON
  npm run project-topic-relevance -- --root PRIVATE_ROOT create REVIEW_JSON
  npm run project-topic-relevance -- --root PRIVATE_ROOT open REVIEW_UUID

Preview and create use exact topic/project references. Reopen the caller UUID
after an uncertain write; do not automatically repeat the mutation.`;
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
  if (command === 'list' && args.length === 0) result = await listProjectTopicRelevance(root);
  else if (command === 'preview' && args.length === 1)
    result = await previewProjectTopicRelevance(root, parse(args[0]));
  else if (command === 'create' && args.length === 1)
    result = await createProjectTopicRelevance(root, parse(args[0]));
  else if (command === 'open' && args.length === 1)
    result = await readProjectTopicRelevance(root, args[0]);
  else throw new Error('invalid_command');
  console.log(JSON.stringify(result, null, 2));
} catch (failure) {
  const error = failure instanceof Error ? failure : new Error('project_topic_relevance_failed');
  console.error(
    JSON.stringify({
      code: error.message,
      reason:
        'Reopen the exact retained UUID and resolve current references explicitly; no automatic retry occurred.',
    }),
  );
  if (error.message === 'invalid_command') console.error(usage);
  process.exitCode = 1;
}
