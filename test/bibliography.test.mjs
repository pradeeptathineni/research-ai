import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReport, reviseReport } from '../src/report.mjs';
import { validateReferenceList, formatBibliography, exportReportWithReferences } from '../src/bibliography.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const selection = { ref: { owner: 'planning-ai', kind: 'note', id: 'n1', revision: 'r1', digest: 'a'.repeat(64) }, instance_id: 'synthetic', owner_epoch: null };
const metadata = { type: 'article', title: 'A {complex} Unicode café', authors: [{ family: 'Ng', given: 'Ari' }, { literal: 'Research & Development' }], container_title: 'Journal_One', doi: '10.1234/example' };
const row = { id: `ref-${hash(canonical(selection))}`, selection, metadata_revision: 1, metadata_sha256: hash(canonical(metadata)), metadata, qualification: 'User-supplied bibliographic metadata; unverified.' };
const list = { schema: 'signals.reference-list.v1', topic: { id: 'topic-1', revision: 2 }, references: [row] };
const sources = [{ uri: 'https://example.org/source', text: 'Evidence from the cited source.' }];
const basis = { version: 'research-outline-v1', topic: 'Synthetic topic', sources: sources.map((source) => ({ ...source, sha256: hash(source.text) })), sections: [{ id: 's', title: 'Finding', points: [], gaps: ['Date is unknown.'] }], origin: { type: 'caller-authored' }, limits: ['Synthetic example.'] };
const report = reviseReport(createReport(basis), { sectionId: 's', paragraphs: [{ text: 'Evidence is retained.', citations: [{ source: 0, start: 0, end: 8, quote: 'Evidence' }] }] });

test('validates and deterministically emits text, BibTeX and CSL-JSON without inventing unknown fields', () => {
  assert.equal(validateReferenceList(list), list);
  assert.equal(formatBibliography(list, { format: 'text' }), 'Ari Ng, Research & Development. A {complex} Unicode café. Journal_One. https://doi.org/10.1234/example.');
  const bibtex = formatBibliography(list, { format: 'bibtex' });
  assert.match(bibtex, /@article\{/);
  assert.match(bibtex, /Ng, Ari and Research \\& Development/);
  assert.match(bibtex, /A \\{complex\\} Unicode café/);
  assert.doesNotMatch(bibtex, /year\s*=/);
  const csl = JSON.parse(formatBibliography(list, { format: 'csl-json' }));
  assert.equal(csl[0].type, 'article-journal');
  assert.equal(csl[0].title, metadata.title);
  assert.equal(csl[0].author[1].literal, 'Research & Development');
  assert.equal(csl[0].issued, undefined);
  assert.equal(formatBibliography({ ...list, references: [...list.references].reverse() }, { format: 'bibtex' }), bibtex);
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
  assert.match(html, new RegExp(hash(canonical(list))));
  assert.throws(() => exportReportWithReferences(report, list, [{ source: 7, reference_id: row.id }]), /out-of-range/);
  assert.throws(() => exportReportWithReferences(report, list, [{ source: 0, reference_id: 'unknown' }]), /unknown/);
  assert.throws(() => exportReportWithReferences(report, list, [{ source: 0, reference_id: row.id }, { source: 0, reference_id: row.id }]), /duplicate/);
});
