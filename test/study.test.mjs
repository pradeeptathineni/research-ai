import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkResearchStudyOrigins, createResearchNotebook, createResearchStudy, exportResearchStudyPlanningSource, getResearchStudyCitation,
  createResearchStudyReportBasis, createReport, exportReportHtml, renderReport, reviseReport, validateReport,
  prepareResearchStudyQuestion, recordResearchStudyQuestion, renderResearchStudy, renderResearchNotebook, reviseResearchNotebook,
  reviseResearchStudy, researchDocumentCoverage, searchResearchNotebooks, validateResearchStudy,
  saveResearchStudyQuestionAsNotebookNote, validateResearchStudyPlanningSource,
} from "../src/index.mjs";
import { fakeCodex, message } from "./fake-codex.mjs";

const sha = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const rid = (prefix) => `${prefix}:${randomUUID()}`;
const page = (number, text) => ({ number, text, sha256: sha(text) });
const doc = (id, title, pages) => ({ id, title, sha256: sha(`caller supplied ${id}`), pages });
const reply = (value) => ({ events: [message(JSON.stringify(value)), { type: "turn.completed" }] });

function fixtureNotebooks() {
  let sources = createResearchNotebook("Source notebook");
  sources = reviseResearchNotebook(sources, { type: "add-source", document: doc("source-record", "Yield report", [
    page(1, "A preliminary page describes the apparatus."),
    page(2, "The retained report measured a yield of 17 units after cooling."),
  ]) });
  let notes = createResearchNotebook("Notes notebook");
  notes = reviseResearchNotebook(notes, { type: "add-note", title: "Scope memo", text: "This unverified note defines scope: compare the observed yield 😀 only." });
  return [sources, notes];
}

function selectedStudy(notebooks) {
  const [sourceNotebook, noteNotebook] = notebooks;
  const sourceSearch = searchResearchNotebooks(notebooks, "yield", { kinds: ["document"] });
  const sourceHit = sourceSearch.hits.find((hit) => hit.notebookId === sourceNotebook.id);
  const noteSearch = searchResearchNotebooks(notebooks, "unverified", { kinds: ["note"], noteVersions: "all" });
  const noteHit = noteSearch.hits.find((hit) => hit.notebookId === noteNotebook.id);
  assert.ok(sourceHit && noteHit);
  let study = createResearchStudy("Cross-notebook yield study");
  study = reviseResearchStudy(study, { type: "select-hit", notebooks, search: sourceSearch, hitId: sourceHit.id });
  study = reviseResearchStudy(study, { type: "select-hit", notebooks, search: noteSearch, hitId: noteHit.id });
  return { study, sourceHit, sourceSearch, noteHit, noteSearch };
}

