import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createResearchNotebook, reviseResearchNotebook, prepareNotebookQuestion,
  researchDocumentCoverage, recordNotebookQuestion, getNotebookCitation,
  saveNotebookQuestionAsNote, validateResearchNotebook, renderResearchNotebook, prepareDocumentCoverage } from "../src/index.mjs";
import { fakeCodex, message } from "./fake-codex.mjs";

const sha = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const id = (prefix) => `${prefix}:${randomUUID()}`;
const page = (number, text) => ({ number, text, sha256: sha(text) });
const doc = (documentId, pages) => ({ id: documentId, title: `Synthetic ${documentId}`, sha256: sha(`caller assertion ${documentId}`), pages });
const reply = (value) => ({ events: [message(JSON.stringify(value)), { type: "turn.completed" }] });

function starter() {
  const report = doc("cell-report", [
    page(1, "The retained test cell delivered 1,200 cycles at 80% capacity."),
    page(2, "A separate test stopped at 900 cycles."),
    page(3, "The report does not identify field performance."),
  ]);
  const counter = doc("counter-report", [page(1, "A synthetic counterexample reports 600 cycles.")]);
  let notebook = createResearchNotebook("Battery evidence", { topic: "Cycle life" });
  notebook = reviseResearchNotebook(notebook, { type: "add-source", document: report });
  notebook = reviseResearchNotebook(notebook, { type: "add-source", document: counter });
  notebook = reviseResearchNotebook(notebook, { type: "add-note", title: "Scope", text: "Compare only supplied test reports." });
  return notebook;
}

function fakeCoverage(prepared, fixture) {
  const plan = prepared.request;
  const coveragePlan = prepareDocumentCoverage(prepared.request.question, prepared.request.documents, prepared.request.policy);
  const selectedWindows = prepared.request.documents.map((document) => coveragePlan.windows.find((window) => window.documentId === document.id));
  const quoteRows = [];
  const answerRows = [];
  for (const selected of selectedWindows) {
    const document = plan.documents.find((item) => item.id === selected.documentId);
    const quote = document.id === "cell-report" ? "1,200 cycles" : document.title.startsWith("Unverified note:") ? "Compare only supplied test reports." : null;
    if (!quote) continue;
    const evidenceId = document.id === "cell-report" ? "report" : "scope-note";
    quoteRows.push({ id: evidenceId, windowId: selected.id, quote, relation: "supporting", occurrence: null });
    answerRows.push({ text: `The selected material states ${quote}.`, evidenceIds: [evidenceId] });
  }
  const coverage = {
    answer: answerRows,
    evidence: quoteRows,
    coverage: "partial",
    gaps: ["The retained pages do not establish field performance."],
  };
  const passId = "p01";
  const syntheticIds = quoteRows.map((_, index) => `${passId}-e${String(index + 1).padStart(2, "0")}`);
  const synthesis = {
    answer: [{ text: "The report states 1,200 cycles; the selected note defines scope.", evidenceIds: syntheticIds }],
    coverage: "partial",
    gaps: ["The pages do not establish field performance."],
  };
  return { sessions: [reply(coverage), reply(synthesis)], passId, quoteRows };
}

