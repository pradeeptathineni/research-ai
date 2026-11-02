import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { saveLibraryLead } from './library-leads.js';
import { exactOwnerRecord } from './provider-capabilities.js';
import { createSourceCapture, type RecordRef } from './source-captures.js';
import { checkSourceWatch, createSourceWatch, readSourceWatch } from './source-watches.js';

const resolveRef = async (root: string, ref: RecordRef) => {
  const exact = await exactOwnerRecord(root, ref);
  return { bytes: exact.bytes, ref: exact.ref as RecordRef };
};

it('checks exact watched sections across source descendants without rewriting captured source bytes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-source-watch-')));
  const lead = await saveLibraryLead(
    root,
    {
      uri: 'https://example.test/synthetic-release',
      name: 'Synthetic release notes',
      description: 'A local test source; no external content is fetched.',
      limits: ['Synthetic fixture only.'],
    },
    randomUUID(),
    'synthetic source-watch fixture',
  );
  try {
    const sourceRef = (await exactOwnerRecord(root, {
      owner: 'signals-ai', kind: 'lead', id: lead.id, revision: null, digest: null,
    })).ref as RecordRef;
    const capture = (text: string, observedAt: string, supersedes?: RecordRef) => createSourceCapture(
      root,
      {
        source_ref: sourceRef,
        mode: 'paste',
        text,
        observed_at: observedAt,
        ...(supersedes ? { supersedes } : {}),
      },
      (ref) => resolveRef(root, ref),
    );
    const start = '<!-- WATCHED SECTION START -->';
    const end = '<!-- WATCHED SECTION END -->';
    const first = await capture(
      `Global heading A\n${start}\nRelease status\nUpdated at: 08:00 UTC\nStatus: alpha\n${end}\nGlobal footer A`,
      '2026-11-02T08:00:00Z',
    );
    const second = await capture(
      `Global heading B\n${start}\nRelease status\nUpdated at: 09:00 UTC\nStatus: alpha\n${end}\nGlobal footer B`,
      '2026-11-02T09:00:00Z',
      first.ref,
    );
    const third = await capture(
      `Global heading C\n${start}\nRelease status\nUpdated at: 10:00 UTC\nStatus: beta\n${end}\nGlobal footer C`,
      '2026-11-02T10:00:00Z',
      second.ref,
    );
    const missingMarker = await capture(
      `Global heading D\n${start}\nRelease status\nUpdated at: 11:00 UTC\nStatus: beta\nGlobal footer D`,
      '2026-11-02T11:00:00Z',
      third.ref,
    );
    const duplicatedMarker = await capture(
      `Global heading E\n${start}\nRelease status\n${start}\nUpdated at: 12:00 UTC\nStatus: beta\n${end}\nGlobal footer E`,
      '2026-11-02T12:00:00Z',
      missingMarker.ref,
    );
    const disconnected = await capture(
      `Global heading disconnected\n${start}\nRelease status\nUpdated at: 13:00 UTC\nStatus: alpha\n${end}\nGlobal footer`,
      '2026-11-02T13:00:00Z',
    );

    const capturesPath = join(root, '.signals/source-captures.json');
    const sourcePath = join(root, '.signals/library-leads.json');
    const capturesBeforeWatch = await readFile(capturesPath);
    const sourceBeforeWatch = await readFile(sourcePath);
    const request = {
      request_id: randomUUID(),
      label: 'Synthetic release status section',
      rationale: 'Track the exact retained release-status section; outside text has no watch meaning.',
      baseline_capture_ref: first.ref,
      start_marker: start,
      end_marker: end,
      ignore_lines: ['Updated at: 08:00 UTC', 'Updated at: 09:00 UTC', 'Updated at: 10:00 UTC', 'Updated at: 11:00 UTC', 'Updated at: 12:00 UTC', 'Updated at: 13:00 UTC'],
    };
    const created = await createSourceWatch(root, request);
    expect(created.replayed).toBe(false);
    expect(created.watch.baseline_capture_ref).toEqual(first.ref);
    expect(created.ref.kind).toBe('source-watch');
    const replay = await createSourceWatch(root, request);
    expect(replay.replayed).toBe(true);
    expect(replay.ref).toEqual(created.ref);
    await expect(createSourceWatch(root, { ...request, rationale: 'Changed rationale under the old request identity.' }))
      .rejects.toMatchObject({ status: 409, code: 'source_watch_changed' });

    const cold = await readSourceWatch(root, created.watch.id);
    expect(cold.cold_read).toBe(true);
    expect(cold.watch).toEqual(created.watch);
    expect(cold.ref).toEqual(created.ref);

    const unchanged = await checkSourceWatch(root, created.ref, second.ref);
    expect(unchanged).toMatchObject({
      schema_version: 'source-watch-check-v1',
      status: 'unchanged',
      watch_ref: created.ref,
      baseline_capture_ref: first.ref,
      new_capture_ref: second.ref,
      ignored_counts: { baseline: 1, next: 1 },
    });
    expect(unchanged.baseline_section.text_sha256).toBe(unchanged.new_section.text_sha256);
    expect(first.capture.text).not.toBe(second.capture.text);
    expect(first.capture.text_sha256).not.toBe(second.capture.text_sha256);
    expect(unchanged.qualification.some((item) => item.includes('selected text only'))).toBe(true);

    const changed = await checkSourceWatch(root, created.ref, third.ref);
    expect(changed).toMatchObject({
      status: 'changed',
      watch_ref: created.ref,
      baseline_capture_ref: first.ref,
      new_capture_ref: third.ref,
      ignored_counts: { baseline: 1, next: 1 },
    });
    expect(changed.diff.added).toContain('Status: beta');
    expect(changed.diff.removed).toContain('Status: alpha');
    expect(changed.new_section.line_map.every((line) => line.line_number > 1 && line.line_number < 9)).toBe(true);
    expect(changed.new_section.line_map.every((line) => /^[a-f0-9]{64}$/.test(line.line_sha256))).toBe(true);

    const missing = await checkSourceWatch(root, created.ref, missingMarker.ref);
    expect(missing.status).toBe('unresolved');
    expect(missing.reason).toMatch(/marker/);
    const duplicate = await checkSourceWatch(root, created.ref, duplicatedMarker.ref);
    expect(duplicate.status).toBe('unresolved');
    expect(duplicate.reason).toMatch(/marker/);
    const brokenLineage = await checkSourceWatch(root, created.ref, disconnected.ref);
    expect(brokenLineage.status).toBe('unresolved');
    expect(brokenLineage.reason).toMatch(/descendant/);
    for (const result of [missing, duplicate, brokenLineage]) {
      expect(result.qualification.some((item) => item.includes('no quiet unchanged result was inferred'))).toBe(true);
      expect(result.status).not.toBe('unchanged');
    }
    expect(await readFile(capturesPath)).toEqual(capturesBeforeWatch);
    expect(await readFile(sourcePath)).toEqual(sourceBeforeWatch);
    expect((await readSourceWatch(root, created.watch.id)).watch).toEqual(created.watch);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