test("two-notebook full-source and exact-note selection survives question, citation, and cold reopen", async () => {
  const notebooks = fixtureNotebooks();
  const { study: initial, sourceHit } = selectedStudy(notebooks);
  const spec = { id: rid("study-question"), question: "What yield did the retained report measure?", selectionIds: initial.selections.map((entry) => entry.id) };
  const prepared = prepareResearchStudyQuestion(initial, spec, { maxCalls: 2, passUtf16Units: 24000, maxSeconds: 60 });
  assert.deepEqual(prepared.request.documents.map((item) => item.pages.length), [2, 1], "a page search hit expands to its complete document by default");
  assert.deepEqual(prepareResearchStudyQuestion(initial, spec, { maxCalls: 2, passUtf16Units: 24000, maxSeconds: 60 }), prepared, "repeated preview has the same immutable selection and plan");
  assert.match(prepared.request.documents[1].title, /^Unverified note:/);
  assert.equal(prepared.preview.sources[0].page, sourceHit.page, "search page remains provenance anchor");
  assert.equal(prepared.preview.counts.documents, 2);

  const sourceQuote = "The retained report measured a yield of 17 units after cooling.";
  const noteQuote = "This unverified note defines scope: compare the observed yield 😀 only.";
  const sessions = [
    reply({ answer: [{ text: "The report states a measured yield.", evidenceIds: ["report"] }, { text: "The note defines the scope.", evidenceIds: ["scope"] }],
      evidence: [{ id: "report", windowId: "w0002", quote: sourceQuote, relation: "supporting", occurrence: null },
        { id: "scope", windowId: "w0003", quote: noteQuote, relation: "context", occurrence: null }], coverage: "partial", gaps: ["No independent replication was selected."] }),
    reply({ answer: [{ text: "The selected report measures 17 units; the selected note limits the comparison to the observed yield.", evidenceIds: ["p01-e01", "p01-e02"] }], coverage: "partial", gaps: ["No independent replication was selected."] }),
  ];
  const fixture = await fakeCodex({ sessions });
  let result;
  try {
    result = await researchDocumentCoverage(prepared.request.question, prepared.request.documents, {
      ...prepared.request.policy, confirmedPlanDigest: prepared.preview.planDigest, lease: fixture.lease, model: "fixture",
    });
    assert.equal(result.status, "complete", JSON.stringify(result));
    const reviewed = await fixture.session(0);
    assert.match(reviewed.prompt, /A preliminary page describes the apparatus/);
    assert.match(reviewed.prompt, /The retained report measured a yield/);
    assert.match(reviewed.prompt, /unverified note defines scope/);
  } finally { await fixture.cleanup(); }

  let study = recordResearchStudyQuestion(initial, prepared, result);
  assert.deepEqual(recordResearchStudyQuestion(study, prepared, result), study, "repeated identical result is idempotent");
  const reopened = validateResearchStudy(JSON.parse(renderResearchStudy(study, { format: "json" })));
  assert.deepEqual(reopened, study);
  const reportBasis = createResearchStudyReportBasis(reopened, spec.id);
  assert.equal(reportBasis.origin.type, "caller-authored");
  assert.equal(reportBasis.sections.reduce((count, section) => count + section.points.length, 0), 1);
  assert.equal(reportBasis.sections[0].points[0].text, result.draft.answer[0].text);
  assert.equal(reportBasis.sources.length, 2);
  assert.ok(reportBasis.sources.every((source) => source.uri.startsWith("research-notebook://source/") && source.retainedOrigin?.studyId === reopened.id));
  assert.equal(reportBasis.sections[0].points[0].citations[1].quote, noteQuote);
  assert.deepEqual(reportBasis.sources.map((source) => source.retainedOrigin.kind), ["document", "note"]);
  const originalReport = createReport(reportBasis);
  const editableReport = reviseReport(originalReport, {
    sectionId: originalReport.sections[0].id,
    paragraphs: [{ text: "Human-edited report sentence from the retained answer.", citations: originalReport.basis.sections[0].points[0].citations }],
  });
  const coldReport = validateReport(JSON.parse(renderReport(editableReport, { format: "json" })));
  assert.match(renderReport(coldReport), /Human-edited report sentence/);
  assert.match(exportReportHtml(coldReport), /research-notebook:\/\/source/);
  assert.match(renderReport(coldReport), /frozen Research Study/);
  const reportCli = fileURLToPath(new URL("../bin/research-study-report.mjs", import.meta.url));
  const cliReport = spawnSync(process.execPath, [reportCli, "--action", "create"], {
    input: JSON.stringify({ study: reopened, questionId: spec.id }), encoding: "utf8", timeout: 30000,
  });
  assert.equal(cliReport.status, 0, cliReport.stderr);
  assert.deepEqual(validateReport(JSON.parse(cliReport.stdout)), originalReport);
  const alteredReportOrigin = structuredClone(coldReport);
  alteredReportOrigin.basis.sources[0].retainedOrigin.notebookSha256 = sha("different notebook");
  alteredReportOrigin.basisSha256 = sha(JSON.stringify(alteredReportOrigin.basis));
  assert.throws(() => validateReport(alteredReportOrigin), /invalid retained Study source identity/);
  const changedSpan = structuredClone(coldReport);
  changedSpan.basis.sections[0].points[0].citations[0].quote = "a different quote";
  changedSpan.basisSha256 = sha(JSON.stringify(changedSpan.basis));
  assert.throws(() => validateReport(changedSpan), /citation span mismatch/);
  const planningSource = exportResearchStudyPlanningSource(reopened, spec.id);
  assert.match(planningSource.id, /^research-study-[a-f0-9]{48}$/);
  assert.ok(planningSource.text.length <= 16000);
  assert.ok(new TextEncoder().encode(JSON.stringify(planningSource.binding)).byteLength <= 16 * 1024);
  assert.ok(new TextEncoder().encode(JSON.stringify(planningSource.qualification)).byteLength <= 16 * 1024);
  assert.equal(planningSource.binding.owner, "research-study");
  assert.equal(planningSource.binding.studyId, reopened.id);
  assert.equal(planningSource.binding.questionId, spec.id);
  assert.equal(planningSource.binding.questionSha256, reopened.questions[0].sha256);
  assert.equal(planningSource.qualification.coverage, "partial");
  assert.deepEqual(planningSource.qualification.gaps, ["No independent replication was selected."]);
  assert.match(planningSource.text, /No independent replication was selected/);
  assert.equal(planningSource.binding.citations.length, 2);
  assert.ok(planningSource.binding.sourceSnapshots.some((entry) => entry.kind === "document" && entry.documentId === "source-record"));
  assert.ok(planningSource.binding.sourceSnapshots.some((entry) => entry.kind === "note" && entry.recordId === notebooks[1].notes[0].id && entry.version === 1), JSON.stringify(planningSource.binding.sourceSnapshots));
  assert.match(planningSource.text, /answer|report/i);
  assert.match(planningSource.text, /Citations identify exact retained occurrences/);
  assert.doesNotMatch(planningSource.text, /This unverified note defines scope/);
  assert.deepEqual(validateResearchStudyPlanningSource(reopened, spec.id, planningSource), planningSource);
  const planningRoot = process.env.RESEARCH_PLANNING_ROOT;
  if (planningRoot) {
    const planningRevision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: planningRoot, encoding: "utf8" });
    assert.equal(planningRevision.status, 0, planningRevision.stderr);
    assert.equal(planningRevision.stdout.trim(), "1c97ac2c2cd123e9e1ce2e490e56acc6a39536ba");
    const python = process.env.RESEARCH_PLANNING_PYTHON;
    assert.ok(python, "set RESEARCH_PLANNING_PYTHON to the accepted Planning Python runtime");
    const planningCreate = spawnSync(python, ["-m", "planning_ai.specification", "--action", "create"], {
      cwd: planningRoot,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONPATH: join(planningRoot, "src"), PYTHONDONTWRITEBYTECODE: "1" },
      input: JSON.stringify({ title: "Synthetic Research source intake", problem: "Preserve exact study evidence as qualified planning input.", sources: [planningSource] }),
      encoding: "utf8", timeout: 30000,
    });
    assert.equal(planningCreate.status, 0, planningCreate.stderr);
    const createdPlanning = JSON.parse(planningCreate.stdout);
    assert.equal(createdPlanning.schema, "planning.specification.v1");
    assert.deepEqual(createdPlanning.sources, [planningSource]);
  }
  const studyCli = fileURLToPath(new URL("../bin/research-study.mjs", import.meta.url));
  const cliExport = spawnSync(process.execPath, [studyCli, "--action", "planning-source"], {
    input: JSON.stringify({ study: reopened, questionId: spec.id }), encoding: "utf8", timeout: 30000,
  });
  assert.equal(cliExport.status, 0, cliExport.stderr);
  assert.deepEqual(JSON.parse(cliExport.stdout), planningSource);
  const cliValidation = spawnSync(process.execPath, [studyCli, "--action", "validate-planning-source"], {
    input: JSON.stringify({ study: reopened, questionId: spec.id, source: planningSource }), encoding: "utf8", timeout: 30000,
  });
  assert.equal(cliValidation.status, 0, cliValidation.stderr);
  assert.deepEqual(JSON.parse(cliValidation.stdout), planningSource);
  const extendedNotebook = reviseResearchNotebook(createResearchNotebook("Unrelated private notebook"), {
    type: "add-source", document: doc("unrelated-secret", "Unrelated private title", [page(1, "Unrelated private body must not leak.")]),
  });
  const unrelatedSearch = searchResearchNotebooks([extendedNotebook], "unrelated", { kinds: ["document"] });
  const extendedStudy = reviseResearchStudy(reopened, { type: "select-hit", notebooks: [extendedNotebook], search: unrelatedSearch, hitId: unrelatedSearch.hits[0].id });
  const afterUnrelatedSelection = exportResearchStudyPlanningSource(extendedStudy, spec.id);
  assert.equal(afterUnrelatedSelection.id, planningSource.id, "the immutable question/result locator is independent of later unrelated study revisions");
  assert.deepEqual(afterUnrelatedSelection, planningSource);
  assert.throws(() => validateResearchStudyPlanningSource(reopened, spec.id, { ...planningSource, text: `${planningSource.text} altered` }), /does not match/);
  const changedQuote = structuredClone(planningSource);
  changedQuote.binding.citations[0].quote += " altered";
  assert.throws(() => validateResearchStudyPlanningSource(reopened, spec.id, changedQuote), /does not match/);
  assert.throws(() => validateResearchStudyPlanningSource(extendedStudy, spec.id, { ...planningSource, binding: { ...planningSource.binding, sourceSnapshots: [] } }), /does not match/);
  const citation = getResearchStudyCitation(reopened, spec.id, "p01-e02");
  assert.equal(citation.source.kind, "note");
  assert.match(citation.selection.document.title, /^Unverified note:/);
  assert.equal(citation.source.noteVersion.text, noteQuote);
  assert.equal(citation.page.text, noteQuote);

  const destination = createResearchNotebook("Answer notebook");
  const saved = saveResearchStudyQuestionAsNotebookNote(reopened, destination, spec.id);
  const savedVersion = saved.notes[0].versions[0];
  assert.equal(savedVersion.origin.kind, "study");
  assert.equal(savedVersion.origin.studyId, reopened.id);
  assert.equal(savedVersion.origin.questionId, spec.id);
  assert.equal(savedVersion.origin.studySha256, reopened.sha256);
  assert.match(savedVersion.text, /Coverage reported: partial/);
  assert.match(savedVersion.text, /No independent replication was selected/);
  assert.match(savedVersion.text, /unverified note: Scope memo/);
  assert.deepEqual(JSON.parse(renderResearchNotebook(saved)).notes[0].versions[0], savedVersion);
  assert.deepEqual(getResearchStudyCitation(reopened, spec.id, "p01-e02"), citation, "study citation remains reopenable after note projection");
  const edited = reviseResearchNotebook(saved, { type: "edit-note", id: saved.notes[0].id, title: "Edited", text: "A later editorial revision." });
  assert.deepEqual(edited.notes[0].versions[0].origin, savedVersion.origin);
  assert.deepEqual(edited.notes[0].versions[1].origin, savedVersion.origin, "later versions cannot retarget provenance");

  const changedOrigin = reviseResearchNotebook(notebooks[1], { type: "edit-note", id: notebooks[1].notes[0].id,
    title: "Scope memo revised", text: "Changed unrelated current origin version." });
  assert.deepEqual(validateResearchStudy(JSON.parse(JSON.stringify(study))), study, "historical study remains cold-openable from embedded versions");
  assert.equal(getResearchStudyCitation(study, spec.id, "p01-e02").source.noteVersion.version, 1);
  const report = checkResearchStudyOrigins(study, [notebooks[0], changedOrigin]);
  assert.equal(report[1].status, "changed");
  assert.equal(report[1].detail, "notebook_changed_selected_version_matches");
  assert.equal(checkResearchStudyOrigins(study, [notebooks[0]])[1].status, "missing");
  assert.match(renderResearchStudy(study, { format: "markdown" }), /Unverified note/);
});

