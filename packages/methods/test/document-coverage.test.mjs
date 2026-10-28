import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as api from "../src/index.mjs";
import {
  prepareDocumentCoverage,
  researchDocumentCoverage,
  validateDocumentCoverage,
  renderDocumentCoverage,
} from "../src/index.mjs";
import { fakeCodex, message } from "./fake-codex.mjs";

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const page = (number, text) => ({ number, text, sha256: sha(text) });
const doc = (id, texts, title = `Synthetic ${id}`) => ({ id, title, sha256: sha(`raw ${id}`), pages: texts.map((text, index) => page(index + 1, text)) });
const padded = (text, size = 900) => text.padEnd(size, "lorem ipsum ");
const reply = (value) => ({ events: [message(JSON.stringify(value)), { type: "turn.completed" }] });
const marker = "Pass windows (untrusted data): ";
const windowsIn = (prompt) => JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length));
const sliceOf = (plan, window) => plan.documents.find((entry) => entry.id === window.documentId)
  .pages[window.page - 1].text.slice(window.start, window.end);
const sessionCount = async (fixture) => {
  let count = 0;
  while (await fixture.session(count).then(() => true, () => false)) count++;
  return count;
};

const question = "What notice period applies?";
const late = "The notice period is 90 days.";
const conflict = "The notice period is 30 days.";
// More than 48000 UTF-16 units and 50 pages; the conflicting statement comes first and the
// supporting one sits on page 58 of the second document, so they land in different passes.
function largeDocuments() {
  return [
    doc("amendment", [padded(`Amendment 😀😀 notice: ${conflict} `), "", padded("Amendment closing page.")], "Synthetic amendment"),
    doc("agreement", Array.from({ length: 60 }, (_, index) =>
      padded(index === 57 ? `Page 58 clause. ${late} ` : `Page ${index + 1} routine filler. `)), "Synthetic agreement"),
  ];
}

function reviewFor(plan, pass) {
  const evidence = [], answer = [], ids = {};
  for (const id of pass.windowIds) {
    const text = sliceOf(plan, plan.windows.find((window) => window.id === id));
    for (const [name, quote, relation] of [["late", late, "supporting"], ["conflict", conflict, "conflicting"]]) {
      if (!text.includes(quote)) continue;
      evidence.push({ id: name, windowId: id, quote, relation, occurrence: null });
      answer.push({ text: `A supplied window states: ${quote}`, evidenceIds: [name] });
      ids[name] = `${pass.id}-e${String(evidence.length).padStart(2, "0")}`;
    }
  }
  return { ids, response: evidence.length ? { answer, evidence, coverage: "answered", gaps: [] }
    : { answer: [], evidence: [], coverage: "insufficient", gaps: ["These windows do not state a notice period."] } };
}

const repeatPage = padded("Repeat: alpha beta. Repeat: alpha beta. Unique gamma. ");
const small = () => [doc("memo", [repeatPage, padded("Second page delta. "), padded("Third page epsilon. ")], "Synthetic memo")];
const smallPolicy = { passUtf16Units: 1000 };
const evidenceRow = (quote, extra = {}) => ({ id: "q", windowId: "w0001", quote, relation: "supporting", occurrence: null, ...extra });
const cited = (evidence) => ({ answer: [{ text: "Quoted.", evidenceIds: evidence.map((item) => item.id) }], evidence, coverage: "answered", gaps: [] });
const insufficient = { answer: [], evidence: [], coverage: "insufficient", gaps: ["No notice period in these windows."] };
const synthesized = { answer: [{ text: "The memo contains one unique gamma statement.", evidenceIds: ["p01-e01"] }], coverage: "answered", gaps: [] };
const completeSessions = () => [reply(cited([evidenceRow("Unique gamma.")])), reply(insufficient), reply(insufficient), reply(synthesized)];

async function runSmall(sessions, { policy = smallPolicy, inspect, ...options } = {}) {
  const fixture = await fakeCodex({ sessions });
  try {
    const documents = small();
    const plan = prepareDocumentCoverage(question, documents, policy);
    const result = await researchDocumentCoverage(question, documents, {
      lease: fixture.lease, confirmedPlanDigest: plan.planDigest, ...policy, ...options,
    });
    const calls = await sessionCount(fixture);
    await inspect?.(fixture);
    return { result, plan, calls };
  } finally { await fixture.cleanup(); }
}

