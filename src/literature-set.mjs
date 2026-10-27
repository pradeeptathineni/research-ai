// Portable bibliographic composition over exact notebook-owned frozen sources.
// This module stores references and caller metadata only; article text stays in its owner.
import { createHash, randomUUID } from "node:crypto";
import { validateResearchNotebook } from "./notebook.mjs";
import { prepareNotebookQuestion } from "./notebook.mjs";

const schema = "research-literature-set-v1";
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v, required, optional = []) => plain(v) && required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const hash = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : plain(v) ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const digest = (v) => hash(canonical(Object.fromEntries(Object.entries(v).filter(([k]) => k !== "sha256"))));
const fail = (why) => { throw new TypeError(`invalid_research_literature_set: ${why}`); };
const uuid = (prefix, value = `${prefix}:${randomUUID()}`) => {
  if (typeof value !== "string" || !new RegExp(`^${prefix}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).test(value)) fail(`${prefix} ID`);
  return value;
};
const text = (v, max, multiline = false) => typeof v === "string" && !!v.trim() && v.length <= max && v.isWellFormed() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(v) && (multiline || !/[\r\n]/u.test(v));

function metadataValid(m) {
  if (!keys(m, ["title"], ["authors", "year", "containerTitle", "publisher", "doi", "url", "type"])) fail("metadata fields");
  if (!text(m.title, 500)) fail("title");
  if (m.authors !== undefined && (!Array.isArray(m.authors) || m.authors.length > 32 || m.authors.some(a => !text(a, 200)))) fail("authors must be caller-supplied names");
  if (m.year !== undefined && (!Number.isInteger(m.year) || m.year < 1000 || m.year > 9999)) fail("year");
  for (const k of ["containerTitle", "publisher"]) if (m[k] !== undefined && !text(m[k], 500)) fail(k);
  if (m.doi !== undefined && (typeof m.doi !== "string" || !/^10\.\d{4,9}\/\S+$/i.test(m.doi) || m.doi.length > 200)) fail("doi");
  if (m.url !== undefined) { try { const u = new URL(m.url); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) fail("url"); } catch { fail("url"); } }
}
function validatePaper(p) {
  if (!keys(p, ["id", "metadata", "availability", "source", "statusEvidence", "finding", "stance", "claimKey", "qualification"])) fail("paper fields");
  uuid("paper", p.id); metadataValid(p.metadata);
  if (!["available", "missing", "retracted"].includes(p.availability)) fail("availability");
  if (p.availability !== "missing") {
    if (!keys(p.source, ["notebookId", "notebookSha256", "sourceId", "sourceDigest", "documentId", "documentSha256"]) ||
        !/^notebook:[0-9a-f-]{36}$/.test(p.source.notebookId) || !/^source:[0-9a-f-]{36}$/.test(p.source.sourceId) ||
        ![p.source.notebookSha256,p.source.sourceDigest,p.source.documentSha256].every(x => /^[a-f0-9]{64}$/.test(x)) || !text(p.source.documentId, 200)) fail("exact notebook source binding required");
  } else if (p.source !== null) fail("missing items cannot claim a retained source");
  if (p.availability === "available") {
    if (p.statusEvidence !== null) fail("status evidence is only for a status qualification");
  } else if (!keys(p.statusEvidence, ["kind", "assertedBy", "observedAt", "verification", "detail"]) ||
      !["missing-source", "retraction", "expression-of-concern", "correction"].includes(p.statusEvidence.kind) ||
      !text(p.statusEvidence.assertedBy, 200) || typeof p.statusEvidence.observedAt !== "string" || !Number.isFinite(Date.parse(p.statusEvidence.observedAt)) ||
      p.statusEvidence.verification !== "asserted-unverified" || !text(p.statusEvidence.detail, 500)) fail("status evidence requires assertion provenance and date");
  if (p.finding !== null && !text(p.finding, 2000, true)) fail("finding");
  if (![null, "supports", "opposes", "mixed", "unclear"].includes(p.stance)) fail("stance");
  if (p.claimKey !== null && !text(p.claimKey, 200)) fail("claim key");
  if (!Array.isArray(p.qualification) || p.qualification.length > 8 || p.qualification.some(q => !text(q, 500))) fail("qualification");
  if (p.availability === "missing" && !p.qualification.some(q => /missing|unavailable/i.test(q))) fail("missing-source qualification");
  if (p.availability === "retracted" && !p.qualification.some(q => /retract/i.test(q))) fail("retraction qualification");
  if (p.availability === "missing" && p.statusEvidence.kind !== "missing-source") fail("missing-source evidence kind");
  if (p.availability === "retracted" && p.statusEvidence.kind !== "retraction") fail("retraction evidence kind");
  return p;
}
function validateState(value) {
  if (!keys(value, ["schema", "id", "title", "revision", "papers", "sha256"]) || value.schema !== schema || !/^literature-set:[0-9a-f-]{36}$/.test(value.id) || !text(value.title, 200) || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Array.isArray(value.papers) || value.papers.length > 100 || !/^[a-f0-9]{64}$/.test(value.sha256)) fail("header");
  const ids = new Set();
  for (const paper of value.papers) { validatePaper(paper); if (ids.has(paper.id)) fail("duplicate paper ID"); ids.add(paper.id); }
  if (digest(value) !== value.sha256 || Buffer.byteLength(canonical(value), "utf8") > 2 * 1024 * 1024) fail("digest or size");
  return value;
}
const seal = (value) => ({ ...value, sha256: digest(value) });

/** Creates a metadata-only paper composition; retained text remains with notebooks. */
export function createLiteratureSet(title, { id } = {}) {
  if (!text(title, 200)) fail("title");
  return validateState(seal({ schema, id: uuid("literature-set", id), title, revision: 1, papers: [] }));
}
/** Append one paper record. Source bindings refer to an exact frozen notebook source. */
export function addLiteraturePaper(value, paper) {
  const state = validateState(value); validatePaper(paper);
  if (state.papers.length >= 100 || state.papers.some(p => p.id === paper.id)) fail("capacity or duplicate paper ID");
  return validateState(seal({ ...state, revision: state.revision + 1, papers: [...state.papers, clone(paper)] }));
}
export function validateLiteratureSet(value) { return validateState(value); }

function normalizedTitle(title) { return title.normalize("NFKD").toLocaleLowerCase("en").replace(/[\p{M}]/gu, "").replace(/[\p{P}\p{Z}\p{S}]+/gu, " ").trim().replace(/\s+/gu, " "); }
function authorKey(m) { return (m.authors ?? []).map(a => a.normalize("NFKD").toLocaleLowerCase("en").replace(/[^\p{L}\p{N}]/gu, "")).sort().join("|"); }
function tokenSimilarity(a, b) { const x = new Set(normalizedTitle(a).match(/[\p{L}\p{N}]+/gu) ?? []), y = new Set(normalizedTitle(b).match(/[\p{L}\p{N}]+/gu) ?? []); const union = new Set([...x, ...y]); return union.size ? [...x].filter(t => y.has(t)).length / union.size : 0; }
/** Conservative identity suggestions: DOI and fully matching title/author/year may merge; fuzzy titles remain explicit ambiguities. */
export function deduplicateLiteraturePapers(papers) {
  if (!Array.isArray(papers) || papers.length > 100) fail("papers");
  papers.forEach(validatePaper);
  const duplicates = [], ambiguities = [];
  for (let i = 0; i < papers.length; i++) for (let j = i + 1; j < papers.length; j++) {
    const a = papers[i], b = papers[j], doiA = a.metadata.doi?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLocaleLowerCase("en"), doiB = b.metadata.doi?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLocaleLowerCase("en");
    if (doiA && doiB && doiA === doiB) { duplicates.push({ papers: [a.id, b.id], basis: "same-normalized-doi", qualification: "Bibliographic identity suggested by caller-supplied DOI; inspect before removal." }); continue; }
    const titleA = normalizedTitle(a.metadata.title), titleB = normalizedTitle(b.metadata.title);
    if (titleA === titleB && a.metadata.year === b.metadata.year && authorKey(a.metadata) === authorKey(b.metadata) && authorKey(a.metadata)) duplicates.push({ papers: [a.id, b.id], basis: "same-title-authors-year", qualification: "Bibliographic identity suggested by metadata; inspect before removal." });
    else if (tokenSimilarity(a.metadata.title, b.metadata.title) >= .65 && (a.metadata.year === undefined || b.metadata.year === undefined || a.metadata.year === b.metadata.year)) ambiguities.push({ papers: [a.id, b.id], basis: "similar-title", similarity: tokenSimilarity(a.metadata.title, b.metadata.title), qualification: "Possible near-duplicate; retained separately pending human identity review." });
  }
  return { schema: "research-literature-dedupe-v1", duplicates, ambiguities };
}

/** Reopens exact source pointers against supplied notebook snapshots; never substitutes text or another revision. */
export function resolveLiteratureSet(value, notebooks) {
  const state = validateState(value);
  if (!Array.isArray(notebooks) || notebooks.length > 8) fail("notebook snapshots required");
  const owners = new Map(notebooks.map(n => { const v = validateResearchNotebook(n); return [v.id, v]; }));
  const resolved = state.papers.map(paper => {
    if (paper.availability === "missing") return { paperId: paper.id, availability: paper.availability, source: null, statusEvidence: clone(paper.statusEvidence), qualification: clone(paper.qualification) };
    const ref = paper.source, notebook = owners.get(ref.notebookId);
    if (!notebook || notebook.sha256 !== ref.notebookSha256) fail(`source notebook is unavailable or changed for ${paper.id}`);
    const source = notebook.sources.find(s => s.id === ref.sourceId);
    if (!source || source.digest !== ref.sourceDigest || source.document.id !== ref.documentId || source.document.sha256 !== ref.documentSha256) fail(`exact retained source changed for ${paper.id}`);
    return { paperId: paper.id, availability: paper.availability, notebookId: notebook.id, sourceId: source.id, sourceDigest: source.digest, document: source.document, statusEvidence: clone(paper.statusEvidence), qualification: clone(paper.qualification) };
  });
  return { schema: "research-literature-resolution-v1", literatureSetId: state.id, literatureSetSha256: state.sha256, resolved };
}

/** Thin path into the existing notebook question and coverage machinery for one exact notebook. */
export function prepareLiteratureQuestion(value, notebookValue, question, policy = {}, { includeRetracted = false } = {}) {
  const state = validateState(value), notebook = validateResearchNotebook(notebookValue);
  if (typeof includeRetracted !== "boolean") fail("includeRetracted must be boolean");
  const papers = state.papers.filter(p => (p.availability === "available" || (includeRetracted && p.availability === "retracted")) && p.source.notebookId === notebook.id);
  if (!papers.length) fail("no available papers from this notebook");
  for (const p of papers) if (p.source.notebookSha256 !== notebook.sha256) fail(`notebook changed for ${p.id}`);
  const prepared = prepareNotebookQuestion(notebook, { id: `question:${randomUUID()}`, question,
    sourceIds: [...new Set(papers.map(p => p.source.sourceId))], notes: [] }, policy);
  const coverage = state.papers.map(p => ({ paperId: p.id, availability: p.availability,
    source: p.source ? { notebookId: p.source.notebookId, sourceId: p.source.sourceId, sourceDigest: p.source.sourceDigest, documentId: p.source.documentId, documentSha256: p.source.documentSha256 } : null,
    disposition: papers.includes(p) ? "included" : p.availability === "missing" ? "not-searched-source-missing" : p.availability === "retracted" ? "excluded-retracted-by-default" : "outside-selected-notebook-cross-notebook-not-joined",
    statusEvidence: clone(p.statusEvidence), qualification: clone(p.qualification) }));
  return { schema: "research-literature-question-v1", literatureSetId: state.id, literatureSetSha256: state.sha256,
    prepared, includedPapers: papers.map(p => ({ paperId: p.id, sourceId: p.source.sourceId, sourceDigest: p.source.sourceDigest, statusEvidence: clone(p.statusEvidence) })), coverage };
}

/** Portable cold-open export: metadata and owner pointers only, with contradiction and status qualifications. */
export function exportLiteratureSet(value) {
  const state = validateState(value);
  const groups = new Map();
  for (const p of state.papers) if (p.claimKey && p.stance && p.stance !== "unclear") {
    const rows = groups.get(p.claimKey) ?? []; rows.push({ paperId: p.id, stance: p.stance }); groups.set(p.claimKey, rows);
  }
  const disagreements = [...groups].filter(([, rows]) => new Set(rows.map(r => r.stance)).size > 1).map(([claimKey, papers]) => ({ claimKey, papers, qualification: "Conflicting caller-reported positions; this flag is not a synthesis or truth assessment." }));
  return JSON.stringify({ ...state, export: { disagreements, questionScopeLimit: "Question composition currently supports one notebook at a time; cross-notebook study composition remains a later integration." } }, null, 2);
}

/** Markdown bibliography and caller-noted evidence map; passage citations remain in notebook answers. */
export function formatLiteratureSet(value) {
  const state = validateState(value);
  const disagreements = JSON.parse(exportLiteratureSet(state)).export.disagreements;
  const lines = [`# ${state.title}`, "", "Bibliographic metadata and findings are caller supplied. Retained-source availability means the frozen source exists; it does not mean retraction screening found it clear. No status signal means status is unknown. This export does not verify source identity or make a truth assessment.", "", "Question composition currently supports one notebook at a time; cross-notebook study composition remains a later integration.", "", "## Bibliography"];
  for (const p of state.papers) {
    const m = p.metadata;
    const authors = m.authors?.join(", ");
    const citation = [authors, m.year, m.title, m.containerTitle, m.publisher, m.doi ? `https://doi.org/${m.doi}` : m.url].filter(Boolean).join(". ");
    lines.push(`\n- ${citation || m.title}${citation.endsWith(".") ? "" : "."}`);
    if (p.source) lines.push(`  - Retained citation target: notebook \`${p.source.notebookId}\`, source \`${p.source.sourceId}\`, SHA-256 \`${p.source.sourceDigest}\`; document \`${p.source.documentId}\` (${p.source.documentSha256}).`);
    if (p.availability !== "available") lines.push(`  - Availability: ${p.availability}; asserted by ${p.statusEvidence.assertedBy} at ${p.statusEvidence.observedAt} (${p.statusEvidence.verification}): ${p.statusEvidence.detail} ${p.qualification.join(" ")}`);
    if (p.finding) lines.push(`  - Caller finding note (${p.stance ?? "stance unspecified"}): ${p.finding}`);
    if (p.claimKey) lines.push(`  - Claim grouping key: ${p.claimKey}`);
    if (p.qualification.length && p.availability === "available") lines.push(`  - Qualification: ${p.qualification.join(" ")}`);
  }
  if (disagreements.length) {
    lines.push("", "## Conflicting reported positions", "", "These are caller-reported positions that differ within the same claim group; they are not a synthesis or truth assessment.");
    for (const group of disagreements) lines.push(`\n- **${group.claimKey}:** ${group.papers.map(p => `${p.paperId} (${p.stance})`).join("; ")}`);
  }
  return `${lines.join("\n").trim()}\n`;
}