test("a frozen retrieval result selects a freshly validated native hit with separate retrieval provenance", () => {
  const [notebook] = fixtureNotebooks();
  const search = searchResearchNotebooks([notebook], "yield", { kinds: ["document"] });
  const hit = search.hits.find((item) => item.kind === "document");
  assert.ok(hit);
  const selectedPage = notebook.sources[0].document.pages.find((item) => item.number === hit.page);
  const armDigests = {
    "research-lexical-exact": sha("exact-arm"),
    "research-lexical-prefix": sha("prefix-arm"),
    "research-lexical-fuzzy": sha("fuzzy-arm"),
  };
  const retrieval = {
    format: "research-retrieval-selection-1",
    previewId: randomUUID(),
    comparisonId: randomUUID(),
    corpusDigest: sha("same-frozen-corpus"),
    questionId: "saved-question-1",
    sourceId: hit.id,
    sourceSha256: hit.sourceDigest,
    sourceSha256: hit.sourceDigest,
    selectedContentSha256: selectedPage.sha256,
    passageStart: 0,
    passageEnd: selectedPage.text.length,
    armDigests,
  };
  const study = reviseResearchStudy(createResearchStudy("Retrieval continuation"), {
    type: "select-retrieval-hit", notebooks: [notebook], search, hitId: hit.id, retrieval,
  });
  const reopened = validateResearchStudy(JSON.parse(JSON.stringify(study)));
  assert.equal(reopened.selections[0].origin.hitId, hit.id);
  assert.equal(reopened.selections[0].origin.searchInputDigest, search.inputDigest);
  assert.deepEqual(reopened.selections[0].origin.retrieval, retrieval);
  assert.equal(checkResearchStudyOrigins(reopened, [notebook])[0].status, "current");
  assert.throws(() => reviseResearchStudy(createResearchStudy("Changed source"), {
    type: "select-retrieval-hit", notebooks: [notebook], search, hitId: hit.id,
    retrieval: { ...retrieval, selectedContentSha256: sha("wrong passage") },
  }), /retrieval passage/);
  assert.throws(() => reviseResearchStudy(createResearchStudy("Wrong span"), {
    type: "select-retrieval-hit", notebooks: [notebook], search, hitId: hit.id,
    retrieval: { ...retrieval, passageEnd: selectedPage.text.length - 1 },
  }), /retrieval passage/);
});

