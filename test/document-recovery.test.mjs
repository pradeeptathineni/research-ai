import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDocumentRecovery, renderDocumentRecovery, retryDocumentRecovery, runDocumentRecovery, validateDocumentRecovery } from "../src/index.mjs";
import { prepareDocumentCoverage, researchDocumentCoverage } from "../src/index.mjs";
import { fakeCodex, message } from "./fake-codex.mjs";

const hash = text => createHash("sha256").update(text, "utf8").digest("hex");
const documents = [{ id: "paper", title: "Synthetic 64-page paper", sha256: hash("synthetic raw document bytes"),
  pages: Array.from({ length: 64 }, (_, index) => {
    const number = index + 1, text = `Page ${number} finding: measured value ${number} units.`;
    return { number, text, sha256: hash(text) };
  }) }];
const sections = [
  { id: "document", parentId: null, title: "Synthetic paper", pageRefs: [], extractionGaps: [] },
  ...Array.from({ length: 8 }, (_, index) => ({ id: `section-${index + 1}`, parentId: "document", title: `Section ${index + 1}`,
    pageRefs: Array.from({ length: 8 }, (_, offset) => ({ documentId: "paper", page: index * 8 + offset + 1 })),
    extractionGaps: index === 6 ? [
      { id: "table-gap", kind: "table", documentId: "paper", page: 50,
        detail: "The extracted text omits a table cell region.", assertedBy: "fixture-extractor", observedAt: "2026-10-27T10:00:00Z" },
      { id: "ocr-gap", kind: "ocr", documentId: "paper", page: 51,
        detail: "A scanned margin region may not be represented in extracted text.", assertedBy: "fixture-extractor", observedAt: "2026-10-27T10:00:00Z" },
    ] : [] })),
];
const policy = { maxCallsPerSection: 2, maxRetriesPerSection: 1, totalMaxCalls: 32, passUtf16Units: 1000, maxSecondsPerSection: 10 };
const reply = value => ({ events: [message(JSON.stringify(value)), { type: "turn.completed" }] });
const calls = async fixture => { let count = 0; while (await fixture.session(count).then(() => true, () => false)) count++; return count; };
function successSessions(startPage) {
  const evidence = Array.from({ length: 8 }, (_, index) => { const page = startPage + index; return ({ id: `q${index + 1}`, windowId: `w${String(index + 1).padStart(4, "0")}`,
    quote: `Page ${page} finding: measured value ${page} units.`, relation: "supporting", occurrence: null }); });
  const review = reply({ answer: evidence.map(item => ({ text: `The retained page reports ${item.quote}`, evidenceIds: [item.id] })), evidence, coverage: "answered", gaps: [] });
  const synthesis = reply({ answer: [{ text: "The reviewed section contains exact page findings.", evidenceIds: ["p01-e01"] }], coverage: "answered", gaps: [] });
  return [review, synthesis];
}
const startError = () => ({ events: [{ type: "turn.failed", error: { message: "synthetic section failure" } }] });

test("64-page hierarchical closure retries only failed leaf and never hides extraction gaps", async () => {
  const sessions = [];
  for (let section = 1; section <= 8; section++) {
    if (section === 4) sessions.push(startError());
    else sessions.push(...successSessions((section - 1) * 8 + 1));
  }
  sessions.push(...successSessions(25)); // section-4 retry only
  const fixture = await fakeCodex({ sessions });
  try {
    let recovery = createDocumentRecovery("What measurements are reported?", { documents, sections, policy });
    assert.equal(recovery.version, "research-document-recovery-v1");
    assert.equal(recovery.plannedMaximumCalls, 32);
    await assert.rejects(runDocumentRecovery(recovery, { confirmedSha256: "0".repeat(64), lease: fixture.lease }), /confirm the exact recovery plan/);
    assert.deepEqual(await fixture.probes(), [], "stale confirmation refuses before runner probes");
    const initialSha = recovery.sha256;
    recovery = await runDocumentRecovery(recovery, { confirmedSha256: initialSha, lease: fixture.lease });
    assert.equal(recovery.sections[3].attempts[0].status, "failed");
    assert.equal(recovery.sections[0].attempts.length, 1);
    assert.equal(recovery.aggregate.status, "partial", JSON.stringify(recovery.sections.map(section => section.attempts.map(attempt => ({ status: attempt.status, failure: attempt.failure, owner: attempt.result?.status, synthesis: attempt.result?.synthesis, draft: attempt.result?.draft?.coverage })))));
    assert.ok(recovery.aggregate.gaps.some(gap => /caller-declared table extraction gap/.test(gap)));
    assert.ok(recovery.aggregate.gaps.some(gap => /caller-declared ocr extraction gap/.test(gap)));
    assert.ok(recovery.aggregate.gaps.some(gap => /Section 4: execution failed/.test(gap)));
    const beforeRetry = recovery.sha256;
    await assert.rejects(retryDocumentRecovery(recovery, ["section-1"], { confirmedSha256: beforeRetry, lease: fixture.lease }), /not an execution or answer-coverage retry candidate/);
    assert.equal(await calls(fixture), 15, "only 7 successful leaves and one failed leaf ran");
    const frozen = JSON.parse(JSON.stringify(recovery));
    recovery = await retryDocumentRecovery(recovery, ["section-4"], { confirmedSha256: beforeRetry, lease: fixture.lease });
    assert.deepEqual(JSON.parse(JSON.stringify(frozen)).sections[3].attempts.map(attempt => attempt.status), ["failed"]);
    assert.deepEqual(recovery.sections[3].attempts.map(attempt => attempt.status), ["failed", "complete"]);
    assert.equal(recovery.sections[0].attempts.length, 1, "other sections were not rerun");
    assert.equal(await calls(fixture), 17);
    assert.ok(recovery.aggregate.startedCalls <= recovery.aggregate.plannedMaximumCalls);
    assert.equal(recovery.aggregate.status, "partial", "declared extraction gap survives recovery");
    assert.ok(recovery.aggregate.answer.length >= 7);
    const citation = recovery.aggregate.answer.find(row => row.sectionId === "section-6").citations[0];
    const originalPage = documents[0].pages[citation.page - 1];
    assert.equal(citation.documentId, "paper");
    assert.equal(citation.documentSha256, documents[0].sha256);
    assert.equal(citation.pageSha256, originalPage.sha256);
    assert.equal(originalPage.text.slice(citation.start, citation.end), citation.quote);
    assert.match(citation.quote, /Page 41 finding/);
    const retryPrompt = (await fixture.session(15)).prompt;
    assert.match(retryPrompt, /Page 25 finding/);
    assert.doesNotMatch(retryPrompt, /Page 1 finding|Page 41 finding/);
    const reopened = validateDocumentRecovery(JSON.parse(renderDocumentRecovery(recovery, { format: "json" })));
    assert.deepEqual(reopened, JSON.parse(renderDocumentRecovery(recovery, { format: "json" })));
    const markdown = renderDocumentRecovery(recovery, { format: "markdown" });
    assert.match(markdown, /Recovery status: partial/);
    assert.match(markdown, /unverified extraction metadata/);
    assert.match(markdown, /source SHA-256/);
  } finally { await fixture.cleanup(); }
});