test("preparation covers every UTF-16 unit once in bounded deterministic passes", () => {
  const documents = largeDocuments();
  const plan = prepareDocumentCoverage(question, documents);
  assert.equal(plan.version, "research-document-coverage-plan-v1");
  assert.deepEqual(plan.policy, { maxCalls: 12, passUtf16Units: 24000, maxSeconds: 600 });
  assert.ok(plan.counts.utf16Units > 48000 && plan.counts.pages > 50);
  assert.equal(plan.counts.windows, plan.windows.length);
  assert.equal(plan.counts.reviewCalls, plan.passes.length);
  assert.equal(plan.counts.maximumCalls, plan.passes.length + 1);
  for (const document of plan.documents) for (const entry of document.pages) {
    const windows = plan.windows.filter((window) => window.documentId === document.id && window.page === entry.number);
    assert.equal(windows.map((window) => entry.text.slice(window.start, window.end)).join(""), entry.text);
    windows.forEach((window, index) => {
      assert.equal(window.start, index ? windows[index - 1].end : 0);
      assert.equal(window.sha256, sha(entry.text.slice(window.start, window.end)));
    });
    assert.equal(windows.at(-1).end, entry.text.length);
  }
  const empty = plan.windows.find((window) => window.documentId === "amendment" && window.page === 2);
  assert.deepEqual([empty.start, empty.end, empty.sha256], [0, 0, sha("")]);
  assert.ok(plan.limits.some((item) => /1 supplied page\(s\) contain no extracted text/.test(item)));
  assert.deepEqual(plan.passes.flatMap((pass) => pass.windowIds), plan.windows.map((window) => window.id));
  for (const pass of plan.passes) {
    const units = pass.windowIds.reduce((sum, id) => {
      const window = plan.windows.find((entry) => entry.id === id);
      return sum + window.end - window.start;
    }, 0);
    assert.ok(pass.windowIds.length <= 32 && units <= 24000);
    assert.equal(pass.utf16Units, units);
  }
  assert.deepEqual(prepareDocumentCoverage(question, structuredClone(documents)), plan);

  const policyChanged = prepareDocumentCoverage(question, documents, { maxCalls: 13 });
  assert.equal(policyChanged.inputDigest, plan.inputDigest);
  assert.notEqual(policyChanged.planDigest, plan.planDigest);
  const questionChanged = prepareDocumentCoverage("Which notice period governs?", documents);
  assert.notEqual(questionChanged.inputDigest, plan.inputDigest);
  assert.notEqual(questionChanged.planDigest, plan.planDigest);
  const edited = structuredClone(documents);
  edited[0].pages[0] = page(1, edited[0].pages[0].text.replace("30 days", "45 days"));
  assert.notEqual(prepareDocumentCoverage(question, edited).inputDigest, plan.inputDigest);

  const tiny = prepareDocumentCoverage(question, [doc("tiny", Array.from({ length: 40 }, (_, index) => `Tiny page ${index + 1}.`))]);
  assert.deepEqual(tiny.passes.map((pass) => pass.windowIds.length), [32, 8]);
});

test("long pages split without overlap at code-point-safe boundaries", () => {
  const text = `${"x".repeat(999)}😀${"y".repeat(1500)}`;
  const plan = prepareDocumentCoverage(question, [doc("long", [text])], { passUtf16Units: 1000 });
  assert.deepEqual(plan.windows.map((window) => [window.start, window.end]), [[0, 999], [999, 1999], [1999, 2501]]);
  assert.ok(plan.windows.every((window) => sliceOf(plan, window).isWellFormed()));
  assert.equal(plan.windows.map((window) => sliceOf(plan, window)).join(""), text);
  assert.equal(plan.passes.length, 3);

  const spaced = prepareDocumentCoverage(question, [doc("spaced", [`${"a".repeat(900)} ${"b".repeat(300)}`])], { passUtf16Units: 1000 });
  assert.deepEqual(spaced.windows.map((window) => [window.start, window.end]), [[0, 901], [901, 1201]]);
});

