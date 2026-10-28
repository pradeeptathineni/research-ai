// src/notebook.mjs - Portable, versioned notebooks over retained complete documents.
//
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { prepareDocumentCoverage, validateDocumentCoverage } from "./document-coverage.mjs";

const schema = "research-notebook-v1";
const previewSchema = "research-notebook-question-preview-v1";
const byteLimit = 16 * 1024 * 1024;
const caps = Object.freeze({ sources: 16, notes: 32, versions: 16, questions: 32 });
const digestPattern = /^[a-f0-9]{64}$/;
const idPattern = /^(notebook|source|note|question):[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, expected) => plain(value)
  && Object.keys(value).sort().join() === [...expected].sort().join();
const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : plain(value) ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  : JSON.stringify(value);
const clone = (value) => JSON.parse(JSON.stringify(value));
const invalid = (reason) => { throw new Error(`invalid_research_notebook: ${reason}`); };
const text = (value, max, multiline = false) => typeof value === "string" && value.length > 0
  && value.length <= max && value.isWellFormed() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)
  && (multiline || !/[\r\n]/u.test(value));
const recordId = (prefix, value = `${prefix}:${randomUUID()}`) => {
  if (typeof value !== "string" || !idPattern.test(value) || !value.startsWith(`${prefix}:`)) invalid(`invalid ${prefix} ID`);
  return value;
};
const notebookDigest = (value) => hash(canonical(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "sha256"))));
const stateSize = (value) => Buffer.byteLength(canonical(value), "utf8");
const sealed = (value, keysExpected, label) => {
  if (!keys(value, keysExpected)) invalid(`${label} has unknown or missing fields`);
  return value;
};
const allowed = (value, required, optional = []) => plain(value)
  && required.every((key) => Object.hasOwn(value, key))
  && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));

function sourceDocument(value) {
  if (!keys(value, ["id", "title", "sha256", "pages"])) invalid("invalid source document fields");
  if (!digestPattern.test(value.sha256)) invalid("source document digest must be SHA-256");
  // The caller owns the document-level digest; this validates every page and its coverage bounds.
  return prepareDocumentCoverage("Validate retained source pages", [value], {
    maxCalls: 64, passUtf16Units: 48000,
  }).documents[0];
}

