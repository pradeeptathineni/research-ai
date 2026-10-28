import { test } from "node:test";
import { fakeCodex, message } from "./fake-codex.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { addLiteraturePaper, createLiteratureSet, createResearchNotebook, reviseResearchNotebook,
  deduplicateLiteraturePapers, exportLiteratureSet, exportLiteratureStudyPlanningSource, validateLiteratureStudyPlanningSource,
  formatLiteratureSet, prepareLiteratureQuestion, prepareNotebookQuestion,
  resolveLiteratureSet, rebindLiteratureSet, prepareLiteratureStudyQuestion, validateLiteratureStudyQuestion,
  checkLiteratureStudyQuestionSources, projectLiteratureStudyEvidence, researchDocumentCoverage, prepareDocumentCoverage } from "../src/index.mjs";

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const id = (p) => `${p}:${randomUUID()}`;
const pageText = "Randomized trial reports intervention reduced endpoint by 12 percent.";
const doc = { id: "paper-doc-1", title: "Trial article", sha256: sha("caller document digest"), pages: [{ number: 1, text: pageText, sha256: sha(pageText) }] };
let notebook = createResearchNotebook("Frozen papers", { topic: "Endpoint evidence" });
notebook = reviseResearchNotebook(notebook, { type: "add-source", document: doc });
const retained = notebook.sources[0];
const source = { notebookId: notebook.id, notebookSha256: notebook.sha256, sourceId: retained.id,
  sourceDigest: retained.digest, documentId: retained.document.id, documentSha256: retained.document.sha256 };
const paper = (title, extra = {}) => ({ id: id("paper"), metadata: { title, authors: ["A. Researcher"], year: 2024, doi: "10.1234/example" },
  availability: "available", source, statusEvidence: null, finding: "Caller notes the trial reports a reduction.", stance: "supports", claimKey: "endpoint-reduction", qualification: [], ...extra });