test("malformed input, policy and over-budget plans are refused before any session", async () => {
  const documents = largeDocuments();
  const good = documents[0];
  for (const [docs, policy] of [
    [[{ ...good, pages: [{ ...good.pages[0], sha256: "0".repeat(64) }] }]],
    [[{ ...good, pages: [good.pages[1], good.pages[0]] }]],
    [[{ ...good, extra: true }]],
    [[{ ...good, sha256: "bad" }]],
    [Array.from({ length: 9 }, (_, index) => ({ ...good, id: `doc-${index}` }))],
    [[doc("many", Array.from({ length: 2001 }, () => ""))]],
    [[doc("huge", Array.from({ length: 21 }, () => "x".repeat(50000)))]],
    [documents, { maxCalls: 1 }],
    [documents, { maxCalls: 2 }],
    [documents, { passUtf16Units: 999 }],
    [documents, { maxSeconds: 3601 }],
    [documents, { maxSeconds: 1.5 }],
    [documents, { unknown: 1 }],
  ]) assert.throws(() => prepareDocumentCoverage(question, docs, policy), /invalid_document_coverage/);
  assert.throws(() => prepareDocumentCoverage("", documents), /invalid_document_coverage/);

  const fixture = await fakeCodex({ sessions: [reply(insufficient)] });
  try {
    const plan = prepareDocumentCoverage(question, documents);
    for (const options of [
      {}, { confirmedPlanDigest: "0".repeat(64) }, { confirmedPlanDigest: plan.planDigest, maxCalls: 13 },
      { confirmedPlanDigest: plan.planDigest, onPass: () => {} }, { confirmedPlanDigest: plan.planDigest, maxCalls: 2 },
    ]) await assert.rejects(researchDocumentCoverage(question, documents, { lease: fixture.lease, ...options }), /invalid_document_coverage/);
    const tampered = structuredClone(documents);
    tampered[1].pages[3].text += "!";
    await assert.rejects(researchDocumentCoverage(question, tampered, { lease: fixture.lease, confirmedPlanDigest: plan.planDigest }),
      /page digest mismatch/);
    await assert.rejects(researchDocumentCoverage(question, documents, { lease: fixture.lease, confirmedPlanDigest: plan.planDigest, profile: "deep" }),
      /unknown_profile/);
    assert.equal(await fixture.launched(), false);
    assert.deepEqual(await fixture.probes(), []);
    assert.equal(existsSync(fixture.lease), false);
  } finally { await fixture.cleanup(); }
});