function shouldaSourceOrigin(value, document) {
  const fields = ["schemaVersion", "kind", "sourceSelectionId", "selectionReceiptSha256", "repository", "sourceId",
    "headCommit", "snapshotFingerprint", "sourceInspectionId", "sourceAssessmentId", "decisionId", "files",
    "nearbyDocuments", "qualificationBasis", "legalCompatibility"];
  if (!keys(value, fields) || value.schemaVersion !== 1 || value.kind !== "shoulda-source-selection")
    invalid("invalid Shoulda source origin fields");
  if (!/^sfs_[0-9a-f]{24}$/.test(value.sourceSelectionId) || !digestPattern.test(value.selectionReceiptSha256)
      || typeof value.repository !== "string" || !/^[^\s/]+\/[^\s/]+$/.test(value.repository)
      || typeof value.sourceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value.sourceId)
      || !/^[0-9a-f]{40,64}$/.test(value.headCommit)
      || typeof value.snapshotFingerprint !== "string" || !/^srcsnap_[0-9a-f]{64}$/.test(value.snapshotFingerprint)
      || !/^sdi_[0-9a-f]{24}$/.test(value.sourceInspectionId)
      || !/^sda_[0-9a-f]{24}$/.test(value.sourceAssessmentId)
      || !/^dec_[0-9a-f]{16,64}$/.test(value.decisionId)
      || value.qualificationBasis !== "caller-authored-only" || value.legalCompatibility !== "not-assessed"
      || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 20
      || !Array.isArray(value.nearbyDocuments)) invalid("invalid Shoulda source identity or qualification");
  if (value.files.length !== document.pages.length) invalid("Shoulda source file/page binding mismatch");
  const paths = new Set();
  const files = value.files.map((file, index) => {
    if (!keys(file, ["page", "path", "role", "sha256", "byteCount"]) || file.page !== index + 1
        || typeof file.path !== "string" || !file.path || file.path.startsWith("/") || file.path.includes("\\")
        || file.path.split("/").some((part) => !part || part === "." || part === "..")
        || typeof file.role !== "string" || !file.role || file.role.length > 80
        || !digestPattern.test(file.sha256) || !Number.isSafeInteger(file.byteCount) || file.byteCount < 0 || file.byteCount > 262144
        || paths.has(file.path) || document.pages[index].sha256 !== file.sha256
        || Buffer.byteLength(document.pages[index].text, "utf8") !== file.byteCount)
      invalid("Shoulda source file identity does not match its retained page");
    paths.add(file.path);
    return { page: file.page, path: file.path, role: file.role, sha256: file.sha256, byteCount: file.byteCount };
  });
  const nearbyDocuments = value.nearbyDocuments.map((item) => {
    if (!keys(item, ["path", "kind", "sha256", "truncated", "state"]) || typeof item.path !== "string"
        || !["readme", "license", "notice"].includes(item.kind)
        || (item.sha256 !== null && !digestPattern.test(item.sha256))
        || typeof item.truncated !== "boolean"
        || !["observed", "missing", "symlink", "unavailable"].includes(item.state))
      invalid("invalid retained Shoulda notice evidence");
    return { path: item.path, kind: item.kind, sha256: item.sha256, truncated: item.truncated, state: item.state };
  });
  return { schemaVersion: 1, kind: "shoulda-source-selection", sourceSelectionId: value.sourceSelectionId,
    selectionReceiptSha256: value.selectionReceiptSha256, repository: value.repository, sourceId: value.sourceId,
    headCommit: value.headCommit, snapshotFingerprint: value.snapshotFingerprint,
    sourceInspectionId: value.sourceInspectionId, sourceAssessmentId: value.sourceAssessmentId, decisionId: value.decisionId,
    files, nearbyDocuments, qualificationBasis: "caller-authored-only", legalCompatibility: "not-assessed" };
}


function noteVersion(value, expectedVersion, noteId, questionIds) {
  sealed(value, ["version", "title", "text", "origin", "sha256"], "note version");
  if (value.version !== expectedVersion || !text(value.title, 200) || !text(value.text, 20000, true)) invalid("invalid note version content");
  if (!plain(value.origin)) invalid("note origin must be an object");
  if (value.origin.kind === "human") {
    sealed(value.origin, ["kind", "questionId"], "note origin");
    if (value.origin.questionId !== null) invalid("human note cannot name a question");
  } else if (value.origin.kind === "question") {
    sealed(value.origin, ["kind", "questionId"], "note origin");
    recordId("question", value.origin.questionId);
    if (!questionIds.has(value.origin.questionId)) invalid("note origin names a missing question");
  } else if (value.origin.kind === "study") {
    sealed(value.origin, ["kind", "studyId", "questionId", "studySha256", "resultSha256"], "study note origin");
    if (!/^study:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.origin.studyId)
        || !/^study-question:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.origin.questionId)
        || !digestPattern.test(value.origin.studySha256) || !digestPattern.test(value.origin.resultSha256)) invalid("invalid study note provenance");
  } else invalid("invalid note origin kind");
  const content = { version: value.version, title: value.title, text: value.text, origin: value.origin };
  if (value.sha256 !== hash(canonical(content))) invalid("note version digest mismatch");
  return { ...content, sha256: value.sha256 };
}

function noteDocument(note, versionNumber) {
  const version = note.versions.find((entry) => entry.version === versionNumber);
  if (!version) invalid("selected note version is not retained");
  const id = `notebook-note-${hash(`${note.id}\n${version.version}`).slice(0, 48)}`;
  const pageText = version.text;
  const page = { number: 1, text: pageText, sha256: hash(pageText) };
  const document = { id, title: `Unverified note: ${version.title}`, sha256: hash(`${id}\n${version.sha256}`), pages: [page] };
  return { document, digest: version.sha256, title: version.title };
}