test("literature sets retain exact source pointers, conservative dedupe, qualifications and disagreement through cold export", () => {
  const a = paper("Intervention effects on endpoint outcomes");
  const near = paper("Intervention effects on endpoint outcome", { metadata: { title: "Intervention effects on endpoint outcome", authors: ["A. Researcher"], year: 2024 } , stance: "opposes", finding: "Caller notes the paper reports no reduction." });
  const missing = { id: id("paper"), metadata: { title: "Unavailable follow-up", authors: ["B. Author"], year: 2025 }, availability: "missing", source: null, statusEvidence: { kind: "missing-source", assertedBy: "local curator", observedAt: "2026-10-27T12:00:00Z", verification: "asserted-unverified", detail: "Could not locate a retained source copy." }, finding: null, stance: null, claimKey: null, qualification: ["Source missing from caller's retained collection."] };
  const retracted = { id: id("paper"), metadata: { title: "Retracted trial", authors: ["C. Author"], year: 2021 }, availability: "retracted", source, statusEvidence: { kind: "retraction", assertedBy: "publisher notice supplied by curator", observedAt: "2026-10-27T12:00:00Z", verification: "asserted-unverified", detail: "Retraction status is caller-asserted, not verified here." }, finding: null, stance: null, claimKey: null, qualification: ["Publisher marks this source retracted; status supplied by caller."] };
  const set = [a, near, missing, retracted].reduce(addLiteraturePaper, createLiteratureSet("Endpoint literature"));
  const dedupe = deduplicateLiteraturePapers(set.papers);
  assert.equal(dedupe.duplicates.length, 0, "near citations are not silently merged");
  assert.equal(dedupe.ambiguities.length, 1);
  assert.equal(dedupe.ambiguities[0].papers.length, 2);
  const reopened = resolveLiteratureSet(set, [notebook]);
  assert.equal(reopened.resolved[0].document.pages[0].text, pageText);
  assert.deepEqual(reopened.resolved.slice(2).map(row => row.availability), ["missing", "retracted"]);
  assert.equal(reopened.resolved[3].document.pages[0].text, pageText);
  assert.equal(JSON.stringify(set).includes(pageText), false, "set stores pointers and metadata, not duplicate source text");

  // The resolved frozen documents feed the established notebook coverage preview.
  const prepared = prepareNotebookQuestion(notebook, { id: id("question"), question: "What do the retained papers report?",
    sourceIds: [retained.id], notes: [] }, { maxCalls: 4, passUtf16Units: 12000, maxSeconds: 120 });
  assert.equal(prepared.sourceMap[0].digest, retained.digest);
  assert.equal(prepared.request.documents[0].pages[0].text, pageText);
  const thinJourney = prepareLiteratureQuestion(set, notebook, "What do available retained papers report?", { maxCalls: 4, passUtf16Units: 12000, maxSeconds: 120 });
  assert.deepEqual(thinJourney.includedPapers.map(p => p.paperId), [a.id, near.id]);
  assert.equal(thinJourney.coverage.find(row => row.paperId === retracted.id).disposition, "excluded-retracted-by-default");
  assert.equal(thinJourney.coverage.find(row => row.paperId === retracted.id).source.sourceDigest, retained.digest);
  assert.deepEqual(thinJourney.prepared.sourceMap.map(row => row.digest), [retained.digest]);
  const includeRetracted = prepareLiteratureQuestion(set, notebook, "Study the retracted claim", { maxCalls: 4, passUtf16Units: 12000, maxSeconds: 120 }, { includeRetracted: true });
  assert.equal(includeRetracted.coverage.find(row => row.paperId === retracted.id).disposition, "included");

  const portable = JSON.parse(exportLiteratureSet(set));
  assert.equal(portable.sha256, set.sha256);
  assert.equal(portable.export.disagreements.length, 1);
  assert.match(portable.export.disagreements[0].qualification, /not a synthesis or truth assessment/);
  assert.match(JSON.stringify(portable), /retracted/i);
  assert.match(JSON.stringify(portable), /missing/i);
  assert.match(portable.export.questionScopeLimit, /one notebook at a time/);
  const markdown = formatLiteratureSet(set);
  assert.match(markdown, /## Bibliography/);
  assert.match(markdown, /Conflicting reported positions/);
  assert.match(markdown, /Retained citation target/);
  assert.match(markdown, /Source missing/);
  assert.match(markdown, /status is unknown/);
});

test("same DOI is a duplicate suggestion and changed notebook snapshots never substitute", () => {
  const a = paper("Paper A");
  const b = paper("Unrelated title", { metadata: { title: "Unrelated title", authors: ["Z. Person"], year: 2020, doi: "10.1234/EXAMPLE" } });
  const decisions = deduplicateLiteraturePapers([a, b]);
  assert.deepEqual(decisions.duplicates[0].papers, [a.id, b.id]);
  assert.throws(() => resolveLiteratureSet([a, b].reduce(addLiteraturePaper, createLiteratureSet("x")), []), /unavailable or changed/);
});

test("explicit source rebind advances answer-only notebook revisions and preserves literature metadata", () => {
  const available = paper("Available trial", { finding: "Curator note stays exactly here.", stance: "mixed", claimKey: "claim:one" });
  const missing = { id: id("paper"), metadata: { title: "Missing citation", authors: ["B. Curator"] },
    availability: "missing", source: null,
    statusEvidence: { kind: "missing-source", assertedBy: "curator", observedAt: "2026-10-27T12:00:00Z",
      verification: "asserted-unverified", detail: "No retained copy." }, finding: "Keep this missing note.",
    stance: "unclear", claimKey: "claim:one", qualification: ["Source missing from retained records."] };
  const retracted = paper("Retracted trial", { availability: "retracted",
    statusEvidence: { kind: "retraction", assertedBy: "curator", observedAt: "2026-10-27T12:00:00Z",
      verification: "asserted-unverified", detail: "Status is caller supplied." },
    qualification: ["Caller identifies a retraction; unverified here."] });
  const set = [available, missing, retracted].reduce(addLiteraturePaper, createLiteratureSet("Rebind test"));
  const nextNotebook = reviseResearchNotebook(notebook, { type: "add-note", title: "Saved answer", text: "A saved answer changes only notebook state." });
  assert.notEqual(nextNotebook.sha256, notebook.sha256);
  assert.throws(() => resolveLiteratureSet(set, [nextNotebook]), /unavailable or changed/,
    "strict whole-notebook resolution remains unchanged");

  const receipt = rebindLiteratureSet(set, [nextNotebook]);
  assert.equal(receipt.schema, "research-literature-rebind-v1");
  assert.deepEqual(receipt.previous, { id: set.id, revision: set.revision, sha256: set.sha256 });
  assert.equal(receipt.literatureSet.revision, set.revision + 1);
  assert.equal(receipt.changedPapers.length, 2, "each non-missing paper reference is reported");
  assert.deepEqual(receipt.sourceChecks, [available, retracted].map((p) => ({ paperId: p.id,
    notebookId: notebook.id, sourceId: retained.id, sourceDigest: retained.digest,
    documentId: doc.id, documentSha256: doc.sha256 })));
  const reboundAvailable = receipt.literatureSet.papers[0];
  assert.deepEqual(reboundAvailable, { ...available, source: { ...available.source, notebookSha256: nextNotebook.sha256 } });
  assert.deepEqual(receipt.literatureSet.papers[1], missing, "missing paper metadata and status assertions are untouched");
  assert.deepEqual(receipt.literatureSet.papers[2], { ...retracted, source: { ...retracted.source, notebookSha256: nextNotebook.sha256 } });
  assert.deepEqual(resolveLiteratureSet(receipt.literatureSet, [nextNotebook]).resolved.map((row) => row.availability),
    ["available", "missing", "retracted"]);
  const prepared = prepareLiteratureQuestion(receipt.literatureSet, nextNotebook,
    "What does the retained trial report?", { maxCalls: 4, passUtf16Units: 12000, maxSeconds: 120 });
  assert.deepEqual(prepared.includedPapers.map((row) => row.paperId), [available.id]);
});

test("source rebind is idempotent and refuses changed, missing, or ambiguous notebook snapshots", () => {
  const item = paper("Exact trial");
  const set = addLiteraturePaper(createLiteratureSet("Rebind idempotence"), item);
  const noChange = rebindLiteratureSet(set, [notebook]);
  assert.deepEqual(noChange.literatureSet, set);
  assert.equal(noChange.literatureSet.sha256, set.sha256);
  assert.equal(noChange.literatureSet.revision, set.revision);
  assert.deepEqual(noChange.changedPapers, []);

  let missingSource = createResearchNotebook("Same owner, source removed", { id: notebook.id });
  assert.throws(() => rebindLiteratureSet(set, [missingSource]), /exact retained source changed/);
  const changedDocument = { ...doc, pages: [{ ...doc.pages[0], text: "A changed retained page.", sha256: sha("A changed retained page.") }] };
  let changedSource = createResearchNotebook("Same owner, source changed", { id: notebook.id });
  changedSource = reviseResearchNotebook(changedSource, { type: "add-source", id: retained.id, document: changedDocument });
  assert.throws(() => rebindLiteratureSet(set, [changedSource]), /exact retained source changed/);
  assert.throws(() => rebindLiteratureSet(set, [notebook, notebook]), /snapshot IDs must be unique/);
});


test("cross-notebook literature coverage preserves exact source identity, qualification and cold projection", async (t) => {
  const notebookWith = (name, text) => {
    let value = createResearchNotebook(name, { topic: "Synthetic cross-notebook comparison" });
    value = reviseResearchNotebook(value, { type: "add-source", document: {
      id: "paper-doc-1", title: "Colliding synthetic document ID", sha256: sha(`caller digest ${name}`),
      pages: [{ number: 1, text, sha256: sha(text) }],
    } });
    const retained = value.sources[0];
    return { notebook: value, ref: { notebookId: value.id, notebookSha256: value.sha256, sourceId: retained.id,
      sourceDigest: retained.digest, documentId: retained.document.id, documentSha256: retained.document.sha256 } };
  };
  const first = notebookWith("Synthetic notebook A", "A finding supports the bounded claim.");
  const second = notebookWith("Synthetic notebook B", "A finding conflicts with the bounded claim.");
  const unselected = notebookWith("Unselected notebook", "This selected question does not read me.");
  const available = (title, ref, extra = {}) => ({ id: id("paper"), metadata: { title }, availability: "available",
    source: ref, statusEvidence: null, finding: `Caller note for ${title}.`, stance: null, claimKey: null, qualification: [], ...extra });
  const firstPaper = available("Synthetic paper A", first.ref);
  const firstAlias = available("Alias for synthetic paper A", first.ref, { qualification: ["Caller says this record aliases the same retained source."] });
  const moreAliases = Array.from({ length: 8 }, (_, index) => available(`Additional alias ${index + 1}`, first.ref));
  const secondPaper = available("Synthetic paper B", second.ref);
  const missing = { id: id("paper"), metadata: { title: "Missing synthetic paper" }, availability: "missing", source: null,
    statusEvidence: { kind: "missing-source", assertedBy: "synthetic curator", observedAt: "2026-10-27T12:00:00Z", verification: "asserted-unverified", detail: "No retained source is available in this fixture." },
    finding: null, stance: null, claimKey: null, qualification: ["Synthetic missing-source qualification."] };
  const retracted = available("Retracted synthetic paper", first.ref, { availability: "retracted",
    statusEvidence: { kind: "retraction", assertedBy: "synthetic curator", observedAt: "2026-10-27T12:00:00Z", verification: "asserted-unverified", detail: "Caller asserts retraction; not verified." },
    qualification: ["Synthetic retraction qualification; caller asserted."] });
  const notSelected = available("Unselected paper", unselected.ref);
  const set = [firstPaper, firstAlias, ...moreAliases, secondPaper, missing, retracted, notSelected]
    .reduce(addLiteraturePaper, createLiteratureSet("Synthetic cross-notebook set"));
  const selectedIds = [firstPaper.id, firstAlias.id, ...moreAliases.map((paperRow) => paperRow.id), secondPaper.id, missing.id, retracted.id];
  const prepared = prepareLiteratureStudyQuestion(set, [first.notebook, second.notebook],
    "What does the selected retained evidence say about this bounded claim?", { maxCalls: 3, passUtf16Units: 1000 },
    { paperIds: selectedIds });
  assert.deepEqual(prepareLiteratureStudyQuestion(set, [first.notebook, second.notebook],
    "What does the selected retained evidence say about this bounded claim?", { maxCalls: 3, passUtf16Units: 1000 },
    { paperIds: selectedIds }), prepared, "repeated preparation has the same frozen source identities and plan");
  assert.equal(prepared.preview.counts.documents, 2);
  assert.equal(prepared.request.documents[0].id.startsWith("literature-source:"), true);
  assert.notEqual(prepared.request.documents[0].id, prepared.request.documents[1].id);
  assert.deepEqual(prepared.sourceMap.map((row) => row.sourceBinding.documentId), ["paper-doc-1", "paper-doc-1"]);
  const aliasMap = prepared.sourceMap.find((row) => row.papers.some((paperRef) => paperRef.paperId === firstPaper.id));
  assert.deepEqual(aliasMap.papers.map((paperRef) => paperRef.paperId), [firstPaper.id, firstAlias.id, ...moreAliases.map((paperRow) => paperRow.id)]);
  assert.equal(aliasMap.sourceIndependence, "same-exact-source-aliases");
  assert.equal(prepared.coverage.find((row) => row.paperId === missing.id).disposition, "not-searched-source-missing");
  const retractedRow = prepared.coverage.find((row) => row.paperId === retracted.id);
  assert.equal(retractedRow.disposition, "excluded-retracted-by-default");
  assert.deepEqual(retractedRow.statusEvidence, retracted.statusEvidence);
  assert.deepEqual(retractedRow.qualification, retracted.qualification);
  const unselectedRow = prepared.coverage.find((row) => row.paperId === notSelected.id);
  assert.equal(unselectedRow.disposition, "not-selected");
  assert.equal(unselectedRow.sourceResolution, "not-compared-not-selected");
  const currentness = checkLiteratureStudyQuestionSources(prepared, set, [first.notebook, second.notebook]);
  assert.equal(currentness.literatureSet.status, "current");
  assert.deepEqual(currentness.sources.map((row) => row.status), ["current", "current"]);
  assert.throws(() => prepareLiteratureStudyQuestion(set, [first.notebook, second.notebook], "Question?", {}, { paperIds: [...selectedIds, notSelected.id] }), /selected source notebook is unavailable/u);
  const staleFirst = reviseResearchNotebook(first.notebook, { type: "rename", title: "Renamed stale notebook" });
  assert.throws(() => prepareLiteratureStudyQuestion(set, [staleFirst, second.notebook], "Question?", {}, { paperIds: selectedIds }), /selected source notebook changed/u);
  assert.equal(checkLiteratureStudyQuestionSources(prepared, set, [staleFirst, second.notebook]).sources[0].status, "changed");
  const defaultExcluded = prepareLiteratureStudyQuestion(set, [first.notebook], "Question about the retracted work?", {},
    { paperIds: [retracted.id] });
  assert.equal(defaultExcluded.request, null);
  const optedIn = prepareLiteratureStudyQuestion(set, [first.notebook], "Question about the retracted work?", {},
    { paperIds: [retracted.id], includeRetracted: true });
  assert.equal(optedIn.includedPapers[0].availability, "retracted");
  assert.deepEqual(optedIn.includedPapers[0].statusEvidence, retracted.statusEvidence);
  assert.deepEqual(optedIn.includedPapers[0].qualification, retracted.qualification);

  let manyNotebook = createResearchNotebook("Nine distinct synthetic sources");
  const manySources = [];
  for (let index = 1; index <= 9; index += 1) {
    const text = `Distinct source ${index} supports a separate synthetic record.`;
    manyNotebook = reviseResearchNotebook(manyNotebook, { type: "add-source", document: {
      id: `distinct-document-${index}`, title: `Distinct document ${index}`, sha256: sha(`raw distinct ${index}`),
      pages: [{ number: 1, text, sha256: sha(text) }],
    } });
    manySources.push(manyNotebook.sources.at(-1));
  }
  const manyPapers = manySources.map((retained, index) => available(`Distinct paper ${index + 1}`, { notebookId: manyNotebook.id,
    notebookSha256: manyNotebook.sha256, sourceId: retained.id, sourceDigest: retained.digest,
    documentId: retained.document.id, documentSha256: retained.document.sha256 }));
  const manySet = manyPapers.reduce(addLiteraturePaper, createLiteratureSet("Nine distinct papers"));
  assert.throws(() => prepareLiteratureStudyQuestion(manySet, [manyNotebook], "Question?", {},
    { paperIds: manyPapers.map((paperRow) => paperRow.id) }), /invalid_document_coverage: expected 1-8 documents/u);

  const plan = prepared.preview;
  const responses = plan.passes.map((pass) => {
    const evidence = pass.windowIds.map((windowId, index) => {
      const window = plan.windows.find((entry) => entry.id === windowId);
      const row = prepared.request.documents.find((document) => document.id === window.documentId);
      const quote = row.pages[window.page - 1].text.slice(window.start, window.end);
      return { id: `finding-${index + 1}`, windowId, quote,
        relation: aliasMap.coverageDocumentId === window.documentId ? "supporting" : "conflicting", occurrence: null };
    });
    return { events: [message(JSON.stringify({
      answer: evidence.map((item) => ({ text: `Synthetic report: ${item.quote}`, evidenceIds: [item.id] })),
      evidence, coverage: "answered", gaps: [],
    })), { type: "turn.completed" }] };
  });
  const allEvidenceIds = plan.passes.flatMap((pass, passIndex) => pass.windowIds.map((_, index) =>
    `p${String(passIndex + 1).padStart(2, "0")}-e${String(index + 1).padStart(2, "0")}`));
  responses.push({ events: [message(JSON.stringify({ answer: [{ text: "The two retained sources report different positions.", evidenceIds: allEvidenceIds }], coverage: "partial", gaps: ["The reason for the disagreement is not established by this synthetic evidence."] })), { type: "turn.completed" }] });
  const fixture = await fakeCodex({ sessions: responses });
  t.after(() => fixture.cleanup());
  const result = await researchDocumentCoverage(prepared.request.question, prepared.request.documents, {
    lease: fixture.lease, confirmedPlanDigest: prepared.preview.planDigest, ...prepared.request.policy,
  });
  assert.equal(result.status, "complete");
  assert.equal(result.draft.coverage, "partial");
  const cold = validateLiteratureStudyQuestion(JSON.parse(JSON.stringify(prepared)));
  const projected = projectLiteratureStudyEvidence(cold, result);
  assert.equal(projected.evidence.length, 2);
  const projectedA = projected.evidence.find((item) => item.paperReferences.some((paperRef) => paperRef.paperId === firstPaper.id));
  const projectedB = projected.evidence.find((item) => item.paperReferences.some((paperRef) => paperRef.paperId === secondPaper.id));
  assert.equal(projectedA.relation, "supporting");
  assert.deepEqual(projectedA.paperReferences.map((paperRef) => paperRef.paperId), [firstPaper.id, firstAlias.id, ...moreAliases.map((paperRow) => paperRow.id)]);
  assert.equal(projectedA.sourceIndependence, "same-exact-source-aliases");
  assert.equal(projectedB.relation, "conflicting");
  assert.equal(projectedB.sourceIndependence, "unknown");
  assert.equal(projectedB.paperReferences[0].source.notebookId, second.notebook.id);
  const planningSource = exportLiteratureStudyPlanningSource(prepared, result, "00000000-0000-4000-8000-000000000091");
  assert.equal(planningSource.binding.owner, "research-literature-study");
  assert.equal(planningSource.binding.literatureSetSha256, set.sha256);
  assert.equal(planningSource.binding.preparedSha256, prepared.sha256);
  assert.equal(planningSource.binding.requestId, "00000000-0000-4000-8000-000000000091");
  assert.equal(planningSource.qualification.executionStatus, "complete");
  assert.equal(planningSource.qualification.reportedCoverage, "partial");
  assert.deepEqual(planningSource.qualification.gaps, ["The reason for the disagreement is not established by this synthetic evidence."]);
  assert.equal(planningSource.binding.selectedCoverage.find((row) => row.paperId === missing.id).statusEvidence.kind, "missing-source");
  assert.equal(planningSource.binding.selectedCoverage.find((row) => row.paperId === retracted.id).statusEvidence.kind, "retraction");
  assert.equal(planningSource.binding.citations.some((citation) => citation.quote && citation.paperIds.includes(firstAlias.id)), true);
  assert.deepEqual(validateLiteratureStudyPlanningSource(cold, result, planningSource.binding.requestId, planningSource), planningSource);
  const alteredPlanningSource = structuredClone(planningSource);
  alteredPlanningSource.binding.citations[0].quote = "altered exact quote";
  assert.throws(() => validateLiteratureStudyPlanningSource(cold, result, planningSource.binding.requestId, alteredPlanningSource), /exact saved cross-notebook answer/u);
  assert.equal(result.passes.every((pass) => pass.receipt.outcome.searches === 0), true);
  const tampered = structuredClone(prepared);
  tampered.sourceMap[0].papers[0].metadata.title = "Tampered paper mapping";
  assert.throws(() => validateLiteratureStudyQuestion(tampered), /source map paper binding|prepared source attribution/u);

  const alteredPageClosure = structuredClone(prepared);
  const firstCoverageDocument = alteredPageClosure.request.documents[0];
  const changedPageText = `${firstCoverageDocument.pages[0].text} Altered after source selection.`;
  firstCoverageDocument.pages[0] = { number: 1, text: changedPageText, sha256: sha(changedPageText) };
  alteredPageClosure.preview = prepareDocumentCoverage(alteredPageClosure.request.question,
    alteredPageClosure.request.documents, alteredPageClosure.request.policy);
  const { sha256: _priorPreparedDigest, ...alteredPayload } = alteredPageClosure;
  alteredPageClosure.sha256 = sha(canonical(alteredPayload));
  assert.deepEqual(alteredPageClosure.literatureSet, prepared.literatureSet);
  assert.deepEqual(alteredPageClosure.sourceMap[0].sourceBinding, prepared.sourceMap[0].sourceBinding);
  assert.throws(() => validateLiteratureStudyQuestion(alteredPageClosure), /retained source digest changed/u);
});
