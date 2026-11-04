// Compose explicit offline lexical results with caller-supplied dense rankings.
import { createHash } from "node:crypto";
import { collectResearchRetrievalSources, exportResearchRetrievalArm } from "./retrieval-arm.mjs";
import { validateResearchNotebook } from "./notebook.mjs";

const hash = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().filter((k) => v[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v);
const bad = (why) => { throw new Error(`invalid_research_retrieval_strategy: ${why}`); };
const line = (v, n) => typeof v === "string" && v.trim() && v.length <= n && v.isWellFormed()
  && !/[\r\n\p{Cc}\p{Zl}\p{Zp}]/u.test(v);

function seal(value) { return { ...value, sha256: hash(canonical(value)) }; }

function denseRows(input, questionIds, sourceHashes) {
  if (input === undefined) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some((key) => !questionIds.includes(key))) bad("denseRankings must map declared question IDs to rows");
  const result = {};
  for (const questionId of questionIds) {
    const rows = input[questionId];
    if (rows === undefined) continue;
    if (!Array.isArray(rows) || rows.length > sourceHashes.size) bad("each dense ranking must be a bounded array");
    const seen = new Set();
    result[questionId] = rows.map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)
          || Object.keys(row).sort().join() !== "id,score,sha256"
          || typeof row.id !== "string" || !sourceHashes.has(row.id) || sourceHashes.get(row.id) !== row.sha256
          || !Number.isFinite(row.score) || seen.has(row.id))
        bad(`dense ranking for ${questionId} must bind unique retained source IDs/digests and finite scores`);
      seen.add(row.id);
      return { id: row.id, score: row.score };
    }).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return result;
}

/**
 * Adds a lexical, dense, or reciprocal-rank-fused arm. Dense scores are supplied
 * by the caller, bound to this exact retained corpus, and used only for ordering.
 */
export function exportResearchRetrievalStrategy(notebooks, questions, options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).some((key) => !["mode", "researchRevision", "strategy", "denseRankings"].includes(key)))
    bad("options accept only mode, researchRevision, strategy, and denseRankings");
  const strategy = options.strategy ?? "lexical";
  if (!["lexical", "dense", "hybrid"].includes(strategy)) bad("strategy must be lexical, dense, or hybrid");
  const lexical = exportResearchRetrievalArm(notebooks, questions, { mode: options.mode, researchRevision: options.researchRevision });
  const sourceHashes = new Map(lexical.corpus.source_sha256.map(({ id, sha256 }) => [id, sha256]));
  const dense = denseRows(options.denseRankings, lexical.questions.map(({ id }) => id), sourceHashes);
  const diagnostics = {};
  const rankings = {};
  for (const question of lexical.questions) {
    const qid = question.id;
    const lexicalIds = lexical.arm.rankings[qid];
    const denseIds = (dense[qid] ?? []).map(({ id }) => id);
    const usable = denseIds.length > 0;
    const fallbackReason = strategy !== "lexical" && !usable
      ? options.denseRankings === undefined ? "dense input absent" : "no usable dense candidates for this question" : null;
    const effective = strategy === "lexical" || fallbackReason ? "lexical" : strategy;
    if (effective === "lexical") rankings[qid] = lexicalIds;
    else if (effective === "dense") rankings[qid] = denseIds;
    else {
      const fused = new Map();
      for (const [ids, weight] of [[lexicalIds, 1], [denseIds, 1]])
        ids.forEach((id, index) => fused.set(id, (fused.get(id) ?? 0) + weight / (60 + index + 1)));
      rankings[qid] = [...fused].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([id]) => id);
    }
    diagnostics[qid] = { requestedStrategy: strategy, effectiveStrategy: effective,
      lexicalCandidateCount: lexicalIds.length, denseCandidateCount: denseIds.length,
      fallbackReason, scoreMeaning: "ranking-only; not evidence strength, confidence, truth, entailment, currentness, or independence" };
  }
  const hasFallback = Object.values(diagnostics).some((item) => item.fallbackReason !== null);
  const armStrategy = hasFallback ? `research-${strategy}-with-lexical-fallback` : `research-${strategy}`;
  const result = seal({
    format: "research-retrieval-strategy-1",
    corpus: lexical.corpus,
    questions: lexical.questions,
    arm: { strategy: armStrategy, provenance: { ...lexical.arm.provenance, version: "research-notebook-retrieval-strategy-v1" },
      corpus_id: lexical.corpus.id, question_ids: lexical.questions.map(({ id }) => id), rankings },
    diagnostics,
    qualifications: [
      "Lexical candidates use the existing offline Research MiniSearch implementation.",
      "Dense ranking rows are caller-supplied scores bound to exact retained source IDs and per-source SHA-256 digests; Research runs no embedding or model service.",
      "Hybrid ordering uses reciprocal-rank fusion (60); dense scores are never evidence strength.",
      `Requested ${strategy} strategy${hasFallback ? " uses the explicit lexical-fallback arm label when any question lacks dense candidates" : " ran without fallback"}.`,
      "Missing dense candidates fall back per question to the existing lexical ranking; inspect diagnostics for effective strategy and counts.",
      "Rankings contain stable IDs for exact retained pages or note versions; they do not add relevance judgments.",
    ],
  });
  return result;
}

