// Cross-document question composition over exact Research Notebook records.
// The portable result is a cold-open view, never a second owner store.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { mindMapResearch, validateMindMap, renderMindMap } from "./mindmap.mjs";
import { validateResearchNotebook } from "./notebook.mjs";

const version = "research-notebook-evidence-graph-v1";
const digestPattern = /^[a-f0-9]{64}$/;
const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v);
const hash = (v) => createHash("sha256").update(typeof v === "string" ? v : canonical(v), "utf8").digest("hex");
const clone = (v) => JSON.parse(JSON.stringify(v));
const fail = (why) => { throw new TypeError(`invalid_notebook_evidence_graph: ${why}`); };
const keys = (v, expected) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join() === [...expected].sort().join();
const line = (v, max) => typeof v === "string" && v.trim() && v.length <= max && v.isWellFormed() && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(v);
const content = (v, max) => typeof v === "string" && v.trim() && v.length <= max && v.isWellFormed();
const sourceUri = (ref) => `https://research-notebook.invalid/${encodeURIComponent(ref.notebookId)}/${ref.kind}/${encodeURIComponent(ref.recordId)}${ref.page === null ? `?version=${ref.version}` : `?page=${ref.page}`}`;
const graphDigest = (value) => hash(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "sha256")));
const mapCoverage = (root) => {
  const hasGap = (node) => node.gap !== null || node.children.some(hasGap);
  return hasGap(root) ? "partial" : "unknown";
};
const coverageQualification = "Partial means at least one explicit gap is retained. With no reported gap, coverage remains unknown; absence of a gap does not establish completeness.";

function resolveSelections(notebooksValue, selections) {
  if (!Array.isArray(notebooksValue) || notebooksValue.length < 1 || notebooksValue.length > 8) fail("provide 1-8 notebook snapshots");
  if (!Array.isArray(selections) || selections.length < 2 || selections.length > 8) fail("select 2-8 exact notebook records or pages");
  const notebooks = notebooksValue.map(validateResearchNotebook);
  if (new Set(notebooks.map((n) => n.id)).size !== notebooks.length) fail("duplicate notebook snapshot");
  const byId = new Map(notebooks.map((notebook) => [notebook.id, notebook]));
  const seen = new Set();
  const sources = selections.map((selection, index) => {
    if (!selection || typeof selection !== "object" || Array.isArray(selection)) fail(`selection ${index + 1} is malformed`);
    const notebook = byId.get(selection.notebookId);
    if (!notebook) fail(`selection ${index + 1} has no supplied notebook`);
    let ref, text;
    if (selection.kind === "document" && Object.keys(selection).sort().join() === ["kind", "notebookId", "page", "recordId"].sort().join()) {
      const source = notebook.sources.find((row) => row.id === selection.recordId);
      const page = source?.document.pages.find((row) => row.number === selection.page);
      if (!source || !page) fail(`selection ${index + 1} does not resolve to a retained document page`);
      ref = { notebookId: notebook.id, notebookSha256: notebook.sha256, kind: "document", recordId: source.id,
        recordDigest: source.digest, documentId: source.document.id, documentSha256: source.document.sha256,
        page: page.number, pageSha256: page.sha256, version: null };
      text = page.text;
    } else if (selection.kind === "note" && Object.keys(selection).sort().join() === ["kind", "notebookId", "recordId", "version"].sort().join()) {
      const note = notebook.notes.find((row) => row.id === selection.recordId);
      const value = note?.versions.find((row) => row.version === selection.version);
      if (!note || !value) fail(`selection ${index + 1} does not resolve to the exact retained note version`);
      ref = { notebookId: notebook.id, notebookSha256: notebook.sha256, kind: "note", recordId: note.id,
        recordDigest: value.sha256, documentId: null, documentSha256: null, page: null, pageSha256: null, version: value.version };
      text = `${value.title}\n\n${value.text}`;
    } else fail(`selection ${index + 1} must name an exact document page or note version`);
    const identity = `${ref.notebookId}:${ref.kind}:${ref.recordId}:${ref.page ?? ref.version}`;
    if (seen.has(identity)) fail("duplicate selected record version");
    seen.add(identity);
    if (!content(text, 48000)) fail(`selection ${index + 1} has empty or invalid extracted text`);
    return { uri: sourceUri(ref), text, ref };
  });
  const distinctDocuments = new Set(sources.filter((s) => s.ref.kind === "document").map((s) => `${s.ref.notebookId}:${s.ref.documentId}`));
  const distinctRecords = new Set(sources.map((s) => `${s.ref.notebookId}:${s.ref.recordId}`));
  if (distinctDocuments.size + sources.filter((s) => s.ref.kind === "note").length < 2 || distinctRecords.size < 2)
    fail("select records from at least two distinct documents or notes");
  if (sources.reduce((total, source) => total + source.text.length, 0) > 48000) fail("selected text exceeds 48,000 UTF-16 units");
  const usedNotebooks = [...new Map(sources.map((source) => [source.ref.notebookId, byId.get(source.ref.notebookId)])).values()];
  return { notebooks: usedNotebooks.map((n) => ({ id: n.id, sha256: n.sha256 })), sources };
}

