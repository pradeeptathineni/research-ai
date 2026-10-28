import { it, expect } from 'vitest';
import { mkdtemp, realpath, rm, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractHtml, cachedMaterial } from './search-document.js';
import { digest } from './search-fetch.js';
import { privateCacheFetch } from './search-cache.js';
import { atomicJson } from './search-store.js';
import { layoutProjectionDigest } from './search-html-layout.js';

const uri = 'https://example.org/limits';
const raw =
  '<html><head><title>Numeric controls</title></head><body><main><h1>Published limits</h1><table id="limits"><tr><th>Date</th><th>Maximum USD</th></tr><tr><td>2026-10-12</td><td>10</td></tr><tr><td>2026-10-13</td><td>100</td></tr></table><p>This proposed launch is not operational. These amounts are limits, not observed usage.</p></main></body></html>';

it.each(['snapshot', 'span', 'text', 'grid'])(
  'rejects projection %s tampering even with recomputed metadata digest',
  (field) => {
    const doc = extractHtml(raw, uri);
    const table = doc.sections.find((section) => section.provenance)?.provenance?.[0] as {
      snapshotDigest: string;
      cells: { start: number; text: string }[];
      grid: number[][];
    };
    if (field === 'snapshot') table.snapshotDigest = 'a'.repeat(64);
    if (field === 'span') table.cells[0]!.start++;
    if (field === 'text') table.cells[0]!.text = 'Invented';
    if (field === 'grid') table.grid[0]![0] = 1;
    doc.scope!.projectionDigest = layoutProjectionDigest(doc.sections);
    expect(() => cachedMaterial(doc)).toThrow(/invalid_table_/);
  },
);

