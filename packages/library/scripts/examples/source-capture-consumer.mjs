#!/usr/bin/env node

// scripts/examples/source-capture-consumer.mjs - Read and verify an exact source selection.
// Usage: node source-capture-consumer.mjs API_BASE INSTANCE_ID OWNER_EPOCH SESSION_TOKEN CAPTURE_REF_JSON ANNOTATION_REFS_JSON
//
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { log, error } from 'node:console';
import process from 'node:process';
import { URL } from 'node:url';
const { fetch } = globalThis;

const [baseValue, instance, epoch, token, captureRefJson, annotationRefsJson] =
  process.argv.slice(2);
if (!baseValue || !instance || !epoch || !token || !captureRefJson || !annotationRefsJson) {
  error(
    'Supply the configured API base, trusted owner identity/epoch, session token, exact capture ref JSON, and exact annotation-ref array JSON.',
  );
  process.exit(2);
}
const base = new URL(baseValue);
assert.equal(base.protocol, 'http:');
assert.ok(['127.0.0.1', '[::1]'].includes(base.hostname));
assert.ok(base.pathname.endsWith('/signals-ai/__signals/api/'));
assert.equal(base.username, '');
assert.equal(base.password, '');
assert.equal(base.search, '');
assert.equal(base.hash, '');
const captureRef = JSON.parse(captureRefJson);
const annotationRefs = JSON.parse(annotationRefsJson);
assert.ok(Array.isArray(annotationRefs) && annotationRefs.length <= 20);
const response = await fetch(new URL('source-captures/selection', base), {
  method: 'POST',
  redirect: 'error',
  headers: {
    'content-type': 'application/json',
    'x-signals-provider-version': '1.0',
    'x-signals-instance-id': instance,
    'x-signals-owner-epoch': epoch,
    'x-signals-token': token,
  },
  body: JSON.stringify({ capture_ref: captureRef, annotation_refs: annotationRefs }),
});
const result = await response.json();
if (!response.ok)
  throw new Error(
    `${result.code ?? 'selection_failed'}: ${result.reason ?? 'owner refused selection'}`,
  );
const sha = (value) => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
function verifyRef(ref, projection, kind, id) {
  const digest = sha(projection);
  assert.equal(ref.owner, 'signals-ai');
  assert.equal(ref.kind, kind);
  assert.equal(ref.id, id);
  assert.equal(ref.digest, digest);
  assert.equal(ref.revision, `sha256:${digest}`);
}
assert.equal(result.schema_version, 'source-capture-selection-v1');
verifyRef(result.capture_ref, result.capture, 'source_capture', result.capture.id);
assert.deepEqual(result.capture_ref, captureRef);
assert.equal(
  result.capture.source_id,
  `source-${sha([result.capture.source_ref.owner, result.capture.source_ref.kind, result.capture.source_ref.id, result.capture.source_uri])}`,
);
assert.equal(
  result.capture.text_sha256,
  createHash('sha256').update(result.capture.text, 'utf8').digest('hex'),
);
assert.equal(result.annotations.length, annotationRefs.length);
for (let i = 0; i < result.annotations.length; i++) {
  const { ref, annotation } = result.annotations[i];
  verifyRef(ref, annotation, 'source_annotation', annotation.id);
  assert.equal(ref.id, annotationRefs[i].id);
  assert.deepEqual(ref, annotationRefs[i]);
  assert.deepEqual(annotation.capture_ref, result.capture_ref);
  assert.equal(annotation.anchor.text_sha256, result.capture.text_sha256);
  assert.equal(
    result.capture.text.slice(annotation.anchor.start, annotation.anchor.end),
    annotation.anchor.quote,
  );
}
log(JSON.stringify(result, null, 2));
