import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReport, reviseReport } from '../src/report.mjs';
import { validateReferenceList, formatBibliography, exportReportWithReferences } from '../src/bibliography.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const selection = { ref: { owner: 'planning-ai', kind: 'note', id: 'n1', revision: 'r1', digest: 'a'.repeat(64) }, instance_id: 'synthetic', owner_epoch: null };
const metadata = { type: 'article', title: 'A {complex} Unicode café', authors: [{ family: 'Ng', given: 'Ari' }, { literal: 'Data and Research & Development^~' }], container_title: 'Journal_One', doi: '10.1234/example' };
const row = { id: `ref-${hash(canonical(selection))}`, selection, metadata_revision: 1, metadata_sha256: hash(canonical(metadata)), metadata, qualification: 'User-supplied bibliographic metadata; unverified.' };
const selection2 = { ...selection, ref: { ...selection.ref, id: 'n2' } };
const metadata2 = { type: 'book', title: 'Second reference' };
const row2 = { id: `ref-${hash(canonical(selection2))}`, selection: selection2, metadata_revision: 1, metadata_sha256: hash(canonical(metadata2)), metadata: metadata2, qualification: 'User-supplied bibliographic metadata; unverified.' };
const list = { schema: 'signals.reference-list.v1', topic: { id: 'topic-1', revision: 2 }, references: [row, row2] };
const sources = [{ uri: 'https://example.org/source', text: 'Evidence from the cited source.' }];
const basis = { version: 'research-outline-v1', topic: 'Synthetic topic', sources: sources.map((source) => ({ ...source, sha256: hash(source.text) })), sections: [{ id: 's', title: 'Finding', points: [], gaps: ['Date is unknown.'] }], origin: { type: 'caller-authored' }, limits: ['Synthetic example.'] };
const report = reviseReport(createReport(basis), { sectionId: 's', paragraphs: [{ text: 'Evidence is retained.', citations: [{ source: 0, start: 0, end: 8, quote: 'Evidence' }] }] });

