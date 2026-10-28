import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { saveLibraryLead } from './library-leads.js';
import { exactOwnerRecord } from './provider-capabilities.js';
import {
  annotateSource,
  compareSourceCaptures,
  createSourceCapture,
  openSourceCapture,
  selectSourceCapture,
  type RecordRef,
} from './source-captures.js';

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

it('retains exact paste, annotation successors and historical selections without source reacquisition', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-captures-')));
  const source = await saveLibraryLead(
    root,
    {
      uri: 'https://example.org/article',
      name: 'Example article',
      description: 'A saved source',
      limits: [],
    },
    randomUUID(),
    'capture fixture',
  );
  const sourceRecord = await exactOwnerRecord(root, {
    owner: 'signals-ai',
    kind: 'lead',
    id: source.id,
    revision: null,
    digest: null,
  });
  const resolveSource = async (ref: RecordRef) => {
    const exact = await exactOwnerRecord(root, ref);
    return { bytes: exact.bytes, ref: exact.ref as RecordRef };
  };
  const sourceRef = sourceRecord.ref as RecordRef;
  const text = 'Alpha 😀 beta\r\nA quoted condition. A quoted condition.';
  try {
    const first = await createSourceCapture(
      root,
      { source_ref: sourceRef, mode: 'paste', text, observed_at: '2026-10-23T12:00:00Z' },
      resolveSource,
    );
    expect(first.capture.text).toBe(text);
    expect(first.capture.final_uri).toBeNull();
    expect(first.capture.raw_digest).toBeNull();
    expect(first.capture.provenance).toEqual({
      kind: 'user-supplied',
      transport_identity: 'unverified',
      freshness: 'unverified',
    });
    expect(first.capture.scope.capture).toMatchObject({
      mode: 'paste',
      original_utf16_units: text.length,
      retained_utf16_units: text.length,
      omitted_utf16_units: 0,
    });

    const quote = 'A quoted condition.';
    const anchor = { text_sha256: sha(text), start: 15, end: 34, quote };
    await expect(
      annotateSource(root, {
        capture_ref: first.ref,
        anchor: { ...anchor, text_sha256: '0'.repeat(64) },
        note: 'Wrong digest',
      }),
    ).rejects.toMatchObject({ status: 400 });
    const annotation1 = await annotateSource(root, {
      capture_ref: first.ref,
      anchor,
      note: 'My original reading',
    });
    const annotation2 = await annotateSource(root, {
      capture_ref: first.ref,
      anchor,
      note: 'Correction: I meant the first condition.',
      supersedes: annotation1.ref,
    });

    const secondText = 'Alpha 😀 beta\r\nA revised condition.';
    const second = await createSourceCapture(
      root,
      {
        source_ref: sourceRef,
        mode: 'paste',
        text: secondText,
        observed_at: '2026-10-23T13:00:00Z',
        supersedes: first.ref,
      },
      resolveSource,
    );
    const compare = await compareSourceCaptures(root, first.capture.id, second.capture.id);
    expect(compare.same_text).toBe(false);

    const selected = await selectSourceCapture(root, {
      capture_ref: first.ref,
      annotation_refs: [annotation1.ref],
    });
    expect(selected.annotations[0]?.ref).toEqual(annotation1.ref);
    expect(selected.annotations[0]?.annotation.note).toBe('My original reading');
    expect(() =>
      selected.annotations.map(({ annotation }) =>
        text.slice(annotation.anchor.start, annotation.anchor.end),
      ),
    ).not.toThrow();
    expect(annotation2.annotation.supersedes).toEqual(annotation1.ref);

    // Reopen uses only immutable private bytes after the live lead owner disappears.
    await rm(join(root, '.signals/library-leads.json'));
    expect((await openSourceCapture(root, first.capture.id)).capture).toEqual(first.capture);

    const exact = await exactOwnerRecord(root, first.ref);
    expect(JSON.parse(exact.bytes.toString('utf8'))).toEqual(first.capture);
    expect(exact.ref.digest).toBe(sha(exact.bytes.toString('utf8')));
    await expect(
      selectSourceCapture(root, {
        capture_ref: { ...first.ref, digest: 'f'.repeat(64), revision: `sha256:${'f'.repeat(64)}` },
        annotation_refs: [],
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      JSON.parse(await readFile(join(root, '.signals/source-captures.json'), 'utf8')).captures[0]
        .text,
    ).toBe(first.capture.text);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects an invalid private aggregate without repairing or replacing its bytes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-captures-corrupt-')));
  await (await import('./search-store.js')).secureDirectory(join(root, '.signals'));
  const corrupt = '{"schema_version":"1.0","captures":[],"annotations":[],"extra":true}';
  const path = join(root, '.signals/source-captures.json');
  await writeFile(path, corrupt, { mode: 0o600 });
  try {
    await expect(openSourceCapture(root, randomUUID())).rejects.toMatchObject({
      status: 503,
      code: 'source_capture_unavailable',
    });
    await expect(readFile(path, 'utf8')).resolves.toBe(corrupt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects stored capture forks while reopening a valid linear predecessor chain', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-captures-capture-fork-')));
  const source = await saveLibraryLead(
    root,
    { uri: 'https://example.org/a', name: 'A', description: 'A', limits: [] },
    randomUUID(),
    'fixture',
  );
  const raw = await exactOwnerRecord(root, {
    owner: 'signals-ai',
    kind: 'lead',
    id: source.id,
    revision: null,
    digest: null,
  });
  const ref = raw.ref as RecordRef;
  const resolveSource = async (candidate: RecordRef) => {
    const value = await exactOwnerRecord(root, candidate);
    return { bytes: value.bytes, ref: value.ref as RecordRef };
  };
  const path = join(root, '.signals/source-captures.json');
  try {
    const first = await createSourceCapture(
      root,
      {
        source_ref: ref,
        mode: 'paste',
        text: 'First version.',
        observed_at: '2026-10-23T12:00:00Z',
      },
      resolveSource,
    );
    const second = await createSourceCapture(
      root,
      {
        source_ref: ref,
        mode: 'paste',
        text: 'Second version.',
        observed_at: '2026-10-23T13:00:00Z',
        supersedes: first.ref,
      },
      resolveSource,
    );
    const third = await createSourceCapture(
      root,
      {
        source_ref: ref,
        mode: 'paste',
        text: 'Third version.',
        observed_at: '2026-10-23T14:00:00Z',
      },
      resolveSource,
    );
    await expect(openSourceCapture(root, second.capture.id)).resolves.toMatchObject({
      capture: second.capture,
    });
    const fork = JSON.parse(await readFile(path, 'utf8')) as {
      captures: Array<{ id: string; supersedes: RecordRef | null }>;
      annotations: unknown[];
    };
    const thirdRow = fork.captures.find((capture) => capture.id === third.capture.id)!;
    thirdRow.supersedes = first.ref;
    const bytes = JSON.stringify(fork);
    await writeFile(path, bytes, { mode: 0o600 });
    await expect(openSourceCapture(root, second.capture.id)).rejects.toMatchObject({
      status: 503,
      code: 'source_capture_unavailable',
    });
    await expect(readFile(path, 'utf8')).resolves.toBe(bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects split-surrogate, wrong-quote, and out-of-range anchors without changing history', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-captures-anchor-')));
  const source = await saveLibraryLead(
    root,
    { uri: 'https://example.org/a', name: 'A', description: 'A', limits: [] },
    randomUUID(),
    'fixture',
  );
  const raw = await exactOwnerRecord(root, {
    owner: 'signals-ai',
    kind: 'lead',
    id: source.id,
    revision: null,
    digest: null,
  });
  const ref = raw.ref as RecordRef;
  const resolveSource = async (candidate: RecordRef) => {
    const value = await exactOwnerRecord(root, candidate);
    return { bytes: value.bytes, ref: value.ref as RecordRef };
  };
  try {
    const text = 'A😀B';
    const capture = await createSourceCapture(
      root,
      { source_ref: ref, mode: 'paste', text, observed_at: '2026-10-23T12:00:00Z' },
      resolveSource,
    );
    const good = { text_sha256: sha(text), start: 1, end: 3, quote: '😀' };
    for (const anchor of [
      { ...good, start: 2, end: 3 },
      { ...good, quote: 'B' },
      { ...good, start: 0, end: 5 },
    ])
      await expect(
        annotateSource(root, { capture_ref: capture.ref, anchor, note: 'bad' }),
      ).rejects.toMatchObject({ status: 400 });
    expect((await openSourceCapture(root, capture.capture.id)).annotations).toHaveLength(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('allows one successor for a tip and rejects stale and cross-capture annotation predecessors', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-captures-lineage-')));
  const source = await saveLibraryLead(
    root,
    { uri: 'https://example.org/a', name: 'A', description: 'A', limits: [] },
    randomUUID(),
    'fixture',
  );
  const raw = await exactOwnerRecord(root, {
    owner: 'signals-ai',
    kind: 'lead',
    id: source.id,
    revision: null,
    digest: null,
  });
  const ref = raw.ref as RecordRef;
  const resolveSource = async (candidate: RecordRef) => {
    const value = await exactOwnerRecord(root, candidate);
    return { bytes: value.bytes, ref: value.ref as RecordRef };
  };
  try {
    const first = await createSourceCapture(
      root,
      {
        source_ref: ref,
        mode: 'paste',
        text: 'A exact quote.',
        observed_at: '2026-10-23T12:00:00Z',
      },
      resolveSource,
    );
    const second = await createSourceCapture(
      root,
      {
        source_ref: ref,
        mode: 'paste',
        text: 'A changed quote.',
        observed_at: '2026-10-23T13:00:00Z',
      },
      resolveSource,
    );
    await createSourceCapture(
      root,
      {
        source_ref: ref,
        mode: 'paste',
        text: 'A third quote.',
        observed_at: '2026-10-23T14:00:00Z',
        supersedes: first.ref,
      },
      resolveSource,
    );
    await expect(
      createSourceCapture(
        root,
        {
          source_ref: ref,
          mode: 'paste',
          text: 'A fourth quote.',
          observed_at: '2026-10-23T15:00:00Z',
          supersedes: first.ref,
        },
        resolveSource,
      ),
    ).rejects.toMatchObject({ status: 409 });
    const firstAnchor = {
      text_sha256: sha(first.capture.text),
      start: 2,
      end: 13,
      quote: 'exact quote',
    };
    const annotation = await annotateSource(root, {
      capture_ref: first.ref,
      anchor: firstAnchor,
      note: 'first',
    });
    const other = await annotateSource(root, {
      capture_ref: second.ref,
      anchor: { text_sha256: sha(second.capture.text), start: 2, end: 15, quote: 'changed quote' },
      note: 'other',
    });
    await expect(
      annotateSource(root, {
        capture_ref: first.ref,
        anchor: firstAnchor,
        note: 'cross',
        supersedes: other.ref,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const results = await Promise.allSettled([
      annotateSource(root, {
        capture_ref: first.ref,
        anchor: firstAnchor,
        note: 'successor A',
        supersedes: annotation.ref,
      }),
      annotateSource(root, {
        capture_ref: first.ref,
        anchor: firstAnchor,
        note: 'successor B',
        supersedes: annotation.ref,
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await openSourceCapture(root, first.capture.id)).capture.supersedes).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('fails closed on malformed stored provenance, surrogate text, and source-ref binding', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-captures-closure-')));
  const source = await saveLibraryLead(
    root,
    { uri: 'https://example.org/a', name: 'A', description: 'A', limits: [] },
    randomUUID(),
    'fixture',
  );
  const raw = await exactOwnerRecord(root, {
    owner: 'signals-ai',
    kind: 'lead',
    id: source.id,
    revision: null,
    digest: null,
  });
  const ref = raw.ref as RecordRef;
  const resolveSource = async (candidate: RecordRef) => {
    const value = await exactOwnerRecord(root, candidate);
    return { bytes: value.bytes, ref: value.ref as RecordRef };
  };
  const path = join(root, '.signals/source-captures.json');
  try {
    const created = await createSourceCapture(
      root,
      { source_ref: ref, mode: 'paste', text: 'Valid text.', observed_at: '2026-10-23T12:00:00Z' },
      resolveSource,
    );
    type MutableCapture = {
      provenance: { kind: string };
      text: string;
      source_ref: { revision: string };
    };
    const original = JSON.parse(await readFile(path, 'utf8')) as {
      captures: MutableCapture[];
      annotations: unknown[];
    };
    for (const mutate of [
      (capture: MutableCapture) => {
        capture.provenance.kind = 'fetch';
      },
      (capture: MutableCapture) => {
        capture.text = '\ud800';
      },
      (capture: MutableCapture) => {
        capture.source_ref.revision = `sha256:${'0'.repeat(64)}`;
      },
    ]) {
      const changed = structuredClone(original);
      mutate(changed.captures[0]!);
      const bytes = JSON.stringify(changed);
      await writeFile(path, bytes, { mode: 0o600 });
      await expect(openSourceCapture(root, created.capture.id)).rejects.toMatchObject({
        status: 503,
        code: 'source_capture_unavailable',
      });
      await expect(readFile(path, 'utf8')).resolves.toBe(bytes);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects unsafe source URIs and leaves prior capture bytes unchanged', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-captures-unsafe-')));
  const source = await saveLibraryLead(
    root,
    { uri: 'https://example.org/a', name: 'A', description: 'A', limits: [] },
    randomUUID(),
    'fixture',
  );
  const raw = await exactOwnerRecord(root, {
    owner: 'signals-ai',
    kind: 'lead',
    id: source.id,
    revision: null,
    digest: null,
  });
  const ref = raw.ref as RecordRef;
  const resolveSource = async (candidate: RecordRef) => {
    const value = await exactOwnerRecord(root, candidate);
    return { bytes: value.bytes, ref: value.ref as RecordRef };
  };
  try {
    await createSourceCapture(
      root,
      { source_ref: ref, mode: 'paste', text: 'Keep me.', observed_at: '2026-10-23T12:00:00Z' },
      resolveSource,
    );
    const path = join(root, '.signals/source-captures.json');
    const before = await readFile(path);
    await expect(
      createSourceCapture(
        root,
        { source_ref: { ...ref, kind: 'lead' }, mode: 'fetch' },
        async (candidate) => ({
          bytes: Buffer.from(JSON.stringify({ uri: 'http://127.0.0.1/private' })),
          ref: candidate,
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(readFile(path)).resolves.toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
