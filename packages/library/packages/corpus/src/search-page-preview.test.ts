import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Value } from 'typebox/value';
import { selectedPacketSchema } from '../../domain/src/selected-source.js';
import { selectPagePreview } from './search-material-preview.js';
import { materialPreviewCli } from '../../../scripts/material-preview.js';

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
// Authored projections only. These metadata labels do not represent parser/runtime execution.
function fixture(strings: string[]) {
  let end = 0;
  const pages = strings.map((text, index) => {
    const start = end + (index ? 2 : 0);
    end = start + text.length;
    return { page: index + 1, state: 'text', directImagePresent: true, start, end };
  });
  const text = strings.join('\n\n');
  return {
    parser: 'pypdf6.20.1',
    coordinateUnits: 'UTF16',
    pages,
    text,
    sourceDigest: digest('authored synthetic PDF identity, not actual PDF bytes'),
    status: 'text-layer',
    completeSourceCoverage: false,
    omissions: [
      'Authored text-layer control; image/visual/semantic completeness is not established.',
    ],
    textDigest: digest(text),
    resourceReadback: { addressSpace: [201326592, 201326592], cpu: [8, 8], uid: 65534 },
  };
}
const bytes = (source: ReturnType<typeof fixture>) => Buffer.from(JSON.stringify(source));
function request(source: ReturnType<typeof fixture>, anchors = ['anchor']) {
  return {
    expectedInputSha256: digest(bytes(source)),
    expectedSourceSha256: source.sourceDigest,
    expectedTextSha256: source.textDigest,
    sourceUri: 'https://example.org/manual?rev=B#requirements',
    claim: 'Authored conditional proposition, not a production fact.',
    anchors,
  };
}

const cases = [
  {
    id: 'cooling',
    pages: [
      'Compatibility scope. Fluid C is listed for copper circuits only.',
      'Aluminum circuits: Do not use Fluid C. The exception applies only to the coated copper adapter, not an aluminum radiator.',
      'Use Fluid D for aluminum circuits. Damaged coatings require independent inspection.',
    ],
    anchor: 'Fluid C',
    retained: ['Do not use Fluid C', 'not an aluminum radiator', 'independent inspection'],
  },
  {
    id: 'retention',
    pages: [
      'Lifecycle specification. This is prescribed policy, not an observed account operation.',
      'RetainExceptOnCreate retains the resource on later stack deletion.',
      'Exception: if the operation that created the resource rolls back, RetainExceptOnCreate deletes that resource.',
      'No conclusion about update replacement or account permissions follows.',
    ],
    anchor: 'RetainExceptOnCreate',
    retained: ['later stack deletion', 'rolls back', 'deletes that resource', 'No conclusion'],
  },
  {
    id: 'version-date',
    pages: [
      'Release record. Revision A applies before 2025-01-01.',
      'Revision B is effective from 2025-01-01; it does not apply retroactively.',
      'Printed date is a document label; current deployment configuration is not known.',
    ],
    anchor: 'Revision B',
    retained: ['before 2025-01-01', 'does not apply retroactively', 'not known'],
  },
  {
    id: 'numeric-negation',
    pages: [
      'A test fixture quotes a maximum of 7 mm. Quotation is not unconditional permission.',
      'Do not use 7 mm when the seal is damaged. Maximum is 3 mm in that condition.',
      'This exception governs the earlier threshold; an absent inspection cannot establish a safe setting.',
    ],
    anchor: '7 mm',
    retained: [
      'not unconditional permission',
      'Do not use 7 mm',
      'Maximum is 3 mm',
      'cannot establish a safe setting',
    ],
  },
];
it.each(cases)(
  'preserves unrelated $id prerequisites/negations without semantic rewriting',
  (control) => {
    const source = fixture(control.pages);
    const result = selectPagePreview(bytes(source), request(source, [control.anchor]));
    for (const phrase of control.retained)
      expect(result.windows.map((w) => w.text).join('')).toContain(phrase);
    expect(result.semanticReview).toBe('not-performed');
    expect(result.confidence).toBe('Unknown');
    expect(result.completeSourceCoverage).toBe(false);
  },
);

