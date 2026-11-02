#!/usr/bin/env node

import { resolve } from 'node:path';
import { exactOwnerRecord } from '../packages/corpus/src/provider-capabilities.js';
import {
  createSourceArchive,
  readSourceArchive,
  readSourceArchiveRequest,
  SourceArchiveError,
} from '../packages/corpus/src/source-archives.js';
import { SourceCaptureError, type RecordRef } from '../packages/corpus/src/source-captures.js';

const args = process.argv.slice(2);
const usage = `Usage:
  npm run source-archives -- --root PRIVATE_ROOT create REQUEST_JSON
  npm run source-archives -- --root PRIVATE_ROOT request REQUEST_UUID
  npm run source-archives -- --root PRIVATE_ROOT read EXACT_CAPTURE_REF_JSON

Create performs one explicit fetch through the existing source-capture owner. Request
JSON is literal JSON text, not a filename. Read returns an opaque base64 body only
for an exact retained capture and raw digest; no HTML is served or executed. The private
archive index is capped at 2,000,000 serialized bytes and 100 requests; full-size bodies
will consume much of this finite capacity, and no older archive is evicted.`;
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
  const resolveSource = async (ref: RecordRef) => {
    const exact = await exactOwnerRecord(root, ref);
    return { bytes: exact.bytes, ref: exact.ref as RecordRef };
  };
  let result: unknown;
  if (command === 'create' && args.length === 1)
    result = await createSourceArchive(root, parse(args[0]), resolveSource);
  else if (command === 'request' && args.length === 1)
    result = await readSourceArchiveRequest(root, args[0]!);
  else if (command === 'read' && args.length === 1)
    result = await readSourceArchive(root, parse(args[0]));
  else throw new Error('invalid_command');
  console.log(JSON.stringify(result, null, 2));
} catch (failure) {
  const error = failure instanceof Error ? failure : new Error('source_archive_failed');
  const ownerError =
    error instanceof SourceArchiveError || error instanceof SourceCaptureError ? error : null;
  console.error(
    JSON.stringify({
      ...(ownerError
        ? { status: ownerError.status, code: ownerError.code }
        : { code: error.message }),
      reason: ownerError
        ? ownerError.reason
        : 'Inspect the exact archive request and private owner state; no automatic retry or repair was performed.',
    }),
  );
  if (error.message === 'invalid_command') console.error(usage);
  process.exitCode = 1;
}
