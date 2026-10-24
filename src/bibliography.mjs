// Copyright (c) 2026. Adapted portions: Citation.js (Lars Willighagen et al.), MIT.
// See src/bibliography-NOTICE.txt for the exact source pin and modifications.
import { createHash } from 'node:crypto';
import { validateReport } from './report.mjs';
import { exportReportHtml } from './report-export.mjs';

const types = new Set(['article', 'book', 'webpage', 'report']);
const keys = (value, required, optional) => value && typeof value === 'object' && !Array.isArray(value)
  && required.every((key) => Object.hasOwn(value, key))
  && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const digest = (value) => createHash('sha256').update(value).digest('hex');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function invalid(reason) { throw new TypeError(`invalid_reference_list: ${reason}`); }

function validateMetadata(metadata) {
  if (!keys(metadata, ['type', 'title'], ['authors', 'year', 'container_title', 'publisher', 'doi', 'url'])) invalid('metadata fields');
  if (Object.values(metadata).some((value) => value === undefined)) invalid('undefined metadata value');
  if (!types.has(metadata.type)) invalid('metadata type');
  if (typeof metadata.title !== 'string' || !metadata.title.trim() || metadata.title.length > 500) invalid('title');
  if (metadata.authors !== undefined) {
    if (!Array.isArray(metadata.authors) || metadata.authors.length > 32) invalid('authors');
    for (const author of metadata.authors) {
      if (keys(author, ['literal'], []) && typeof author.literal === 'string' && author.literal.trim() && author.literal.length <= 200) continue;
      if (!keys(author, ['family'], ['given']) || typeof author.family !== 'string' || !author.family.trim() || author.family.length > 200 || (author.given !== undefined && (typeof author.given !== 'string' || author.given.length > 200))) invalid('author');
    }
  }
  if (metadata.year !== undefined && (!Number.isInteger(metadata.year) || metadata.year < 1000 || metadata.year > 9999)) invalid('year');
  for (const key of ['container_title', 'publisher']) if (metadata[key] !== undefined && (typeof metadata[key] !== 'string' || !metadata[key].trim() || metadata[key].length > 500)) invalid(key);
  if (metadata.doi !== undefined && (typeof metadata.doi !== 'string' || metadata.doi.length > 200 || !/^10\.\d{4,9}\/\S+$/.test(metadata.doi))) invalid('doi');
  if (metadata.url !== undefined) {
    if (typeof metadata.url !== 'string' || metadata.url.length > 2000) invalid('url');
    try {
      const url = new URL(metadata.url);
      if (!['http:', 'https:'].includes(url.protocol)) invalid('url');
    } catch { invalid('url'); }
  }
}

function validateSelection(selection) {
  if (!keys(selection, ['ref', 'instance_id', 'owner_epoch'], [])
      || !keys(selection.ref, ['owner', 'kind', 'id', 'revision', 'digest'], [])
      || Object.values(selection.ref).some((value) => typeof value !== 'string' || !value)
      || !/^[a-f0-9]{64}$/.test(selection.ref.digest)
      || typeof selection.instance_id !== 'string' || !selection.instance_id
      || (selection.owner_epoch !== null && (typeof selection.owner_epoch !== 'string' || !selection.owner_epoch))) invalid('selection');
  return `ref-${digest(canonical(selection))}`;
}

/** Validates the closed, user-supplied metadata export and returns its original value. */
export function validateReferenceList(list) {
  if (!keys(list, ['schema', 'topic', 'references'], []) || list.schema !== 'signals.reference-list.v1') invalid('header');
  if (!keys(list.topic, ['id', 'revision'], []) || typeof list.topic.id !== 'string' || !list.topic.id || !Number.isInteger(list.topic.revision) || list.topic.revision < 1) invalid('topic');
  if (!Array.isArray(list.references) || list.references.length > 100) invalid('references');
  const ids = new Set();
  for (const row of list.references) {
    if (!keys(row, ['id', 'selection', 'metadata_revision', 'metadata_sha256', 'metadata', 'qualification'], [])) invalid('reference row');
    const expectedId = validateSelection(row.selection);
    if (row.id !== expectedId || ids.has(row.id)) invalid('reference id or duplicate');
    ids.add(row.id);
    if (!Number.isInteger(row.metadata_revision) || row.metadata_revision < 1) invalid('metadata revision');
    validateMetadata(row.metadata);
    if (row.metadata_sha256 !== digest(canonical(row.metadata))) invalid('stale metadata hash');
    if (row.qualification !== 'User-supplied bibliographic metadata; unverified.') invalid('qualification');
  }
  return list;
}