test("every window reaches exactly one pass prompt and late conflicting evidence is synthesized at original offsets", async () => {
  const documents = largeDocuments();
  const plan = prepareDocumentCoverage(question, documents);
  const reviews = plan.passes.map((pass) => reviewFor(plan, pass));
  const ids = Object.assign({}, ...reviews.map((review) => review.ids));
  assert.ok(ids.late && ids.conflict);
  assert.notEqual(ids.late.slice(0, 3), ids.conflict.slice(0, 3));
  const synthesis = {
    answer: [{ text: "Agreement page 58 states 90 days, while the amendment states 30 days.", evidenceIds: [ids.late, ids.conflict] }],
    coverage: "partial", gaps: ["The supplied pages do not establish which period governs."],
  };
  const fixture = await fakeCodex({ sessions: [...reviews.map((review) => reply(review.response)), reply(synthesis)] });
  try {
    const activity = [];
    const running = researchDocumentCoverage(question, documents, {
      lease: fixture.lease, confirmedPlanDigest: plan.planDigest, model: "fixture",
      activity: (event) => activity.push(event.kind),
    });
    documents[1].title = "Mutated title";
    documents[1].pages[57].text = "Mutated page";
    const result = await running;
    assert.equal(result.status, "complete");
    assert.equal(result.plan.documents[1].title, "Synthetic agreement");
    assert.ok(activity.includes("session.started"));

    const seen = [];
    for (let index = 0; index < plan.passes.length; index++) {
      const { args, prompt } = await fixture.session(index);
      assert.match(args.join(" "), /web_search="disabled"/);
      assert.ok(args.includes("--output-schema"));
      assert.doesNotMatch(prompt, /Mutated/);
      const sent = windowsIn(prompt);
      assert.equal(sent.pass, plan.passes[index].id);
      assert.deepEqual(sent.windows.map((window) => window.windowId), plan.passes[index].windowIds);
      for (const window of sent.windows) {
        const planned = plan.windows.find((entry) => entry.id === window.windowId);
        assert.deepEqual([window.documentId, window.page, window.start, window.end], [planned.documentId, planned.page, planned.start, planned.end]);
        assert.equal(window.text, sliceOf(plan, planned));
        seen.push(window.windowId);
      }
    }
    assert.equal(new Set(seen).size, seen.length);
    assert.deepEqual(seen, plan.windows.map((window) => window.id));
    const synthesisPrompt = (await fixture.session(plan.passes.length)).prompt;
    assert.doesNotMatch(synthesisPrompt, /routine filler/);
    assert.match(synthesisPrompt, /The notice period is 90 days/);
    assert.equal(await sessionCount(fixture), plan.counts.maximumCalls);

    const lateEvidence = result.draft.evidence.find((item) => item.id === ids.late);
    const agreementPage = plan.documents[1].pages[57].text;
    assert.deepEqual([lateEvidence.documentId, lateEvidence.page, lateEvidence.start, lateEvidence.end],
      ["agreement", 58, agreementPage.indexOf(late), agreementPage.indexOf(late) + late.length]);
    const conflictEvidence = result.draft.evidence.find((item) => item.id === ids.conflict);
    const amendmentPage = plan.documents[0].pages[0].text;
    assert.equal(conflictEvidence.start, amendmentPage.indexOf(conflict));
    assert.equal(conflictEvidence.start, [...amendmentPage.slice(0, conflictEvidence.start)].length + 2);
    assert.equal(conflictEvidence.relation, "conflicting");
    assert.equal(lateEvidence.relation, "supporting");

    assert.deepEqual(result.inputCoverage, {
      complete: true, reviewedWindows: plan.windows.map((window) => window.id), unreviewedWindows: [],
      reviewedPages: plan.documents.flatMap((document) => document.pages.map((entry) => ({ documentId: document.id, page: entry.number }))),
      reviewedUtf16Units: plan.counts.utf16Units, totalUtf16Units: plan.counts.utf16Units,
    });
    assert.deepEqual([result.receipt.startedCalls, result.receipt.cleanup, result.receipt.stopReason], [plan.counts.maximumCalls, "complete", null]);
    assert.deepEqual(validateDocumentCoverage(JSON.parse(JSON.stringify(result))), result);
    const markdown = renderDocumentCoverage(result);
    assert.match(markdown, /Status: complete/);
    assert.match(markdown, /Answer coverage \(model-reported\): partial/);
    assert.match(markdown, /page 58, supporting/);
    assert.match(markdown, /which period governs/);
    assert.match(markdown, /Every window has a completed, validated review/);
    assert.doesNotMatch(markdown, /\]\(/);
    assert.equal(JSON.parse(renderDocumentCoverage(result, { format: "json" })).receipt.contentSha256, result.receipt.contentSha256);
  } finally { await fixture.cleanup(); }
});