test("complete notebook journey retains selected source and old note citation through edit, save and reopen", async () => {
  let notebook = starter();
  const scopeNote = notebook.notes[0];
  const prepared = prepareNotebookQuestion(notebook, {
    id: id("question"), question: "What cycle life did the supplied test report?",
    sourceIds: [notebook.sources[0].id], notes: [{ id: scopeNote.id, version: 1 }],
  }, { maxCalls: 4, passUtf16Units: 24000, maxSeconds: 60 });
  assert.equal(prepared.request.documents[0].id, "cell-report");
  assert.match(prepared.request.documents[1].id, /^notebook-note-[a-f0-9]{48}$/);
  assert.equal(prepared.request.documents[0].pages.length, 3);
  assert.match(prepared.request.documents[1].title, /^Unverified note:/);
  assert.equal(prepared.preview.counts.pages, 4);
  assert.equal(prepared.preview.sources.length, 2);
  assert.equal(prepared.request.documents.some((entry) => entry.id === "counter-report"), false);

  const fake = fakeCoverage(prepared);
  const fixture = await fakeCodex({ sessions: fake.sessions });
  let result;
  try {
    result = await researchDocumentCoverage(prepared.request.question, prepared.request.documents, {
      ...prepared.request.policy, confirmedPlanDigest: prepared.preview.planDigest,
      lease: fixture.lease, model: "fixture",
    });
    assert.equal(result.status, "complete", JSON.stringify({ passes: result.passes, synthesis: result.synthesis }));
    assert.equal(await fixture.launched(), true);
    const pass = await fixture.session(0);
    assert.match(pass.prompt, /The retained test cell delivered 1,200 cycles/);
    assert.match(pass.prompt, /Compare only supplied test reports/);
    assert.doesNotMatch(pass.prompt, /synthetic counterexample/i);
  } finally { await fixture.cleanup(); }

  const oversized = structuredClone(result);
  const evidenceIds = oversized.draft.evidence.map((entry) => entry.id);
  oversized.draft.answer = Array.from({ length: 17 }, (_, index) => ({
    text: "x".repeat(1200), evidenceIds: index === 0 ? evidenceIds : [evidenceIds[0]],
  }));
  oversized.draft.coverage = "partial";
  oversized.receipt.contentSha256 = sha(canonical({ ...oversized,
    receipt: { ...oversized.receipt, contentSha256: undefined } }));
  const oversizedAttached = recordNotebookQuestion(notebook, prepared, oversized);
  assert.throws(() => saveNotebookQuestionAsNote(oversizedAttached, prepared.spec.id), /exceeds the 20,000/);
  assert.equal(notebook.questions.length, 0, "refused answer attachment leaves original state unchanged");

  // A newer user edit made while the prepared native request was running survives attachment.
  const extra = reviseResearchNotebook(notebook, { type: "add-note", title: "Later note", text: "Keep the raw pages available." });
  notebook = recordNotebookQuestion(extra, prepared, result);
  assert.equal(notebook.notes.length, 2);
  assert.equal(notebook.questions.length, 1);
  const noteCitationId = notebook.questions[0].result.draft.evidence.find((entry) => entry.documentId.startsWith("notebook-note-"))?.id;
  const documentCitationId = notebook.questions[0].result.draft.evidence.find((entry) => entry.documentId === "cell-report")?.id;
  assert.ok(noteCitationId && documentCitationId);
  assert.equal(getNotebookCitation(notebook, prepared.spec.id, documentCitationId).page.text,
    "The retained test cell delivered 1,200 cycles at 80% capacity.");
  const oldCitation = getNotebookCitation(notebook, prepared.spec.id, noteCitationId);
  assert.equal(oldCitation.source.version.text, "Compare only supplied test reports.");

  notebook = saveNotebookQuestionAsNote(notebook, prepared.spec.id, { title: "Retained answer" });
  const generated = notebook.notes.at(-1);
  assert.equal(generated.versions[0].origin.kind, "question");
  assert.equal(generated.versions[0].origin.questionId, prepared.spec.id);
  notebook = reviseResearchNotebook(notebook, { type: "edit-note", id: scopeNote.id, title: "Scope revised", text: "Compare only the original reports." });
  assert.equal(getNotebookCitation(notebook, prepared.spec.id, noteCitationId).source.version.text,
    "Compare only supplied test reports.");
  assert.deepEqual(recordNotebookQuestion(notebook, prepared, result), notebook, "same retained result is idempotent");
  const future = prepareNotebookQuestion(notebook, {
    id: id("question"), question: "What did the saved answer say?", sourceIds: [],
    notes: [{ id: generated.id, version: 1 }],
  });
  assert.equal(future.request.documents.length, 1);
  assert.throws(() => prepareNotebookQuestion(notebook, {
    id: prepared.spec.id, question: "Self citation", sourceIds: [], notes: [{ id: generated.id, version: 1 }],
  }), /cite a note saved from itself/);
  notebook = reviseResearchNotebook(notebook, { type: "edit-note", id: generated.id, title: "Answer revised", text: "A human revised this prior synthesis." });
  assert.equal(validateResearchNotebook(notebook).notes.at(-1).versions[1].origin.questionId, prepared.spec.id);
  assert.equal(getNotebookCitation(notebook, prepared.spec.id, noteCitationId).source.version.text,
    "Compare only supplied test reports.");
  assert.throws(() => prepareNotebookQuestion(notebook, {
    id: id("question"), question: "Missing version", sourceIds: [], notes: [{ id: scopeNote.id, version: 3 }],
  }), /version is not retained/);
  assert.throws(() => prepareNotebookQuestion(notebook, {
    id: id("question"), question: "No scope", sourceIds: [], notes: [],
  }), /explicitly select/);
  const reopened = validateResearchNotebook(JSON.parse(renderResearchNotebook(notebook, { format: "json" })));
  assert.deepEqual(reopened, notebook);
  const markdown = renderResearchNotebook(notebook, { format: "markdown" });
  assert.match(markdown, /Unverified answer note:/);
  assert.match(markdown, /The pages do not establish field performance/);
  assert.doesNotMatch(markdown, /<script>/i);
});