function specShape(spec) {
  sealed(spec, ["id", "question", "sourceIds", "notes"], "question spec");
  recordId("question", spec.id);
  if (!text(spec.question, 2000) || !Array.isArray(spec.sourceIds) || !Array.isArray(spec.notes)
      || spec.sourceIds.length > caps.sources || spec.notes.length > caps.notes) invalid("invalid question scope");
  if (spec.sourceIds.some((id) => typeof id !== "string") || new Set(spec.sourceIds).size !== spec.sourceIds.length) invalid("duplicate or invalid source selection");
  const seenNotes = new Set();
  for (const selected of spec.notes) {
    sealed(selected, ["id", "version"], "selected note");
    recordId("note", selected.id);
    if (!Number.isSafeInteger(selected.version) || selected.version < 1 || seenNotes.has(selected.id)) invalid("duplicate or invalid note version selection");
    seenNotes.add(selected.id);
  }
  if (spec.sourceIds.length + spec.notes.length === 0) invalid("question scope must explicitly select a source or note");
}

function prepareScope(notebook, spec, policy) {
  specShape(spec);
  const bySource = new Map(notebook.sources.map((entry) => [entry.id, entry]));
  const byNote = new Map(notebook.notes.map((entry) => [entry.id, entry]));
  const documents = [];
  const sourceMap = [];
  for (const id of spec.sourceIds) {
    const entry = bySource.get(id);
    if (!entry) invalid("selected source does not belong to this notebook");
    documents.push(clone(entry.document));
    sourceMap.push({ documentId: entry.document.id, kind: "document", recordId: id, version: null,
      digest: entry.digest, title: entry.document.title });
  }
  for (const selected of spec.notes) {
    const note = byNote.get(selected.id);
    if (!note) invalid("selected note does not belong to this notebook");
    const selectedVersion = note.versions.find((entry) => entry.version === selected.version);
    if (!selectedVersion) invalid("selected note version is not retained");
    if (selectedVersion.origin.kind === "question" && selectedVersion.origin.questionId === spec.id)
      invalid("a question cannot cite a note saved from itself");
    const { document, digest, title } = noteDocument(note, selected.version);
    documents.push(document);
    sourceMap.push({ documentId: document.id, kind: "note", recordId: note.id, version: selected.version, digest, title });
  }
  const plan = prepareDocumentCoverage(spec.question, documents, policy);
  const normalizedSpec = clone(spec);
  const scopeDigest = hash(canonical({ notebookId: notebook.id, spec: normalizedSpec, documents: plan.documents, policy: plan.policy }));
  return { plan, sourceMap, scopeDigest, spec: normalizedSpec };
}

function validateQuestion(notebook, value, priorQuestionIds) {
  sealed(value, ["id", "question", "scopeDigest", "notebookDigest", "spec", "sourceMap", "policy", "result"], "question record");
  recordId("question", value.id);
  if (value.spec.id !== value.id || value.question !== value.spec.question
      || !digestPattern.test(value.scopeDigest) || !digestPattern.test(value.notebookDigest)) invalid("invalid question identity or digests");
  const prepared = prepareScope(notebook, value.spec, value.policy);
  for (const selected of value.spec.notes) {
    const note = notebook.notes.find((entry) => entry.id === selected.id);
    const version = note.versions.find((entry) => entry.version === selected.version);
    if (version.origin.kind === "question" && !priorQuestionIds.has(version.origin.questionId))
      invalid("question-derived notes may be used only by later questions");
  }
  if (prepared.scopeDigest !== value.scopeDigest || !isDeepStrictEqual(prepared.sourceMap, value.sourceMap)) invalid("question scope binding mismatch");
  const result = validateDocumentCoverage(value.result);
  if (!isDeepStrictEqual(result.plan, prepared.plan)) invalid("question result does not bind its selected complete inputs");
  priorQuestionIds.add(value.id);
  return { id: value.id, question: value.question, scopeDigest: value.scopeDigest,
    notebookDigest: value.notebookDigest, spec: clone(value.spec), sourceMap: clone(value.sourceMap),
    policy: clone(value.policy), result };
}

