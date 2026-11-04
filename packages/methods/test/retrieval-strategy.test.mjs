import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createResearchNotebook, reviseResearchNotebook, exportResearchRetrievalStrategy, openResearchRetrievalSource } from "../src/index.mjs";
import { createHash } from "node:crypto";

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().filter((k) => v[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v);
function corpus() {
  let n = createResearchNotebook("Synthetic retrieval");
  n = reviseResearchNotebook(n, { type: "add-source", document: { id: "source:doc", title: "Astronomy", sha256: sha("doc-v1"), pages: [{ number: 1, text: "Comets follow elliptical orbits.", sha256: sha("Comets follow elliptical orbits.") }] } });
  n = reviseResearchNotebook(n, { type: "add-note", title: "Observation", text: "A retained note about distant icy bodies." });
  return n;
}
const questions = [{ id: "q:orbits", text: "elliptical orbits" }];
const revision = "rs08-test-revision";

test("strategy arms rank exact retained sources, fall back offline, and cold-reopen without rerunning", () => {
  const notebook = corpus();
  const lexical = exportResearchRetrievalStrategy([notebook], questions, { researchRevision: revision });
  const pageId = lexical.corpus.sources.find((source) => source.kind === "document").id;
  const note = lexical.corpus.sources.find((source) => source.kind === "note");
  const denseRows = { "q:orbits": [
    { id: note.id, sha256: lexical.corpus.source_sha256.find((item) => item.id === note.id).sha256, score: 0.99 },
    { id: pageId, sha256: lexical.corpus.source_sha256.find((item) => item.id === pageId).sha256, score: 0.1 },
  ] };
  const dense = exportResearchRetrievalStrategy([notebook], questions,
    { researchRevision: revision, strategy: "dense", denseRankings: denseRows });
  const hybrid = exportResearchRetrievalStrategy([notebook], questions,
    { researchRevision: revision, strategy: "hybrid", denseRankings: denseRows });
  const fallback = exportResearchRetrievalStrategy([notebook], questions,
    { researchRevision: revision, strategy: "hybrid", denseRankings: { "q:orbits": [] } });

  assert.equal(lexical.corpus.id, dense.corpus.id);
  assert.equal(lexical.corpus.id, hybrid.corpus.id);
  assert.equal(hybrid.arm.corpus_id, hybrid.corpus.id);
  assert.deepEqual(hybrid.arm.question_ids, questions.map(({ id }) => id));
  assert.ok(Object.values(hybrid.arm.rankings).flat().every((id) => hybrid.corpus.source_ids.includes(id)));
  assert.notEqual(hybrid.arm.strategy, lexical.arm.strategy);
  assert.deepEqual(lexical.questions, dense.questions);
  assert.equal(dense.arm.rankings["q:orbits"][0], note.id);
  assert.deepEqual(new Set(hybrid.arm.rankings["q:orbits"]), new Set([note.id, pageId]), "hybrid preserves the lexical and dense candidate union");
  assert.equal(fallback.diagnostics["q:orbits"].effectiveStrategy, "lexical");
  assert.equal(fallback.arm.strategy, "research-hybrid-with-lexical-fallback");
  assert.match(fallback.diagnostics["q:orbits"].fallbackReason, /no usable dense/);
  assert.equal(fallback.arm.rankings["q:orbits"][0], pageId);
  assert.match(hybrid.diagnostics["q:orbits"].scoreMeaning, /not evidence strength/);

  const cold = JSON.parse(JSON.stringify(dense));
  const reopened = openResearchRetrievalSource([JSON.parse(JSON.stringify(notebook))], cold, note.id);
  assert.equal(reopened.text, "A retained note about distant icy bodies.");
  assert.equal(reopened.version, 1);
  assert.equal(reopened.corpusCurrentness, "current");
  assert.deepEqual(reopened.rankedQuestions, [{ questionId: "q:orbits", rank: 1,
    effectiveStrategy: "dense", fallbackReason: null }]);
  const hybridSource = openResearchRetrievalSource([notebook], JSON.parse(JSON.stringify(hybrid)), pageId);
  assert.deepEqual(hybridSource.rankedQuestions, [{ questionId: "q:orbits",
    rank: hybrid.arm.rankings["q:orbits"].indexOf(pageId) + 1, effectiveStrategy: "hybrid", fallbackReason: null }]);
  const fallbackSource = openResearchRetrievalSource([notebook], JSON.parse(JSON.stringify(fallback)), pageId);
  assert.equal(fallbackSource.rankedQuestions[0].effectiveStrategy, "lexical");
  assert.match(fallbackSource.rankedQuestions[0].fallbackReason, /no usable dense/);
  assert.equal(openResearchRetrievalSource([notebook], cold, note.id, "q:orbits").id, note.id);
  assert.throws(() => openResearchRetrievalSource([notebook], cold, note.id, "q:other"), /not ranked for the requested question/);
  const tampered = JSON.parse(JSON.stringify(cold));
  tampered.corpus.sources.find((source) => source.id === note.id).content_sha256 = "f".repeat(64);
  tampered.sha256 = sha(canonical(Object.fromEntries(Object.entries(tampered).filter(([key]) => key !== "sha256"))));
  assert.throws(() => openResearchRetrievalSource([notebook], tampered, note.id), /metadata does not match/);
  const revised = reviseResearchNotebook(notebook, { type: "add-note", title: "Unrelated", text: "Added after the ranking was saved." });
  const reopenAfterUnrelatedChange = openResearchRetrievalSource([revised], cold, note.id);
  assert.equal(reopenAfterUnrelatedChange.text, reopened.text);
  assert.equal(reopenAfterUnrelatedChange.corpusCurrentness, "changed");
  assert.deepEqual(reopenAfterUnrelatedChange.corpusChanges, { added: 1, missing: 0, changed: 0 });
  const changedSource = reviseResearchNotebook(notebook, { type: "edit-note", id: note.record_id, title: "Observation", text: "Different retained note version." });
  const historical = openResearchRetrievalSource([changedSource], cold, note.id);
  assert.equal(historical.text, reopened.text, "an exact old retained note version remains openable after a later version is added");
  assert.equal(historical.corpusCurrentness, "changed");
  assert.equal(historical.corpusChanges.added, 1);
  assert.throws(() => exportResearchRetrievalStrategy([notebook], questions, { researchRevision: revision,
    strategy: "dense", denseRankings: { "q:orbits": [{ id: note.id, sha256: "0".repeat(64), score: 0.9 }] } }), /bind unique retained/);
});

test("standalone strategy and source actions round-trip through explicit JSON stdin", () => {
  const notebook = corpus();
  const cli = fileURLToPath(new URL("../bin/research-notebook-search.mjs", import.meta.url));
  const run = (action, request) => spawnSync(process.execPath, [cli, "--action", action],
    { input: JSON.stringify(request), encoding: "utf8", timeout: 10000 });
  const ranked = run("strategy", { notebooks: [notebook], questions,
    options: { researchRevision: revision, strategy: "hybrid" } });
  assert.equal(ranked.status, 0, ranked.stderr);
  const result = JSON.parse(ranked.stdout);
  const sourceId = result.arm.rankings["q:orbits"][0];
  const reopened = run("source", { notebooks: [notebook], result, sourceId, questionId: "q:orbits" });
  assert.equal(reopened.status, 0, reopened.stderr);
  assert.equal(JSON.parse(reopened.stdout).id, sourceId);
  assert.deepEqual(JSON.parse(reopened.stdout).rankedQuestions, [{ questionId: "q:orbits",
    rank: 1, effectiveStrategy: "lexical", fallbackReason: "dense input absent" }]);
  const wrongQuestion = run("source", { notebooks: [notebook], result, sourceId, questionId: "q:other" });
  assert.equal(wrongQuestion.status, 1);
  assert.match(wrongQuestion.stderr, /not ranked for the requested question/);
});