it('selects all hits plus adjacent whole pages and preserves an exact union/unread complement', () => {
  const source = fixture([
    'scope condition',
    'anchor affirmative',
    'local negation',
    'remote exception remains unread',
    'unrelated note',
    'anchor adverse',
    'last prerequisite',
    'unread ending',
  ]);
  const input = bytes(source);
  const before = Buffer.from(input);
  const result = selectPagePreview(input, request(source));
  expect(result.selectedPages.map((p) => p.page)).toEqual([1, 2, 3, 5, 6, 7]);
  expect(result.unreadPages).toEqual([4, 8]);
  expect(result.windows.length).toBe(2);
  const ranges = [...result.windows, ...result.unreadRanges].sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const range of ranges) {
    expect(range.start).toBe(cursor);
    cursor = range.end;
  }
  expect(cursor).toBe(source.text.length);
  for (const window of result.windows)
    expect(window.text).toBe(source.text.slice(window.start, window.end));
  expect(result.selectedUnits).toBe(result.windows.reduce((n, w) => n + w.text.length, 0));
  expect(result.omissions.join(' ')).toContain('may contain decisive contrary');
  expect(result.omissions.join(' ')).toContain(
    'absence here does not establish source-wide absence',
  );
  expect(input).toEqual(before);
  expect(result.sourceUriLabel).toBe(request(source).sourceUri);
});

it('allows explicit remote context pages without choosing them semantically or losing the input', () => {
  const source = fixture([
    'anchor near start',
    'local context',
    'ordinary page',
    'remote exception',
    'other',
  ]);
  const result = selectPagePreview(bytes(source), { ...request(source), contextPages: [4] });
  expect(result.request.contextPages).toEqual([4]);
  expect(result.unreadPages).toEqual([]);
  expect(result.windows[0]!.text).toContain('remote exception');
  expect(result.completeSourceCoverage).toBe(false);
});

it('keeps original Unicode offsets and overlapping literal occurrences, without regex injection', () => {
  const source = fixture(['İ prefix 🧪 aaaa literal [x] and UPPER label']);
  const result = selectPagePreview(bytes(source), request(source, ['aaa', '[x]', 'upper', '🧪']));
  const repeated = result.occurrences.filter((x) => x.anchorIndex === 0);
  expect(repeated.length).toBe(2);
  expect(repeated[1]!.start).toBe(repeated[0]!.start + 1);
  for (const hit of result.occurrences)
    expect(source.text.slice(hit.start, hit.end).toLowerCase()).toBe(
      result.request.anchors[hit.anchorIndex]!.toLowerCase(),
    );
  expect(result.omissions.join(' ')).toContain('ligatures');
  expect(Value.Check(selectedPacketSchema, result)).toBe(true);
});

it.each([6, 7, 10])('closes the packet schema with all %i extraction warnings intact', (count) => {
  const source = fixture(['anchor with its condition']);
  source.omissions = Array.from({ length: count }, (_, index) => `Authored limitation ${index}.`);
  const result = selectPagePreview(bytes(source), request(source));
  expect(result.omissions.slice(0, count)).toEqual(source.omissions);
  expect(result.omissions).toHaveLength(count + 4);
  expect(Value.Check(selectedPacketSchema, result)).toBe(true);
});

it('keeps a cross-page anchor and internal separators without rediscovering page boundaries', () => {
  const source = fixture([
    'scope',
    'has internal\n\nseparator and tail',
    'head of next page',
    'last condition',
  ]);
  const result = selectPagePreview(bytes(source), request(source, ['tail\n\nhead']));
  expect(result.occurrences[0]!.pages).toEqual([2, 3]);
  expect(result.selectedPages.map((p) => p.page)).toEqual([1, 2, 3, 4]);
  expect(result.windows[0]!.text).toBe(source.text);
});

