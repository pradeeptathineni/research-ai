import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { addWorkflowPerspective, compareWorkflowBranches, createPerspectiveWorkflow, draftWorkflowOutline, perspectiveSpanContribution, prepareWorkflowPerspectiveAddition,
  renderPerspectiveWorkflow, reviseWorkflowOutline, runWorkflowBranches, runWorkflowPerspectives,
  reviewWorkflowOutlineCitations, startWorkflowInvestigation, validatePerspectiveWorkflow, workflowComparisonCurrentness, workflowOutlineCurrentness } from "../src/index.mjs";
import { fakeCodex, message } from "./fake-codex.mjs";

const sha = s => createHash("sha256").update(s, "utf8").digest("hex");
const id = prefix => `${prefix}:${randomUUID()}`;
const first = "## Outcomes\nIn adults under 50, reported reduction was 12 percent.";
const second = "## Limitations\nIn adults over 70, reported effect was no change.";
const sources = [
  { uri: "https://papers.example/a", text: first, observedAt: "caller fixture" },
  { uri: "https://papers.example/b", text: second, omissions: ["The reports do not establish shared trial populations."] },
];
const at = (text, quote) => text.indexOf(quote);
const citation = (source, text, quote) => ({ source, start: at(text, quote), end: at(text, quote) + quote.length });
const perspective = (quote, status = "answered") => ({ questions: [{ question: "What does this source report?", status,
  answer: `The source says ${quote}.`, citations: [citation(quote === "12 percent" || quote === "adults under 50" ? 0 : 1,
    quote === "12 percent" || quote === "adults under 50" ? first : second, quote)] }], omissions: [] });
const branch = (finding, answer, uri) => ({ findings: [finding], gaps: [], sources: [{ uri }], answer });
const point = (attemptId, stance, branchQuote, sourceUri, sourceQuote) => ({ attemptId, stance, branchQuote, sourceUri, sourceQuote, sourceOccurrence: 1 });

