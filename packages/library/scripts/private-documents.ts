#!/usr/bin/env node

// scripts/private-documents.ts - Import and select private local documents.
// Usage: npm run private-documents -- --root PRIVATE_ROOT import FILE
//
// --
// Paths are accepted only by this explicit local operator command; HTTP requests use bytes.

import { open } from 'node:fs/promises';
import type { Buffer } from 'node:buffer';
import { basename, extname, resolve } from 'node:path';
import {
  importPrivateDocument,
  listPrivateDocuments,
  openPrivateDocument,
  selectPrivateDocument,
  PrivateDocumentError,
} from '../packages/corpus/src/private-documents.js';

const args = process.argv.slice(2);
const usage = `Usage:
  npm run private-documents -- --root PRIVATE_ROOT import FILE [--media-type TYPE] [--name DISPLAY_NAME] [--python PYTHON]
  npm run private-documents -- --root PRIVATE_ROOT list
  npm run private-documents -- --root PRIVATE_ROOT open DOCUMENT_UUID
  npm run private-documents -- --root PRIVATE_ROOT select REQUEST_JSON --origin http://127.0.0.1:PORT

Import reads only the explicitly named local file (maximum 4 MiB). Known extensions are
.pdf, .md, .markdown, .html, .htm and .txt. HTTP import accepts bounded bytes, never paths.
Selection JSON uses {"document_ref": EXACT_PRIVATE_DOCUMENT_REF, "pages": [1]}.
PDF extraction requires pypdf 6.15.0 installed in the selected Python environment.`;
const parse = (value: string | undefined): unknown => {
  try {
    return JSON.parse(value ?? '') as unknown;
  } catch {
    throw new Error('invalid_json_argument');
  }
};
function mediaType(path: string) {
  switch (extname(path).toLowerCase()) {
    case '.pdf':
      return 'application/pdf';
    case '.md':
    case '.markdown':
      return 'text/markdown';
    case '.html':
    case '.htm':
      return 'text/html';
    case '.txt':
      return 'text/plain';
    default:
      throw new Error('known_document_extension_required');
  }
}

if (args[0] === '--help' || args[0] === '-h') {
  console.log(usage);
  process.exit(0);
}

let root: string;
try {
  if (args.shift() !== '--root' || !args[0]) throw new Error('explicit_root_required');
  root = resolve(args.shift()!);
  const command = args.shift();
  let result: unknown;
  if (command === 'import') {
    const path = args.shift();
    if (!path) throw new Error('document_file_required');
    let type: ReturnType<typeof mediaType> | undefined;
    try {
      type = mediaType(path);
    } catch {
      type = undefined;
    }
    let name = basename(path);
    let python: string | undefined;
    while (args.length) {
      const option = args.shift();
      const value = args.shift();
      if (!value) throw new Error('option_value_required');
      if (option === '--media-type') {
        if (!['application/pdf', 'text/markdown', 'text/html', 'text/plain'].includes(value))
          throw new Error('invalid_media_type');
        type = value as NonNullable<typeof type>;
      } else if (option === '--name') name = value;
      else if (option === '--python') python = value;
      else throw new Error('unknown_import_option');
    }
    if (!type) throw new Error('known_extension_or_media_type_required');
    const handle = await open(resolve(path), 'r');
    let bytes: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
        throw new Error('document_file_exceeds_4_mib');
      bytes = await handle.readFile();
      if (bytes.length > 4 * 1024 * 1024) throw new Error('document_file_exceeds_4_mib');
    } finally {
      await handle.close();
    }
    result = await importPrivateDocument(
      root,
      { name, media_type: type, bytes_base64: bytes!.toString('base64') },
      python ? { python } : {},
    );
  } else if (command === 'list') {
    if (args.length) throw new Error('unexpected_list_arguments');
    result = await listPrivateDocuments(root);
  } else if (command === 'open') {
    if (args.length !== 1) throw new Error('document_uuid_required');
    const id = args[0];
    if (!id) throw new Error('document_uuid_required');
    result = await openPrivateDocument(root, id);
  } else if (command === 'select') {
    const request = args.shift();
    if (args.shift() !== '--origin') throw new Error('exact_loopback_origin_required');
    const origin = args.shift();
    if (!request || !origin || args.length) throw new Error('selection_json_required');
    result = await selectPrivateDocument(root, parse(request), origin);
  } else {
    throw new Error('unknown_command');
  }
  console.log(JSON.stringify(result, null, 2));
} catch (failure) {
  const error = failure instanceof Error ? failure : new Error('private_document_failed');
  console.error(
    JSON.stringify({
      code: error instanceof Error && 'code' in error ? error.code : error.message,
      reason:
        error instanceof PrivateDocumentError
          ? error.reason
          : 'Inspect the explicit file, exact selection and private owner state; no automatic retry or repair was performed.',
    }),
  );
  if (error.message === 'unknown_command') console.error(usage);
  process.exitCode = 1;
}