function validatePrepared(value) {
  if (!keys(value, ["version", "question", "notebooks", "sources", "sha256"]) || value.version !== "research-notebook-evidence-graph-preview-v1"
      || !line(value.question, 2000) || !Array.isArray(value.notebooks) || value.notebooks.length < 1 || value.notebooks.length > 8
      || !Array.isArray(value.sources) || value.sources.length < 2 || value.sources.length > 8 || !digestPattern.test(value.sha256)
      || graphDigest(value) !== value.sha256) fail("invalid or changed preparation");
  const notebookIds = new Set();
  for (const notebook of value.notebooks) {
    if (!keys(notebook, ["id", "sha256"]) || !/^notebook:[0-9a-f-]{36}$/.test(notebook.id) || !digestPattern.test(notebook.sha256) || notebookIds.has(notebook.id)) fail("invalid notebook binding");
    notebookIds.add(notebook.id);
  }
  const identities = new Set();
  let units = 0;
  for (const [index, source] of value.sources.entries()) {
    const ref = source?.ref;
    if (!keys(source, ["uri", "text", "ref"]) || !content(source.text, 48000) || !keys(ref, ["notebookId", "notebookSha256", "kind", "recordId", "recordDigest", "documentId", "documentSha256", "page", "pageSha256", "version"])) fail(`invalid prepared source ${index + 1}`);
    if (!notebookIds.has(ref.notebookId) || value.notebooks.find((n) => n.id === ref.notebookId).sha256 !== ref.notebookSha256
        || !["document", "note"].includes(ref.kind) || !/^(?:source|note):[0-9a-f-]{36}$/.test(ref.recordId)
        || !digestPattern.test(ref.recordDigest) || source.uri !== sourceUri(ref)) fail(`invalid prepared source binding ${index + 1}`);
    if (ref.kind === "document" ? (!line(ref.documentId, 200) || !digestPattern.test(ref.documentSha256 ?? "")
        || !Number.isSafeInteger(ref.page) || ref.page < 1 || !digestPattern.test(ref.pageSha256 ?? "") || ref.version !== null)
      : (ref.documentId !== null || ref.documentSha256 !== null || ref.page !== null || ref.pageSha256 !== null || !Number.isSafeInteger(ref.version) || ref.version < 1)) fail("invalid page or note version reference");
    const id = `${ref.notebookId}:${ref.kind}:${ref.recordId}:${ref.page ?? ref.version}`;
    if (identities.has(id)) fail("duplicate prepared record version");
    identities.add(id); units += source.text.length;
  }
  if (units > 48000) fail("prepared text exceeds the Research bound");
  return value;
}

function verifyPreparedAgainstNotebooks(value, notebooks) {
  const prepared = validatePrepared(value);
  if (!Array.isArray(notebooks)) fail("validated Notebook snapshots are required before dispatch or graph creation");
  const selections = prepared.sources.map(({ ref }) => ref.kind === "document"
    ? { notebookId: ref.notebookId, kind: "document", recordId: ref.recordId, page: ref.page }
    : { notebookId: ref.notebookId, kind: "note", recordId: ref.recordId, version: ref.version });
  const expected = prepareNotebookEvidenceGraph(prepared.question, notebooks, selections);
  if (!isDeepStrictEqual(expected, prepared)) fail("prepared text or bindings do not match the supplied Notebook snapshots");
  return prepared;
}

