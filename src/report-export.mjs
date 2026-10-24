import { createHash } from 'node:crypto';
import { validateReport } from './report.mjs';

const maxHtmlBytes = 8 * 1024 * 1024;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const safeText = (value) => escape(String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (character) => `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`));

function sourceKey(source, citation) {
  return JSON.stringify([source.uri, source.sha256, citation.start, citation.end]);
}

function originLabel(version) {
  if (!version) return 'Outline content';
  const current = `current ${version.id}`;
  return version.origin === 'user-modified'
    ? `User-edited ${current}`
    : `Model-generated ${current}; attempt ${version.attemptId}`;
}

/** Validates current report content and returns a self-contained, offline HTML document. */
export function exportReportHtml(report) {
  const state = validateReport(report);
  const stateDigest = sha256(JSON.stringify(state));
  const citations = new Map();
  const sections = state.sections.map((section) => {
    const base = state.basis.sections.find((item) => item.id === section.id);
    const version = section.currentVersion === null ? null : section.versions[section.currentVersion];
    const paragraphs = version?.paragraphs ?? base.points;
    const gaps = version?.gaps ?? base.gaps;
    const body = paragraphs.length
      ? paragraphs.map((paragraph) => {
        const links = paragraph.citations.map((citation) => {
          const source = state.basis.sources[citation.source];
          const key = sourceKey(source, citation);
          if (!citations.has(key)) citations.set(key, { id: `source-${citations.size + 1}`, citation, source, sectionId: section.id });
          return `<a class="citation" href="#${citations.get(key).id}" aria-label="Source ${citation.source + 1}, UTF-16 ${citation.start} to ${citation.end}">[${citation.source + 1}]</a>`;
        }).join(' ');
        return `<p>${safeText(paragraph.text)} <span class="citation-links">${links}</span></p>`;
      }).join('\n') : '<p class="empty">No paragraph draft yet.</p>';
    const gapList = gaps.length ? `<ul>${gaps.map((gap) => `<li>${safeText(gap)}</li>`).join('')}</ul>` : '<p>None recorded.</p>';
    return `<section aria-labelledby="section-${escape(section.id)}"><h2 id="section-${escape(section.id)}">${safeText(section.title)}</h2><p class="origin">${originLabel(version)}</p>${body}<h3>Gaps and unknowns</h3>${gapList}</section>`;
  }).join('\n');
  const sourceList = [...citations.values()].map(({ id, citation, source, sectionId }) => {
    const qualifications = [source.observedAt ? `<li>Caller observation: ${safeText(source.observedAt)}</li>` : '', ...(source.omissions ?? []).map((note) => `<li>Caller omission or qualification: ${safeText(note)}</li>`)].filter(Boolean).join('');
    return `<article class="source" id="${id}"><h3>Source ${citation.source + 1}</h3><p class="uri">URI: ${safeText(source.uri)}</p><p>Quote</p><blockquote>${safeText(citation.quote)}</blockquote>${qualifications ? `<ul>${qualifications}</ul>` : ''}<details><summary>Source details</summary><p>SHA-256: <code>${source.sha256}</code></p><p>UTF-16 span: ${citation.start}–${citation.end}</p></details><p><a href="#section-${escape(sectionId)}">Back to report section</a></p></article>`;
  }).join('\n');
  const metadata = `<details><summary>Report details</summary><dl><dt>Report format</dt><dd>research-report-v1</dd><dt>Revision</dt><dd>${state.revision}</dd><dt>Parent digest</dt><dd>${state.parentHash ?? 'none'}</dd><dt>State SHA-256</dt><dd>${stateDigest}</dd></dl></details>`;
  const limits = state.limits.map((limit) => `<li>${safeText(limit)}</li>`).join('');
  const css = `:root{color-scheme:light}body{font-family:Georgia,"Times New Roman",serif;font-size:12pt;line-height:1.6;color:#333;background:#fff;margin:0 auto;padding:1.5rem;max-width:72ch}h1,h2,h3{font-family:Georgia,"Times New Roman",serif;color:#000;margin-top:1em}h1{font-size:2em}h2{font-size:1.5em}p{margin:0 0 1em}section{margin:2.5rem 0;break-inside:avoid}.origin,.empty{color:#666;font-size:.9em}.citation{white-space:nowrap}.source{margin:1.5rem 0;padding:1rem;border:1px solid #ddd;break-inside:avoid}.source blockquote{font-style:italic;margin:1em 0;padding:1em;background:#f9f9f9;white-space:pre-wrap;overflow-wrap:anywhere}.uri,code{overflow-wrap:anywhere}dl{display:grid;grid-template-columns:max-content 1fr;gap:.2rem 1rem}dt{font-weight:650}dd{margin:0;overflow-wrap:anywhere}details{margin:.5rem 0}summary{cursor:pointer}@media print{body{max-width:none;margin:0;padding:0}a{color:inherit;text-decoration:none}section,.source{break-inside:avoid}.source{border-color:#bbb}details>:not(summary){display:block}}`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><meta name="research-report-format" content="research-report-v1"><meta name="research-report-revision" content="${state.revision}"><meta name="research-report-sha256" content="${stateDigest}"><title>${safeText(state.topic)}</title><style>${css}</style></head><body>
<header><h1>${safeText(state.topic)}</h1><p>From retained sources; support and currentness are unverified.</p>${metadata}</header>
<main>${sections}<section aria-labelledby="sources"><h2 id="sources">Cited source spans</h2>${sourceList || '<p>No cited source spans.</p>'}</section><section aria-labelledby="limits"><h2 id="limits">Limits</h2><ul>${limits}</ul></section></main>
<footer><p>Offline document. Open in a browser and use its Print command to save as PDF.</p></footer></body></html>`;
  if (Buffer.byteLength(html, 'utf8') > maxHtmlBytes) throw new Error(`report_export_too_large: HTML exceeds ${maxHtmlBytes} bytes`);
  return html;
}