test("whole-state and scope tampering refuse without mutating retained input", () => {
  const notebook = starter();
  const spec = { id: id("question"), question: "How many cycles?", sourceIds: [notebook.sources[0].id], notes: [] };
  const prepared = prepareNotebookQuestion(notebook, spec);
  assert.throws(() => prepareNotebookQuestion(notebook, { ...spec, sourceIds: [] }), /explicitly select/);
  assert.throws(() => reviseResearchNotebook(notebook, { type: "add-source", extra: true, document: notebook.sources[0].document }), /unknown revision/);
  const modified = structuredClone(notebook);
  modified.sources[0].document.pages[0].text += "!";
  assert.throws(() => validateResearchNotebook(modified), /page digest mismatch|source record digest mismatch/);
  const forged = structuredClone(notebook);
  forged.notes[0].versions[0].sha256 = "0".repeat(64);
  forged.sha256 = "0".repeat(64);
  assert.throws(() => validateResearchNotebook(forged), /note version digest mismatch/);
  assert.equal(notebook.questions.length, 0);
  assert.equal(prepared.spec.id, spec.id);
});

test("Shoulda selected-source origin is additive, exact-page bound and cold-reopen validated", () => {
  const content = "# Retained selected file\n\nExact synthetic bytes.\n";
  const document = doc("shoulda-sfs_0123456789abcdef01234567", [page(1, content)]);
  const origin = {
    schemaVersion: 1,
    kind: "shoulda-source-selection",
    sourceSelectionId: "sfs_0123456789abcdef01234567",
    selectionReceiptSha256: sha("exact synthetic Shoulda receipt"),
    repository: "example/synthetic-repo",
    sourceId: "fixture",
    headCommit: "1".repeat(40),
    snapshotFingerprint: `srcsnap_${"2".repeat(64)}`,
    sourceInspectionId: "sdi_0123456789abcdef01234567",
    sourceAssessmentId: "sda_0123456789abcdef01234567",
    decisionId: "dec_0123456789abcdef",
    files: [{ page: 1, path: "README.md", role: "implementation overview", sha256: sha(content), byteCount: Buffer.byteLength(content) }],
    nearbyDocuments: [{ path: "NOTICE", kind: "notice", sha256: sha("Synthetic notice."), truncated: false, state: "observed" }],
    qualificationBasis: "caller-authored-only",
    legalCompatibility: "not-assessed",
  };
  const documentId = document.id;
  let notebook = createResearchNotebook("Selected repository evidence");
  notebook = reviseResearchNotebook(notebook, { type: "add-shoulda-source", document, origin });
  assert.equal(notebook.sources[0].document.id, documentId);
  assert.equal(notebook.sources[0].shouldaOrigin.sourceSelectionId, origin.sourceSelectionId);
  assert.equal(notebook.sources[0].shouldaOrigin.repository, origin.repository);
  assert.equal(notebook.sources[0].shouldaOrigin.legalCompatibility, "not-assessed");
  assert.deepEqual(validateResearchNotebook(JSON.parse(renderResearchNotebook(notebook))), notebook);

  const tampered = structuredClone(notebook);
  tampered.sources[0].shouldaOrigin.files[0].sha256 = sha("different bytes");
  tampered.sha256 = sha(canonical(Object.fromEntries(Object.entries(tampered).filter(([key]) => key !== "sha256"))));
  assert.throws(() => validateResearchNotebook(tampered), /Shoulda source file identity/);
  assert.throws(() => reviseResearchNotebook(notebook, { type: "add-shoulda-source",
    document: doc("second-shoulda-selection", [page(1, content)]),
    origin: { ...origin, legalCompatibility: "compatible" } }), /qualification/);
  assert.equal(validateResearchNotebook(starter()).sources[0].shouldaOrigin, undefined, "older source records remain compatible");
});

