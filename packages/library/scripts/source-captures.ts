#!/usr/bin/env node

// scripts/source-captures.ts - Manage private immutable source captures and notes.
// Usage: npm run source-captures -- --root PRIVATE_ROOT list
//
import { open } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import { exactOwnerRecord } from '../packages/corpus/src/provider-capabilities.js';
import {
  annotateSource,
  compareSourceCaptures,
  createSourceCapture,
  listSourceCaptures,
  openSourceCapture,
  selectSourceCapture,
  type RecordRef,
} from '../packages/corpus/src/source-captures.js';
import { openSourceRender, renderSourceCapture } from '../packages/corpus/src/source-render.js';

const args = process.argv.slice(2);
const usage = `Usage:
  npm run source-captures -- --root PRIVATE_ROOT list [EXACT_SOURCE_REF_JSON]
  npm run source-captures -- --root PRIVATE_ROOT capture EXACT_SOURCE_REF_JSON [--paste-file FILE --observed-at ISO] [--supersedes EXACT_CAPTURE_REF_JSON]
  npm run source-captures -- --root PRIVATE_ROOT open CAPTURE_UUID
  npm run source-captures -- --root PRIVATE_ROOT render REQUEST_JSON
  npm run source-captures -- --root PRIVATE_ROOT render-open CAPTURE_UUID [MANIFEST_SHA256]
  npm run source-captures -- --root PRIVATE_ROOT annotate REQUEST_JSON
  npm run source-captures -- --root PRIVATE_ROOT compare LEFT_UUID RIGHT_UUID
  npm run source-captures -- --root PRIVATE_ROOT select REQUEST_JSON

Paste imports read only the explicitly named file and retain its exact bytes as
user-supplied text. HTTP routes never accept paths. Annotation request JSON uses
the POST source-annotations shape; selection JSON uses source-captures/selection.
All retained refs must be exact Signals refs with non-null digest and revision.`;
const parse = (value: string | undefined): unknown => {
  try {
    return JSON.parse(value ?? '') as unknown;
  } catch {
    throw new Error('invalid_json_argument');
  }
};

let root: string;
try {
  if (args[0] === '--help' || args[0] === '-h') {
    console.log(usage);
    process.exit(0);
  }
  if (args.shift() !== '--root' || !args[0]) throw new Error('explicit_root_required');
  root = resolve(args.shift()!);
  const command = args.shift();
  const resolver = async (ref: RecordRef) => {
    const exact = await exactOwnerRecord(root, ref);
    return { bytes: exact.bytes, ref: exact.ref as RecordRef };
  };
  let result: unknown;
  if (command === 'list') {
    result = await listSourceCaptures(root, args[0] ? parse(args[0]) : undefined, resolver);
  } else if (command === 'capture') {
    const sourceRef = parse(args.shift());
    let mode: 'fetch' | 'paste' = 'fetch';
    let text: string | undefined;
    let observedAt: string | undefined;
    let supersedes: unknown;
    while (args.length) {
      const option = args.shift();
      if (option === '--paste-file') {
        const path = args.shift();
        if (!path) throw new Error('paste_file_required');
        const handle = await open(resolve(path), 'r');
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > 96000) throw new Error('paste_file_exceeds_limit');
          const bytes = await handle.readFile();
          text = bytes.toString('utf8');
          if (bytes.length > 96000 || !Buffer.from(text, 'utf8').equals(bytes))
            throw new Error('paste_file_invalid_utf8_or_exceeds_limit');
        } finally {
          await handle.close();
        }
        mode = 'paste';
      } else if (option === '--observed-at') observedAt = args.shift();
      else if (option === '--supersedes') supersedes = parse(args.shift());
      else throw new Error('unknown_capture_option');
    }
    result = await createSourceCapture(
      root,
      {
        source_ref: sourceRef,
        mode,
        ...(mode === 'paste' ? { text, observed_at: observedAt } : {}),
        ...(supersedes ? { supersedes } : {}),
      },
      resolver,
    );
  } else if (command === 'open') {
    if (args.length !== 1) throw new Error('capture_uuid_required');
    result = await openSourceCapture(root, args[0]);
  } else if (command === 'render') {
    if (args.length !== 1) throw new Error('source_render_request_json_required');
    result = await renderSourceCapture(root, parse(args[0]), resolver);
  } else if (command === 'render-open') {
    if (args.length < 1 || args.length > 2)
      throw new Error('capture_uuid_and_optional_manifest_digest_required');
    result = await openSourceRender(root, args[0], args[1]);
  } else if (command === 'annotate') {
    if (args.length !== 1) throw new Error('annotation_request_json_required');
    result = await annotateSource(root, parse(args[0]));
  } else if (command === 'compare') {
    if (args.length !== 2) throw new Error('two_capture_uuids_required');
    result = await compareSourceCaptures(root, args[0], args[1]!);
  } else if (command === 'select') {
    if (args.length !== 1) throw new Error('selection_request_json_required');
    result = await selectSourceCapture(root, parse(args[0]));
  } else {
    throw new Error('unknown_command');
  }
  console.log(JSON.stringify(result, null, 2));
} catch (failure) {
  const error = failure instanceof Error ? failure : new Error('source_capture_failed');
  console.error(
    JSON.stringify({
      code: error.message,
      reason:
        'Inspect the exact selection and private owner state; no automatic retry or repair was performed.',
    }),
  );
  if (error.message === 'unknown_command') console.error(usage);
  process.exitCode = 1;
}