function nodeEdges(root, sourceRefs) {
  const edges = [];
  const nodes = [];
  const walk = (node, parentId = null) => {
    nodes.push({ id: node.id, label: node.label, parentId, gap: node.gap });
    if (parentId !== null) edges.push({ id: `edge-${node.id}`, from: parentId, to: node.id, label: node.label, relation: node.relation,
      basis: "model-extracted", citations: node.citations.map((citation) => ({ sourceIndex: citation.source,
        reference: clone(sourceRefs[citation.source]), start: citation.start, end: citation.end, quote: citation.quote })), gap: node.gap });
    node.children.forEach((child) => walk(child, node.id));
  };
  walk(root);
  return { nodes, edges };
}

function validateGraph(value) {
  if (!keys(value, ["version", "question", "coverage", "coverageQualification", "notebooks", "sources", "map", "assertions", "sha256"]) || value.version !== version
      || !line(value.question, 2000) || !Array.isArray(value.notebooks) || value.notebooks.length < 1 || value.notebooks.length > 8
      || !Array.isArray(value.sources) || value.sources.length < 2 || value.sources.length > 8 || !Array.isArray(value.assertions) || value.assertions.length > 120
      || !digestPattern.test(value.sha256) || graphDigest(value) !== value.sha256) fail("graph digest or header");
  const map = validateMindMap(value.map);
  if (map.question !== value.question || map.origin.type !== "model-generated" || map.sources.length !== value.sources.length) fail("graph must retain its completed cross-document mind map");
  if (value.coverage !== mapCoverage(map.root) || value.coverageQualification !== coverageQualification) fail("invalid explicit coverage qualification");
  if (!isDeepStrictEqual(value.notebooks, [...new Map(value.sources.map((source) => [source.reference.notebookId, source.reference.notebookSha256])).entries()].map(([id, sha256]) => ({ id, sha256 })))) fail("notebook bindings do not match selected sources");
  const refs = [];
  const sourceIdentities = new Set();
  const distinctDocuments = new Set();
  const distinctRecords = new Set();
  for (const [index, source] of value.sources.entries()) {
    const ref = source?.reference;
    if (!keys(source, ["uri", "reference"]) || source.uri !== map.sources[index].uri || !keys(ref, ["notebookId", "notebookSha256", "kind", "recordId", "recordDigest", "documentId", "documentSha256", "page", "pageSha256", "version"])
        || !/^notebook:[0-9a-f-]{36}$/.test(ref.notebookId) || !digestPattern.test(ref.notebookSha256) || !["document", "note"].includes(ref.kind)
        || !/^(?:source|note):[0-9a-f-]{36}$/.test(ref.recordId) || !digestPattern.test(ref.recordDigest) || source.uri !== sourceUri(ref)
        || (ref.kind === "document" ? (!ref.recordId.startsWith("source:") || !line(ref.documentId, 200) || !digestPattern.test(ref.documentSha256 ?? "") || !Number.isSafeInteger(ref.page) || ref.page < 1 || !digestPattern.test(ref.pageSha256 ?? "") || ref.version !== null || map.sources[index].sha256 !== ref.pageSha256)
          : (!ref.recordId.startsWith("note:") || ref.documentId !== null || ref.documentSha256 !== null || ref.page !== null || ref.pageSha256 !== null || !Number.isSafeInteger(ref.version) || ref.version < 1))) fail(`source reference ${index + 1}`);
    refs.push(source.reference);
    const identity = `${ref.notebookId}:${ref.kind}:${ref.recordId}:${ref.page ?? ref.version}`;
    if (sourceIdentities.has(identity)) fail("duplicate selected record version");
    sourceIdentities.add(identity);
    distinctRecords.add(`${ref.notebookId}:${ref.recordId}`);
    if (ref.kind === "document") distinctDocuments.add(`${ref.notebookId}:${ref.documentId}`);
  }
  if (distinctDocuments.size + refs.filter((ref) => ref.kind === "note").length < 2 || distinctRecords.size < 2) fail("graph must span at least two documents or notes");
  const expected = nodeEdges(map.root, refs);
  const ids = new Set(expected.nodes.map((node) => node.id));
  const assertionIds = new Set();
  for (const assertion of value.assertions) {
    if (!keys(assertion, ["id", "from", "to", "label", "relation", "assertedBy", "basis", "qualification"])
        || !/^assertion-[a-z0-9][a-z0-9-]{0,63}$/.test(assertion.id) || assertionIds.has(assertion.id)
        || !ids.has(assertion.from) || !ids.has(assertion.to) || assertion.from === assertion.to
        || !line(assertion.label, 240) || !["related", "supports", "contrasts", "qualifies", "elaborates"].includes(assertion.relation)
        || !line(assertion.assertedBy, 200) || assertion.basis !== "user-asserted"
        || assertion.qualification !== "Caller assertion; not source-extracted, verified, or independently assessed.") fail("invalid user-asserted edge");
    assertionIds.add(assertion.id);
  }
  return { value, map, ...expected, assertions: value.assertions };
}

/** Bind explicit notebook pages and note versions into a bounded cross-document question preview. */
export function prepareNotebookEvidenceGraph(question, notebooks, selections) {
  if (!line(question, 2000)) fail("invalid question");
  const resolved = resolveSelections(notebooks, selections);
  const base = { version: "research-notebook-evidence-graph-preview-v1", question, notebooks: resolved.notebooks, sources: resolved.sources };
  return { ...base, sha256: graphDigest(base) };
}

/** Runs the existing frozen mind-map method over only the exact selected Notebook material. */
export async function researchNotebookEvidenceGraph(preparedValue, notebooks, options = {}) {
  const prepared = verifyPreparedAgainstNotebooks(preparedValue, notebooks);
  const result = await mindMapResearch(prepared.question, { ...options, sources: prepared.sources.map(({ uri, text }) => ({ uri, text })) });
  if (result.status !== "complete" || !result.map) return { status: result.status, graph: null, receipt: result.receipt };
  return { status: "complete", graph: createNotebookEvidenceGraph(prepared, notebooks, result.map), receipt: result.receipt };
}

/** Creates a cold-open graph closure after a completed map; no notebook data is written. */
export function createNotebookEvidenceGraph(preparedValue, notebooks, mapValue) {
  const prepared = verifyPreparedAgainstNotebooks(preparedValue, notebooks);
  const map = validateMindMap(mapValue);
  const expectedSources = prepared.sources.map(({ uri, text }) => ({ uri, text }));
  if (map.question !== prepared.question || map.origin.type !== "model-generated" || !isDeepStrictEqual(map.sources.map(({ uri, text }) => ({ uri, text })), expectedSources)) fail("mind map does not match the exact prepared notebook sources");
  const base = { version, question: prepared.question, coverage: mapCoverage(map.root), coverageQualification,
    notebooks: clone(prepared.notebooks), sources: prepared.sources.map(({ uri, ref }) => ({ uri, reference: clone(ref) })), map, assertions: [] };
  return validateGraph({ ...base, sha256: graphDigest(base) }).value;
}

/** Cold-validates saved source references, model-extracted edges and caller assertions. */
export function validateNotebookEvidenceGraph(value) { return validateGraph(value).value; }

/** Adds one explicitly caller-asserted edge without changing generated evidence or the source map. */
export function assertNotebookEvidenceGraphEdge(value, input) {
  const graph = validateGraph(value);
  if (!input || !keys(input, ["id", "from", "to", "label", "relation", "assertedBy"])) fail("assertion needs id, endpoints, label, relation and assertedBy");
  const base = { ...value, assertions: [...value.assertions, { ...input, basis: "user-asserted", qualification: "Caller assertion; not source-extracted, verified, or independently assessed." }] };
  delete base.sha256;
  return validateGraph({ ...base, sha256: graphDigest(base) }).value;
}