test("Briefing notebook sources retain exact item/source refs and only the owner excerpt", () => {
  const excerpt = "Synthetic retained Briefing excerpt, observed from its source.";
  const itemReference = { owner: "signals-ai", kind: "briefing-item", id: "item:rd02", revision: `sha256:${sha("item record")}` };
  const sourceReference = { owner: "signals-ai", kind: "briefing-source", id: "source:rd02", revision: `sha256:${sha("source record")}` };
  const origin = {
    schemaVersion: 1, kind: "signals-briefing-item", itemReference, sourceReference,
    contentDigest: sha("original captured content"), excerptSha256: sha(excerpt),
    observedAt: "2026-10-28T10:00:00.000Z",
    sourceHealth: { status: "unknown", lastGoodAt: null, lastAttemptAt: null, lastAttemptStatus: null,
      lastSuccessfulLinkCount: null, failureClass: null, expectedIntervalSec: null },
  };
  const document = { id: `briefing-item-${sha(canonical([itemReference, sourceReference]))}`, title: "Synthetic Briefing item",
    sha256: sha("caller asserted document header"), pages: [page(1, excerpt)] };
  const notebook = reviseResearchNotebook(createResearchNotebook("Briefing handoff"), {
    type: "add-briefing-source", document, origin,
  });
  const reopened = validateResearchNotebook(JSON.parse(renderResearchNotebook(notebook)));
  assert.deepEqual(reopened, notebook);
  assert.equal(reopened.sources[0].briefingOrigin.itemReference.revision, itemReference.revision);
  assert.equal(reopened.sources[0].briefingOrigin.sourceReference.revision, sourceReference.revision);
  assert.equal(reopened.sources[0].document.pages[0].text, excerpt);
  assert.notEqual(reopened.sources[0].document.pages[0].text, "original captured content");

  const changed = structuredClone(notebook);
  changed.sources[0].briefingOrigin.excerptSha256 = sha("different excerpt");
  changed.sha256 = sha(canonical(Object.fromEntries(Object.entries(changed).filter(([key]) => key !== "sha256"))));
  assert.throws(() => validateResearchNotebook(changed), /Briefing item excerpt/);
  assert.equal(validateResearchNotebook(starter()).sources[0].briefingOrigin, undefined,
    "legacy notebooks without a Briefing origin remain compatible");
});

test("default empty topic reopens and a large source stays available for reading and explicit planning", () => {
  let notebook = createResearchNotebook("Untitled notes");
  assert.equal(notebook.topic, "");
  assert.deepEqual(validateResearchNotebook(notebook), notebook);
  notebook = reviseResearchNotebook(notebook, { type: "rename", title: "Battery notebook" });
  assert.equal(notebook.topic, "");
  assert.deepEqual(validateResearchNotebook(JSON.parse(renderResearchNotebook(notebook, { format: "json" }))), notebook);

  const largeText = "Synthetic complete retained text. ".repeat(9000);
  const large = doc("large-source", [page(1, largeText)]);
  notebook = reviseResearchNotebook(notebook, { type: "add-source", document: large });
  assert.equal(notebook.sources[0].document.pages[0].text.length, largeText.length);
  const preview = prepareNotebookQuestion(notebook, {
    id: id("question"), question: "What does the supplied large source say?",
    sourceIds: [notebook.sources[0].id], notes: [],
  }, { maxCalls: 64, passUtf16Units: 48000 });
  assert.equal(preview.request.documents[0].pages[0].text.length, largeText.length);
  assert.ok(preview.preview.counts.maximumCalls <= 64);
});