function validateState(value) {
  sealed(value, ["version", "id", "title", "topic", "revision", "sources", "notes", "questions", "sha256"], "notebook");
  if (value.version !== schema || !idPattern.test(value.id) || !value.id.startsWith("notebook:")
      || !text(value.title, 200) || !(value.topic === "" || text(value.topic, 2000, true))
      || !Number.isSafeInteger(value.revision) || value.revision < 1
      || !Array.isArray(value.sources) || value.sources.length > caps.sources || !Array.isArray(value.notes) || value.notes.length > caps.notes
      || !Array.isArray(value.questions) || value.questions.length > caps.questions) invalid("invalid notebook header or capacity");
  const sources = [];
  const sourceIds = new Set();
  const documents = new Set();
  for (const entry of value.sources) {
    if (!allowed(entry, ["id", "document", "digest"], ["shouldaOrigin"])) invalid("source record has unknown or missing fields");
    recordId("source", entry.id);
    if (sourceIds.has(entry.id) || !digestPattern.test(entry.digest)) invalid("duplicate source or invalid digest");
    const document = sourceDocument(entry.document);
    if (documents.has(document.id)) invalid("duplicate retained document ID");
    documents.add(document.id);
    const digest = hash(canonical(document));
    if (digest !== entry.digest) invalid("source record digest mismatch");
    sourceIds.add(entry.id);
    const source = { id: entry.id, document, digest };
    if (entry.shouldaOrigin !== undefined) source.shouldaOrigin = shouldaSourceOrigin(entry.shouldaOrigin, document);
    sources.push(source);
  }
  const noteIds = new Set();
  const notes = [];
  for (const note of value.notes) {
    sealed(note, ["id", "versions"], "note record");
    recordId("note", note.id);
    if (noteIds.has(note.id) || !Array.isArray(note.versions) || note.versions.length < 1 || note.versions.length > caps.versions) invalid("duplicate note or invalid version count");
    noteIds.add(note.id);
    const versions = note.versions.map((entry, index) => noteVersion(entry, index + 1, note.id, new Set(value.questions.map((item) => item.id))));
    notes.push({ id: note.id, versions });
  }
  const questionIds = new Set();
  const questions = value.questions.map((question) => {
    if (questionIds.has(question?.id)) invalid("duplicate question ID");
    return validateQuestion({ ...value, sources, notes }, question, questionIds);
  });
  const normalized = { version: schema, id: value.id, title: value.title, topic: value.topic, revision: value.revision,
    sources, notes, questions, sha256: value.sha256 };
  if (!digestPattern.test(value.sha256) || notebookDigest(normalized) !== value.sha256) invalid("notebook digest mismatch");
  if (stateSize(normalized) > byteLimit) invalid("notebook exceeds the 16 MiB state limit");
  return normalized;
}

function seal(value) {
  const next = { ...value };
  delete next.sha256;
  next.sha256 = notebookDigest(next);
  if (stateSize(next) > byteLimit) invalid("notebook exceeds the 16 MiB state limit");
  return next;
}

function changed(notebook, patch) {
  return validateState(seal({ ...notebook, ...patch, revision: notebook.revision + 1 }));
}

/** Starts a notebook record that callers can save as ordinary JSON. */
export function createResearchNotebook(title, { topic = "", id } = {}) {
  if (!text(title, 200) || !(topic === "" || text(topic, 2000, true))) invalid("invalid notebook title or topic");
  const value = { version: schema, id: recordId("notebook", id), title, topic, revision: 1, sources: [], notes: [], questions: [] };
  return validateState(seal(value));
}

/** Replays the closed state, every retained page, note version and cited question result. */
export function validateResearchNotebook(value) {
  return validateState(value);
}