test("closed retry reservation rejects excess sections before dispatch", () => {
  assert.throws(() => createDocumentRecovery("question", { documents, sections,
    policy: { ...policy, totalMaxCalls: 31 } }), /closed call reservation 32 exceeds totalMaxCalls 31/);
  const changed = structuredClone(sections);
  changed[2].pageRefs[0].page = 64;
  assert.throws(() => createDocumentRecovery("question", { documents, sections: changed, policy }), /assigned more than once/);
});

test("unknown post-invocation outcome stops later sections and refuses replay", async () => {
  let invocations = 0;
  const recovery = createDocumentRecovery("Question", { documents, sections, policy });
  const dispatched = await runDocumentRecovery(recovery, { confirmedSha256: recovery.sha256, dispatchSection: async () => {
    invocations++; // Simulate durable provider dispatch, then loss before the owner returns a result.
    throw new Error("synthetic post-dispatch response loss");
  } });
  assert.equal(invocations, 1);
  assert.equal(dispatched.sections[0].attempts[0].status, "unknown");
  assert.equal(dispatched.sections[0].attempts[0].result, null);
  assert.equal(dispatched.aggregate.status, "unknown", "aggregate must not collapse dispatch uncertainty into failed");
  assert.ok(dispatched.sections.slice(1).every(section => section.attempts[0].status === "not_run"));
  assert.match(dispatched.aggregate.gaps[0], /Do not retry from this artifact/);
  await assert.rejects(retryDocumentRecovery(dispatched, ["section-1"], { confirmedSha256: dispatched.sha256 }), /unknown dispatch outcome/);
  assert.equal(invocations, 1, "neither automatic nor manual replay occurred");
  assert.deepEqual(validateDocumentRecovery(dispatched), dispatched);
});

test("one unknown retry blocks every later selected retry and every subsequent retry call", async () => {
  const smallDocument = [{ id: "two-pages", title: "Synthetic two-page", sha256: hash("raw two pages"), pages: [1, 2].map(number => {
    const text = `Page ${number} says nothing about the question.`; return { number, text, sha256: hash(text) };
  }) }];
  const tree = [{ id: "root", parentId: null, title: "Root", pageRefs: [], extractionGaps: [] },
    { id: "left", parentId: "root", title: "Left", pageRefs: [{ documentId: "two-pages", page: 1 }], extractionGaps: [] },
    { id: "right", parentId: "root", title: "Right", pageRefs: [{ documentId: "two-pages", page: 2 }], extractionGaps: [] }];
  const fixture = await fakeCodex({ sessions: [startError(), startError()] });
  try {
    const planned = createDocumentRecovery("Question", { documents: smallDocument, sections: tree,
      policy: { maxCallsPerSection: 2, maxRetriesPerSection: 1, totalMaxCalls: 8, passUtf16Units: 1000, maxSecondsPerSection: 10 } });
    const failed = await runDocumentRecovery(planned, { confirmedSha256: planned.sha256, lease: fixture.lease });
    assert.deepEqual(failed.sections.map(section => section.attempts[0].status), ["failed", "failed"]);
    const dispatched = [];
    const retried = await retryDocumentRecovery(failed, ["left", "right"], { confirmedSha256: failed.sha256,
      dispatchSection: async request => { dispatched.push(request.sectionId); throw new Error("synthetic unknown outcome"); } });
    assert.deepEqual(dispatched, ["left"]);
    assert.equal(retried.sections[0].attempts[1].status, "unknown");
    assert.equal(retried.sections[1].attempts[1].status, "not_run");
    await assert.rejects(retryDocumentRecovery(retried, ["right"], { confirmedSha256: retried.sha256,
      dispatchSection: async request => { dispatched.push(request.sectionId); return { status: "unknown", reason: "still pending" }; } }), /workflow contains an unknown dispatch outcome/);
    assert.deepEqual(dispatched, ["left"]);
  } finally { await fixture.cleanup(); }
});

