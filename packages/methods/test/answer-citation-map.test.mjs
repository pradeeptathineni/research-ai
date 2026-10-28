import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createResearchNotebook, reviseResearchNotebook, prepareNotebookQuestion, researchDocumentCoverage,
  prepareDocumentCoverage, recordNotebookQuestion, exportResearchAnswerCitationMap } from "../src/index.mjs";
import { fakeCodex, message } from "./fake-codex.mjs";

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const page = (number, text) => ({ number, text, sha256: sha(text) });
const response = (value) => ({ events: [message(JSON.stringify(value)), { type: "turn.completed" }] });

async function savedNotebook() {
  const doc = { id: "doc:answer", title: "Answer source title", sha256: sha("caller-raw-document-hash"),
    pages: [page(1, "Page citation exact.")] };
  let notebook = createResearchNotebook("Cited notebook");
  notebook = reviseResearchNotebook(notebook, { type: "add-source", document: doc });
  notebook = reviseResearchNotebook(notebook, { type: "add-note", title: "Citation note", text: "Note citation exact." });
  const questionId = `question:${randomUUID()}`;
  const prepared = prepareNotebookQuestion(notebook, { id: questionId, question: "What is retained?",
    sourceIds: [notebook.sources[0].id], notes: [{ id: notebook.notes[0].id, version: 1 }] });
  const coveragePlan = prepareDocumentCoverage(prepared.request.question, prepared.request.documents, prepared.request.policy);
  const rows = prepared.request.documents.map((document, i) => ({
    id: `quote-${i + 1}`,
    windowId: coveragePlan.windows.find((window) => window.documentId === document.id).id,
    quote: document.title.startsWith("Unverified note:") ? "Note citation exact." : "Page citation exact.",
    relation: "supporting", occurrence: null,
  }));
  const firstPass = { answer: rows.map((row) => ({ text: `The material states ${row.quote}`, evidenceIds: [row.id] })),
    evidence: rows, coverage: "answered", gaps: [] };
  const finalIds = rows.map((_, i) => `p01-e${String(i + 1).padStart(2, "0")}`);
  const final = { answer: [{ text: "The saved answer cites both selected inputs.", evidenceIds: finalIds }], coverage: "answered", gaps: [] };
  const fixture = await fakeCodex({ sessions: [response(firstPass), response(final)] });
  try {
    const result = await researchDocumentCoverage(prepared.request.question, prepared.request.documents, {
      ...prepared.request.policy, confirmedPlanDigest: prepared.preview.planDigest, lease: fixture.lease, model: "fixture",
    });
    assert.equal(result.status, "complete");
    notebook = recordNotebookQuestion(notebook, prepared, result);
  } finally { await fixture.cleanup(); }
  return { notebook, questionId };
}

test("final saved page and note citations map to exact retained retrieval inputs with provenance", async () => {
  const { notebook, questionId } = await savedNotebook();
  // A later version is retained, but the answer remains bound to note version 1.
  const later = reviseResearchNotebook(notebook, { type: "edit-note", id: notebook.notes[0].id,
    title: "Revised citation note", text: "A different note version." });
  let unrelated = createResearchNotebook("UNRELATED NOTEBOOK SECRET");
  unrelated = reviseResearchNotebook(unrelated, { type: "add-note", title: "UNRELATED TITLE SECRET", text: "UNRELATED BODY SECRET" });
  const result = exportResearchAnswerCitationMap([later], [questionId]);
  const question = result.questions[0];
  assert.equal(question.status, "mapped");
  assert.equal(question.citations.length, 2);
  const pageCitation = question.citations.find((entry) => entry.kind === "document");
  assert.equal(pageCitation.record_id, later.sources[0].id);
  assert.equal(pageCitation.page, 1);
  assert.equal(pageCitation.version, null);
  assert.equal(pageCitation.title, "Answer source title");
  assert.equal(pageCitation.content_sha256, later.sources[0].document.pages[0].sha256);
  const noteCitation = question.citations.find((entry) => entry.kind === "note");
  assert.equal(noteCitation.record_id, later.notes[0].id);
  assert.equal(noteCitation.page, null);
  assert.equal(noteCitation.version, 1);
  assert.equal(noteCitation.title, "Citation note");
  assert.equal(noteCitation.content_sha256, notebook.notes[0].versions[0].sha256);
  assert.deepEqual(Object.keys(question.provenance).sort(), ["notebook_sha256", "question_scope_sha256", "result_sha256"]);
  assert.ok(question.citations.every((entry) => entry.provenance.source_sha256));
  assert.doesNotMatch(JSON.stringify(result), /UNRELATED/);
  assert.doesNotMatch(JSON.stringify(result), /Page citation exact|Note citation exact/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(unrelated.id));
});

test("changed or invalid retained citation state refuses rather than fabricating a mapping", async () => {
  const { notebook, questionId } = await savedNotebook();
  const damaged = structuredClone(notebook);
  damaged.questions[0].result.draft.evidence[0].quote = "changed citation";
  assert.throws(() => exportResearchAnswerCitationMap([damaged], [questionId]), /invalid_research_answer_citation_map|invalid_research_notebook|invalid_document_coverage/);
  assert.throws(() => exportResearchAnswerCitationMap([notebook], ["question:00000000-0000-4000-8000-000000000000"]), /question ID.*not retained/);
});