const bibtexEscape = (value) => String(value).replace(/[\\{}%$&#_]/g, (character) => ({ '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '%': '\\%', '$': '\\$', '&': '\\&', '#': '\\#', '_': '\\_' })[character]);
const bibtexName = (author) => author.literal ?? [author.family, author.given].filter(Boolean).join(', ');
const cslType = { article: 'article-journal', book: 'book', webpage: 'webpage', report: 'report' };
const entryType = { article: 'article', book: 'book', webpage: 'online', report: 'report' };

function cslRow(row) {
  const metadata = row.metadata;
  const result = { id: row.id, type: cslType[metadata.type], title: metadata.title };
  if (metadata.authors) result.author = metadata.authors.map((author) => author.literal ? { literal: author.literal } : { family: author.family, ...(author.given ? { given: author.given } : {}) });
  if (metadata.year !== undefined) result.issued = { 'date-parts': [[metadata.year]] };
  if (metadata.container_title) result['container-title'] = metadata.container_title;
  if (metadata.publisher) result.publisher = metadata.publisher;
  if (metadata.doi) result.DOI = metadata.doi;
  if (metadata.url) result.URL = metadata.url;
  return result;
}

function bibtexRow(row) {
  const metadata = row.metadata;
  const fields = [
    ['author', metadata.authors?.map(bibtexName).join(' and ')], ['title', metadata.title],
    ['journal', metadata.type === 'article' ? metadata.container_title : undefined],
    ['booktitle', metadata.type !== 'article' ? metadata.container_title : undefined],
    ['publisher', metadata.publisher], ['year', metadata.year], ['doi', metadata.doi], ['url', metadata.url],
  ].filter(([, value]) => value !== undefined);
  return `@${entryType[metadata.type]}{${row.id},\n${fields.map(([key, value]) => `  ${key} = {${bibtexEscape(value)}},`).join('\n')}\n}`;
}

/** Formats validated metadata as plain text, a supported BibTeX subset, or CSL-JSON. */
export function formatBibliography(referenceList, { format = 'text' } = {}) {
  validateReferenceList(referenceList);
  if (!['text', 'bibtex', 'csl-json'].includes(format)) throw new TypeError('format must be text, bibtex, or csl-json');
  if (format === 'csl-json') return JSON.stringify(referenceList.references.map(cslRow), null, 2);
  if (format === 'bibtex') return referenceList.references.map(bibtexRow).join('\n\n');
  return referenceList.references.map(({ metadata: item }) => {
    const names = item.authors?.map((author) => author.literal ?? [author.given, author.family].filter(Boolean).join(' ')).join(', ');
    return [names, item.year, item.title, item.container_title, item.publisher, item.doi ? `https://doi.org/${item.doi}` : item.url].filter((part) => part !== undefined).join('. ') + '.';
  }).join('\n\n');
}

/** Adds explicitly bound, user-assigned reference metadata to a validated offline report. */
export function exportReportWithReferences(report, referenceList, bindings) {
  const state = validateReport(report);
  validateReferenceList(referenceList);
  if (!Array.isArray(bindings)) throw new TypeError('invalid_report_bindings: expected an array');
  const references = new Map(referenceList.references.map((row) => [row.id, row]));
  const seen = new Set();
  const bound = bindings.map((binding) => {
    if (!keys(binding, ['source', 'reference_id'], []) || !Number.isInteger(binding.source) || binding.source < 0 || binding.source >= state.basis.sources.length || typeof binding.reference_id !== 'string' || !references.has(binding.reference_id) || seen.has(binding.source)) throw new TypeError('invalid_report_bindings: malformed, duplicate, unknown, or out-of-range binding');
    seen.add(binding.source);
    return { source: binding.source, row: references.get(binding.reference_id) };
  });
  let html = exportReportHtml(state);
  if (!bound.length) return html;
  const bib = bound.map(({ source, row }) => `<li><span>[${source + 1}]</span> ${escapeCitationText(renderTextRow(row.metadata))} <span class="qualification">User-assigned metadata; unverified.</span></li>`).join('');
  const section = `<section aria-labelledby="bibliography"><h2 id="bibliography">Bibliography</h2><p>Associations are user-assigned and unverified.</p><ol>${bib}</ol><details><summary>Bibliography details</summary><p>Schema: signals.reference-list.v1</p><p>SHA-256: ${digest(canonical(referenceList))}</p></details></section>`;
  html = html.replace('</main>', `${section}</main>`);
  if (Buffer.byteLength(html, 'utf8') > 8 * 1024 * 1024) throw new Error('report_export_too_large: HTML exceeds 8 MiB');
  return html;
}

function renderTextRow(item) {
  const authors = item.authors?.map((author) => author.literal ?? [author.given, author.family].filter(Boolean).join(' ')).join(', ');
  return [authors, item.year, item.title, item.container_title, item.publisher, item.doi ? `https://doi.org/${item.doi}` : item.url].filter((part) => part !== undefined).join('. ') + '.';
}
function escapeCitationText(value) { return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }
