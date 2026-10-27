// Offline frozen candidate-arm export over explicitly selected retained notebooks.
import { createHash } from "node:crypto";
import { searchResearchNotebooks, notebookSearchLimits } from "./notebook-search.mjs";
import { validateResearchNotebook } from "./notebook.mjs";

const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  : JSON.stringify(value);
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const bad = (why) => { throw new Error(`invalid_research_retrieval_arm: ${why}`); };
const line = (v, max) => typeof v === "string" && v.trim() !== "" && v.length <= max && v.isWellFormed()
  && !/[\r\n\p{Cc}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(v);
const idOk = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(v);
const hitId = (identity) => `notebook-hit-${hash(canonical(identity)).slice(0, 40)}`;

function collect(notebooks) {
  if (!Array.isArray(notebooks) || notebooks.length < 1 || notebooks.length > notebookSearchLimits.notebooks)
    bad(`select 1-${notebookSearchLimits.notebooks} notebooks explicitly`);
  const checked = notebooks.map(validateResearchNotebook);
  if (new Set(checked.map((n) => n.id)).size !== checked.length) bad("notebook IDs must be unique");
  const records = [];
  for (const n of checked) {
    for (const source of n.sources) for (const page of source.document.pages) {
      records.push({ id: hitId({ notebookId: n.id, kind: "document", recordId: source.id, version: null, page: page.number }),
        sha256: hash(canonical({ source: source.digest, page: page.sha256 })),
        source: { notebook_id: n.id, kind: "document", record_id: source.id, page: page.number, version: null,
          title: source.document.title, content_sha256: page.sha256 } });
    }
    for (const note of n.notes) for (const version of note.versions) {
      records.push({ id: hitId({ notebookId: n.id, kind: "note", recordId: note.id, version: version.version, page: null }),
        sha256: version.sha256,
        source: { notebook_id: n.id, kind: "note", record_id: note.id, page: null, version: version.version,
          title: version.title, content_sha256: version.sha256 } });
    }
  }
  records.sort((a, b) => cmp(a.id, b.id));
  if (records.length < 1) bad("selected corpus contains no retained pages or note versions");
  if (records.length > notebookSearchLimits.records) bad(`corpus exceeds ${notebookSearchLimits.records} records`);
  if (new Set(records.map((r) => r.id)).size !== records.length) bad("source hit IDs must be unique");
  return records;
}

// Shared with the answer-citation mapper so both surfaces use the same stable hit IDs.
export function collectResearchRetrievalSources(notebooks) {
  return collect(notebooks);
}

/** Exports one offline lexical retrieval arm suitable for combining with other frozen arms. */
export function exportResearchRetrievalArm(notebooks, questions, options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).some((key) => !["mode", "researchRevision"].includes(key))) bad("options accept only mode and researchRevision");
  const mode = options.mode ?? "exact";
  if (!["exact", "prefix", "fuzzy"].includes(mode)) bad("mode must be exact, prefix, or fuzzy");
  const revision = options.researchRevision;
  if (!line(revision, 160)) bad("researchRevision must be supplied as bounded single-line pinned revision provenance");
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 32) bad("questions must contain 1-32 ordered entries");
  const qids = new Set();
  for (const q of questions) {
    if (!q || typeof q !== "object" || Array.isArray(q) || Object.keys(q).sort().join() !== "id,text"
        || !idOk(q.id) || !line(q.text, notebookSearchLimits.queryUtf16Units)) bad("each question needs a unique valid id and single-line text");
    if (qids.has(q.id)) bad("question IDs must be unique");
    qids.add(q.id);
  }
  const records = collect(notebooks);
  const sourceIds = records.map((r) => r.id);
  const corpusHashes = records.map(({ id, sha256 }) => ({ id, sha256 }));
  const corpusId = `research-corpus-sha256:${hash(canonical(corpusHashes))}`;
  const rankings = {};
  for (const q of questions) {
    const result = searchResearchNotebooks(notebooks, q.text, { mode, kinds: ["document", "note"], noteVersions: "all", limit: notebookSearchLimits.hits });
    if (result.counts.totalHits > result.counts.returnedHits) bad(`question ${q.id} exceeds the ${notebookSearchLimits.hits}-hit arm bound`);
    rankings[q.id] = result.hits.map((hit) => hit.id);
  }
  return {
    format: "research-retrieval-arm-1",
    corpus: { id: corpusId, source_ids: sourceIds, source_sha256: corpusHashes,
      sources: records.map(({ id, source }) => ({ id, ...source })) },
    questions: questions.map(({ id, text }) => ({ id, text })),
    arm: { strategy: `research-lexical-${mode}`, provenance: {
      producer: "@pradeeptathineni/research-ai", version: "research-notebook-search-v1",
      reference: revision, engine: notebookSearchLimits.engine,
    }, corpus_id: corpusId, question_ids: questions.map((q) => q.id), rankings },
    qualifications: [
      "Candidate rankings use the existing Research MiniSearch lexical implementation only.",
      "No embeddings, dense or hybrid retrieval, model, network, ground truth, judgments, or metrics are included.",
      "The corpus digest binds the exact ordered stable source hit IDs to each retained page or note-version SHA-256.",
      "All selected notebook pages and every retained note version belong to the corpus, regardless of retrieval mode.",
    ],
  };
}