test("exact quote occurrence rules derive offsets or reject the whole pass output", async () => {
  const accepted = await runSmall([reply(cited([evidenceRow("alpha beta", { occurrence: 1 })])), reply(insufficient), reply(insufficient), reply(synthesized)]);
  assert.equal(accepted.result.status, "complete");
  const [evidence] = accepted.result.passes[0].findings.evidence;
  assert.equal(evidence.id, "p01-e01");
  assert.equal(evidence.start, repeatPage.indexOf("alpha beta", repeatPage.indexOf("alpha beta") + 1));

  for (const [name, response] of [
    ["ambiguous null occurrence", cited([evidenceRow("alpha beta")])],
    ["out-of-range occurrence", cited([evidenceRow("alpha beta", { occurrence: 2 })])],
    ["negative occurrence", cited([evidenceRow("alpha beta", { occurrence: -1 })])],
    ["fractional occurrence", cited([evidenceRow("alpha beta", { occurrence: 0.5 })])],
    ["absent quote", cited([evidenceRow("alpha gamma")])],
    ["window from another pass", cited([evidenceRow("Second page delta.", { windowId: "w0002" })])],
    ["unknown window", cited([evidenceRow("Unique gamma.", { windowId: "w9999" })])],
    ["model-supplied offsets", cited([{ ...evidenceRow("Unique gamma."), start: 40 }])],
    ["unknown citation", { ...cited([evidenceRow("Unique gamma.")]), answer: [{ text: "Quoted.", evidenceIds: ["missing"] }] }],
    ["uncited evidence", { answer: [{ text: "Quoted.", evidenceIds: ["q"] }],
      evidence: [evidenceRow("Unique gamma."), evidenceRow("Repeat:", { id: "r", occurrence: 0 })], coverage: "answered", gaps: [] }],
    ["excess answers", { ...cited([evidenceRow("Unique gamma.")]), answer: Array.from({ length: 25 }, () => ({ text: "Quoted.", evidenceIds: ["q"] })) }],
    ["excess evidence", cited(Array.from({ length: 49 }, (_, index) => evidenceRow("Unique gamma.", { id: `q${index}` })))],
    ["coverage contradiction", { ...cited([evidenceRow("Unique gamma.")]), coverage: "partial" }],
    ["not an object", "not json"],
  ]) {
    const { result, calls } = await runSmall([reply(response)]);
    assert.equal(result.status, "failed", name);
    assert.equal(result.passes[0].status, "failed", name);
    assert.equal(result.passes[0].findings, null, name);
    assert.match(result.passes[0].failure, /^invalid_review_output/, name);
    assert.deepEqual(result.passes.slice(1).map((pass) => [pass.status, pass.failure]), [["not_run", "review_failed"], ["not_run", "review_failed"]], name);
    assert.equal(result.synthesis.status, "not_run", name);
    assert.equal(result.draft, null, name);
    assert.deepEqual(result.inputCoverage.reviewedWindows, [], name);
    assert.equal(calls, 1, name);
    validateDocumentCoverage(JSON.parse(JSON.stringify(result)));
  }
});