test("standalone CLI creates, previews, asks once, cites, saves and reopens in fresh processes", async () => {
  const pageText = "The synthetic battery retained 1,200 cycles.";
  const document = doc("cli-report", [page(1, pageText)]);
  const question = "What cycle count is stated?";
  const evidence = "1,200 cycles";
  const fixture = await fakeCodex({ sessions: [
    reply({ answer: [{ text: "The report states 1,200 cycles.", evidenceIds: ["count"] }],
      evidence: [{ id: "count", windowId: "w0001", quote: evidence, relation: "supporting", occurrence: null }],
      coverage: "answered", gaps: [] }),
    reply({ answer: [{ text: "The synthetic report states 1,200 cycles.", evidenceIds: ["p01-e01"] }], coverage: "answered", gaps: [] }),
  ] });
  const cli = fileURLToPath(new URL("../bin/research-notebook.mjs", import.meta.url));
  const call = (action, input) => {
    const result = spawnSync(process.execPath, [cli, "--action", action], {
      input: input === undefined ? undefined : JSON.stringify(input), encoding: "utf8", timeout: 30000, env: process.env,
    });
    assert.equal(result.status, 0, `${action}: ${result.stderr}${result.stdout}`);
    return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  };
  try {
    let notebook = call("create", { title: "CLI battery", topic: "Synthetic" });
    notebook = call("revise", { notebook, edit: { type: "add-source", document } });
    notebook = call("revise", { notebook, edit: { type: "add-note", title: "Scope", text: "Use this page only." } });
    const spec = { id: id("question"), question, sourceIds: [notebook.sources[0].id], notes: [{ id: notebook.notes[0].id, version: 1 }] };
    const preview = call("preview", { notebook, spec });
    assert.equal(preview.request.documents[0].id, "cli-report");
    assert.match(preview.request.documents[1].id, /^notebook-note-/);
    const asked = call("ask", { notebook, spec, confirmNotebookDigest: preview.notebookDigest,
      confirmScopeDigest: preview.scopeDigest, confirmPlanDigest: preview.preview.planDigest,
      profile: "quick", model: "fixture", lease: fixture.lease });
    assert.equal(asked.status, "complete");
    assert.equal(asked.notebook.questions.length, 1);
    assert.equal((await fixture.probes()).filter((args) => args[0] === "exec" && args[1] !== "--help").length, 2);
    const evidenceId = asked.notebook.questions[0].result.draft.evidence[0].id;
    const citation = call("citation", { notebook: asked.notebook, questionId: spec.id, evidenceId });
    assert.equal(citation.page.text, pageText);
    const saved = call("save-note", { notebook: asked.notebook, questionId: spec.id, title: "Answer" });
    const reopened = call("render", { notebook: saved, format: "json" });
    assert.deepEqual(reopened, saved);
    const renderedMarkdown = spawnSync(process.execPath, [cli, "--action", "render"], {
      input: JSON.stringify({ notebook: reopened, format: "markdown" }), encoding: "utf8", timeout: 30000, env: process.env,
    });
    assert.equal(renderedMarkdown.status, 0, renderedMarkdown.stderr);
    assert.equal(renderedMarkdown.stdout.match(/The synthetic report states 1,200 cycles/g)?.length, 2);
    assert.equal((await fixture.probes()).filter((args) => args[0] === "exec" && args[1] !== "--help").length, 2, "reopening performs no native calls");
  } finally { await fixture.cleanup(); }
});