/** Applies one explicit append or metadata edit and returns a new notebook value. */
export function reviseResearchNotebook(value, edit) {
  const notebook = validateState(value);
  if (!plain(edit) || typeof edit.type !== "string") invalid("revision must name one edit type");
  if (edit.type === "rename" && allowed(edit, ["type"], ["title", "topic"])
      && (Object.hasOwn(edit, "title") || Object.hasOwn(edit, "topic"))) {
    const title = edit.title ?? notebook.title;
    const topic = edit.topic ?? notebook.topic;
    if (!text(title, 200) || !(topic === "" || text(topic, 2000, true))) invalid("invalid notebook title or topic");
    return changed(notebook, { title, topic });
  }
  if (edit.type === "add-source" && allowed(edit, ["type", "document"], ["id"])) {
    if (notebook.sources.length >= caps.sources) invalid("notebook source capacity reached");
    const id = recordId("source", edit.id);
    if (notebook.sources.some((entry) => entry.id === id)) invalid("source ID already exists");
    const document = sourceDocument(edit.document);
    if (notebook.sources.some((entry) => entry.document.id === document.id)) invalid("document ID already exists");
    const digest = hash(canonical(document));
    return changed(notebook, { sources: [...notebook.sources, { id, document, digest }] });
  }
  if (edit.type === "add-shoulda-source" && allowed(edit, ["type", "document", "origin"], ["id"])) {
    if (notebook.sources.length >= caps.sources) invalid("notebook source capacity reached");
    const id = recordId("source", edit.id);
    if (notebook.sources.some((entry) => entry.id === id)) invalid("source ID already exists");
    const document = sourceDocument(edit.document);
    if (notebook.sources.some((entry) => entry.document.id === document.id)) invalid("document ID already exists");
    const shouldaOrigin = shouldaSourceOrigin(edit.origin, document);
    const digest = hash(canonical(document));
    return changed(notebook, { sources: [...notebook.sources, { id, document, digest, shouldaOrigin }] });
  }
  if (edit.type === "add-note" && allowed(edit, ["type", "title", "text"], ["id"])) {
    if (notebook.notes.length >= caps.notes) invalid("notebook note capacity reached");
    const id = recordId("note", edit.id);
    if (notebook.notes.some((entry) => entry.id === id)) invalid("note ID already exists");
    if (!text(edit.title, 200) || !text(edit.text, 20000, true)) invalid("invalid note content");
    const content = { version: 1, title: edit.title, text: edit.text, origin: { kind: "human", questionId: null } };
    const version = { ...content, sha256: hash(canonical(content)) };
    return changed(notebook, { notes: [...notebook.notes, { id, versions: [version] }] });
  }
  if (edit.type === "add-study-note" && allowed(edit, ["type", "title", "text", "origin"], ["id"])) {
    if (notebook.notes.length >= caps.notes) invalid("notebook note capacity reached");
    const id = recordId("note", edit.id);
    if (notebook.notes.some((entry) => entry.id === id)) invalid("note ID already exists");
    if (!text(edit.title, 200) || !text(edit.text, 20000, true)) invalid("invalid note content");
    const content = { version: 1, title: edit.title, text: edit.text, origin: clone(edit.origin) };
    const version = noteVersion({ ...content, sha256: hash(canonical(content)) }, 1, id, new Set(notebook.questions.map((entry) => entry.id)));
    return changed(notebook, { notes: [...notebook.notes, { id, versions: [version] }] });
  }
  if (edit.type === "edit-note" && keys(edit, ["type", "id", "title", "text"])) {
    const id = recordId("note", edit.id);
    if (!text(edit.title, 200) || !text(edit.text, 20000, true)) invalid("invalid note content");
    const index = notebook.notes.findIndex((entry) => entry.id === id);
    if (index < 0) invalid("note does not belong to this notebook");
    const note = notebook.notes[index];
    if (note.versions.length >= caps.versions) invalid("note version capacity reached");
    const previous = note.versions.at(-1);
    const content = { version: previous.version + 1, title: edit.title, text: edit.text, origin: previous.origin };
    const versions = [...note.versions, { ...content, sha256: hash(canonical(content)) }];
    const notes = [...notebook.notes];
    notes[index] = { id, versions };
    return changed(notebook, { notes });
  }
  invalid("unknown revision type or fields");
}

