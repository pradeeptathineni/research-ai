// Portable bibliographic composition over exact notebook-owned frozen sources.
// This module stores references and caller metadata only; article text stays in its owner.
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { documentCoverageLimits, prepareDocumentCoverage, validateDocumentCoverage } from "./document-coverage.mjs";
import { validateResearchNotebook, prepareNotebookQuestion } from "./notebook.mjs";

const schema = "research-literature-set-v1";
const maxLiteraturePapers = 100;
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
  if (!keys(value, ["schema", "id", "title", "revision", "papers", "sha256"]) || value.schema !== schema || !/^literature-set:[0-9a-f-]{36}$/.test(value.id) || !text(value.title, 200) || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Array.isArray(value.papers) || value.papers.length > maxLiteraturePapers || !/^[a-f0-9]{64}$/.test(value.sha256)) fail("header");
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

/** Explicitly advances exact source pointers to a newer notebook snapshot without replacing sources. */
export function rebindLiteratureSet(value, notebooks) {
  const state = validateState(value);
  if (!Array.isArray(notebooks) || notebooks.length > 8) fail("notebook snapshots must be an array of at most 8 entries");
  const owners = new Map();
  for (const snapshot of notebooks) {
    const notebook = validateResearchNotebook(snapshot);
    if (owners.has(notebook.id)) fail("notebook snapshot IDs must be unique");
    owners.set(notebook.id, notebook);
  }

  const changedPapers = [];
  const sourceChecks = [];
  const papers = state.papers.map((paper) => {
    if (paper.availability === "missing") return paper;
    const ref = paper.source;
    const notebook = owners.get(ref.notebookId);
    if (!notebook) fail(`source notebook is unavailable for ${paper.id}`);
    const source = notebook.sources.find((entry) => entry.id === ref.sourceId);
    if (!source || source.digest !== ref.sourceDigest || source.document.id !== ref.documentId
        || source.document.sha256 !== ref.documentSha256) fail(`exact retained source changed for ${paper.id}`);
    sourceChecks.push({ paperId: paper.id, notebookId: notebook.id, sourceId: source.id,
      sourceDigest: source.digest, documentId: source.document.id, documentSha256: source.document.sha256 });
    if (ref.notebookSha256 === notebook.sha256) return paper;
    changedPapers.push({ paperId: paper.id, fromNotebookSha256: ref.notebookSha256, toNotebookSha256: notebook.sha256 });
    return { ...paper, source: { ...ref, notebookSha256: notebook.sha256 } };
  });

  const updated = changedPapers.length
    ? validateState(seal({ ...state, revision: state.revision + 1, papers }))
    : state;
  return { schema: "research-literature-rebind-v1",
    previous: { id: state.id, revision: state.revision, sha256: state.sha256 },
    literatureSet: updated, changedPapers, sourceChecks };
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


const literatureStudySchema = "research-literature-study-question-v1";
const sourceBindingKeys = ["notebookId", "notebookSha256", "sourceId", "sourceDigest", "documentId", "documentSha256"];
const literatureStudyDigest = (value) => hash(canonical(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "sha256"))));
const exactSourceKey = (source) => canonical(Object.fromEntries(sourceBindingKeys.map((key) => [key, source[key]])));
const coverageSourceId = (source) => `literature-source:${hash(exactSourceKey(source))}`;
const paperReference = (paper) => ({ paperId: paper.id, metadata: clone(paper.metadata), availability: paper.availability,
  statusEvidence: clone(paper.statusEvidence), finding: paper.finding, stance: paper.stance, claimKey: paper.claimKey,
  qualification: clone(paper.qualification), source: clone(paper.source) });

function normalizeLiteratureStudyOptions(options) {
  if (!keys(options, [], ["paperIds", "includeRetracted"]) || !Array.isArray(options.paperIds)
      || options.paperIds.length < 1 || options.paperIds.length > maxLiteraturePapers
      || new Set(options.paperIds).size !== options.paperIds.length) fail(`select 1-${maxLiteraturePapers} unique paper IDs; the coverage plan separately limits unique source documents to ${documentCoverageLimits.documents}`);
  const includeRetracted = options.includeRetracted ?? false;
  if (typeof includeRetracted !== "boolean") fail("includeRetracted must be boolean");
  options.paperIds.forEach((paperId) => uuid("paper", paperId));
  return { paperIds: [...options.paperIds], includeRetracted };
}

