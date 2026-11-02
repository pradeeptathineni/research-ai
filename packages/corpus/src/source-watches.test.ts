import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { exactOwnerRecord } from './provider-capabilities.js';
import { saveLibraryLead } from './library-leads.js';
import {
  checkSourceWatch,
  createSourceWatch,
  listSourceWatches,
  readSourceWatch,
} from './source-watches.js';
import { createSourceCapture, type RecordRef } from './source-captures.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-source-watch-')));
  roots.push(root);
  const lead = await saveLibraryLead(
    root,
    {
      uri: 'https://example.test/synthetic',
      name: 'Synthetic',
      description: 'Fixture',
      limits: [],
    },
    randomUUID(),
    'Synthetic source-watch fixture.',
  );
  const resolved = await exactOwnerRecord(root, {
    owner: 'signals-ai',
    kind: 'lead',
    id: lead.id,
    revision: null,
    digest: null,
  });
  const sourceRef = resolved.ref as RecordRef;
  const resolveSource = async (ref: RecordRef) => {
    const record = await exactOwnerRecord(root, ref);
    return { bytes: record.bytes, ref: record.ref as RecordRef };
  };
  const capture = (text: string, supersedes?: RecordRef) =>
    createSourceCapture(
      root,
      {
        source_ref: sourceRef,
        mode: 'paste',
        text,
        observed_at: '2026-11-02T12:00:00Z',
        ...(supersedes ? { supersedes } : {}),
      },
      resolveSource,
    );
  return { root, sourceRef, capture };
}

function request(baselineCaptureRef: RecordRef, requestId = randomUUID()) {
  return {
    request_id: requestId,
    label: 'Policy section',
    rationale: 'Track the literal retained section over exact captures.',
    baseline_capture_ref: baselineCaptureRef,
    start_marker: 'BEGIN POLICY',
    end_marker: 'END POLICY',
    ignore_lines: ['Generated on demand'],
  };
}

it('creates an immutable watch, replays the same intent, and cold-lists it', async () => {
  const { root, capture } = await fixture();
  const baseline = await capture('header\nBEGIN POLICY\nRule A\nEND POLICY\nfooter');
  const input = request(baseline.ref);
  const sourceCapturesPath = join(root, '.signals/source-captures.json');
  const captureBytes = await readFile(sourceCapturesPath);

  const created = await createSourceWatch(root, input);
  const replay = await createSourceWatch(root, input);
  const read = await readSourceWatch(root, created.watch.id);
  const listed = await listSourceWatches(root);

  expect(created.replayed).toBe(false);
  expect(replay.replayed).toBe(true);
  expect(replay.ref).toEqual(created.ref);
  expect(read.watch).toEqual(created.watch);
  expect(read.cold_read).toBe(true);
  expect(listed.watches).toHaveLength(1);
  expect((await readFile(sourceCapturesPath)).equals(captureBytes)).toBe(true);
  await expect(
    createSourceWatch(root, { ...input, rationale: 'Changed intent.' }),
  ).rejects.toMatchObject({ code: 'source_watch_changed', status: 409 });
});

it('checks only the selected exact text, preserving line mapping and ignore counts', async () => {
  const { root, capture } = await fixture();
  const baseline = await capture(
    'header\nBEGIN POLICY\nRule A\nGenerated on demand\nEND POLICY\nfooter',
  );
  const watch = await createSourceWatch(root, request(baseline.ref));
  const next = await capture(
    'header\nBEGIN POLICY\nRule B\nGenerated on demand\nEND POLICY\nfooter',
    baseline.ref,
  );

  const checked = await checkSourceWatch(root, watch.ref, next.ref);

  expect(checked.status).toBe('changed');
  expect(checked.comparison_scope).toBe('selected-retained-text-only');
  expect(checked.watch_ref).toEqual(watch.ref);
  expect(checked.baseline_capture_ref).toEqual(baseline.ref);
  expect(checked.new_capture_ref).toEqual(next.ref);
  expect(checked.baseline_coverage.scope).toEqual(baseline.capture.scope);
  expect(checked.new_coverage.text_sha256).toBe(next.capture.text_sha256);
  expect(checked.baseline_section.text).toContain('Rule A');
  expect(checked.new_section.text).toContain('Rule B');
  expect(checked.baseline_section.line_map.length).toBeLessThanOrEqual(40);
  expect(checked.ignored_counts).toEqual({ baseline: 1, next: 1 });
  expect(checked.diff.state).toBe('changed');
  expect(checked.comparison_scope).toBe('selected-retained-text-only');
  expect(checked.diff_line_coordinates).toBe('filtered-section-lines');
  expect(checked.qualification.join(' ')).toContain('does not judge semantic importance');
});

it('hashes full original capture lines when markers sit mid-line', async () => {
  const { root, capture } = await fixture();
  const baselineText = 'prefix BEGIN POLICY\nRule A\nEND POLICY suffix';
  const baseline = await capture(baselineText);
  const input = {
    ...request(baseline.ref),
    start_marker: 'BEGIN POLICY',
    end_marker: 'END POLICY',
    ignore_lines: [],
  };
  const watch = await createSourceWatch(root, input);
  const next = await capture('prefix BEGIN POLICY\nRule B\nEND POLICY suffix', baseline.ref);
  const checked = await checkSourceWatch(root, watch.ref, next.ref);

  expect(checked.status).toBe('changed');
  expect(checked.baseline_section.line_map[0]).toEqual({
    line_number: 1,
    line_sha256: createHash('sha256').update('prefix BEGIN POLICY').digest('hex'),
  });
  expect(checked.baseline_section.line_map[1]).toEqual({
    line_number: 2,
    line_sha256: createHash('sha256').update('Rule A').digest('hex'),
  });
  expect(checked.diff_line_coordinates).toBe('filtered-section-lines');
});

it('returns unresolved for marker, source, or lineage mismatches', async () => {
  const { root, capture } = await fixture();
  const baseline = await capture('BEGIN POLICY\nRule A\nEND POLICY');
  const watch = await createSourceWatch(root, request(baseline.ref));
  const missingMarkers = await capture('No selected section', baseline.ref);
  const missingCheck = await checkSourceWatch(root, watch.ref, missingMarkers.ref);
  expect(missingCheck.status).toBe('unresolved');
  expect(missingCheck.comparison_scope).toBe('selected-retained-text-only');
  expect(missingCheck.baseline_coverage.scope).toEqual(baseline.capture.scope);

  const unrelated = await capture('BEGIN POLICY\nRule A\nEND POLICY');
  expect((await checkSourceWatch(root, watch.ref, unrelated.ref)).status).toBe('unresolved');

  const other = await fixture();
  const otherCapture = await other.capture('BEGIN POLICY\nRule A\nEND POLICY');
  expect((await checkSourceWatch(root, watch.ref, otherCapture.ref)).status).toBe('unresolved');
});

it('refuses missing or ambiguous literal markers when defining a watch', async () => {
  const { root, capture } = await fixture();
  const baseline = await capture('BEGIN POLICY\nRule A\nEND POLICY\nBEGIN POLICY');
  await expect(createSourceWatch(root, request(baseline.ref))).rejects.toMatchObject({
    code: 'invalid_source_watch',
    status: 400,
  });
  const overlap = await capture('aaaa\nEND');
  await expect(
    createSourceWatch(root, {
      ...request(overlap.ref),
      start_marker: 'aaa',
      end_marker: 'END',
    }),
  ).rejects.toMatchObject({ code: 'invalid_source_watch', status: 400 });
});
