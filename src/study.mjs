// Original Research implementation: portable composition over selected notebook evidence; no donor code is included.
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { reviseResearchNotebook, validateResearchNotebook } from "./notebook.mjs";
import { openNotebookSearchHit } from "./notebook-search.mjs";
import { prepareDocumentCoverage, validateDocumentCoverage } from "./document-coverage.mjs";

const schema = "research-study-v1";
const digestPattern = /^[a-f0-9]{64}$/;
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, expected) => plain(value) && Object.keys(value).sort().join() === [...expected].sort().join();
const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : plain(value) ? `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  : JSON.stringify(value);
const clone = (value) => JSON.parse(JSON.stringify(value));
const invalid = (why) => { throw new Error(`invalid_research_study: ${why}`); };
const line = (value, max) => typeof value === "string" && value.trim() !== "" && value.length <= max
  && value.isWellFormed() && !/[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value);
const idPattern = /^(study|study-selection|study-question):[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const id = (prefix, value = `${prefix}:${randomUUID()}`) => {
  if (typeof value !== "string" || !idPattern.test(value) || !value.startsWith(`${prefix}:`)) invalid(`invalid ${prefix} ID`);
  return value;
};
const stateDigest = (value) => hash(canonical(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "sha256"))));
const seal = (value) => { const next = { ...value }; delete next.sha256; next.sha256 = stateDigest(next); return next; };
const selectionDigest = (value) => hash(canonical(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "sha256"))));
const questionDigest = (value) => hash(canonical(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "sha256"))));
const maxSelections = 16, maxQuestions = 32, byteLimit = 16 * 1024 * 1024;

function validateDocument(document) {
  if (!keys(document, ["id", "title", "sha256", "pages"])) invalid("malformed retained source document");
  return prepareDocumentCoverage("Validate selected study evidence", [document], { maxCalls: 64, passUtf16Units: 48000 }).documents[0];
}
function noteDocument(noteId, version) {
  const idValue = `notebook-note-${hash(`${noteId}\n${version.version}`).slice(0, 48)}`;
  const pageText = version.text;
  const page = { number: 1, text: pageText, sha256: hash(pageText) };
  const document = { id: idValue, title: `Unverified note: ${version.title}`, sha256: hash(`${idValue}\n${version.sha256}`), pages: [page] };
  return document;
}
function validateSelection(value) {
  if (!keys(value, ["id", "origin", "document", "noteVersion", "contentSha256", "sha256"])) invalid("selection fields are closed");
  id("study-selection", value.id);
  if (!keys(value.origin, ["notebookId", "notebookSha256", "searchScope", "query", "searchOptions", "searchInputDigest", "searchResultSha256", "hitId", "kind", "recordId", "version", "documentId", "page", "sourceDigest"])) invalid("invalid selection origin");
  if (!/^notebook:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.origin.notebookId) || !digestPattern.test(value.origin.notebookSha256)
      || !Array.isArray(value.origin.searchScope) || value.origin.searchScope.length < 1 || value.origin.searchScope.length > 8
      || !line(value.origin.query, 200) || !keys(value.origin.searchOptions, ["mode", "kinds", "noteVersions", "limit"])
      || !["exact", "prefix", "fuzzy"].includes(value.origin.searchOptions.mode)
      || !Array.isArray(value.origin.searchOptions.kinds) || !value.origin.searchOptions.kinds.length
      || value.origin.searchOptions.kinds.some((kind) => !["document", "note"].includes(kind))
      || new Set(value.origin.searchOptions.kinds).size !== value.origin.searchOptions.kinds.length
      || !["latest", "all"].includes(value.origin.searchOptions.noteVersions)
      || !Number.isSafeInteger(value.origin.searchOptions.limit) || value.origin.searchOptions.limit < 1 || value.origin.searchOptions.limit > 50
      || !digestPattern.test(value.origin.searchInputDigest)
      || !digestPattern.test(value.origin.searchResultSha256) || !/^notebook-hit-[a-f0-9]{40}$/.test(value.origin.hitId)
      || !["document", "note"].includes(value.origin.kind) || typeof value.origin.recordId !== "string"
      || !(value.origin.version === null || Number.isSafeInteger(value.origin.version) && value.origin.version > 0)
      || !(value.origin.documentId === null || typeof value.origin.documentId === "string")
      || !(value.origin.page === null || Number.isSafeInteger(value.origin.page) && value.origin.page > 0)
      || !digestPattern.test(value.origin.sourceDigest)) invalid("malformed search hit provenance");
  if (value.origin.searchScope.some((entry, index) => !keys(entry, ["id", "sha256"])
      || !/^notebook:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(entry.id)
      || !digestPattern.test(entry.sha256) || (index > 0 && value.origin.searchScope[index - 1].id >= entry.id))
      || !value.origin.searchScope.some((entry) => entry.id === value.origin.notebookId && entry.sha256 === value.origin.notebookSha256)) invalid("invalid search scope binding");
  if (!digestPattern.test(value.contentSha256) || !digestPattern.test(value.sha256)
      || selectionDigest(value) !== value.sha256) invalid("selection digest mismatch");
  const document = validateDocument(value.document);
  if (!isDeepStrictEqual(document, value.document) || hash(canonical(document)) !== value.contentSha256) invalid("selected content digest mismatch");
  if (value.origin.kind === "document") {
    if (value.noteVersion !== null || value.document.id !== value.origin.documentId || value.origin.version !== null || value.origin.page === null
        || value.origin.page > value.document.pages.length || value.origin.sourceDigest !== value.contentSha256) invalid("document selection identity mismatch");
  } else {
    const version = value.noteVersion;
    if (!keys(version, ["version", "title", "text", "origin", "sha256"]) || version.version !== value.origin.version
        || !line(version.title, 200) || typeof version.text !== "string" || !version.text.isWellFormed() || version.text.length > 20000
        || !keys(version.origin, ["kind", "questionId"]) || !["human", "question"].includes(version.origin.kind)
        || !(version.origin.kind === "human" ? version.origin.questionId === null : /^question:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(version.origin.questionId))
        || !digestPattern.test(version.sha256)) invalid("invalid selected note version");
    const noteContent = { version: version.version, title: version.title, text: version.text, origin: version.origin };
    if (hash(canonical(noteContent)) !== version.sha256 || value.origin.sourceDigest !== version.sha256
        || !isDeepStrictEqual(document, noteDocument(value.origin.recordId, version))
        || value.origin.documentId !== null || value.origin.page !== null) invalid("note version binding mismatch");
  }
  return value;
}
function validateQuestion(value, selections) {
  if (!keys(value, ["id", "question", "selectionIds", "selectionDigest", "sourceMap", "policy", "request", "planDigest", "result", "sha256"])) invalid("question fields are closed");
  id("study-question", value.id);
  if (!line(value.question, 2000) || !Array.isArray(value.selectionIds) || value.selectionIds.length < 1 || value.selectionIds.length > 8
      || new Set(value.selectionIds).size !== value.selectionIds.length || value.selectionIds.some((selectionId) => !selections.has(selectionId))
      || !digestPattern.test(value.selectionDigest) || !Array.isArray(value.sourceMap) || !digestPattern.test(value.planDigest)
      || !plain(value.policy) || !plain(value.request) || !digestPattern.test(value.sha256)) invalid("invalid question record");
  const selected = value.selectionIds.map((selectionId) => selections.get(selectionId));
  const boundDigest = hash(canonical(selected.map(({ sha256 }) => sha256)));
  if (boundDigest !== value.selectionDigest) invalid("question selection has changed");
  const expectedMap = selected.map((selection) => ({ documentId: selection.document.id, selectionId: selection.id,
    notebookId: selection.origin.notebookId, notebookSha256: selection.origin.notebookSha256,
    kind: selection.origin.kind, recordId: selection.origin.recordId, version: selection.origin.version,
    sourceDigest: selection.origin.sourceDigest, page: selection.origin.page }));
  if (!isDeepStrictEqual(expectedMap, value.sourceMap)) invalid("question source map mismatch");
  const plan = prepareDocumentCoverage(value.question, selected.map((selection) => selection.document), value.policy);
  if (!isDeepStrictEqual(plan.documents, value.request.documents) || plan.planDigest !== value.planDigest) invalid("question plan no longer matches retained selected content");
  const result = validateDocumentCoverage(value.result);
  if (!isDeepStrictEqual(result.plan, plan)) invalid("question result does not bind the retained study scope");
  const normalized = { ...value, sourceMap: clone(expectedMap), result };
  if (questionDigest(normalized) !== value.sha256) invalid("question digest mismatch");
  return normalized;
}
function validateState(value) {
  if (!keys(value, ["version", "id", "title", "revision", "selections", "questions", "sha256"]) || value.version !== schema
      || !idPattern.test(value.id) || !value.id.startsWith("study:") || !line(value.title, 200)
      || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Array.isArray(value.selections) || value.selections.length > maxSelections
      || !Array.isArray(value.questions) || value.questions.length > maxQuestions || !digestPattern.test(value.sha256)) invalid("invalid study header");
  const selections = new Map();
  for (const raw of value.selections) {
    const selected = validateSelection(raw);
    if (selections.has(selected.id)) invalid("duplicate selection ID");
    selections.set(selected.id, selected);
  }
  const questions = value.questions.map((entry) => validateQuestion(entry, selections));
  if (new Set(questions.map((entry) => entry.id)).size !== questions.length) invalid("duplicate question ID");
  const normalized = { version: schema, id: value.id, title: value.title, revision: value.revision,
    selections: [...selections.values()], questions, sha256: value.sha256 };
  if (stateDigest(normalized) !== value.sha256 || Buffer.byteLength(canonical(normalized), "utf8") > byteLimit) invalid("study digest mismatch or state exceeds 16 MiB");
  return normalized;
}
function resolveCurrent(notebooks, search, hitId) {
  if (!Array.isArray(notebooks) || notebooks.length < 1 || notebooks.length > 8) invalid("select 1-8 origin notebooks explicitly");
  const validated = notebooks.map(validateResearchNotebook);
  const opened = openNotebookSearchHit(validated, search, hitId);
  const hit = opened.hit;
  const notebook = validated.find((item) => item.id === hit.notebookId);
  let document, noteVersion = null;
  if (hit.kind === "document") document = opened.source.document;
  else {
    noteVersion = opened.source.version;
    document = noteDocument(hit.recordId, noteVersion);
  }
  const searchOptions = { mode: search.query.mode, kinds: [...search.query.kinds], noteVersions: search.query.noteVersions, limit: search.query.limit };
  const origin = { notebookId: notebook.id, notebookSha256: notebook.sha256, query: search.query.text,
    searchScope: clone(search.scope), searchOptions, searchInputDigest: search.inputDigest, searchResultSha256: search.sha256,
    hitId: hit.id, kind: hit.kind, recordId: hit.recordId, version: hit.version, documentId: hit.documentId,
    page: hit.page, sourceDigest: hit.sourceDigest };
  const selection = { id: id("study-selection"), origin, document: validateDocument(document), noteVersion: clone(noteVersion),
    contentSha256: hash(canonical(document)) };
  selection.sha256 = selectionDigest(selection);
  return validateSelection(selection);
}

/** Creates a portable cross-notebook study composition value. */
export function createResearchStudy(title, { id: studyId } = {}) {
  if (!line(title, 200)) invalid("title is required");
  return validateState(seal({ version: schema, id: id("study", studyId), title, revision: 1, selections: [], questions: [] }));
}
/** Validates and appends an explicit current search hit, or removes an unused selection. */
export function reviseResearchStudy(value, edit) {
  const study = validateState(value);
  if (!plain(edit) || typeof edit.type !== "string") invalid("revision must name an edit");
  if (edit.type === "select-hit" && keys(edit, ["type", "notebooks", "search", "hitId"])) {
    if (study.selections.length >= maxSelections) invalid("study selection capacity reached");
    const selection = resolveCurrent(edit.notebooks, edit.search, edit.hitId);
    const identity = canonical({ notebookId: selection.origin.notebookId, kind: selection.origin.kind,
      recordId: selection.origin.recordId, version: selection.origin.version, sourceDigest: selection.origin.sourceDigest });
    if (study.selections.some((entry) => canonical({ notebookId: entry.origin.notebookId, kind: entry.origin.kind,
      recordId: entry.origin.recordId, version: entry.origin.version, sourceDigest: entry.origin.sourceDigest }) === identity)) invalid("this exact source version is already selected");
    return validateState(seal({ ...study, revision: study.revision + 1, selections: [...study.selections, selection] }));
  }
  if (edit.type === "deselect-hit" && keys(edit, ["type", "selectionId"])) {
    const selectionId = id("study-selection", edit.selectionId);
    if (study.questions.some((question) => question.selectionIds.includes(selectionId))) invalid("retained questions keep their selected evidence");
    const selections = study.selections.filter((entry) => entry.id !== selectionId);
    if (selections.length === study.selections.length) invalid("selection is not in this study");
    return validateState(seal({ ...study, revision: study.revision + 1, selections }));
  }
  invalid("unknown revision type or fields");
}
/** Cold-opens the study from its embedded immutable evidence snapshots without current notebooks. */
export function validateResearchStudy(value) { return validateState(value); }
/** Reports whether each selection still matches its current origin; saved snapshots remain unchanged. */
export function checkResearchStudyOrigins(value, notebooks) {
  const study = validateState(value);
  if (!Array.isArray(notebooks) || notebooks.length > 8) invalid("provide up to 8 current origin notebooks");
  const current = new Map();
  for (const item of notebooks) { const notebook = validateResearchNotebook(item); if (current.has(notebook.id)) invalid("current origin notebook IDs must be unique"); current.set(notebook.id, notebook); }
  return study.selections.map((selection) => {
    const origin = selection.origin, notebook = current.get(origin.notebookId);
    if (!notebook) return { selectionId: selection.id, notebookId: origin.notebookId, status: "missing", expectedNotebookSha256: origin.notebookSha256, currentNotebookSha256: null };
    let currentDigest = null;
    if (origin.kind === "document") currentDigest = notebook.sources.find((entry) => entry.id === origin.recordId)?.digest ?? null;
    else currentDigest = notebook.notes.find((entry) => entry.id === origin.recordId)?.versions.find((entry) => entry.version === origin.version)?.sha256 ?? null;
    const status = !currentDigest ? "missing" : notebook.sha256 === origin.notebookSha256 && currentDigest === origin.sourceDigest ? "current" : "changed";
    const detail = !currentDigest ? "selected_record_missing" : currentDigest !== origin.sourceDigest ? "selected_version_changed"
      : notebook.sha256 !== origin.notebookSha256 ? "notebook_changed_selected_version_matches" : "current";
    return { selectionId: selection.id, notebookId: origin.notebookId, status, detail, expectedNotebookSha256: origin.notebookSha256,
      currentNotebookSha256: notebook.sha256, expectedSourceDigest: origin.sourceDigest, currentSourceDigest: currentDigest };
  });
}
/** Prepares an explicit <=8 selected-record question from the study's stored complete evidence. */
export function prepareResearchStudyQuestion(value, spec, policy = {}) {
  const study = validateState(value);
  if (!keys(spec, ["id", "question", "selectionIds"])) invalid("question requires id, question, and explicit selectionIds");
  id("study-question", spec.id);
  if (!line(spec.question, 2000) || !Array.isArray(spec.selectionIds) || spec.selectionIds.length < 1 || spec.selectionIds.length > 8
      || new Set(spec.selectionIds).size !== spec.selectionIds.length) invalid("select 1-8 unique study evidence records");
  const byId = new Map(study.selections.map((entry) => [entry.id, entry]));
  const selected = spec.selectionIds.map((selectionId) => byId.get(id("study-selection", selectionId)));
  if (selected.some((entry) => !entry)) invalid("selected evidence does not belong to this study");
  if (new Set(selected.map((entry) => entry.document.id)).size !== selected.length) invalid("selected records have duplicate document IDs; select distinct retained records");
  const plan = prepareDocumentCoverage(spec.question, selected.map((entry) => entry.document), policy);
  const sourceMap = selected.map((entry) => ({ documentId: entry.document.id, selectionId: entry.id,
    notebookId: entry.origin.notebookId, notebookSha256: entry.origin.notebookSha256, kind: entry.origin.kind,
    recordId: entry.origin.recordId, version: entry.origin.version, sourceDigest: entry.origin.sourceDigest, page: entry.origin.page }));
  return { version: "research-study-question-preview-v1", studyId: study.id, studySha256: study.sha256,
    spec: clone(spec), selectionDigest: hash(canonical(selected.map(({ sha256 }) => sha256))), sourceMap,
    request: { question: plan.question, documents: clone(plan.documents), policy: clone(plan.policy) },
    preview: { planDigest: plan.planDigest, inputDigest: plan.inputDigest, counts: clone(plan.counts), policy: clone(plan.policy),
      sources: sourceMap.map((source) => ({ ...source, pages: plan.documents.find((document) => document.id === source.documentId).pages.length })) } };
}
/** Appends a validated complete, partial, or failed coverage result to the study history. */
export function recordResearchStudyQuestion(value, prepared, resultValue) {
  const study = validateState(value);
  if (!keys(prepared, ["version", "studyId", "studySha256", "spec", "selectionDigest", "sourceMap", "request", "preview"])
      || prepared.version !== "research-study-question-preview-v1" || prepared.studyId !== study.id) invalid("invalid prepared study question");
  if (!digestPattern.test(prepared.studySha256) || !digestPattern.test(prepared.selectionDigest) || !digestPattern.test(prepared.preview?.planDigest)) invalid("invalid prepared study digests");
  const fresh = prepareResearchStudyQuestion(study, prepared.spec, prepared.request?.policy);
  if (fresh.selectionDigest !== prepared.selectionDigest || !isDeepStrictEqual(fresh.sourceMap, prepared.sourceMap)
      || !isDeepStrictEqual(fresh.request, prepared.request) || !isDeepStrictEqual(fresh.preview, prepared.preview)) invalid("prepared study question no longer matches selected evidence");
  const prior = study.questions.find((question) => question.id === prepared.spec.id);
  if (prepared.studySha256 !== study.sha256 && !prior) invalid("prepared study commitment does not match current study");
  const result = validateDocumentCoverage(resultValue);
  if (!isDeepStrictEqual(result.plan, prepareDocumentCoverage(prepared.spec.question, prepared.request.documents, prepared.request.policy))) invalid("result does not match study question plan");
  if (prepared.studySha256 !== study.sha256) {
    if (prior && prior.selectionDigest === prepared.selectionDigest && prior.result.receipt.contentSha256 === result.receipt.contentSha256) return study;
    invalid("prepared study commitment does not match current study");
  }
  if (prior) {
    if (prior.selectionDigest === prepared.selectionDigest && prior.result.receipt.contentSha256 === result.receipt.contentSha256) return study;
    invalid("question ID already records another result");
  }
  if (study.questions.length >= maxQuestions) invalid("study question capacity reached");
  const record = { id: prepared.spec.id, question: prepared.spec.question, selectionIds: [...prepared.spec.selectionIds],
    selectionDigest: prepared.selectionDigest, sourceMap: clone(prepared.sourceMap), policy: clone(prepared.request.policy),
    request: clone(prepared.request), planDigest: prepared.preview.planDigest, result };
  record.sha256 = questionDigest(record);
  return validateState(seal({ ...study, revision: study.revision + 1, questions: [...study.questions, record] }));
}
/** Reopens an exact cited page from the embedded selected source or note-version snapshot. */
export function getResearchStudyCitation(value, questionId, evidenceId) {
  const study = validateState(value), question = study.questions.find((entry) => entry.id === questionId);
  if (!question) invalid("question is not retained in this study");
  const evidence = [...(question.result.draft?.evidence ?? []), ...question.result.passes.filter((pass) => pass.findings).flatMap((pass) => pass.findings.evidence)]
    .find((entry) => entry.id === evidenceId);
  if (!evidence) invalid("evidence ID is not retained in this question");
  const map = question.sourceMap.find((entry) => entry.documentId === evidence.documentId);
  const selection = study.selections.find((entry) => entry.id === map?.selectionId);
  const page = selection?.document.pages.find((entry) => entry.number === evidence.page);
  if (!selection || !page || page.text.slice(evidence.start, evidence.end) !== evidence.quote) invalid("citation no longer matches its selected version");
  return { evidence: clone(evidence), page: clone(page), document: clone(selection.document), selection: clone(selection),
    source: selection.origin.kind === "note" ? { kind: "note", noteVersion: clone(selection.noteVersion) }
      : { kind: "document", notebookId: selection.origin.notebookId, recordId: selection.origin.recordId, digest: selection.origin.sourceDigest } };
}

const planningSourceTextLimit = 16000;
const planningSourceObjectLimit = 16 * 1024;
function buildStudyPlanningSource(studyValue, questionId) {
  const study = validateState(studyValue);
  id("study-question", questionId);
  const question = study.questions.find((entry) => entry.id === questionId);
  if (!question) invalid("question is not retained in this study");
  const draft = question.result.draft;
  if (question.result.status !== "complete" || !draft || !["answered", "partial"].includes(draft.coverage)
      || !Array.isArray(draft.answer) || draft.answer.length < 1 || draft.answer.length > 24)
    invalid("study question has no complete nonempty answer with answered or partial coverage");
  if (draft.coverage === "partial" && draft.gaps.length === 0) invalid("partial study answer has no stated qualification");

  const evidenceById = new Map(draft.evidence.map((item) => [item.id, item]));
  const sourceSnapshots = [], selectedById = new Map();
  const citations = [];
  const renderedAnswers = draft.answer.map((row, answerParagraph) => {
    if (typeof row.text !== "string" || !row.text.trim() || row.text.length > 1200
        || !Array.isArray(row.evidenceIds) || row.evidenceIds.length < 1 || row.evidenceIds.length > 48)
      invalid("study answer paragraph is not bounded and evidence-cited");
    const markers = [];
    for (const evidenceId of row.evidenceIds) {
      const retainedEvidence = evidenceById.get(evidenceId);
      if (!retainedEvidence) invalid("study answer cites evidence outside its retained final answer");
      const opened = getResearchStudyCitation(study, questionId, evidenceId);
      if (!isDeepStrictEqual(opened.evidence, retainedEvidence)) invalid("study answer citation differs from its retained exact quote");
      const source = question.sourceMap.find((entry) => entry.documentId === retainedEvidence.documentId);
      const selection = study.selections.find((entry) => entry.id === source?.selectionId);
      if (!source || !selection) invalid("study answer citation has no retained selected source");
      let snapshot = selectedById.get(selection.id);
      if (!snapshot) {
        snapshot = { selectionId: selection.id, notebookId: selection.origin.notebookId,
          notebookSha256: selection.origin.notebookSha256, kind: selection.origin.kind,
          recordId: selection.origin.recordId, version: selection.origin.version,
          sourceDigest: selection.origin.sourceDigest, documentId: selection.document.id,
          title: selection.document.title, contentSha256: selection.contentSha256 };
        selectedById.set(selection.id, snapshot);
        sourceSnapshots.push(snapshot);
      }
      citations.push({ evidenceId, answerParagraph, selectionId: selection.id, documentId: retainedEvidence.documentId,
        page: retainedEvidence.page, start: retainedEvidence.start, end: retainedEvidence.end,
        quote: retainedEvidence.quote, relation: retainedEvidence.relation });
      markers.push(evidenceId);
    }
    return `- ${row.text} [${markers.join(", ")}]`;
  });
  const qualification = { resultStatus: question.result.status, coverage: draft.coverage, gaps: [...draft.gaps], limits: [...draft.limits],
    currentness: "frozen-snapshot-origin-not-checked",
    claimLimit: "Occurrence is validated; entailment, truth, and live source currentness are not." };
  const text = [`Unverified saved Research Study answer`, `Question: ${question.question}`, `Study: ${study.id}; question: ${question.id}.`,
    `Execution status: ${question.result.status}; reported coverage: ${draft.coverage}.`, "", ...renderedAnswers,
    ...(draft.gaps.length ? ["", "Qualifications and gaps:", ...draft.gaps.map((gap) => `- ${gap}`)] : []),
    "", "Citations identify exact retained occurrences; they do not establish entailment or truth."].join("\n");
  if (!text.isWellFormed() || text.length > planningSourceTextLimit) invalid("saved study answer exceeds the Planning source text limit of 16,000 characters");
  const binding = { owner: "research-study", studyId: study.id, questionId: question.id, questionSha256: question.sha256,
    selectionDigest: question.selectionDigest, planDigest: question.planDigest, resultSha256: hash(canonical(question.result)),
    sourceSnapshots, citations };
  if (Buffer.byteLength(canonical(binding), "utf8") > planningSourceObjectLimit)
    invalid("Planning source binding exceeds its 16 KiB object limit");
  if (Buffer.byteLength(canonical(qualification), "utf8") > planningSourceObjectLimit)
    invalid("Planning source qualification exceeds its 16 KiB object limit");
  const locatorDigest = hash(canonical({ studyId: study.id, questionId: question.id, questionSha256: question.sha256 }));
  const output = { id: `research-study-${locatorDigest.slice(0, 48)}`, text, binding, qualification };
  if (Buffer.byteLength(canonical(output), "utf8") > byteLimit) invalid("Planning source exceeds the 16 MiB output limit");
  return output;
}

/** Exports one saved, cited Study answer as a bounded fallible Planning source. */
export function exportResearchStudyPlanningSource(studyValue, questionId) {
  return buildStudyPlanningSource(studyValue, questionId);
}

/** Recomputes and validates a previously exported source against the exact saved Study answer. */
export function validateResearchStudyPlanningSource(studyValue, questionId, candidate) {
  const expected = buildStudyPlanningSource(studyValue, questionId);
  if (!isDeepStrictEqual(candidate, expected)) invalid("Planning source does not match the exact saved Study answer");
  return expected;
}

/** Saves a qualified answer as a versioned note with immutable study/result provenance. */
export function saveResearchStudyQuestionAsNotebookNote(studyValue, notebookValue, questionId, { title, id: noteId } = {}) {
  const study = validateState(studyValue), notebook = validateResearchNotebook(notebookValue);
  id("study-question", questionId);
  const question = study.questions.find((entry) => entry.id === questionId);
  if (!question) invalid("question is not retained in this study");
  const draft = question.result.draft;
  if (question.result.status !== "complete" || !draft || !Array.isArray(draft.answer) || draft.answer.length === 0)
    invalid("study question has no complete synthesized answer");
  const evidence = new Map([...(draft.evidence ?? []), ...question.result.passes.filter((pass) => pass.findings)
    .flatMap((pass) => pass.findings.evidence)].map((item) => [item.id, item]));
  const answer = draft.answer.map((row) => {
    if (typeof row.text !== "string" || !row.text.trim() || !Array.isArray(row.evidenceIds) || row.evidenceIds.length === 0
        || row.evidenceIds.some((evidenceId) => !evidence.has(evidenceId))) invalid("study answer contains an unqualified claim");
    const qualifiers = row.evidenceIds.map((evidenceId) => {
      const item = evidence.get(evidenceId), source = question.sourceMap.find((entry) => entry.documentId === item.documentId);
      const selection = study.selections.find((entry) => entry.id === source?.selectionId);
      if (!source || !selection) invalid("study answer citation has no retained source");
      const sourceTitle = selection.origin.kind === "note" ? selection.document.title.replace(/^Unverified note: /, "") : selection.document.title;
      return `${selection.origin.kind === "note" ? "unverified note" : "source"}: ${sourceTitle}`;
    });
    return `- ${row.text} [${[...new Set(qualifiers)].join("; ")}]`;
  });
  const gaps = Array.isArray(draft.gaps) ? draft.gaps : [];
  if (draft.coverage === "partial" && gaps.length === 0) invalid("partial study answer has no stated qualification");
  const projection = [`Unverified study answer to: ${question.question}`, "", ...answer, "", `Coverage reported: ${draft.coverage}.`,
    ...(gaps.length ? ["Qualifications and gaps:", ...gaps.map((gap) => `- ${gap}`)] : [])].join("\n");
  if (!projection.isWellFormed() || projection.length > 20000) invalid("qualified study answer exceeds the note text limit");
  const noteTitle = title ?? `Study answer: ${question.question}`.slice(0, 200);
  if (typeof noteTitle !== "string" || !noteTitle.trim() || noteTitle.length > 200) invalid("invalid note title");
  const origin = { kind: "study", studyId: study.id, questionId, studySha256: study.sha256,
    resultSha256: hash(canonical(question.result)) };
  return reviseResearchNotebook(notebook, { type: "add-study-note", title: noteTitle, text: projection, id: noteId, origin });
}
/** Exports the validated portable study and its retained exact evidence. */
const safeMarkdown = (value) => String(value).replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char])
  .replace(/[\\`*_{}\[\]!|>#]/g, "\\$&").replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\r?\n/g, " ");