function resolveSelectedStudySources(state, notebooks, selectedPaperIds, includeRetracted) {
  if (!Array.isArray(notebooks) || notebooks.length > 8) fail("provide up to 8 current notebook snapshots");
  const owners = new Map();
  for (const snapshot of notebooks) {
    const notebook = validateResearchNotebook(snapshot);
    if (owners.has(notebook.id)) fail("current notebook IDs must be unique");
    owners.set(notebook.id, notebook);
  }
  const selected = new Set(selectedPaperIds);
  const groups = new Map();
  for (const paper of state.papers) {
    if (!selected.has(paper.id) || paper.availability === "missing"
        || (paper.availability === "retracted" && !includeRetracted)) continue;
    const ref = paper.source;
    const notebook = owners.get(ref.notebookId);
    if (!notebook) fail(`selected source notebook is unavailable for ${paper.id}`);
    if (notebook.sha256 !== ref.notebookSha256) fail(`selected source notebook changed for ${paper.id}`);
    const source = notebook.sources.find((entry) => entry.id === ref.sourceId);
    if (!source || source.digest !== ref.sourceDigest || source.document.id !== ref.documentId
        || source.document.sha256 !== ref.documentSha256) fail(`selected exact retained source is unavailable or changed for ${paper.id}`);
    const binding = Object.fromEntries(sourceBindingKeys.map((key) => [key, ref[key]]));
    const key = exactSourceKey(binding);
    let group = groups.get(key);
    if (!group) {
      const documentId = coverageSourceId(binding);
      const existing = [...groups.values()].find((entry) => entry.document.id === documentId && entry.key !== key);
      if (existing) fail("coverage source identity hash collision");
      group = { key, documentId, binding, document: { ...clone(source.document), id: documentId }, papers: [] };
      groups.set(key, group);
    }
    group.papers.push(paperReference(paper));
  }
  return [...groups.values()];
}

function makeLiteratureStudyQuestion(value, notebooks, question, policy, options) {
  const state = validateState(value);
  if (!text(question, 2000)) fail("question must be a single-line string of at most 2000 characters");
  if (!plain(policy)) fail("policy must be an object");
  const normalizedOptions = normalizeLiteratureStudyOptions(options);
  const papers = new Map(state.papers.map((paper) => [paper.id, paper]));
  for (const paperId of normalizedOptions.paperIds) if (!papers.has(paperId)) fail(`selected paper is not in the literature set: ${paperId}`);
  const groups = resolveSelectedStudySources(state, notebooks, normalizedOptions.paperIds, normalizedOptions.includeRetracted);
  const sourceMap = groups.map((group) => ({
    coverageDocumentId: group.document.id,
    sourceBinding: group.binding,
    papers: group.papers,
    sourceIndependence: group.papers.length > 1 ? "same-exact-source-aliases" : "unknown",
  }));
  const includedPapers = sourceMap.flatMap((group) => group.papers.map((paper) => ({
    ...clone(paper), coverageDocumentId: group.coverageDocumentId,
    sourceIndependence: group.sourceIndependence,
  })));
  const selected = new Set(normalizedOptions.paperIds);
  const groupByPaper = new Map(includedPapers.map((paper) => [paper.paperId, paper]));
  const coverage = state.papers.map((paper) => {
    const inclusion = groupByPaper.get(paper.id);
    const chosen = selected.has(paper.id);
    const disposition = inclusion ? "included"
      : !chosen ? "not-selected"
        : paper.availability === "missing" ? "not-searched-source-missing"
          : paper.availability === "retracted" && !normalizedOptions.includeRetracted ? "excluded-retracted-by-default"
            : "not-included";
    const sourceResolution = inclusion ? "resolved-at-preparation"
      : paper.availability === "missing" ? "missing-no-retained-source"
        : !chosen ? "not-compared-not-selected"
          : paper.availability === "retracted" && !normalizedOptions.includeRetracted ? "not-compared-excluded-retracted"
            : "not-compared";
    return { ...paperReference(paper), disposition, sourceResolution,
      coverageDocumentId: inclusion?.coverageDocumentId ?? null,
      sourceIndependence: inclusion?.sourceIndependence ?? "unknown" };
  });
  const request = groups.length ? (() => {
    const plan = prepareDocumentCoverage(question, groups.map((group) => group.document), policy);
    return { question: plan.question, documents: clone(plan.documents), policy: clone(plan.policy) };
  })() : null;
  const plan = request ? prepareDocumentCoverage(request.question, request.documents, request.policy) : null;
  const prepared = {
    schema: literatureStudySchema,
    literatureSet: clone(state),
    selectedPaperIds: normalizedOptions.paperIds,
    includeRetracted: normalizedOptions.includeRetracted,
    request,
    sourceMap,
    includedPapers,
    coverage,
    preview: plan ? clone(plan) : null,
  };
  prepared.sha256 = literatureStudyDigest(prepared);
  return prepared;
}

/** Prepares a selected multi-notebook composition over exact retained paper sources. No inference or acquisition. */
export function prepareLiteratureStudyQuestion(value, notebooks, question, policy = {}, options = {}) {
  return validateLiteratureStudyQuestion(makeLiteratureStudyQuestion(value, notebooks, question, policy, options));
}