test("one portable workflow composes perspectives, sibling-isolated branches, cited conflict and editable outline history", async () => {
  const firstFinding = "The under-50 subgroup is described as reduced.";
  const secondFinding = "The over-70 subgroup is described as unchanged.";
  const fixture = await fakeCodex({ sessions: [
    { events: [message(JSON.stringify(perspective("adults under 50"))), { type: "turn.completed" }] },
    { events: [message(JSON.stringify(perspective("12 percent"))), { type: "turn.completed" }] },
    { events: [message(JSON.stringify({ questions: [{ question: "What contrasting details occur?", status: "answered", answer: "The captures describe adults under 50 and adults over 70.", citations: [citation(0, first, "adults under 50"), citation(1, second, "adults over 70")] }], omissions: [] })), { type: "turn.completed" }] },
    { events: [message(JSON.stringify(branch(firstFinding, "The source reports a reduction among adults under 50.", sources[0].uri))), { type: "turn.completed" }] },
    { events: [message(JSON.stringify(branch(secondFinding, "The source reports no change among adults over 70.", sources[1].uri))), { type: "turn.completed" }] },
    { events: [message(JSON.stringify({ summary: "Reported effects differ across the described populations.", agreements: [], disagreements: [{ summary: "The outcomes differ by reported population.", positions: [
      point("a1", "reduction reported for younger adults", firstFinding, sources[0].uri, "12 percent"),
      point("a2", "no change reported for older adults", secondFinding, sources[1].uri, "effect was no change"),
    ] }], unknowns: [] })), { type: "turn.completed" }] },
    { events: [message(JSON.stringify({ sections: [{ title: "Reported population outcomes", points: [{ text: "The under-50 source reports a reduction.", citations: [citation(0, first, "12 percent")] }], gaps: ["These passages do not establish directly comparable populations."] }] })), { type: "turn.completed" }] },
    { events: [message(JSON.stringify(perspective("adults under 50"))), { type: "turn.completed" }] },
    { events: [message(JSON.stringify(perspective("reported effect was no change"))), { type: "turn.completed" }] },
  ] });
  try {
    let workflow = createPerspectiveWorkflow("How do reported outcomes differ by population?", { sources });
    workflow = await runWorkflowPerspectives(workflow, { lease: fixture.lease });
    assert.equal(workflow.perspectiveResult.status, "complete");
    const marginal = perspectiveSpanContribution(workflow);
    assert.equal(marginal.length, 3);
    assert.deepEqual(marginal.map(x => x.uniqueCitedSpans.map(s => s.quote)), [[], ["12 percent"], ["adults over 70"]]);
    assert.deepEqual(marginal.map(x => x.sharedCitedSpans.map(s => s.quote)), [["adults under 50"], [], ["adults under 50"]]);
    assert.deepEqual(marginal.map(x => x.claimsLosingAllCitations.length), [0, 1, 0]);
    assert.match(marginal[0].qualification, /not.*quality/);

    workflow = startWorkflowInvestigation(workflow, { questions: [
      { id: "q-younger", parentId: null, question: "What outcome is reported for adults under 50?" },
      { id: "q-older", parentId: null, question: "What outcome is reported for adults over 70?" },
    ] });
    workflow = await runWorkflowBranches(workflow, ["q-younger"], { lease: fixture.lease });
    workflow = await runWorkflowBranches(workflow, ["q-older"], { lease: fixture.lease });
    const branchBPrompt = (await fixture.session(4)).prompt;
    assert.match(branchBPrompt, /sibling branch findings are deliberately withheld/);
    assert.doesNotMatch(branchBPrompt, new RegExp(firstFinding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    workflow = await compareWorkflowBranches(workflow, { branchIds: ["q-younger", "q-older"], lease: fixture.lease });
    const comparison = workflow.comparisons[0];
    assert.equal(comparison.status, "complete");
    assert.equal(comparison.result.disagreements.length, 1);
    assert.deepEqual(comparison.result.disagreements[0].positions.map(p => [p.branchId, p.source.quote]), [
      ["q-younger", "12 percent"], ["q-older", "effect was no change"],
    ]);
    assert.equal(workflowComparisonCurrentness(workflow).current, true);

    workflow = await draftWorkflowOutline(workflow, { lease: fixture.lease });
    const original = workflow.outlines[0].outline;
    assert.equal(workflow.outlines[0].setAsideDisagreements.length, 1);
    assert.equal(perspectiveSpanContribution(workflow)[1].conflictCitedSpans[0].quote, "12 percent");
    assert.equal(perspectiveSpanContribution(workflow)[1].outlineClaimsLosingAllCitations.length, 1);
    assert.match(workflow.outlines[0].setAsideDisagreements[0].reason, /source-only/);
    const sourceQuote = "effect was no change";
    workflow = reviseWorkflowOutline(workflow, { sections: [...original.sections, { id: "comparison-context", title: "Limits on comparison",
      points: [{ text: "The retained passages describe different populations.", citations: [{ ...citation(1, second, sourceQuote), quote: sourceQuote }] }],
      gaps: ["Population differences remain unresolved in the source set."] }] });
    assert.equal(workflow.outlines.length, 2);
    assert.equal(workflow.outlines[0].outline.sections.length, 1, "edit retains the historical generated outline");
    assert.equal(workflow.outlines[1].status, "user-modified");
    assert.equal(workflow.outlines[1].citationReview.required, true);
    assert.throws(() => reviewWorkflowOutlineCitations(workflow, { confirmRevision: 1 }), /exact current revision/);
    workflow = reviewWorkflowOutlineCitations(workflow, { confirmRevision: 2 });
    assert.equal(workflow.outlines[2].status, "user-reviewed");
    assert.equal(workflow.outlines[2].citationReview.required, false);
    assert.throws(() => reviseWorkflowOutline(workflow, { sections: original.sections }), /requires conflictSetAsideReason/);
    workflow = reviseWorkflowOutline(workflow, { sections: original.sections }, { conflictSetAsideReason: "The source set does not establish comparable study populations." });
    assert.equal(workflow.outlines[3].conflictSetAside.removedSpans[0].sourceUri, sources[1].uri);
    assert.match(workflow.outlines[3].conflictSetAside.reason, /comparable study populations/);
    const oldComparison = structuredClone(workflow.comparisons[0]);
    const preview = prepareWorkflowPerspectiveAddition(workflow, { label: "Limitations", focus: "Identify stated limits on the outcome." });
    assert.equal(preview.nativeSessionCount, 2);
    assert.deepEqual(preview.staleComparisonIndexes, [0]);
    assert.deepEqual(preview.staleOutlineRevisions, [1, 2, 3, 4]);
    workflow = await addWorkflowPerspective(workflow, { label: "Limitations", focus: "Identify stated limits on the outcome." }, { lease: fixture.lease });
    assert.deepEqual(workflow.comparisons[0], oldComparison, "prior moderated comparison is retained byte-for-byte");
    assert.equal(workflowComparisonCurrentness(workflow, 0).current, false);
    assert.equal(workflowOutlineCurrentness(workflow, 3).current, false);
    assert.match(renderPerspectiveWorkflow(workflow, { format: "markdown" }), /stale after perspective selection change/);
    await assert.rejects(draftWorkflowOutline(workflow), /explicitly compare current independent branches/);
    const reopened = JSON.parse(renderPerspectiveWorkflow(workflow, { format: "json" }));
    assert.deepEqual(validatePerspectiveWorkflow(reopened), reopened);
    const markdown = renderPerspectiveWorkflow(workflow, { format: "markdown" });
    assert.match(markdown, /Claimed disagreements/);
    assert.match(markdown, /UTF-16/);
    assert.match(markdown, /Outline revision 2 \(user-modified\)/);
    assert.match(markdown, /Outline revision 3 \(user-reviewed\)/);
    assert.match(markdown, /Conflict set aside by researcher/);
  } finally { await fixture.cleanup(); }
});

test("failed perspective status is not reported as completed with zero contribution", async () => {
  const fixture = await fakeCodex({ sessions: [
    { events: [message(JSON.stringify(perspective("adults under 50"))), { type: "turn.completed" }] },
    { events: [message(JSON.stringify({ questions: [{ question: "Is population absent?", status: "unanswered", answer: "The capture does not answer this question.", citations: [] }], omissions: ["No population details beyond the supplied phrase."] })), { type: "turn.completed" }] },
    { events: [{ type: "turn.failed", error: { message: "synthetic stopped" } }] },
  ] });
  try {
    const workflow = await runWorkflowPerspectives(createPerspectiveWorkflow("outcomes", { sources: [sources[0]], perspectives: [
      { label: "No evidence angle", focus: "Check whether the requested detail appears." },
      { label: "Failed angle", focus: "Check a separate detail." },
    ] }), { lease: fixture.lease });
    const contributions = perspectiveSpanContribution(workflow);
    assert.deepEqual(contributions.map(x => x.status), ["complete", "complete", "failed"]);
    assert.equal(contributions[0].uniqueCitedSpans.length, 1);
    assert.equal(contributions[1].disposition, "completed-no-supporting-span");
    assert.equal(contributions[2].uniqueCitedSpans.length, 0);
    assert.match(contributions[2].qualification, /not treated as a completed search/);
  } finally { await fixture.cleanup(); }
});

test("a new perspective runs independently and appends exact marginal spans without changing prior lenses", async () => {
  const siblingFinding = "SIBLING_FINDING_MUST_NOT_ENTER_THE_NEW_PERSPECTIVE_PROMPT";
  const lensReply = (quote, answer) => ({ questions: [{
    question: "What does the retained source report?", status: "answered", answer,
    citations: [citation(quote === "adults under 50" || quote === "12 percent" ? 0 : 1,
      quote === "adults under 50" || quote === "12 percent" ? first : second, quote)],
  }], omissions: [] });
  const fixture = await fakeCodex({ sessions: [
    { events: [message(JSON.stringify(lensReply("adults under 50", siblingFinding))), { type: "turn.completed" }] },
    { events: [message(JSON.stringify(lensReply("12 percent", "The numeric lens answer."))), { type: "turn.completed" }] },
    { events: [message(JSON.stringify(lensReply("adults over 70", "The age lens answer."))), { type: "turn.completed" }] },
    { events: [message(JSON.stringify(lensReply("adults under 50", "A repeated neutral answer."))), { type: "turn.completed" }] },
    { events: [message(JSON.stringify(lensReply("reported effect was no change", "The added lens found a distinct retained span."))), { type: "turn.completed" }] },
  ] });
  try {
    const initial = createPerspectiveWorkflow("How do outcomes differ?", { sources, perspectives: [
      { label: "Numeric", focus: "Find reported quantities." },
      { label: "Age", focus: "Find population and age boundaries." },
    ] });
    const base = await runWorkflowPerspectives(initial, { lease: fixture.lease });
    const before = structuredClone(base.perspectiveResult.lenses);
    await assert.rejects(addWorkflowPerspective(base, { label: "Context leak", focus: "Should not run." }, { lease: fixture.lease, context: siblingFinding }), /cannot receive caller cross-lens context/);
    const added = await addWorkflowPerspective(base, { label: "Limitations", focus: "Identify stated limits on the outcome." }, { lease: fixture.lease });

    assert.equal(added.revision, base.revision + 1);
    assert.deepEqual(added.perspectiveResult.lenses.slice(0, -1), before);
    assert.deepEqual(added.lenses.slice(0, -1), base.lenses);
    assert.equal(added.lenses.length, base.lenses.length + 1);
    assert.equal(added.perspectiveResult.lenses.at(-1).lens.id, added.lenses.at(-1).id);
    assert.equal(added.perspectiveResult.comparison.at(-1).lens, added.lenses.at(-1).id);
    assert.deepEqual(added.sources, base.sources);
    assert.deepEqual(added.investigation, base.investigation);
    assert.deepEqual(added.comparisons, base.comparisons);
    assert.deepEqual(added.outlines, base.outlines);
    assert.ok(perspectiveSpanContribution(added).at(-1).uniqueCitedSpans.some(span => span.quote === "reported effect was no change"));
    const addedPrompt = (await fixture.session(4)).prompt;
    assert.doesNotMatch(addedPrompt, new RegExp(siblingFinding));
    assert.match(addedPrompt, /Limitations/);
    const reopened = JSON.parse(renderPerspectiveWorkflow(added, { format: "json" }));
    assert.deepEqual(validatePerspectiveWorkflow(reopened), reopened);

    await assert.rejects(addWorkflowPerspective(added, { label: "Limitations", focus: "A changed focus still has the same lens ID." }, { lease: fixture.lease }), /distinct lens/);
  } finally { await fixture.cleanup(); }
});

test("unfinished, failed and cancelled stages stay explicit in the portable closure", () => {
  const workflow = createPerspectiveWorkflow("Frozen topic", { sources });
  const reopened = validatePerspectiveWorkflow(JSON.parse(renderPerspectiveWorkflow(workflow, { format: "json" })));
  assert.equal(reopened.perspectiveResult, null);
  assert.equal(reopened.investigation, null);
  assert.deepEqual(reopened.comparisons, []);
  assert.deepEqual(reopened.outlines, []);
});

test("workflow CLI creates, validates and cold-renders without provider probes", () => {
  const cli = fileURLToPath(new URL("../bin/research-perspective-workflow.mjs", import.meta.url));
  const call = (action, input) => spawnSync(process.execPath, [cli, "--action", action], { input: JSON.stringify(input), encoding: "utf8" });
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /perspective-add/);
  const created = call("create", { topic: "Frozen topic", sources });
  assert.equal(created.status, 0, created.stderr);
  const workflow = JSON.parse(created.stdout);
  assert.equal(workflow.version, "research-perspective-workflow-v1");
  const validated = call("validate", { workflow });
  assert.equal(validated.status, 0, validated.stderr);
  assert.deepEqual(JSON.parse(validated.stdout), workflow);
  const rendered = call("render", { workflow, format: "markdown" });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /Perspectives not run/);
});