it('refuses missing anchors and non-equivalent ligature/casefold text rather than implying absence', () => {
  const source = fixture(['anchor and ﬁne Straße']);
  for (const anchors of [['anchor', 'missing'], ['fine'], ['STRASSE']])
    expect(() => selectPagePreview(bytes(source), request(source, anchors))).toThrow(
      'selection_anchor_unmatched',
    );
});

it('refuses overbroad all-hit inputs instead of silently selecting the first allowed hits', () => {
  const source = fixture(['aa '.repeat(129)]);
  expect(() => selectPagePreview(bytes(source), request(source, ['aa']))).toThrow(
    'selection_occurrence_overflow',
  );
});

it('refuses stale extraction/source/text identities before selecting', () => {
  const source = fixture(['anchor note']);
  const input = bytes(source);
  const zero = '0'.repeat(64);
  expect(() => selectPagePreview(input, { ...request(source), expectedInputSha256: zero })).toThrow(
    'selection_stale_input',
  );
  expect(() =>
    selectPagePreview(input, { ...request(source), expectedSourceSha256: zero }),
  ).toThrow('selection_stale_source_or_text');
  expect(() => selectPagePreview(input, { ...request(source), expectedTextSha256: zero })).toThrow(
    'selection_stale_source_or_text',
  );
  source.textDigest = zero;
  expect(() => selectPagePreview(bytes(source), request(source))).toThrow(
    'selection_stale_source_or_text',
  );
});

it('refuses altered, overlapping, gapped, noninteger and split-surrogate page ledgers', () => {
  const base = fixture(['first', 'anchor second']);
  for (const change of [0, -1, 1, 0.5]) {
    const source = structuredClone(base);
    source.pages[1]!.start += change;
    if (change === 0) source.pages[1]!.page = 1;
    expect(() => selectPagePreview(bytes(source), request(source))).toThrow();
  }
  const source = fixture(['anchor 🧪']);
  source.pages[0]!.end--;
  expect(() => selectPagePreview(bytes(source), request(source))).toThrow(
    'selection_invalid_page_ledger',
  );
});

it('refuses unknown properties, projection versions, failed/missing text and absent omission scope', () => {
  const base = fixture(['anchor text']);
  const controls = [
    { ...base, parser: 'other-parser' },
    { ...base, extra: true },
    { ...base, status: 'partial' },
    { ...base, omissions: [] },
    { ...base, omissions: Array.from({ length: 11 }, () => 'Beyond extraction warning bound.') },
    { ...base, pages: [{ ...base.pages[0], state: 'failed' }] },
  ];
  for (const source of controls) {
    const input = Buffer.from(JSON.stringify(source));
    expect(() =>
      selectPagePreview(input, { ...request(base), expectedInputSha256: digest(input) }),
    ).toThrow('selection_invalid_extraction');
  }
  expect(selectPagePreview(bytes(base), request(base)).selectedPages[0]!.directImagePresent).toBe(
    true,
  );
});

it('refuses ill-formed Unicode and unsafe caller source labels without normalization loss', () => {
  const source = fixture(['anchor \ud800']);
  expect(() => selectPagePreview(bytes(source), request(source))).toThrow(
    'selection_invalid_unicode_or_length',
  );
  const valid = fixture(['anchor']);
  for (const sourceUri of [
    'https://user:secret@example.org/a',
    'https://127.0.0.1/a',
    'file:///tmp/a',
  ])
    expect(() => selectPagePreview(bytes(valid), { ...request(valid), sourceUri })).toThrow(
      'selection_invalid_source_uri',
    );
});