/** Cold-validates the complete frozen metadata, source map, document plan and digest without current notebooks. */
export function validateLiteratureStudyQuestion(value) {
  if (!keys(value, ["schema", "literatureSet", "selectedPaperIds", "includeRetracted", "request", "sourceMap", "includedPapers", "coverage", "preview", "sha256"])
      || value.schema !== literatureStudySchema || typeof value.includeRetracted !== "boolean"
      || !Array.isArray(value.selectedPaperIds) || !Array.isArray(value.sourceMap)
      || !Array.isArray(value.includedPapers) || !Array.isArray(value.coverage)
      || !(value.request === null || plain(value.request)) || !(value.preview === null || plain(value.preview))
      || !/^[a-f0-9]{64}$/.test(value.sha256)) fail("prepared literature study question shape");
  const state = validateState(value.literatureSet);
  const options = normalizeLiteratureStudyOptions({ paperIds: value.selectedPaperIds, includeRetracted: value.includeRetracted });
  for (const paperId of options.paperIds) if (!state.papers.some((paper) => paper.id === paperId)) fail("prepared paper selection is outside its frozen set");
  const paperById = new Map(state.papers.map((paper) => [paper.id, paper]));
  const seenSources = new Set(), seenPapers = new Set();
  const sourceMap = value.sourceMap.map((entry) => {
    if (!keys(entry, ["coverageDocumentId", "sourceBinding", "papers", "sourceIndependence"]) || !Array.isArray(entry.papers)
        || !keys(entry.sourceBinding, sourceBindingKeys) || !/^literature-source:[a-f0-9]{64}$/.test(entry.coverageDocumentId)
        || entry.coverageDocumentId !== coverageSourceId(entry.sourceBinding)
        || !["unknown", "same-exact-source-aliases"].includes(entry.sourceIndependence)) fail("source map entry");
    const key = exactSourceKey(entry.sourceBinding);
    if (seenSources.has(key)) fail("duplicate exact source map entry");
    seenSources.add(key);
    const papers = entry.papers.map((ref) => {
      if (!keys(ref, ["paperId", "metadata", "availability", "statusEvidence", "finding", "stance", "claimKey", "qualification", "source"])) fail("source paper reference");
      const paper = paperById.get(ref.paperId);
      if (!paper || seenPapers.has(ref.paperId) || !isDeepStrictEqual(ref, paperReference(paper))
          || !isDeepStrictEqual(ref.source, entry.sourceBinding)) fail("source map paper binding");
      seenPapers.add(ref.paperId);
      return clone(ref);
    });
    if (!papers.length || entry.sourceIndependence !== (papers.length > 1 ? "same-exact-source-aliases" : "unknown")) fail("source alias qualification");
    return { ...clone(entry), papers };
  });
  const selected = new Set(options.paperIds);
  const eligible = state.papers.filter((paper) => selected.has(paper.id)
    && (paper.availability === "available" || (paper.availability === "retracted" && options.includeRetracted)));
  if (eligible.length !== seenPapers.size || eligible.some((paper) => !seenPapers.has(paper.id))) fail("selected eligible papers are missing from the source map");
  const includedPapers = sourceMap.flatMap((group) => group.papers.map((paper) => ({
    ...clone(paper), coverageDocumentId: group.coverageDocumentId,
    sourceIndependence: group.sourceIndependence,
  })));
  const groupByPaper = new Map(includedPapers.map((paper) => [paper.paperId, paper]));
  const expectedCoverage = state.papers.map((paper) => {
    const inclusion = groupByPaper.get(paper.id), chosen = selected.has(paper.id);
    const disposition = inclusion ? "included" : !chosen ? "not-selected"
      : paper.availability === "missing" ? "not-searched-source-missing"
        : paper.availability === "retracted" && !options.includeRetracted ? "excluded-retracted-by-default" : "not-included";
    const sourceResolution = inclusion ? "resolved-at-preparation"
      : paper.availability === "missing" ? "missing-no-retained-source"
        : !chosen ? "not-compared-not-selected"
          : paper.availability === "retracted" && !options.includeRetracted ? "not-compared-excluded-retracted" : "not-compared";
    return { ...paperReference(paper), disposition, sourceResolution,
      coverageDocumentId: inclusion?.coverageDocumentId ?? null,
      sourceIndependence: inclusion?.sourceIndependence ?? "unknown" };
  });
  if (!isDeepStrictEqual(value.includedPapers, includedPapers) || !isDeepStrictEqual(value.coverage, expectedCoverage)
      || !isDeepStrictEqual(value.sourceMap, sourceMap)) fail("prepared source attribution changed");
  if (value.request === null) {
    if (sourceMap.length || value.preview !== null) fail("empty source plan shape");
  } else {
    if (!keys(value.request, ["question", "documents", "policy"]) || !Array.isArray(value.request.documents)
        || value.request.documents.length !== sourceMap.length) fail("prepared request shape");
    const docsById = new Map(value.request.documents.map((document) => [document.id, document]));
    if (docsById.size !== sourceMap.length || sourceMap.some((entry) => !docsById.has(entry.coverageDocumentId))) fail("prepared documents do not match source map");
    const plan = prepareDocumentCoverage(value.request.question, value.request.documents, value.request.policy);
    if (!isDeepStrictEqual(value.preview, plan) || sourceMap.some((entry) => {
      const doc = docsById.get(entry.coverageDocumentId);
      if (!doc || doc.id !== entry.coverageDocumentId || doc.sha256 !== entry.sourceBinding.documentSha256) return true;
      const originalDocument = { ...doc, id: entry.sourceBinding.documentId };
      return hash(canonical(originalDocument)) !== entry.sourceBinding.sourceDigest;
    })) fail("prepared coverage plan or retained source digest changed");
  }
  if (literatureStudyDigest(value) !== value.sha256) fail("prepared digest mismatch");
  return clone(value);
}