it.each([false, true])(
  'preserves legacy HTML cache across plain-text changes at every age (expired=%s)',
  async (expired) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-cache-kind-')));
    const path = join(root, '.signals/source-cache', `${digest(uri)}.json`);
    try {
      const old = extractHtml(raw, uri, 'text-v2');
      await atomicJson(path, {
        uri,
        text: old.text,
        material: old,
        digest: digest(raw),
        normalizer: 'text-v2',
      });
      if (expired) await utimes(path, new Date(0), new Date(0));
      const bytes = await readFile(path);
      let calls = 0;
      const fetch = privateCacheFetch(root, undefined, async () => {
        calls++;
        return {
          uri,
          text: 'A changed plain-text body.',
          digest: digest('A changed plain-text body.'),
          normalizer: 'text-v2',
        };
      });
      await fetch(uri);
      expect((await fetch(uri)).text).toBe('A changed plain-text body.');
      expect(calls).toBe(1);
      expect(await readFile(path)).toEqual(bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('retains the exact historical v2 fixture while v3 preserves dates/amounts with snapshot-bound cell spans', () => {
  expect(digest(raw)).toBe('0612b0595ce0aba7befe970bac9155a2f0bd9f0ca95d08681e597a4cdaf302ac');
  const old = extractHtml(raw, uri, 'text-v2');
  expect(old.text).toBe(
    'Numeric controls Published limitsDateMaximum USD2026-10-12102026-10-13100This proposed launch is not operational. These amounts are limits, not observed usage.',
  );
  expect(old.sections.find((section) => section.locator === '#limits')?.text).toBe(
    'DateMaximum USD2026-10-12102026-10-13100',
  );
  const next = extractHtml(raw, uri);
  const projection = next.sections.find((section) => section.locator === '#limits')
    ?.provenance?.[0] as {
    cells: { text: string; start: number; end: number }[];
    grid: number[][];
    start: number;
    end: number;
    snapshotDigest: string;
  };
  expect(projection.grid.map((row) => row.map((index) => projection.cells[index]?.text))).toEqual([
    ['Date', 'Maximum USD'],
    ['2026-10-12', '10'],
    ['2026-10-13', '100'],
  ]);
  for (const cell of projection.cells)
    expect(next.text.slice(cell.start, cell.end)).toBe(cell.text);
  expect(projection.snapshotDigest).toBe(digest(next.text));
  expect(next.text).toContain('not operational');
  expect(next.text).toContain('limits, not observed usage');
  expect(cachedMaterial(next)).toEqual(next);
  expect(digest(next.text)).not.toBe(digest(old.text));
});

it('projects grouped/rowspan headers and preserves block caveats without inventing values', () => {
  const doc = extractHtml(
    '<html><body><table><caption>Measurements</caption><thead><tr><th rowspan="2">Cohort</th><th colspan="2">Assay</th></tr><tr><th>Count</th><th>Response (%)</th></tr></thead><tbody><tr><th scope="row" rowspan="2">Group A</th><td>20</td><td>0</td></tr><tr><td>10</td><td>Not measured</td></tr></tbody></table><p>Not a recommendation.</p><footer>Duration unknown.</footer></body></html>',
    uri,
  );
  const projection = doc.sections.find((section) => section.provenance)?.provenance?.[0] as {
    cells: { text: string; rowSpan: number; columnSpan: number }[];
    grid: number[][];
  };
  expect(projection.grid.map((row) => row.map((index) => projection.cells[index]?.text))).toEqual([
    ['Cohort', 'Assay', 'Assay'],
    ['Cohort', 'Count', 'Response (%)'],
    ['Group A', '20', '0'],
    ['Group A', '10', 'Not measured'],
  ]);
  expect(doc.text).toContain('Not a recommendation.');
  expect(doc.text).toContain('Duration unknown.');
  expect(doc.scope?.omittedTables).toBe(0);
});

it('keeps safe curated links, meaningful query/hash and visible polarity while excluding explicit hidden/noise', () => {
  const doc = extractHtml(
    '<html><body><nav>NOISE<a href="/guide?edition=2#scope">Guide</a></nav><p>Do <em>not</em> infer clinical effect.</p><div hidden>PRIVATE_SENTINEL<a href="/hidden">Secret</a></div><p style="display:none">PRIVATE_STYLE</p><script>globalThis.layoutExecuted = true</script><a href="https://127.0.0.1/private">Bad</a><a href="file:///etc/passwd">Bad</a></body></html>',
    uri,
  );
  expect(doc.text).toContain('Do not infer clinical effect.');
  expect(doc.text).not.toMatch(/NOISE|PRIVATE_|layoutExecuted/);
  expect(doc.links).toEqual([{ uri: 'https://example.org/guide?edition=2#scope', title: 'Guide' }]);
  expect(doc.scope?.excludedNodes).toBeGreaterThan(0);
  expect('layoutExecuted' in globalThis).toBe(false);
});

it('exposes unsupported span bounds instead of pretending a complete table association', () => {
  const doc = extractHtml(
    '<html><body><table><tr><th>A</th></tr><tr><td colspan="99999">Do not adopt.</td></tr></table></body></html>',
    uri,
  );
  expect(doc.scope?.omittedTables).toBe(1);
  expect(doc.text).toContain('Unresolved table structure');
  expect(doc.text).toContain('Do not adopt.');
});

it('counts omitted table and deep DOM coverage, and rejects a forged snapshot in cache replay', () => {
  const many = extractHtml(
    `<html><body>${'<table><tr><td>Visible.</td></tr></table>'.repeat(81)}</body></html>`,
    uri,
  );
  expect(many.scope?.tables).toBe(81);
  expect(many.scope?.omittedTables).toBe(1);
  const deep = extractHtml(
    `<html><body>${'<div>'.repeat(140)}Unvisited.${'</div>'.repeat(140)}</body></html>`,
    uri,
  );
  expect(deep.scope?.omittedDepth).toBeGreaterThan(0);
  expect(() => cachedMaterial({ ...many, text: `${many.text} invented` })).toThrow(
    'invalid_document_layout_digest',
  );
});

it('bypasses and preserves v2 HTML cache, writing a separate version key without renewing cached dates', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-layout-cache-')));
  const old = extractHtml(raw, uri, 'text-v2');
  const oldPath = join(root, '.signals/source-cache', `${digest(uri)}.json`);
  try {
    await atomicJson(oldPath, {
      uri,
      text: old.text,
      digest: digest(raw),
      normalizer: 'text-v2',
      material: old,
      fetchedAt: '2020-01-01T00:00:00Z',
    });
    const oldBytes = await readFile(oldPath);
    let calls = 0;
    const fetch = privateCacheFetch(root, undefined, async () => {
      calls++;
      const material = extractHtml(raw, uri);
      return { uri, text: material.text, digest: digest(raw), normalizer: 'text-v3', material };
    });
    const first = await fetch(uri),
      second = await fetch(uri);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.normalizer).toBe('text-v3');
    expect(second.fetchedAt).toBe(first.fetchedAt);
    expect(calls).toBe(1);
    expect(await readFile(oldPath)).toEqual(oldBytes);
    expect(
      await readFile(
        join(root, '.signals/source-cache', `${digest(`${uri}:text-v3`)}.json`),
        'utf8',
      ),
    ).toContain('html-layout-v1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