test("a failed second pass keeps first findings and leaves later windows visibly unreviewed", async () => {
  const { result, calls } = await runSmall([
    reply(cited([evidenceRow("Unique gamma.")])),
    { events: [message("{}"), { type: "turn.failed", error: { message: "fixture failure" } }] },
  ]);
  assert.equal(result.status, "partial");
  assert.equal(calls, 2);
  assert.equal(result.passes[0].status, "complete");
  assert.equal(result.passes[0].findings.evidence[0].quote, "Unique gamma.");
  assert.equal(result.passes[1].status, "failed");
  assert.ok(result.passes[1].receipt.outcome);
  assert.deepEqual([result.passes[2].status, result.passes[2].failure], ["not_run", "review_failed"]);
  assert.match(result.synthesis.reason, /review incomplete/);
  assert.deepEqual(result.inputCoverage.reviewedWindows, ["w0001"]);
  assert.deepEqual(result.inputCoverage.unreviewedWindows, ["w0002", "w0003"]);
  assert.deepEqual(result.inputCoverage.reviewedPages, [{ documentId: "memo", page: 1 }]);
  assert.equal(result.receipt.stopReason, "review_failed");
  const markdown = renderDocumentCoverage(JSON.parse(JSON.stringify(result)));
  assert.match(markdown, /## Review pass findings/);
  assert.match(markdown, /Unique gamma\./);
  assert.match(markdown, /w0003: `memo` page 3, UTF-16 0–900/);
});

test("cancellation and deadline stop dispatch; zero-start cancellation never takes the lease", async () => {
  const controller = new AbortController();
  const cancelled = await runSmall([reply(cited([evidenceRow("Unique gamma.")])), {
    events: [{ type: "thread.started", thread_id: "coverage-cancel-fixture" }], hang: true,
  }], {
    signal: controller.signal,
    // Native acknowledgement proves the fake wrote its input record; the host start event does not.
    activity: (event) => { if (event.kind === "thread.started") controller.abort(); },
  });
  assert.equal(cancelled.result.status, "cancelled");
  assert.equal(cancelled.calls, 2);
  assert.deepEqual(cancelled.result.passes.map((pass) => pass.status), ["complete", "cancelled", "not_run"]);
  assert.equal(cancelled.result.passes[1].receipt.outcome.aborted, true);
  assert.equal(cancelled.result.passes[2].failure, "cancelled");
  assert.deepEqual([cancelled.result.receipt.cleanup, cancelled.result.receipt.stopReason, cancelled.result.receipt.startedCalls], ["complete", "cancelled", 2]);
  assert.equal(cancelled.result.synthesis.status, "not_run");
  assert.deepEqual(cancelled.result.inputCoverage.unreviewedWindows, ["w0002", "w0003"]);
  validateDocumentCoverage(JSON.parse(JSON.stringify(cancelled.result)));

  const aborted = new AbortController();
  aborted.abort();
  const none = await runSmall(completeSessions(), {
    signal: aborted.signal,
    inspect: async (fixture) => {
      assert.equal(await fixture.launched(), false);
      assert.equal(existsSync(fixture.lease), false);
    },
  });
  assert.equal(none.result.status, "cancelled");
  assert.deepEqual(none.result.passes.map((pass) => pass.status), ["not_run", "not_run", "not_run"]);
  assert.deepEqual([none.result.receipt.cleanup, none.result.receipt.startedCalls, none.calls], ["not_started", 0, 0]);
  validateDocumentCoverage(JSON.parse(JSON.stringify(none.result)));

  const timed = await runSmall([{ hang: true }], { policy: { ...smallPolicy, maxSeconds: 1 } });
  assert.equal(timed.result.status, "cancelled");
  assert.deepEqual([timed.result.passes[0].status, timed.result.passes[0].failure], ["cancelled", "deadline"]);
  assert.equal(timed.result.receipt.stopReason, "deadline");
  assert.equal(timed.calls, 1);
  assert.ok(timed.result.receipt.elapsedMs < 5000);
  validateDocumentCoverage(JSON.parse(JSON.stringify(timed.result)));
});

test("unconfirmed process-group cleanup stops the pipeline and is never reported as success", async () => {
  const realKill = process.kill;
  let groupKills = 0;
  process.kill = function (pid, signal) {
    if (pid < 0 && signal === "SIGKILL" && ++groupKills === 2)
      throw Object.assign(new Error("fixture: group state unknown"), { code: "EPERM" });
    return realKill.call(process, pid, signal);
  };
  let outcome;
  try {
    outcome = await runSmall(completeSessions(), {
      inspect: async (fixture) => assert.equal(existsSync(join(fixture.lease, "owner.json")), true),
    });
  } finally { process.kill = realKill; }
  const { result, calls } = outcome;
  assert.equal(calls, 2);
  assert.equal(result.status, "partial");
  assert.equal(result.passes[0].status, "complete");
  assert.equal(result.passes[1].status, "failed");
  assert.equal(result.passes[1].receipt.outcome.cleanup.complete, false);
  assert.deepEqual([result.passes[2].status, result.passes[2].failure], ["not_run", "cleanup_unconfirmed"]);
  assert.deepEqual([result.receipt.cleanup, result.receipt.stopReason], ["unconfirmed", "cleanup_unconfirmed"]);
  assert.equal(result.draft, null);
  validateDocumentCoverage(JSON.parse(JSON.stringify(result)));
});

test("synthesis with unknown, missing or summary-only citations fails without an answer", async () => {
  for (const response of [
    { answer: [{ text: "Unsupported.", evidenceIds: ["p09-e01"] }], coverage: "answered", gaps: [] },
    { answer: [{ text: "Cites a pass summary.", evidenceIds: ["p01"] }], coverage: "answered", gaps: [] },
    { answer: [{ text: "Uncited.", evidenceIds: [] }], coverage: "answered", gaps: [] },
    { ...synthesized, gaps: ["Contradicts answered coverage."] },
    { ...synthesized, evidence: [] },
  ]) {
    const { result, calls } = await runSmall([...completeSessions().slice(0, 3), reply(response)]);
    assert.equal(result.status, "partial");
    assert.equal(calls, 4);
    assert.equal(result.synthesis.status, "failed");
    assert.match(result.synthesis.reason, /^invalid_synthesis_output/);
    assert.ok(result.synthesis.receipt.outcome);
    assert.equal(result.draft, null);
    assert.equal(result.inputCoverage.complete, true);
    assert.equal(result.passes[0].findings.evidence[0].quote, "Unique gamma.");
    assert.match(renderDocumentCoverage(result), /No synthesized answer/);
  }
});

test("oversized synthesis input keeps every finding and does not run synthesis", async () => {
  const segments = (tag) => Array.from({ length: 6 }, (_, index) => `[${tag}${index}]`.padEnd(3990, "z"));
  const texts = [segments("A").join(""), segments("B").join("")];
  const documents = [doc("ledger", texts, "Synthetic ledger")];
  const policy = { passUtf16Units: 48000 };
  const plan = prepareDocumentCoverage(question, documents, policy);
  assert.equal(plan.passes.length, 1);
  const evidence = ["A", "B"].flatMap((tag, windowIndex) => segments(tag).map((quote, index) =>
    ({ id: `${tag}${index}`, windowId: plan.windows[windowIndex].id, quote, relation: "context", occurrence: null })));
  const answer = ["A", "B"].map((tag) => ({ text: `Segments ${tag}.`, evidenceIds: evidence.filter((item) => item.id.startsWith(tag)).map((item) => item.id) }));
  const fixture = await fakeCodex({ sessions: [reply({ answer, evidence, coverage: "answered", gaps: [] }), reply(synthesized)] });
  try {
    const result = await researchDocumentCoverage(question, documents, { lease: fixture.lease, confirmedPlanDigest: plan.planDigest, ...policy });
    assert.equal(await sessionCount(fixture), 1);
    assert.equal(result.status, "partial");
    assert.equal(result.synthesis.status, "not_run");
    assert.match(result.synthesis.reason, /bound is 48000 and evidence is never trimmed/);
    assert.equal(result.receipt.stopReason, "synthesis_input_exceeds_bound");
    assert.equal(result.passes[0].findings.evidence.length, 12);
    assert.ok(result.passes[0].findings.evidence.every((item) => item.quote.length === 3990));
    assert.equal(result.inputCoverage.complete, true);
    validateDocumentCoverage(JSON.parse(JSON.stringify(result)));
  } finally { await fixture.cleanup(); }
});

test("offline validation replays the retained closure and refuses edits", async () => {
  const { result } = await runSmall(completeSessions());
  assert.equal(result.status, "complete");
  assert.deepEqual(validateDocumentCoverage(JSON.parse(JSON.stringify(result))), result);
  for (const mutate of [
    (value) => { value.plan.documents[0].pages[0].text += " "; },
    (value) => {
      const text = value.plan.documents[0].pages[0].text.replace("gamma", "delta");
      value.plan.documents[0].pages[0] = { number: 1, text, sha256: sha(text) };
    },
    (value) => { value.plan.policy.maxCalls = 13; },
    (value) => { value.plan.windows[0].end -= 1; },
    (value) => { value.passes[0].findings.evidence[0].quote = "Unique gamma!"; },
    (value) => { value.passes[0].findings.evidence[0].start += 1; value.passes[0].findings.evidence[0].end += 1; },
    (value) => { value.passes[0].findings.evidence[0].relation = "verified"; },
    (value) => { value.passes[1].status = "not_run"; },
    (value) => { value.inputCoverage.complete = false; },
    (value) => { value.draft.answer[0].evidenceIds = ["p01-e99"]; },
    (value) => { value.draft.answer[0].text = "A different claim."; },
    (value) => { value.draft.evidence = []; },
    (value) => { value.receipt.startedCalls += 1; },
    (value) => { value.receipt.contentSha256 = "0".repeat(64); },
    (value) => { value.status = "partial"; },
    (value) => { value.limits.push("An added limit."); },
  ]) {
    const copy = JSON.parse(JSON.stringify(result));
    mutate(copy);
    assert.throws(() => validateDocumentCoverage(copy), /invalid_document_coverage/);
    assert.throws(() => renderDocumentCoverage(copy), /invalid_document_coverage/);
  }
});

test("CLI preview and render start no native work; confirm requires the exact plan digest", async () => {
  const documents = small();
  const plan = prepareDocumentCoverage(question, documents, smallPolicy);
  const fixture = await fakeCodex({ sessions: completeSessions() });
  const bin = fileURLToPath(new URL("../bin/research-document-coverage.mjs", import.meta.url));
  const input = join(fixture.root, "input.json");
  await writeFile(input, JSON.stringify({ question, documents }));
  const cli = (...args) => new Promise((resolve) => execFile(process.execPath, [bin, ...args], { env: fixture.env, maxBuffer: 64 * 1024 * 1024 },
    (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })));
  try {
    const help = await cli("--help");
    assert.equal(help.code, 0);
    assert.match(help.stdout, /--preview prints the deterministic plan/);
    const shown = await cli("--input", input, "--preview", "--pass-units", "1000");
    assert.equal(shown.code, 0);
    const preview = JSON.parse(shown.stdout);
    assert.equal(preview.planDigest, plan.planDigest);
    assert.deepEqual(preview.passes, plan.passes);
    assert.equal(preview.documents[0].pages, 3);
    assert.doesNotMatch(shown.stdout, /Unique gamma/);
    const refused = await cli("--input", input, "--preview", "--pass-units", "1000", "--max-calls", "3");
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /maxCalls is 3/);
    const stale = await cli("--input", input, "--confirm", plan.planDigest);
    assert.equal(stale.code, 1);
    assert.match(stale.stderr, /plan digest does not match/);
    assert.equal((await cli("--input", input)).code, 1);
    assert.deepEqual(await fixture.probes(), []);

    const ran = await cli("--input", input, "--confirm", plan.planDigest, "--pass-units", "1000");
    assert.equal(ran.code, 0, ran.stderr);
    const result = validateDocumentCoverage(JSON.parse(ran.stdout));
    assert.equal(result.status, "complete");
    assert.equal(JSON.parse(ran.stderr.trim().split("\n").at(-1)).contentSha256, result.receipt.contentSha256);
    const probes = (await fixture.probes()).length;

    const saved = join(fixture.root, "result.json");
    await writeFile(saved, ran.stdout);
    const rendered = await cli("--render", saved);
    assert.equal(rendered.code, 0);
    assert.match(rendered.stdout, /Status: complete/);
    const json = await cli("--render", saved, "--format", "json");
    assert.equal(json.code, 0);
    assert.equal(JSON.parse(json.stdout).receipt.contentSha256, result.receipt.contentSha256);
    const edited = JSON.parse(ran.stdout);
    edited.draft.answer[0].text = "Edited.";
    await writeFile(saved, JSON.stringify(edited));
    assert.equal((await cli("--render", saved)).code, 1);
    assert.equal((await fixture.probes()).length, probes);
  } finally { await fixture.cleanup(); }
});