export function renderResearchStudy(value, { format = "json" } = {}) {
  const study = validateState(value);
  if (format === "json") return `${JSON.stringify(study, null, 2)}\n`;
  if (format !== "markdown") invalid("format must be json or markdown");
  const out = [`# ${safeMarkdown(study.title)}`, "", `Study ${study.id}; revision ${study.revision}.`, "", "## Selected evidence", ""];
  for (const selection of study.selections) out.push(`- ${selection.origin.kind === "note" ? "Unverified note" : "Source document"}: ${safeMarkdown(selection.document.title)} — notebook ${selection.origin.notebookId}, record ${selection.origin.recordId}${selection.origin.version ? ` v${selection.origin.version}` : ""}; origin SHA-256 ${selection.origin.sourceDigest}; selected from search hit ${selection.origin.hitId}.`);
  out.push("", "## Questions", "");
  for (const question of study.questions) {
    out.push(`### ${safeMarkdown(question.question)}`, "", `Status: ${question.result.status}; model-reported coverage: ${question.result.draft?.coverage ?? "no synthesized answer"}.`, "");
    out.push(question.result.draft?.answer.map((row) => `- ${safeMarkdown(row.text)} ${row.evidenceIds.map((evidenceId) => `[${evidenceId}]`).join(" ")}`).join("\n") ?? "No synthesized answer was retained.", "", "Gaps:", "", ...(question.result.draft?.gaps.map((gap) => `- ${safeMarkdown(gap)}`) ?? ["- No synthesized answer was retained."]), "");
  }
  for (const question of study.questions) {
    out.push(`## Cited text for ${safeMarkdown(question.id)}`, "");
    const evidenceItems = [...(question.result.draft?.evidence ?? []), ...question.result.passes.filter((pass) => pass.findings).flatMap((pass) => pass.findings.evidence)];
    for (const evidence of evidenceItems) {
      const source = question.sourceMap.find((entry) => entry.documentId === evidence.documentId);
      out.push(`- ${safeMarkdown(source?.kind === "note" ? "Unverified note" : "Source document")} ${safeMarkdown(source?.notebookId ?? "unknown")}, ${safeMarkdown(evidence.documentId)}, page ${evidence.page}, UTF-16 ${evidence.start}–${evidence.end}: ${safeMarkdown(evidence.quote)}`);
    }
    out.push("");
  }
  out.push("## Limits", "", "Question answers are fallible research; citations establish exact occurrence in retained text, not entailment or truth.", "Question-derived notes retain their original unverified status.");
  return `${out.join("\n")}\n`;
}
export const researchStudyLimits = Object.freeze({ selections: maxSelections, questions: maxQuestions, selectedQuestionSources: 8, bytes: byteLimit, schema });