/** Rechecks only selected record identities against supplied snapshots; never reruns research. */
export function checkNotebookEvidenceGraphSources(value, notebooksValue) {
  const graph = validateGraph(value);
  if (!Array.isArray(notebooksValue)) fail("notebook snapshots must be an array");
  const notebooks = new Map(notebooksValue.map((value) => { const notebook = validateResearchNotebook(value); return [notebook.id, notebook]; }));
  const sources = graph.value.sources.map(({ reference }) => {
    const expected = reference, notebook = notebooks.get(expected.notebookId);
    if (!notebook) return { ...clone(expected), status: "missing", notebookSnapshot: "missing" };
    const snapshot = notebook.sha256 === expected.notebookSha256 ? "current" : "changed";
    if (expected.kind === "document") {
      const source = notebook.sources.find((row) => row.id === expected.recordId);
      const page = source?.document.pages.find((row) => row.number === expected.page);
      if (!source || !page) return { ...clone(expected), status: "missing", notebookSnapshot: snapshot };
      const current = source.digest === expected.recordDigest && source.document.id === expected.documentId
        && source.document.sha256 === expected.documentSha256 && page.sha256 === expected.pageSha256;
      return { ...clone(expected), status: current ? "current" : "changed", notebookSnapshot: snapshot };
    }
    const note = notebook.notes.find((row) => row.id === expected.recordId);
    const current = note?.versions.find((row) => row.version === expected.version);
    if (!current) return { ...clone(expected), status: "missing", notebookSnapshot: snapshot };
    return { ...clone(expected), status: current.sha256 === expected.recordDigest ? "current" : "changed", notebookSnapshot: snapshot };
  });
  return { version: "research-notebook-evidence-graph-currentness-v1", graphSha256: graph.value.sha256,
    sources, qualification: "Currentness is checked only for the selected notebook records; the extracted relationships remain fallible research judgments." };
}

/** JSON is the cold-open closure; list is a citation-linked edge projection, not a separate store. */
export function renderNotebookEvidenceGraph(value, { format = "markdown" } = {}) {
  const graph = validateGraph(value);
  const edges = [...graph.edges, ...graph.assertions.map((row) => ({ ...row, citations: [] }))];
  const list = { version: "research-notebook-evidence-graph-list-v1", question: value.question,
    graphSha256: value.sha256, coverage: value.coverage, coverageQualification: value.coverageQualification,
    nodes: graph.nodes, edges,
    qualifications: [...graph.map.limits, value.coverageQualification, "A quote proves exact text occurrence only, not entailment, truth, independence, or currentness."] };
  if (format === "json") return `${JSON.stringify(value, null, 2)}\n`;
  if (format === "list") return `${JSON.stringify(list, null, 2)}\n`;
  if (format !== "markdown") fail("unsupported render format");
  const visible = (text) => text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => `\\u${c.codePointAt(0).toString(16).padStart(4, "0")}`);
  const escape = (text) => visible(text).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]).replace(/([\\`*_{}\[\]()!|#~+-])/g, "\\$1");
  const codeSpan = (text) => {
    const fence = "`".repeat(Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length)) + 1);
    const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
    return `${fence}${pad}${text}${pad}${fence}`;
  };
  const sourceLabel = (ref) => `${ref.kind} ${ref.recordId}${ref.page ? `, page ${ref.page}` : `, version ${ref.version}`} · notebook ${ref.notebookId} · SHA-256 ${ref.pageSha256 ?? ref.recordDigest}`;
  const edgeLines = edges.map((edge) => {
    const citations = edge.citations.map((citation) => `  - ${sourceLabel(citation.reference)} · UTF-16 ${citation.start}–${citation.end}: ${codeSpan(visible(citation.quote))}`).join("\n");
    return `- **${edge.basis} · ${edge.relation}:** ${escape(edge.label)} (${edge.from} → ${edge.to})${edge.gap ? `\n  - Gap: ${escape(edge.gap)}` : ""}${citations ? `\n${citations}` : ""}${edge.assertedBy ? `\n  - Asserted by: ${escape(edge.assertedBy)}` : ""}`;
  });
  return `# Cross-document connections: ${escape(value.question)}\n\nGraph SHA-256: ${value.sha256}\n\nCoverage: ${value.coverage} — ${escape(value.coverageQualification)}\n\n## Connections\n\n${edgeLines.join("\n")}\n\n## Limits\n\n${list.qualifications.map((item) => `- ${escape(item)}`).join("\n")}\n`;
}