test("selection refuses stale hits; changed/missing origins and tampered snapshots are explicit", () => {
  const notebooks = fixtureNotebooks();
  const { study, noteSearch, noteHit } = selectedStudy(notebooks);
  const changed = reviseResearchNotebook(notebooks[1], { type: "edit-note", id: notebooks[1].notes[0].id,
    title: "Scope memo", text: "The changed note is still unverified." });
  assert.throws(() => reviseResearchStudy(study, { type: "select-hit", notebooks: [notebooks[0], changed], search: noteSearch, hitId: noteHit.id }), /stale|replay/);
  assert.equal(checkResearchStudyOrigins(study, [notebooks[0], changed])[1].status, "changed");
  assert.equal(checkResearchStudyOrigins(study, [notebooks[0]])[1].status, "missing");
  assert.throws(() => checkResearchStudyOrigins(study, [notebooks[0], notebooks[0]]), /IDs must be unique/);
  const tampered = structuredClone(study);
  tampered.selections[0].document.pages[0].text += " changed";
  assert.throws(() => validateResearchStudy(tampered), /digest|invalid/);
  const duplicateDocIds = fixtureNotebooks();
  duplicateDocIds[1] = reviseResearchNotebook(duplicateDocIds[1], { type: "add-source", document: doc("source-record", "Other source", [page(1, "yield")]) });
  const firstSearch = searchResearchNotebooks(duplicateDocIds, "yield", { kinds: ["document"] });
  const firstHit = firstSearch.hits.find((hit) => hit.notebookId === duplicateDocIds[0].id);
  const secondHit = firstSearch.hits.find((hit) => hit.notebookId === duplicateDocIds[1].id);
  let duplicates = createResearchStudy("Duplicate document selection");
  duplicates = reviseResearchStudy(duplicates, { type: "select-hit", notebooks: duplicateDocIds, search: firstSearch, hitId: firstHit.id });
  duplicates = reviseResearchStudy(duplicates, { type: "select-hit", notebooks: duplicateDocIds, search: firstSearch, hitId: secondHit.id });
  assert.throws(() => prepareResearchStudyQuestion(duplicates, { id: rid("study-question"), question: "Compare", selectionIds: duplicates.selections.map((entry) => entry.id) }), /duplicate document IDs/);
});