it('refuses a large whole page or escaped serialized packet without trimming or raising the cap', () => {
  const large = fixture(['anchor ' + 'A'.repeat(48000)]);
  expect(() => selectPagePreview(bytes(large), request(large))).toThrow(
    'preview_range_over_budget',
  );
  const escaped = fixture(['anchor ' + '\x01'.repeat(8000)]);
  expect(() => selectPagePreview(bytes(escaped), request(escaped))).toThrow(
    'selection_packet_over_budget',
  );
  expect(escaped.text.length).toBe(8007);
  const warnings = fixture(['anchor retained']);
  warnings.omissions = Array.from({ length: 10 }, () => '\x01'.repeat(1200));
  expect(() => selectPagePreview(bytes(warnings), request(warnings))).toThrow(
    'selection_packet_over_budget',
  );
});

it('refuses invalid caller anchors, context IDs and claim fields', () => {
  const source = fixture(['anchor']);
  const base = request(source);
  for (const anchors of [[], ['a'], ['  '], ['X'.repeat(129)]])
    expect(() => selectPagePreview(bytes(source), { ...base, anchors })).toThrow(
      'selection_invalid_claim_or_anchors',
    );
  for (const contextPages of [[0], [2], [1, 1], [0.5]])
    expect(() => selectPagePreview(bytes(source), { ...base, contextPages })).toThrow(
      'selection_invalid_context_pages',
    );
  expect(() => selectPagePreview(bytes(source), { ...base, claim: ' ' })).toThrow(
    'selection_invalid_claim_or_anchors',
  );
  expect(() =>
    selectPagePreview(bytes(source), { ...base, anchors: ['anchor', 'ANCHOR'] }),
  ).toThrow('selection_duplicate_anchor');
  expect(() => selectPagePreview(bytes(source), { ...base, anchors: ['longſ', 'longs'] })).toThrow(
    'selection_duplicate_anchor',
  );
  expect(() =>
    selectPagePreview(bytes(source), {
      ...base,
      sourceUri: 'https://example.org/' + '🧪'.repeat(200),
    }),
  ).toThrow('selection_invalid_source_uri');
});

it('admits distinct Unicode literal forms that lowercase to the same string', () => {
  const source = fixture(['Scope: İx and i\u0307x have distinct literal spellings.']);
  const result = selectPagePreview(bytes(source), request(source, ['İx', 'i\u0307x']));
  expect(result.occurrences).toHaveLength(2);
  expect(result.occurrences.map((hit) => source.text.slice(hit.start, hit.end))).toEqual([
    'İx',
    'i\u0307x',
  ]);
  expect(result.request.anchors).toEqual(['İx', 'i\u0307x']);
});

it('emits byte-identical compact CLI packets with the exact serialized budget and no input writes', () => {
  const home = mkdtempSync(join(tmpdir(), 'page-preview-test-'));
  try {
    const source = fixture(['scope', 'anchor [literal]', 'unless condition']);
    const input = bytes(source);
    const path = join(home, 'extraction.json');
    writeFileSync(path, input);
    const req = request(source);
    const args = [
      'pages',
      '--snapshot',
      path,
      '--input-sha256',
      req.expectedInputSha256,
      '--source-sha256',
      req.expectedSourceSha256,
      '--text-sha256',
      req.expectedTextSha256,
      '--source-uri',
      req.sourceUri,
      '--claim',
      req.claim,
      '--anchors',
      JSON.stringify(req.anchors),
    ];
    const first = materialPreviewCli(args);
    expect(first.code).toBe(0);
    expect(first.stderr).toBe('');
    expect(materialPreviewCli(args)).toEqual(first);
    expect(first.stdout).toBe(JSON.stringify(JSON.parse(first.stdout)) + '\n');
    expect(first.stdout.length).toBeLessThanOrEqual(48000);
    expect(Buffer.byteLength(first.stdout)).toBeLessThanOrEqual(300000);
    expect(readFileSync(path)).toEqual(input);
    expect(materialPreviewCli([...args, '--claim', 'duplicate']).code).toBe(2);
    expect(
      materialPreviewCli(
        args.map((arg) => (arg === req.expectedInputSha256 ? '0'.repeat(64) : arg)),
      ).code,
    ).toBe(1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
