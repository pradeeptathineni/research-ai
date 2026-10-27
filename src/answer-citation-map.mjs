// Offline mapping from retained answer evidence IDs to stable retrieval input identities.
import { getNotebookCitation, validateResearchNotebook } from "./notebook.mjs";
import { collectResearchRetrievalSources } from "./retrieval-arm.mjs";

const bad = (reason) => { throw new Error(`invalid_research_answer_citation_map: ${reason}`); };
const questionIdPattern = /^question:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const maxCitationIds = 48;

/** Maps final saved answer citations to exact retained page or note-version retrieval IDs. */
export function exportResearchAnswerCitationMap(notebooks, questionIds) {
  if (!Array.isArray(notebooks) || notebooks.length < 1 || notebooks.length > 8)
    bad("select 1-8 validated notebooks explicitly");
  const validated = notebooks.map(validateResearchNotebook);
  if (!Array.isArray(questionIds) || questionIds.length < 1 || questionIds.length > 32
      || questionIds.some((id) => typeof id !== "string" || !questionIdPattern.test(id))
      || new Set(questionIds).size !== questionIds.length) bad("questionIds must contain 1-32 unique retained question IDs");
  const selected = [];
  for (const questionId of questionIds) {
    const found = validated.flatMap((notebook) => notebook.questions
      .filter((question) => question.id === questionId).map((question) => ({ notebook, question })));
    if (found.length !== 1) bad(found.length ? `question ID ${questionId} is ambiguous across notebooks` : `question ID ${questionId} is not retained`);
    selected.push({ ...found[0], questionId });
  }
  const retainedSources = collectResearchRetrievalSources(validated);
  let citationIds = 0;
  const mapped = selected.map(({ notebook, question, questionId }) => {
    const provenance = { notebook_sha256: question.notebookDigest, question_scope_sha256: question.scopeDigest,
      result_sha256: question.result.receipt.contentSha256 };
    const answer = question.result.draft?.answer;
    if (!answer) return { notebook_id: notebook.id, question_id: questionId, status: "unresolved", provenance,
      citations: [], unresolved: [{ evidence_id: null, reason: "no_saved_final_answer" }] };

    const evidencePositions = new Map();
    answer.forEach((row, paragraphIndex) => row.evidenceIds.forEach((evidenceId) => {
      const positions = evidencePositions.get(evidenceId) ?? [];
      positions.push(paragraphIndex);
      evidencePositions.set(evidenceId, positions);
    }));
    const citations = [];
    const unresolved = [];
    for (const [evidenceId, answerParagraphs] of evidencePositions) {
      if (++citationIds > maxCitationIds) bad(`selected questions exceed the ${maxCitationIds}-citation bound`);
      // This owner replays the saved quote against its exact retained page/note version.
      const opened = getNotebookCitation(notebook, questionId, evidenceId);
      const isNote = Object.hasOwn(opened.source, "version");
      const source = retainedSources.find((entry) => entry.source.notebook_id === notebook.id
        && entry.source.kind === (isNote ? "note" : "document")
        && entry.source.record_id === opened.source.id
        && entry.source.page === (isNote ? null : opened.evidence.page)
        && entry.source.version === (isNote ? opened.source.version.version : null));
      if (!source) {
        unresolved.push({ evidence_id: evidenceId, reason: "retained_source_not_in_retrieval_corpus" });
        continue;
      }
      citations.push({ evidence_id: evidenceId, answer_paragraphs: answerParagraphs,
        hit_id: source.id, notebook_id: source.source.notebook_id, kind: source.source.kind,
        record_id: source.source.record_id, page: source.source.page, version: source.source.version,
        title: source.source.title, content_sha256: source.source.content_sha256,
        provenance: { ...provenance, source_sha256: source.sha256 } });
    }
    if (evidencePositions.size === 0) unresolved.push({ evidence_id: null, reason: "final_answer_has_no_evidence_ids" });
    return { notebook_id: notebook.id, question_id: questionId,
      status: unresolved.length ? citations.length ? "partial" : "unresolved" : "mapped",
      provenance, citations, unresolved };
  });
  return { format: "research-answer-citation-map-1", questions: mapped, qualifications: [
    "Mappings identify exact retained input records reached by final saved answer evidence IDs.",
    "Citation integrity is replayed against retained quote text and page or note-version identity.",
    "Membership does not establish relevance, entailment, answer correctness, ground truth, or retrieval quality.",
    "No source bodies are exported; only explicitly selected notebooks and question IDs are inspected.",
  ] };
}