test("dispatch callback readback reuses stable execution IDs and stops on an unresolved journal entry", async () => {
  const fixture = await fakeCodex({ sessions: successSessions(1) });
  try {
    const recovery = createDocumentRecovery("What measurements are reported?", { documents, sections, policy });
    const journal = new Map(), dispatched = [], requestIds = [];
    const dispatchSection = async request => {
      requestIds.push([request.sectionId, request.executionId]);
      const prior = journal.get(request.executionId);
      if (prior?.status === "result") return prior.result;
      if (prior?.status === "pending") return { status: "unknown", reason: "existing intent has no durable result readback" };
      journal.set(request.executionId, { status: "pending" });
      if (request.sectionId !== "section-1") return { status: "unknown", reason: "synthetic process loss after intent" };
      dispatched.push(request.executionId);
      const result = await researchDocumentCoverage(request.question, request.documents, request.coverageOptions);
      journal.set(request.executionId, { status: "result", result });
      return result;
    };
    const first = await runDocumentRecovery(recovery, { confirmedSha256: recovery.sha256, dispatchSection });
    assert.equal(first.sections[0].attempts[0].status, "complete");
    assert.equal(first.sections[1].attempts[0].status, "unknown");
    assert.ok(first.sections.slice(2).every(section => section.attempts[0].status === "not_run"));
    const replay = await runDocumentRecovery(recovery, { confirmedSha256: recovery.sha256, dispatchSection });
    assert.equal(replay.sections[0].attempts[0].status, "complete", "completed prior section is restored from caller readback");
    assert.equal(replay.sections[1].attempts[0].status, "unknown", "pending unknown stops further dispatch");
    assert.deepEqual(dispatched, [requestIds[0][1]], "the provider ran only once");
    assert.equal(requestIds[0][1], requestIds[2][1], "same confirmed attempt has the same deterministic identity");
    assert.equal(await calls(fixture), 2);
    assert.deepEqual(validateDocumentRecovery(replay), replay);
  } finally { await fixture.cleanup(); }
});

test("dispatch callback rejects a valid owner result from the wrong question scope", async () => {
  const fixture = await fakeCodex({ sessions: successSessions(1) });
  try {
    const recovery = createDocumentRecovery("Expected question", { documents, sections, policy });
    const plan = prepareDocumentCoverage("Different question", [{ ...documents[0], pages: documents[0].pages.slice(0, 8) }],
      { maxCalls: policy.maxCallsPerSection, passUtf16Units: policy.passUtf16Units, maxSeconds: policy.maxSecondsPerSection });
    const foreign = await researchDocumentCoverage("Different question", plan.documents, { ...plan.policy, confirmedPlanDigest: plan.planDigest, lease: fixture.lease });
    const seen = [];
    const dispatchSection = async request => { seen.push(request.executionId); return foreign; };
    const rejected = await runDocumentRecovery(recovery, { confirmedSha256: recovery.sha256, dispatchSection });
    assert.equal(rejected.sections[0].attempts[0].status, "unknown");
    assert.match(rejected.sections[0].attempts[0].failure, /invalid or mismatched owner result/);
    assert.ok(rejected.sections.slice(1).every(section => section.attempts[0].status === "not_run"));
    await assert.rejects(retryDocumentRecovery(rejected, ["section-1"], { confirmedSha256: rejected.sha256 }), /unknown dispatch outcome/);
    assert.equal(seen.length, 1);
    assert.equal(await calls(fixture), 2, "only the offline wrong-scope fixture owner ran");
  } finally { await fixture.cleanup(); }
});

test("recovery CLI creates, validates and cold-renders without provider probes", () => {
  const cli = fileURLToPath(new URL("../bin/research-document-recovery.mjs", import.meta.url));
  const call = (action, input) => spawnSync(process.execPath, [cli, "--action", action], { input: JSON.stringify(input), encoding: "utf8" });
  const created = call("create", { question: "offline", documents: documents.slice(0, 1), sections, policy });
  assert.equal(created.status, 0, created.stderr);
  const recovery = JSON.parse(created.stdout);
  const checked = call("validate", { workflow: recovery });
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).sha256, recovery.sha256);
  const rendered = call("render", { workflow: recovery });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /Not run/);
});