/** Builds exact explicit inputs and a metadata-only consent projection without inference. */
export function prepareNotebookQuestion(value, spec, policy = {}) {
  const notebook = validateState(value);
  const prepared = prepareScope(notebook, spec, policy);
  const plan = prepared.plan;
  return {
    version: previewSchema,
    notebookId: notebook.id,
    notebookDigest: notebook.sha256,
    spec: prepared.spec,
    scopeDigest: prepared.scopeDigest,
    sourceMap: prepared.sourceMap,
    request: { question: plan.question, documents: clone(plan.documents), policy: plan.policy },
    preview: {
      scopeDigest: prepared.scopeDigest, planDigest: plan.planDigest, inputDigest: plan.inputDigest,
      counts: clone(plan.counts), policy: clone(plan.policy),
      sources: prepared.sourceMap.map((source) => ({ ...source,
        pages: plan.documents.find((document) => document.id === source.documentId).pages.length })),
    },
  };
}

/** Retains a validated complete, partial or failed coverage result against its original selected versions. */
export function recordNotebookQuestion(value, prepared, resultValue) {
  const notebook = validateState(value);
  if (!keys(prepared, ["version", "notebookId", "notebookDigest", "spec", "scopeDigest", "sourceMap", "request", "preview"])
      || prepared.version !== previewSchema || prepared.notebookId !== notebook.id
      || !digestPattern.test(prepared.notebookDigest) || !digestPattern.test(prepared.scopeDigest)) invalid("invalid prepared question");
  const replayed = prepareScope(notebook, prepared.spec, prepared.request?.policy);
  if (replayed.scopeDigest !== prepared.scopeDigest || !isDeepStrictEqual(replayed.sourceMap, prepared.sourceMap)
      || !isDeepStrictEqual(replayed.plan.documents, prepared.request.documents)
      || replayed.plan.question !== prepared.request.question
      || !isDeepStrictEqual(replayed.plan.policy, prepared.request.policy)
      || !isDeepStrictEqual(replayed.plan.planDigest, prepared.preview?.planDigest)
      || prepared.preview?.scopeDigest !== prepared.scopeDigest) invalid("prepared question no longer matches retained scope");
  const result = validateDocumentCoverage(resultValue);
  if (!isDeepStrictEqual(result.plan, replayed.plan)) invalid("result does not match confirmed question plan");
  const question = { id: prepared.spec.id, question: prepared.spec.question, scopeDigest: prepared.scopeDigest,
    notebookDigest: prepared.notebookDigest, spec: clone(prepared.spec), sourceMap: clone(prepared.sourceMap),
    policy: clone(prepared.request.policy), result };
  const prior = notebook.questions.find((entry) => entry.id === question.id);
  if (prior) {
    if (prior.scopeDigest === question.scopeDigest && prior.result.receipt.contentSha256 === result.receipt.contentSha256) return notebook;
    invalid("question ID already names a different retained result");
  }
  if (notebook.questions.length >= caps.questions) invalid("notebook question capacity reached");
  return changed(notebook, { questions: [...notebook.questions, question] });
}

/** Creates an editable, unverified note from a retained nonempty answer without inference. */
export function saveNotebookQuestionAsNote(value, questionId, { title, id } = {}) {
  const notebook = validateState(value);
  recordId("question", questionId);
  const question = notebook.questions.find((entry) => entry.id === questionId);
  if (!question) invalid("question does not belong to this notebook");
  const answer = question.result.draft?.answer.map((row) => row.text).join("\n\n").trim();
  if (!answer) invalid("question has no nonempty synthesized answer to save");
  if (!text(answer, 20000, true)) invalid("synthesized answer exceeds the 20,000 UTF-16 unit note limit");
  if (notebook.notes.length >= caps.notes) invalid("notebook note capacity reached");
  const noteId = recordId("note", id);
  if (notebook.notes.some((entry) => entry.id === noteId)) invalid("note ID already exists");
  const noteTitle = title ?? `Answer: ${question.question}`.slice(0, 200);
  if (!text(noteTitle, 200)) invalid("invalid note title");
  const content = { version: 1, title: noteTitle, text: answer, origin: { kind: "question", questionId } };
  const note = { id: noteId, versions: [{ ...content, sha256: hash(canonical(content)) }] };
  return changed(notebook, { notes: [...notebook.notes, note] });
}