test("prepared questions bind the exact study commitment and reject mutation", () => {
  const notebooks = fixtureNotebooks();
  const { study } = selectedStudy(notebooks);
  const prepared = prepareResearchStudyQuestion(study, { id: rid("study-question"), question: "Yield?", selectionIds: [study.selections[0].id] });
  const changedStudy = reviseResearchStudy(study, { type: "deselect-hit", selectionId: study.selections[1].id });
  assert.notEqual(changedStudy.sha256, prepared.studySha256);
  assert.throws(() => recordResearchStudyQuestion(changedStudy, prepared, {}), /commitment/);
});

test("offline CLI creates, selects, and cold-validates explicit study JSON", () => {
  const bin = fileURLToPath(new URL("../bin/research-study.mjs", import.meta.url));
  const run = (action, request) => {
    const result = spawnSync(process.execPath, [bin, "--action", action], { input: JSON.stringify(request), encoding: "utf8", timeout: 30000, env: process.env });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const [source, note] = fixtureNotebooks();
  const notebooks = [source, note];
  const search = searchResearchNotebooks(notebooks, "yield", { kinds: ["document"] });
  let study = run("create", { title: "CLI study" });
  study = run("select", { study, notebooks, search, hitId: search.hits[0].id });
  assert.deepEqual(run("validate", { study }), study);
});
