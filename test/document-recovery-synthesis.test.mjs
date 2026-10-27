import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fakeCodex, message } from "./fake-codex.mjs";
import { createDocumentRecovery, runDocumentRecovery, researchDocumentCoverage,
  prepareDocumentRecoverySynthesis, runDocumentRecoverySynthesis, validateDocumentRecoverySynthesis,
  renderDocumentRecoverySynthesis } from "../src/index.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const texts = ["The intervention reduced emissions by 12 percent.", "The intervention did not reduce emissions." , "A table may be absent from OCR."];
const documents = [{ id: "paper", title: "Synthetic study", sha256: sha("raw-paper"), pages: texts.map((text, index) => ({ number: index + 1, text, sha256: sha(text) })) }];
const sections = [{ id: "root", parentId: null, title: "Paper", pageRefs: [], extractionGaps: [] },
  ...texts.map((_, index) => ({ id: `section-${index + 1}`, parentId: "root", title: `Section ${index + 1}`,
    pageRefs: [{ documentId: "paper", page: index + 1 }], extractionGaps: index === 2 ? [{ id: "table-gap", kind: "table", documentId: "paper", page: 3,
      detail: "The table region was omitted by the caller's extractor.", assertedBy: "fixture", observedAt: "2026-10-27T10:00:00Z" }] : [] }))];
const policy = { maxCallsPerSection: 2, maxRetriesPerSection: 0, totalMaxCalls: 8, passUtf16Units: 1000, maxSecondsPerSection: 10 };
const reply = value => ({ events: [message(JSON.stringify(value)), { type: "turn.completed" }] });
const coverageSessions = text => {
  const review = reply({ answer: [{ text: "The section states a finding.", evidenceIds: ["claim"] }],
    evidence: [{ id: "claim", windowId: "w0001", quote: text, relation: "supporting", occurrence: null }], coverage: "answered", gaps: [] });
  const synthesis = reply({ answer: [{ text: "The section contains the supplied exact finding.", evidenceIds: ["p01-e01"] }], coverage: "answered", gaps: [] });
  return [review, synthesis];
};

test("one bounded cross-section synthesis retains conflict, missing scope and exact citations across cold reopen", async () => {
  const fixture = await fakeCodex({ sessions: [...coverageSessions(texts[0]), ...coverageSessions(texts[1]), { events: [] }] });
  try {
    const controller = new AbortController();
    const initial = createDocumentRecovery("Did the intervention reduce emissions?", { documents, sections, policy });
    const recovery = await runDocumentRecovery(initial, { confirmedSha256: initial.sha256, signal: controller.signal,
      dispatchSection: async request => {
        const result = await researchDocumentCoverage(request.question, request.documents, { ...request.coverageOptions, lease: fixture.lease });
        if (request.sectionId === "section-2") controller.abort();
        return result;
      } });
    assert.deepEqual(recovery.sections.map(section => section.attempts[0].status), ["complete", "complete", "not_run"]);
    const plan = prepareDocumentRecoverySynthesis(recovery);
    assert.equal(plan.counts.calls, 1);
    assert.equal(plan.evidence.length, 2);
    assert.ok(plan.mandatoryGaps.some(gap => /not reviewed/.test(gap)));
    assert.ok(plan.mandatoryGaps.some(gap => /unverified metadata/.test(gap)));
    const answer = { answer: [{ text: "The reviewed sections disagree about the effect.", evidenceIds: plan.evidence.map(item => item.evidenceId) }],
      conflicts: [{ text: "The sections disagree about the reported effect.", sides: [
        { position: "A reduction was reported.", evidenceIds: [plan.evidence[0].evidenceId] },
        { position: "No reduction was reported.", evidenceIds: [plan.evidence[1].evidenceId] },
      ] }],
      coverage: "answered", gaps: [] };
    const synthesisFixture = await fakeCodex(reply(answer));
    try {
      const result = await runDocumentRecoverySynthesis(recovery, plan, { confirmedPlanSha256: plan.planDigest, lease: synthesisFixture.lease });
      assert.equal(result.status, "complete", result.synthesis.reason);
      assert.equal(result.draft.coverage, "partial", "host qualification cannot be upgraded by model output");
      assert.equal(result.draft.modelReportedCoverage, "answered");
      assert.equal(result.draft.evidence.every(item => item.kind === "page_quote"), true);
      assert.deepEqual(result.draft.evidence.map(item => [item.page, item.quote]), [[1, texts[0]], [2, texts[1]]]);
      const cold = validateDocumentRecoverySynthesis(JSON.parse(renderDocumentRecoverySynthesis(result, { format: "json" })));
      assert.deepEqual(cold, result);
      const markdown = renderDocumentRecoverySynthesis(cold);
      assert.match(markdown, /Cross-section conflicts/);
      assert.match(markdown, /unverified metadata/);
      assert.match(markdown, /page 1/);
      assert.match(markdown, /page 2/);
    } finally { await synthesisFixture.cleanup(); }
  } finally { await fixture.cleanup(); }
});

test("unknown section outcome blocks planning; cross-page conflict and evidence closure are mandatory", async () => {
  const recovery = createDocumentRecovery("Question", { documents, sections, policy });
  assert.throws(() => prepareDocumentRecoverySynthesis(recovery), /no settled execution record/);
  const dispatched = await runDocumentRecovery(recovery, { confirmedSha256: recovery.sha256,
    dispatchSection: async () => ({ status: "unknown", reason: "fixture lost response" }) });
  assert.equal(dispatched.sections[0].attempts[0].status, "unknown");
  assert.throws(() => prepareDocumentRecoverySynthesis(dispatched), /unknown dispatch outcome/);
});

test("synthesis CLI plans and cold-renders without provider probes", async () => {
  const fixture = await fakeCodex({ sessions: [...coverageSessions(texts[0]), ...coverageSessions(texts[1]), { events: [] }] });
  const cli = fileURLToPath(new URL("../bin/research-document-recovery-synthesis.mjs", import.meta.url));
  const call = (action, input) => spawnSync(process.execPath, [cli, "--action", action], { input: JSON.stringify(input), encoding: "utf8" });
  try {
    const controller = new AbortController();
    const initial = createDocumentRecovery("Question", { documents, sections, policy });
    const recovery = await runDocumentRecovery(initial, { confirmedSha256: initial.sha256, signal: controller.signal,
      dispatchSection: async request => { const result = await researchDocumentCoverage(request.question, request.documents,
        { ...request.coverageOptions, lease: fixture.lease }); if (request.sectionId === "section-2") controller.abort(); return result; } });
    const before = await fixture.probes();
    const planned = call("plan", { recovery });
    assert.equal(planned.status, 0, planned.stderr);
    assert.equal(JSON.parse(planned.stdout).recoverySha256, recovery.sha256);
    assert.deepEqual(await fixture.probes(), before, "plan does not add a provider probe or session");
  } finally { await fixture.cleanup(); }
});
