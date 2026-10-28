import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { extractHtml } from './search-document.js';
import { digest } from './search-fetch.js';
import { listPreview, previewSnapshot, selectPreview } from './search-material-preview.js';

const bytes = (text: string) =>
  Buffer.from(
    JSON.stringify({
      text,
      title: 'Authored range control',
      author: null,
      publishedAt: null,
      links: [],
      sections: [],
      extractor: 'plain-text',
    }),
  );

it('returns the exact caller-selected slice, original coordinates and outside scope without mutating input', () => {
  const input = bytes('Scope. Not safe unless the prerequisite holds. Other material.');
  const before = Buffer.from(input);
  const snapshot = previewSnapshot(input);
  const result = selectPreview(snapshot, {
    expectedTextSha256: digest(snapshot.material.text),
    start: 7,
    end: 46,
  });
  expect(result.selection.text).toBe('Not safe unless the prerequisite holds.');
  expect(result.selection.units).toBe(39);
  expect(result.outsideSelection.before).toEqual({ start: 0, end: 7, units: 7 });
  expect(result.outsideSelection.after.end).toBe(snapshot.material.text.length);
  expect(result.coordinate).toContain('UTF16');
  expect(result.notices.join(' ')).toContain('not independently authenticated');
  expect(input).toEqual(before);
  expect(result.inputSha256).toBe(createHash('sha256').update(input).digest('hex'));
});

it('refuses a stale digest and malformed, unsafe or empty coordinates', () => {
  const snapshot = previewSnapshot(bytes('ordinary source'));
  expect(() =>
    selectPreview(snapshot, { expectedTextSha256: '0'.repeat(64), start: 0, end: 3 }),
  ).toThrow('preview_stale_digest');
  const invalidRanges: [number, number][] = [
    [-1, 3],
    [0.1, 3],
    [0, Infinity],
    [NaN, 3],
    [5, 3],
    [3, 3],
    [0, 100],
    [0, Number.MAX_SAFE_INTEGER + 1],
  ];
  for (const [start, end] of invalidRanges) {
    expect(() =>
      selectPreview(snapshot, { expectedTextSha256: digest(snapshot.material.text), start, end }),
    ).toThrow('preview_invalid_range');
  }
});

it('keeps the exact48000-unit bound and refuses an oversized selection rather than trimming', () => {
  const snapshot = previewSnapshot(bytes('A'.repeat(48001)));
  const request = { expectedTextSha256: digest(snapshot.material.text), start: 0, end: 48000 };
  expect(selectPreview(snapshot, request).selection.text.length).toBe(48000);
  expect(() => selectPreview(snapshot, { ...request, end: 48001 })).toThrow(
    'preview_range_over_budget',
  );
  expect(snapshot.material.text.length).toBe(48001);
});

it('rejects split surrogate boundaries and preserves valid non-BMP selections and navigation', () => {
  const snapshot = previewSnapshot(bytes('A🧪B🧭C'));
  const request = { expectedTextSha256: digest(snapshot.material.text), start: 1, end: 3 };
  expect(selectPreview(snapshot, request).selection.text).toBe('🧪');
  expect(() => selectPreview(snapshot, { ...request, start: 2 })).toThrow(
    'preview_range_splits_surrogate',
  );
  expect(() => selectPreview(snapshot, { ...request, start: 0, end: 2 })).toThrow(
    'preview_range_splits_surrogate',
  );
  expect(() => listPreview(snapshot, { offset: 2 })).toThrow('preview_offset_splits_surrogate');
  let offset = 0,
    observed = '';
  do {
    const page = listPreview(snapshot, { offset, windowUnits: 2, windows: 1 }).page;
    observed += snapshot.material.text.slice(page.windows[0]!.start, page.windows[0]!.end);
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  } while (offset < snapshot.material.text.length);
  expect(observed).toBe(snapshot.material.text);
});

it('rejects ill-formed Unicode that would collide under the UTF8 text digest', () => {
  expect(digest('\ud800')).toBe(digest('\ud801'));
  expect(() => previewSnapshot(bytes('\ud800'))).toThrow('preview_invalid_unicode');
});

it('offers bounded navigation to late material without semantic section or ranking claims', () => {
  const snapshot = previewSnapshot(
    bytes('A'.repeat(60000) + 'Not permitted without supporting equipment.'),
  );
  const first = listPreview(snapshot, { windows: 2 });
  expect(first.page.windows.length).toBe(2);
  expect(first.page.nextOffset).toBe(8000);
  const late = listPreview(snapshot, { offset: 60000, windows: 1 });
  expect(late.page.windows[0]!.snippet).toContain('Not permitted');
  expect(late.page.nextOffset).toBeNull();
  expect(late.navigation).toContain('not semantic or complete prose sections');
  expect(first.page.windows.every((window) => window.snippet.length <= 160)).toBe(true);
});

it('retains caller URI labels including meaningful query and fragment while validating safety', () => {
  const label = 'https://example.org/specification?edition=2#requirements';
  expect(previewSnapshot(bytes('text'), label).sourceUriLabel).toBe(label);
  expect(() => previewSnapshot(bytes('text'), 'https://127.0.0.1/private')).toThrow(
    'preview_invalid_source_uri',
  );
});

it('retains extraction warnings, old unmeasured scope and original table coordinates without cell geometry', () => {
  const doc = extractHtml(
    '<html><body><h1 id="conditions">Conditions</h1><p>Not for unsupported configurations.</p><table><tr><th>Setting</th><th>Value</th></tr><tr><td>Limit</td><td>5 mm</td></tr></table><div hidden>Unless independently tested.</div></body></html>',
    'https://example.org/spec',
  );
  const before = JSON.stringify(doc);
  const snapshot = previewSnapshot(Buffer.from(before));
  const table = doc.sections
    .flatMap((section) => section.provenance ?? [])
    .find((item) => (item as { kind?: string }).kind === 'html-table-v1') as {
    start: number;
    end: number;
  };
  const result = selectPreview(snapshot, {
    expectedTextSha256: digest(doc.text),
    start: table.start + 1,
    end: table.end - 1,
  });
  expect(result.tables[0]).toMatchObject({
    tableStart: table.start,
    tableEnd: table.end,
    fullyWithinRange: false,
  });
  expect(result.tables[0]).not.toHaveProperty('cells');
  expect(result.omissions.join(' ')).toContain('not complete source coverage');
  expect(JSON.stringify(doc)).toBe(before);
  const historical = structuredClone(doc);
  delete historical.scope;
  expect(
    listPreview(previewSnapshot(Buffer.from(JSON.stringify(historical)))).omissions.join(' '),
  ).toContain('not measured');
});

it('refuses malformed recognized projection, malformed JSON, invalid UTF8 and excessive bytes', () => {
  const doc = extractHtml(
    '<html><body><p>Text</p><table><tr><td>Value</td></tr></table></body></html>',
    'https://example.org/table',
  );
  doc.scope!.textDigest = '0'.repeat(64);
  expect(() => previewSnapshot(Buffer.from(JSON.stringify(doc)))).toThrow(
    'invalid_document_layout_digest',
  );
  expect(() => previewSnapshot(Buffer.from('{'))).toThrow('preview_malformed_material');
  expect(() => previewSnapshot(Buffer.from([0xc3, 0x28]))).toThrow('preview_malformed_material');
  expect(() => previewSnapshot(Buffer.alloc(16 * 1024 * 1024 + 1))).toThrow(
    'preview_input_too_large',
  );
});

it('opens later windows at a blank-line separator without exceeding the limit or dropping text', () => {
  const text = `Intro\n\n${'A'.repeat(90)}\n\nCaveat: not valid without the adapter.\n\n${'B'.repeat(90)}`;
  const snapshot = previewSnapshot(bytes(text));
  const page = listPreview(snapshot, { windowUnits: 120 }).page;
  const [first, second] = page.windows;
  // A fixed cut at 120 would end mid-caveat-neighbourhood; the last separator fits within it.
  expect(first!.end).toBe(99);
  expect(first!.endsAtBlockGap).toBe(true);
  expect(second!.opensAtBlockGap).toBe(true);
  expect(second!.snippet.startsWith('Caveat: not valid')).toBe(true);
  expect(page.windows.every((window) => window.units <= 120)).toBe(true);
  expect(page.windows.map((window) => text.slice(window.start, window.end)).join('')).toBe(text);
  expect(page.end).toBe(text.length);
  expect(page.remainingUnits).toBe(0);
});

it('falls back to the plain cut for oversized blocks and early separators, never shrinking below half', () => {
  const huge = previewSnapshot(bytes(`${'A'.repeat(500)}\n\nTail`));
  const hugePage = listPreview(huge, { windowUnits: 100, windows: 2 }).page;
  expect(hugePage.windows.map((window) => window.end)).toEqual([100, 200]);
  expect(hugePage.windows[0]!.endsAtBlockGap).toBe(false);
  expect(hugePage.nextOffset).toBe(200);
  expect(hugePage.remainingUnits).toBe(huge.material.text.length - 200);
  // An early separator would yield a 3-unit window; the half-limit guard keeps the full cut.
  const early = previewSnapshot(bytes(`X\n\n${'A'.repeat(300)}`));
  expect(listPreview(early, { windowUnits: 100, windows: 1 }).page.windows[0]!.end).toBe(100);
  // Exact limit sizing is unchanged when no separator exists in the whole text.
  const plain = previewSnapshot(bytes('A'.repeat(60000)));
  expect(listPreview(plain, { windows: 2 }).page.nextOffset).toBe(8000);
});

it('never ends a snapped window inside a generated table projection', () => {
  const doc = extractHtml(
    `<html><body><p>${'Lead '.repeat(20)}</p><table><caption>Limits</caption><tr><th>Setting</th><th>Value</th></tr><tr><td>Flow</td><td>5 mm</td></tr><tr><td>Note</td><td>Not valid unless calibrated</td></tr></table><p>${'Trail '.repeat(20)}</p></body></html>`,
    'https://example.org/table-windows',
  );
  const table = doc.sections
    .flatMap((section) => section.provenance ?? [])
    .find((item) => (item as { kind?: string }).kind === 'html-table-v1') as {
    start: number;
    end: number;
  };
  const snapshot = previewSnapshot(Buffer.from(JSON.stringify(doc)));
  for (let units = 40; units <= 400; units += 7)
    for (const window of listPreview(snapshot, { windowUnits: units, windows: 100 }).page.windows) {
      expect(window.units).toBeLessThanOrEqual(units);
      // Hard cuts inside the table stay possible and are flagged; snapped ends are not inside it.
      if (window.endsAtBlockGap && window.end < doc.text.length)
        expect(window.end <= table.start || window.end >= table.end).toBe(true);
    }
});
