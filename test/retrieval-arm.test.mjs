import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createResearchNotebook, reviseResearchNotebook, exportResearchRetrievalArm } from "../src/index.mjs";

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const page = (number, text) => ({ number, text, sha256: sha(text) });
const doc = (text) => ({ id: "source:one", title: "Appeal policy", sha256: sha(`document:${text}`), pages: [page(1, text)] });
function corpus(text = "Appeal window lasts thirty days.") {
  let n = createResearchNotebook("Policy");
  n = reviseResearchNotebook(n, { type: "add-source", document: doc(text) });
  n = reviseResearchNotebook(n, { type: "add-note", title: "Retention", text: "Receipts stay for one year." });
  return n;
}
const questions = [{ id: "q:appeal", text: "appeal window" }, { id: "q:receipt", text: "receipts" }];
const revision = "55992df";

test("exports compatible frozen lexical arms with mode-independent corpus closure", () => {
  const n = corpus();
  const exact = exportResearchRetrievalArm([n], questions, { mode: "exact", researchRevision: revision });
  const fuzzy = exportResearchRetrievalArm([n], questions, { mode: "fuzzy", researchRevision: revision });
  assert.equal(exact.corpus.id, fuzzy.corpus.id);
  assert.deepEqual(exact.corpus.source_ids, exact.corpus.source_sha256.map((x) => x.id));
  assert.equal(exact.corpus.source_ids.length, 2, "all pages and retained note versions are included");
  assert.deepEqual(exact.arm.question_ids, questions.map((q) => q.id));
  assert.deepEqual(Object.keys(exact.arm.rankings), questions.map((q) => q.id));
  assert.equal(exact.arm.rankings["q:appeal"].length, 1);
  assert.ok(exact.corpus.source_ids.includes(exact.arm.rankings["q:appeal"][0]));
  assert.equal(exact.arm.provenance.reference, revision);
  assert.match(exact.corpus.id, /^research-corpus-sha256:[a-f0-9]{64}$/);
});

test("source byte changes alter corpus identity and invalid or excessive inputs refuse", () => {
  const a = exportResearchRetrievalArm([corpus()], questions, { researchRevision: revision });
  const b = exportResearchRetrievalArm([corpus("Appeal window lasts sixty days.")], questions, { researchRevision: revision });
  assert.notEqual(a.corpus.id, b.corpus.id);
  for (const [notebooks, qs, options] of [
    [[corpus()], [{ id: "q:x", text: "bad\nquestion" }], { researchRevision: revision }],
    [[corpus()], [questions[0], questions[0]], { researchRevision: revision }],
    [[corpus()], questions, { mode: "hybrid", researchRevision: revision }],
    [[corpus()], questions, { researchRevision: "" }],
    [[corpus()], Array.from({ length: 33 }, (_, i) => ({ id: `q:${i}`, text: "x" })), { researchRevision: revision }],
  ]) assert.throws(() => exportResearchRetrievalArm(notebooks, qs, options), /invalid_research_retrieval_arm/);
});