test("public exports and handwritten declarations cover the coverage API", async () => {
  for (const name of ["prepareDocumentCoverage", "researchDocumentCoverage", "validateDocumentCoverage", "renderDocumentCoverage"])
    assert.equal(typeof api[name], "function");
  assert.ok(Object.isFrozen(api.documentCoverageLimits));
  assert.deepEqual(api.documentCoverageLimits.policyDefaults, { maxCalls: 12, passUtf16Units: 24000, maxSeconds: 600 });
  assert.equal(api.documentCoverageLimits.synthesisInputUtf16Units, 48000);
  assert.equal(api.documentResearchLimits.totalUtf16Units, 48000);
  const types = await readFile(new URL("../src/index.d.ts", import.meta.url), "utf8");
  for (const declaration of [
    "export function prepareDocumentCoverage(question: string, documents: ResearchDocumentInput[], policy?: Partial<DocumentCoveragePolicy>): PreparedDocumentCoverage;",
    "export function researchDocumentCoverage(question: string, documents: ResearchDocumentInput[], options: DocumentCoverageOptions): Promise<DocumentCoverageResult>;",
    "export function validateDocumentCoverage(value: unknown): DocumentCoverageResult;",
    'export function renderDocumentCoverage(value: DocumentCoverageResult, options?: { format?: "markdown" | "json" }): string;',
    'version: "research-document-coverage-plan-v1";',
    'version: "research-document-coverage-result-v1";',
    'version: "research-document-coverage-answer-v1";',
    'cleanup: "complete" | "unconfirmed" | "not_started";',
    "contentSha256: string;",
    "confirmedPlanDigest: string;",
  ]) assert.ok(types.includes(declaration), declaration);
});
