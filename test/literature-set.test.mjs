import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { addLiteraturePaper, createLiteratureSet, createResearchNotebook, reviseResearchNotebook,
  deduplicateLiteraturePapers, exportLiteratureSet, formatLiteratureSet, prepareLiteratureQuestion, prepareNotebookQuestion, resolveLiteratureSet } from "../src/index.mjs";

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
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