/** Cold-reopens an exact page or note version from a strategy export. */
export function openResearchRetrievalSource(notebooks, resultValue, sourceId, questionId) {
  if (!resultValue || resultValue.format !== "research-retrieval-strategy-1" || !Array.isArray(notebooks)
      || !line(sourceId, 200) || !/^[a-f0-9]{64}$/.test(resultValue.sha256)
      || hash(canonical(Object.fromEntries(Object.entries(resultValue).filter(([k]) => k !== "sha256")))) !== resultValue.sha256)
    bad("invalid retrieval result or source ID");
  if (questionId !== undefined && !line(questionId, 200)) bad("question ID must be a declared single-line ID");
  const originalHashes = resultValue.corpus?.source_sha256;
  if (!Array.isArray(originalHashes) || !Array.isArray(resultValue.corpus?.sources)
      || originalHashes.length < 1 || originalHashes.length > 8000 || resultValue.corpus.sources.length !== originalHashes.length
      || originalHashes.some((row) => !row || typeof row !== "object" || Object.keys(row).sort().join() !== "id,sha256"
        || typeof row.id !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256))
      || new Set(originalHashes.map((row) => row.id)).size !== originalHashes.length
      || resultValue.corpus.source_ids?.length !== originalHashes.length
      || canonical(resultValue.corpus.source_ids) !== canonical(originalHashes.map(({ id }) => id))
      || resultValue.corpus.sources.some((row) => !row || typeof row !== "object" || typeof row.id !== "string")
      || canonical(resultValue.corpus.sources.map(({ id }) => id)) !== canonical(resultValue.corpus.source_ids)
      || `research-corpus-sha256:${hash(canonical(originalHashes))}` !== resultValue.corpus.id) bad("invalid original corpus binding");
  const current = collectResearchRetrievalSources(notebooks);
  const currentHashes = current.map(({ id, sha256 }) => ({ id, sha256 }));
  const originalById = new Map(originalHashes.map(({ id, sha256 }) => [id, sha256]));
  const currentById = new Map(currentHashes.map(({ id, sha256 }) => [id, sha256]));
  const corpusChanges = {
    added: currentHashes.filter(({ id }) => !originalById.has(id)).length,
    missing: originalHashes.filter(({ id }) => !currentById.has(id)).length,
    changed: originalHashes.filter(({ id, sha256 }) => currentById.has(id) && currentById.get(id) !== sha256).length,
  };
  const entry = resultValue.corpus.sources.find(({ id }) => id === sourceId);
  const retained = current.find(({ id }) => id === sourceId);
  if (!entry || !retained || retained.sha256 !== originalById.get(sourceId)) bad("selected source is missing or changed since ranking");
  const sourceBinding = entry.kind === "document"
    ? hash(canonical({ source: entry.source_sha256, page: entry.content_sha256 }))
    : entry.kind === "note" ? entry.content_sha256 : null;
  if (sourceBinding !== originalById.get(sourceId)) bad("source metadata does not match its sealed per-hit digest");
  if (!Object.values(resultValue.arm?.rankings ?? {}).some((ids) => Array.isArray(ids) && ids.includes(sourceId)))
    bad("source ID is not in a retained question ranking");
  const rankedQuestions = resultValue.questions.map((question) => {
    const rank = resultValue.arm.rankings[question.id]?.indexOf(sourceId) ?? -1;
    if (rank < 0) return null;
    const diagnostic = resultValue.diagnostics?.[question.id];
    if (!diagnostic || !["lexical", "dense", "hybrid"].includes(diagnostic.effectiveStrategy))
      bad("selected ranking has no valid question strategy diagnostic");
    return { questionId: question.id, rank: rank + 1, effectiveStrategy: diagnostic.effectiveStrategy,
      fallbackReason: diagnostic.fallbackReason };
  }).filter(Boolean);
  if (rankedQuestions.length === 0) bad("source ID is not in a declared question ranking");
  if (questionId !== undefined && !rankedQuestions.some((item) => item.questionId === questionId))
    bad("selected source is not ranked for the requested question");
  const stableId = `notebook-hit-${hash(canonical({ notebookId: entry.notebook_id, kind: entry.kind,
    recordId: entry.record_id, version: entry.version, page: entry.page })).slice(0, 40)}`;
  if (stableId !== entry.id) bad("source ID does not bind its notebook/page/version reference");
  const notebook = validateResearchNotebook(notebooks.find((item) => item.id === entry.notebook_id));
  if (entry.kind === "document") {
    const source = notebook.sources.find((item) => item.id === entry.record_id);
    const page = source?.document.pages.find((item) => item.number === entry.page);
    if (!source || source.digest !== entry.source_sha256 || !page || page.sha256 !== entry.content_sha256) bad("retained page identity changed");
    return { id: entry.id, notebookId: notebook.id, kind: entry.kind, recordId: source.id,
      documentId: source.document.id, page: page.number, version: null, title: source.document.title,
      sourceDigest: source.digest, contentSha256: page.sha256, text: page.text,
      rankedQuestions,
      corpusCurrentness: corpusChanges.added + corpusChanges.missing + corpusChanges.changed === 0 ? "current" : "changed",
      corpusChanges };
  }
  const note = notebook.notes.find((item) => item.id === entry.record_id);
  const version = note?.versions.find((item) => item.version === entry.version);
  if (!version || version.sha256 !== entry.content_sha256 || version.sha256 !== entry.source_sha256) bad("retained note version identity changed");
  return { id: entry.id, notebookId: notebook.id, kind: entry.kind, recordId: note.id,
    documentId: null, page: null, version: version.version, title: version.title,
    sourceDigest: version.sha256, contentSha256: version.sha256, text: version.text,
    rankedQuestions,
    corpusCurrentness: corpusChanges.added + corpusChanges.missing + corpusChanges.changed === 0 ? "current" : "changed",
    corpusChanges };
}