/** Compares a frozen prepared question with current owner snapshots; it never changes the prepared closure. */
export function checkLiteratureStudyQuestionSources(value, currentSet, notebooks) {
  const prepared = validateLiteratureStudyQuestion(value);
  const state = validateState(currentSet);
  if (state.id !== prepared.literatureSet.id) fail("current literature set has a different identity");
  if (!Array.isArray(notebooks) || notebooks.length > 8) fail("provide up to 8 current notebook snapshots");
  const owners = new Map();
  for (const snapshot of notebooks) {
    const notebook = validateResearchNotebook(snapshot);
    if (owners.has(notebook.id)) fail("current notebook IDs must be unique");
    owners.set(notebook.id, notebook);
  }
  const literatureSet = { status: state.sha256 === prepared.literatureSet.sha256 ? "current" : "changed",
    expectedSha256: prepared.literatureSet.sha256, currentSha256: state.sha256 };
  const sources = prepared.sourceMap.map((entry) => {
    const ref = entry.sourceBinding, notebook = owners.get(ref.notebookId);
    if (!notebook) return { coverageDocumentId: entry.coverageDocumentId, status: "missing", notebookId: ref.notebookId, sourceId: ref.sourceId };
    const source = notebook.sources.find((item) => item.id === ref.sourceId);
    const status = !source ? "missing"
      : notebook.sha256 !== ref.notebookSha256 || source.digest !== ref.sourceDigest
        || source.document.id !== ref.documentId || source.document.sha256 !== ref.documentSha256 ? "changed" : "current";
    return { coverageDocumentId: entry.coverageDocumentId, status, notebookId: ref.notebookId, notebookSha256: notebook.sha256,
      sourceId: ref.sourceId, sourceDigest: source?.digest ?? null, documentId: source?.document.id ?? null,
      documentSha256: source?.document.sha256 ?? null };
  });
  return { schema: "research-literature-study-currentness-v1", literatureSet, sources };
}

/** Projects validated coverage evidence to exact paper/source identities from a cold prepared closure. */
export function projectLiteratureStudyEvidence(preparedValue, resultValue) {
  const prepared = validateLiteratureStudyQuestion(preparedValue);
  if (!prepared.request || !prepared.preview) fail("prepared question has no eligible source documents");
  const result = validateDocumentCoverage(resultValue);
  if (!isDeepStrictEqual(result.plan, prepared.preview)) fail("coverage result does not match the prepared literature question");
  const map = new Map(prepared.sourceMap.map((entry) => [entry.coverageDocumentId, entry]));
  const evidence = result.passes.flatMap((pass) => pass.findings?.evidence ?? []).map((item) => {
    const source = map.get(item.documentId);
    if (!source) fail("coverage evidence references an unmapped paper source");
    return { ...clone(item), paperReferences: clone(source.papers), sourceBinding: clone(source.sourceBinding),
      sourceIndependence: source.sourceIndependence,
      qualification: source.papers.flatMap((paper) => paper.qualification) };
  });
  return { schema: "research-literature-study-evidence-v1", literatureSetId: prepared.literatureSet.id,
    literatureSetSha256: prepared.literatureSet.sha256, question: prepared.request.question,
    resultStatus: result.status, coverage: result.draft?.coverage ?? null,
    answer: result.draft ? clone(result.draft.answer) : null, evidence, gaps: result.draft ? clone(result.draft.gaps) : [],
    qualification: "Exact quote occurrence is retained. Support, truth, independence and currentness are not established by citation projection." };
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