/** Opens one exact retained quote and its original document or note version. */
export function getNotebookCitation(value, questionId, evidenceId) {
  const notebook = validateState(value);
  const question = notebook.questions.find((entry) => entry.id === questionId);
  if (!question) invalid("question does not belong to this notebook");
  const evidence = [...(question.result.draft?.evidence ?? []), ...question.result.passes.filter((pass) => pass.findings)
    .flatMap((pass) => pass.findings.evidence)].find((item) => item.id === evidenceId);
  if (!evidence) invalid("evidence ID is not retained in this question");
  const source = question.sourceMap.find((item) => item.documentId === evidence.documentId);
  if (!source) invalid("evidence has no retained source map entry");
  let retained;
  if (source.kind === "document") retained = notebook.sources.find((entry) => entry.id === source.recordId);
  else {
    const note = notebook.notes.find((entry) => entry.id === source.recordId);
    const version = note?.versions.find((entry) => entry.version === source.version);
    if (version) retained = { id: note.id, version: clone(version) };
  }
  if (!retained) invalid("original evidence source version is missing");
  const document = question.result.plan.documents.find((entry) => entry.id === evidence.documentId);
  const page = document?.pages.find((entry) => entry.number === evidence.page);
  if (!page || page.text.slice(evidence.start, evidence.end) !== evidence.quote) invalid("retained citation no longer matches its exact page");
  return { evidence: clone(evidence), document: clone(document), page: clone(page), source: clone(retained) };
}

const escapeText = (value) => value.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char])
  .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (char) => `\\u${char.codePointAt(0).toString(16).padStart(4, "0")}`)
  .replace(/([\\`*_{}\[\]!|>#])/g, "\\$1");

/** Reopens all retained notebook content as JSON or safe plain Markdown. */
export function renderResearchNotebook(value, { format = "json" } = {}) {
  const notebook = validateState(value);
  if (format === "json") return `${JSON.stringify(notebook, null, 2)}\n`;
  if (format !== "markdown") invalid("format must be json or markdown");
  const out = [`# ${escapeText(notebook.title)}`, "", escapeText(notebook.topic), "", "## Sources", ""];
  for (const entry of notebook.sources) {
    out.push(`### ${escapeText(entry.document.title)} (${escapeText(entry.document.id)})`, "");
    for (const page of entry.document.pages) out.push(`#### Page ${page.number}`, "", escapeText(page.text), "");
  }
  out.push("## Notes", "");
  for (const note of notebook.notes) for (const version of note.versions) {
    const label = version.origin.kind === "question" || version.origin.kind === "study" ? `Unverified answer note: ${version.title}` : version.title;
    const origin = version.origin.kind === "study" ? `study ${version.origin.studyId}, question ${version.origin.questionId}, study SHA-256 ${version.origin.studySha256}, result SHA-256 ${version.origin.resultSha256}`
      : `${version.origin.kind}${version.origin.questionId ? ` (${escapeText(version.origin.questionId)})` : ""}`;
    out.push(`### ${escapeText(label)} — ${escapeText(note.id)} v${version.version}`, "", escapeText(version.text), "",
      `Origin: ${origin}`, "");
  }
  out.push("## Questions", "");
  for (const question of notebook.questions) out.push(`### ${escapeText(question.question)}`, "",
    `Status: ${question.result.status}; coverage: ${question.result.draft?.coverage ?? "no synthesized answer"}.`, "",
    question.result.draft?.answer.map((row) => `- ${escapeText(row.text)} ${row.evidenceIds.map((id) => `[${escapeText(id)}]`).join(" ")}`).join("\n") ?? "No synthesized answer.", "",
    "Gaps:", "", ...(question.result.draft?.gaps.map((gap) => `- ${escapeText(gap)}`) ?? ["- No synthesized answer was retained."]), "");
  return `${out.join("\n")}\n`;
}

export const researchNotebookLimits = Object.freeze({ ...caps, bytes: byteLimit, titleUtf16Units: 200, topicUtf16Units: 2000,
  noteTextUtf16Units: 20000, schema });