test('validates and deterministically emits text, BibTeX and CSL-JSON without inventing unknown fields', () => {
  assert.equal(validateReferenceList(list), list);
  assert.equal(formatBibliography(list, { format: 'text' }), 'Ari Ng, Data and Research & Development^~. A {complex} Unicode café. Journal_One. https://doi.org/10.1234/example.\n\nSecond reference.');
  const bibtex = formatBibliography(list, { format: 'bibtex' });
  assert.match(bibtex, /@article\{/);
  assert.match(bibtex, /Ng, Ari and \{Data and Research \\& Development\\textasciicircum\{\}\\textasciitilde\{\}\}/);
  assert.match(bibtex, /A \\{complex\\} Unicode café/);
  assert.doesNotMatch(bibtex, /year\s*=/);
  const csl = JSON.parse(formatBibliography(list, { format: 'csl-json' }));
  assert.equal(csl[0].type, 'article-journal');
  assert.equal(csl[0].title, metadata.title);
  assert.equal(csl[0].author[1].literal, 'Data and Research & Development^~');
  assert.equal(csl[0].issued, undefined);
  assert.notEqual(formatBibliography({ ...list, references: [...list.references].reverse() }, { format: 'bibtex' }), bibtex);
  assert.ok(formatBibliography({ ...list, references: [...list.references].reverse() }, { format: 'bibtex' }).startsWith(`@book{${row2.id},`));
});

test('rejects stale hashes, repeated IDs, malformed metadata and unsafe schemes', () => {
  assert.throws(() => validateReferenceList({ ...list, references: [{ ...row, metadata_sha256: '0'.repeat(64) }] }), /stale metadata hash/);
  assert.throws(() => validateReferenceList({ ...list, references: [row, row] }), /duplicate/);
  assert.throws(() => formatBibliography({ ...list, references: [{ ...row, metadata: { ...metadata, html: '<script>' } }] }), /metadata fields/);
  const bad = { ...metadata, url: 'javascript:alert(1)' };
  assert.throws(() => formatBibliography({ ...list, references: [{ ...row, metadata: bad, metadata_sha256: hash(canonical(bad)) }] }), /url/);
  const brace = { ...metadata, title: '\\input{private}' };
  const escaped = formatBibliography({ ...list, references: [{ ...row, metadata: brace, metadata_sha256: hash(canonical(brace)) }] }, { format: 'bibtex' });
  assert.match(escaped, /\\textbackslash\{\}input\\\{/);
});

test('adds a separately hashed, explicitly bound bibliography while preserving source evidence and gaps', () => {
  const html = exportReportWithReferences(report, list, [{ source: 0, reference_id: row.id }]);
  assert.match(html, /Cited source spans/);
  assert.match(html, /UTF-16 span:/);
  assert.match(html, /Date is unknown\./);
  assert.match(html, /Bibliography/);
  assert.match(html, /User-assigned metadata; unverified\./);
  assert.match(html, /research-report-bibliography\.v1/);
  assert.throws(() => exportReportWithReferences(report, list, [{ source: 7, reference_id: row.id }]), /out-of-range/);
  assert.throws(() => exportReportWithReferences(report, list, [{ source: 0, reference_id: 'unknown' }]), /unknown/);
  assert.throws(() => exportReportWithReferences(report, list, [{ source: 0, reference_id: row.id }, { source: 0, reference_id: row.id }]), /duplicate/);
});

test('bibliography digest changes when source bindings swap while report source evidence stays fixed', () => {
  const secondSource = { ...sources[0], uri: 'https://example.org/second' };
  const twoSourceBasis = { ...basis, sources: [...basis.sources, { ...secondSource, sha256: hash(secondSource.text) }] };
  const twoSourceReport = reviseReport(createReport(twoSourceBasis), { sectionId: 's', paragraphs: [{
    text: 'Both sources retain the same span.',
    citations: [
      { source: 0, start: 0, end: 8, quote: 'Evidence' },
      { source: 1, start: 0, end: 8, quote: 'Evidence' },
    ],
  }] });
  const first = exportReportWithReferences(twoSourceReport, list, [
    { source: 0, reference_id: row.id }, { source: 1, reference_id: row2.id },
  ]);
  const swapped = exportReportWithReferences(twoSourceReport, list, [
    { source: 0, reference_id: row2.id }, { source: 1, reference_id: row.id },
  ]);
  const digestFrom = (html) => html.match(/<section aria-labelledby="bibliography">[\s\S]*?SHA-256: ([a-f0-9]{64})/)[1];
  const bibliographyAt = (html) => html.slice(html.indexOf('<section aria-labelledby="bibliography">'));
  assert.notEqual(digestFrom(first), digestFrom(swapped));
  assert.equal(first.slice(0, first.indexOf('<section aria-labelledby="bibliography">')), swapped.slice(0, swapped.indexOf('<section aria-labelledby="bibliography">')));
  assert.notEqual(bibliographyAt(first), bibliographyAt(swapped));
});

test('CLI refuses a FIFO promptly without waiting for a writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bibliography-fifo-'));
  const fifo = join(root, 'references.json');
  const cliPath = fileURLToPath(new URL('../bin/research-bibliography.mjs', import.meta.url));
  try {
    execFileSync('mkfifo', [fifo]);
    const started = Date.now();
    const result = await new Promise((resolve) => execFile(process.execPath, [cliPath, '--input', fifo], { timeout: 3000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
    assert.equal(result.error?.code, 1, result.stderr);
    assert.match(result.stderr, /regular non-symlink JSON file/);
    assert.ok(Date.now() - started < 2000, 'FIFO input should be refused without waiting for a writer');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI rejects regular inputs larger than 1 MiB', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bibliography-large-'));
  const input = join(root, 'references.json');
  const cliPath = fileURLToPath(new URL('../bin/research-bibliography.mjs', import.meta.url));
  try {
    await writeFile(input, Buffer.alloc(1024 * 1024 + 1));
    const result = await new Promise((resolve) => execFile(process.execPath, [cliPath, '--input', input], { timeout: 3000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
    assert.equal(result.error?.code, 1, result.stderr);
    assert.match(result.stderr, /no larger than 1 MiB/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
