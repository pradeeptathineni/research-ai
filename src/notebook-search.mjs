// src/notebook-search.mjs - Search explicit retained notebook pages and note versions offline.
//
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import MiniSearch from "./vendor/minisearch-7.2.0.mjs";
import { validateResearchNotebook } from "./notebook.mjs";

const resultVersion = "research-notebook-search-v1";
const engine = Object.freeze({ name: "minisearch", version: "7.2.0", sha256: "0393b3ba253b809d5e55707c7b0875ef9b518a296a006c6739b28876e154edb3" });
const caps = Object.freeze({ notebooks: 8, records: 8000, utf16Units: 4000000, queryUtf16Units: 200,
  hits: 50, matches: 64, excerptUtf16Units: 600, resultBytes: 8 * 1024 * 1024 });
const digestPattern = /^[a-f0-9]{64}$/;
const kinds = ["document", "note"];
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, expected) => plain(value) && Object.keys(value).sort().join() === [...expected].sort().join();
const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : plain(value) ? `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  : JSON.stringify(value);
const clone = (value) => JSON.parse(JSON.stringify(value));
const invalid = (reason) => { throw new Error(`invalid_research_notebook_search: ${reason}`); };
const oneLine = (value, max) => typeof value === "string" && value.trim() !== ""
  && value.length <= max && value.isWellFormed() && !/[\r\n\p{Cc}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const uuidPrefix = /^(notebook|source|note):[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const qualified = Object.freeze([
  "Lexical search only: no vector, embedding, model, network, or source acquisition is used.",
  "Scores rank search relevance; they are not confidence, truth, entailment, currentness, or source-independence judgments.",
  "Each source hit represents one complete retained page; each note hit represents one exact retained note version.",
  "Match ranges are bounded exact token occurrences in the original title or body, not a list of every occurrence.",
  "Results never add hits to a question scope. A consumer must explicitly select a hit before preparing a question.",
]);

function normalizeOptions(options = {}) {
  if (!plain(options) || Object.keys(options).some((key) => !["mode", "kinds", "noteVersions", "limit"].includes(key)))
    invalid("options accept only mode, kinds, noteVersions, and limit");
  const mode = options.mode ?? "exact";
  const noteVersions = options.noteVersions ?? "latest";
  const limit = options.limit ?? 20;
  if (!["exact", "prefix", "fuzzy"].includes(mode)) invalid("mode must be exact, prefix, or fuzzy");
  if (!["latest", "all"].includes(noteVersions)) invalid("noteVersions must be latest or all");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > caps.hits) invalid(`limit must be from 1 to ${caps.hits}`);
  const selectedKinds = options.kinds ?? kinds;
  if (!Array.isArray(selectedKinds) || selectedKinds.length < 1 || selectedKinds.some((kind) => !kinds.includes(kind))
      || new Set(selectedKinds).size !== selectedKinds.length) invalid("kinds must explicitly select document and/or note");
  return { mode, kinds: kinds.filter((kind) => selectedKinds.includes(kind)), noteVersions, limit };
}

function recordsFor(notebooks, queryOptions) {
  if (!Array.isArray(notebooks) || notebooks.length < 1 || notebooks.length > caps.notebooks)
    invalid(`select 1-${caps.notebooks} notebooks explicitly`);
  const validated = notebooks.map((notebook) => validateResearchNotebook(notebook));
  const notebookIds = validated.map((notebook) => notebook.id);
  if (new Set(notebookIds).size !== notebookIds.length) invalid("selected notebook IDs must be unique");
  const scope = validated.map((notebook) => ({ id: notebook.id, sha256: notebook.sha256 }))
    .sort((a, b) => compareText(a.id, b.id));
  const records = [];
  let utf16Units = 0;
  const add = (record) => {
    utf16Units += record.title.length + record.text.length;
    records.push(record);
    if (records.length > caps.records) invalid(`selected content exceeds ${caps.records} indexed records`);
    if (utf16Units > caps.utf16Units) invalid(`selected titles and text exceed ${caps.utf16Units} UTF-16 units`);
  };
  for (const notebook of validated) {
    if (queryOptions.kinds.includes("document")) for (const source of notebook.sources) {
      for (const page of source.document.pages) add({ notebookId: notebook.id, kind: "document", recordId: source.id,
        version: null, documentId: source.document.id, page: page.number, title: source.document.title,
        sourceDigest: source.digest, text: page.text });
    }
    if (queryOptions.kinds.includes("note")) for (const note of notebook.notes) {
      const versions = queryOptions.noteVersions === "all" ? note.versions : [note.versions.at(-1)];
      for (const version of versions) add({ notebookId: notebook.id, kind: "note", recordId: note.id,
        version: version.version, documentId: null, page: null, title: `Unverified note: ${version.title}`,
        sourceDigest: version.sha256, text: version.text });
    }
  }
  records.sort((a, b) => compareText(a.notebookId, b.notebookId)
    || (a.kind === b.kind ? 0 : a.kind === "document" ? -1 : 1)
    || compareText(a.recordId, b.recordId)
    || (a.version ?? 0) - (b.version ?? 0)
    || (a.page ?? 0) - (b.page ?? 0));
  return { notebooks: validated, scope, records, utf16Units };
}

function wordRanges(value) {
  const ranges = [];
  const expression = /[\p{L}\p{N}]+/gu;
  for (const match of value.matchAll(expression)) ranges.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
  return ranges;
}

const tokenize = (value) => value.match(/[\p{L}\p{N}]+/gu) ?? [];

function excerpt(value, anchor) {
  let start = Math.max(0, anchor - 180);
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(value[start]) && /[\uD800-\uDBFF]/u.test(value[start - 1])) start--;
  let end = Math.min(value.length, start + caps.excerptUtf16Units);
  if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1]) && /[\uDC00-\uDFFF]/u.test(value[end])) end--;
  return { start, end, text: value.slice(start, end), truncatedBefore: start > 0, truncatedAfter: end < value.length };
}

function rangesFor(record, engineResult) {
  const byField = new Map();
  for (const term of engineResult.terms) for (const field of engineResult.match[term] ?? []) {
    const terms = byField.get(field) ?? new Set();
    terms.add(term);
    byField.set(field, terms);
  }
  const matches = [];
  let omittedMatchCount = 0;
  let firstBodyMatch = null;
  for (const field of ["title", "text"]) {
    const fieldText = record[field];
    const terms = byField.get(field);
    if (!terms) continue;
    for (const range of wordRanges(fieldText)) if (terms.has(range.text.toLowerCase())) {
      const match = { field, start: range.start, end: range.end, text: range.text };
      if (field === "text" && firstBodyMatch === null) firstBodyMatch = match;
      if (matches.length < caps.matches) matches.push(match);
      else omittedMatchCount++;
    }
  }
  return { matches, omittedMatchCount, firstBodyMatch };
}

function makeHit(record, engineResult) {
  const ranges = rangesFor(record, engineResult);
  const bodyAnchor = ranges.firstBodyMatch?.start ?? 0;
  return {
    id: `notebook-hit-${hash(canonical({ notebookId: record.notebookId, kind: record.kind,
      recordId: record.recordId, version: record.version, page: record.page })).slice(0, 40)}`,
    notebookId: record.notebookId, kind: record.kind, recordId: record.recordId,
    version: record.version, documentId: record.documentId, page: record.page, title: record.title,
    sourceDigest: record.sourceDigest, score: engineResult.score,
    matchedTerms: [...new Set(engineResult.terms)].sort(),
    matches: ranges.matches, omittedMatchCount: ranges.omittedMatchCount,
    excerpt: excerpt(record.text, bodyAnchor),
  };
}

function sealResult(value) {
  const result = { ...value, sha256: hash(canonical(value)) };
  if (Buffer.byteLength(canonical(result), "utf8") > caps.resultBytes) invalid("result exceeds its 8 MiB bound");
  return result;
}

/** Searches only the explicit validated notebooks with a fresh in-memory MiniSearch index. */
export function searchResearchNotebooks(notebooks, query, options = {}) {
  if (!oneLine(query, caps.queryUtf16Units)) invalid(`query must be well-formed single-line text of at most ${caps.queryUtf16Units} UTF-16 units`);
  const queryOptions = normalizeOptions(options);
  const selected = recordsFor(notebooks, queryOptions);
  const digestInput = { scope: selected.scope, query: { text: query, ...queryOptions }, engine };
  if (selected.records.length === 0) {
    const base = { version: resultVersion, inputDigest: hash(canonical(digestInput)),
      query: { text: query, ...queryOptions }, scope: selected.scope, engine,
      counts: { notebooks: selected.notebooks.length, records: 0, utf16Units: 0, totalHits: 0, returnedHits: 0 },
      hits: [], qualifications: [...qualified] };
    return sealResult(base);
  }
  const searchDocs = selected.records.map((record, index) => ({ id: index, title: record.title, text: record.text }));
  const index = new MiniSearch({ fields: ["title", "text"], tokenize, processTerm: (term) => term.toLowerCase(),
    storeFields: [], autoVacuum: false, searchOptions: { combineWith: "OR", boost: { title: 2 } } });
  index.addAll(searchDocs);
  const modeOptions = queryOptions.mode === "prefix" ? { prefix: true, fuzzy: false }
    : queryOptions.mode === "fuzzy" ? { prefix: false, fuzzy: 0.2 } : { prefix: false, fuzzy: false };
  const results = index.search(query, { ...modeOptions, combineWith: "OR", fields: ["title", "text"], boost: { title: 2 } });
  const hits = results.map((result) => makeHit(selected.records[result.id], result))
    .sort((a, b) => b.score - a.score || compareText(a.notebookId, b.notebookId)
      || (a.kind === b.kind ? 0 : a.kind === "document" ? -1 : 1)
      || compareText(a.recordId, b.recordId) || (a.version ?? 0) - (b.version ?? 0) || (a.page ?? 0) - (b.page ?? 0));
  const base = { version: resultVersion, inputDigest: hash(canonical(digestInput)),
    query: { text: query, ...queryOptions }, scope: selected.scope, engine,
    counts: { notebooks: selected.notebooks.length, records: selected.records.length,
      utf16Units: selected.utf16Units, totalHits: hits.length, returnedHits: Math.min(hits.length, queryOptions.limit) },
    hits: hits.slice(0, queryOptions.limit), qualifications: [...qualified] };
  return sealResult(base);
}

function validateSearchResult(value) {
  if (!keys(value, ["version", "inputDigest", "query", "scope", "engine", "counts", "hits", "qualifications", "sha256"]))
    invalid("search result has unknown or missing fields");
  if (Buffer.byteLength(canonical(value), "utf8") > caps.resultBytes || value.version !== resultVersion
      || !digestPattern.test(value.inputDigest) || !digestPattern.test(value.sha256)
      || hash(canonical(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "sha256")))) !== value.sha256
      || !isDeepStrictEqual(value.engine, engine) || !Array.isArray(value.scope) || value.scope.length < 1 || value.scope.length > caps.notebooks
      || !isDeepStrictEqual(value.qualifications, qualified)) invalid("invalid search result identity or digest");
  const query = value.query;
  if (!keys(query, ["text", "mode", "kinds", "noteVersions", "limit"]) || !oneLine(query.text, caps.queryUtf16Units)) invalid("invalid retained query");
  const opts = normalizeOptions({ mode: query.mode, kinds: query.kinds, noteVersions: query.noteVersions, limit: query.limit });
  if (!isDeepStrictEqual(opts, { mode: query.mode, kinds: query.kinds, noteVersions: query.noteVersions, limit: query.limit })) invalid("query options are not canonical");
  const seen = new Set();
  for (const scope of value.scope) {
    if (!keys(scope, ["id", "sha256"]) || !uuidPrefix.test(scope.id) || !digestPattern.test(scope.sha256) || seen.has(scope.id)) invalid("invalid or duplicate search scope entry");
    seen.add(scope.id);
  }
  if (["notebooks", "records", "utf16Units", "totalHits", "returnedHits"].some((key) => !Number.isSafeInteger(value.counts?.[key]) || value.counts[key] < 0)
      || !keys(value.counts, ["notebooks", "records", "utf16Units", "totalHits", "returnedHits"])
      || value.counts.notebooks !== value.scope.length || value.counts.records > caps.records || value.counts.utf16Units > caps.utf16Units
      || !Array.isArray(value.hits) || value.hits.length > caps.hits || value.hits.length !== value.counts.returnedHits
      || value.counts.returnedHits > query.limit || value.counts.totalHits < value.counts.returnedHits) invalid("invalid search counts or hit bounds");
  for (const hit of value.hits) {
    if (!keys(hit, ["id", "notebookId", "kind", "recordId", "version", "documentId", "page", "title", "sourceDigest", "score",
      "matchedTerms", "matches", "omittedMatchCount", "excerpt"])) invalid("search hit has unknown or missing fields");
    if (typeof hit.id !== "string" || !/^notebook-hit-[a-f0-9]{40}$/.test(hit.id)
        || !seen.has(hit.notebookId) || !kinds.includes(hit.kind)
        || !idPattern.test(hit.recordId) || !(hit.version === null || Number.isSafeInteger(hit.version) && hit.version > 0)
        || !(hit.page === null || Number.isSafeInteger(hit.page) && hit.page > 0)
        || !(hit.documentId === null || idPattern.test(hit.documentId)) || !oneLine(hit.title, 240)
        || !digestPattern.test(hit.sourceDigest) || !Number.isFinite(hit.score) || hit.score < 0
        || !Array.isArray(hit.matchedTerms) || !hit.matchedTerms.every((term) => oneLine(term, caps.utf16Units))
        || !Array.isArray(hit.matches) || hit.matches.length > caps.matches || !Number.isSafeInteger(hit.omittedMatchCount) || hit.omittedMatchCount < 0
        || !keys(hit.excerpt, ["start", "end", "text", "truncatedBefore", "truncatedAfter"])
        || !Number.isSafeInteger(hit.excerpt.start) || !Number.isSafeInteger(hit.excerpt.end) || hit.excerpt.start < 0 || hit.excerpt.end < hit.excerpt.start
        || hit.excerpt.end - hit.excerpt.start !== hit.excerpt.text.length || hit.excerpt.text.length > caps.excerptUtf16Units
        || typeof hit.excerpt.truncatedBefore !== "boolean" || typeof hit.excerpt.truncatedAfter !== "boolean") invalid("malformed search hit");
    if ((hit.kind === "note" && (hit.version === null || hit.documentId !== null || hit.page !== null || !hit.title.startsWith("Unverified note: ")))
        || (hit.kind === "document" && (hit.version !== null || hit.documentId === null || hit.page === null))) invalid("hit kind does not match its source fields");
    for (const match of hit.matches) if (!keys(match, ["field", "start", "end", "text"])
      || !["title", "text"].includes(match.field) || !Number.isSafeInteger(match.start) || !Number.isSafeInteger(match.end)
      || match.start < 0 || match.end <= match.start || match.end - match.start !== match.text.length
      || !oneLine(match.text, caps.utf16Units)) invalid("invalid match range");
  }
  return value;
}

/** Opens the exact original page or note version behind a current, digest-valid hit. */
export function openNotebookSearchHit(notebooks, resultValue, hitId) {
  const result = validateSearchResult(resultValue);
  if (typeof hitId !== "string" || !hitId.startsWith("notebook-hit-")) invalid("invalid hit ID");
  const reproduced = searchResearchNotebooks(notebooks, result.query.text, {
    mode: result.query.mode, kinds: result.query.kinds, noteVersions: result.query.noteVersions, limit: result.query.limit,
  });
  if (!isDeepStrictEqual(reproduced, result)) invalid("search result is stale or does not replay from these notebooks");
  const hit = result.hits.find((entry) => entry.id === hitId);
  if (!hit) invalid("hit ID is not in the retained search result");
  const notebook = validateResearchNotebook(notebooks.find((entry) => entry.id === hit.notebookId));
  if (hit.kind === "document") {
    const source = notebook.sources.find((entry) => entry.id === hit.recordId);
    const page = source?.document.pages.find((entry) => entry.number === hit.page);
    if (!source || !page || source.digest !== hit.sourceDigest || source.document.id !== hit.documentId || source.document.title !== hit.title)
      invalid("source page no longer matches the indexed hit");
    return { hit: clone(hit), source: { kind: "document", notebookId: notebook.id, recordId: source.id,
      digest: source.digest, document: clone(source.document), page: clone(page) } };
  }
  const note = notebook.notes.find((entry) => entry.id === hit.recordId);
  const version = note?.versions.find((entry) => entry.version === hit.version);
  if (!note || !version || version.sha256 !== hit.sourceDigest || `Unverified note: ${version.title}` !== hit.title)
    invalid("note version no longer matches the indexed hit");
  return { hit: clone(hit), source: { kind: "note", notebookId: notebook.id, recordId: note.id,
    digest: version.sha256, version: clone(version) } };
}

export const notebookSearchLimits = Object.freeze({ ...caps, engine });
