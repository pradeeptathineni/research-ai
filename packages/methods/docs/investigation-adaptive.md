# Adaptive guided investigation

The existing `guided-investigation-v1` state stays readable. An explicit `reviseInvestigation` appends the exact prior plan checkpoint to optional `planHistory`; older untouched states keep their original serialized shape. Budget-only revisions preserve completed findings when the exact question, source digests, topic, goal, scope and branch mode are unchanged. Changing any of those scope inputs makes prior work historical. Question additions leave unchanged question identities eligible; editing a question requires new work. Usage counters never reset.

`planInvestigation(state)` is an offline review snapshot. It shows completed and remaining question IDs and binds all fields, including source digests, exact budgets and prior plan checkpoints, in its digest. `advanceInvestigationPlan(state, plan, { confirmedPlanDigest, action: 'investigate', branchIds, lease })` requires that exact fresh plan digest, explicit branches, and caller-provided frozen source text. It rejects completed compatible branches. Failed, partial and cancelled attempts remain visible; retrying them is explicit and spends the existing budget. No search or source acquisition is introduced. A source/topic/goal/scope/branch-mode change invalidates previous findings for current use, even if later edits revert the values.

The plan also carries a deterministic method-progress projection against a zero-completion baseline: current completed/remaining branches, findings, reviewed findings, reported gaps, blocked state, and the remaining fixed budget. This is retained-work accounting only; it does not judge answer adequacy, truth or whether further research is useful. `renderInvestigation` shows the same progress and any caller-authored source-span reviews.

`reviewInvestigationClaim(state, input)` appends a bounded caller-authored assessment for one finding from a current completed branch. Each citation must point to the exact text and SHA-256 of a frozen source used by that attempt. Reviews survive JSON cold reopen; a changed question, scope, source or quote makes them historical without retargeting the span. Exact occurrence and the caller's assessment remain distinct from model output and do not establish entailment or truth. Reviews do not invoke Codex or consume/reset any budget.

```js
let state = createInvestigation('Question', {
  questions: [{ id: 'q1', parentId: null, question: 'What does the retained source say?' }],
  sources: [{ uri: 'https://example.org/capture', text: 'Caller-provided retained text.' }],
});
let plan = planInvestigation(state);
state = await advanceInvestigationPlan(state, plan, {
  confirmedPlanDigest: plan.digest, action: 'investigate', branchIds: ['q1'], lease,
});
```

The standalone `research-investigation` CLI reads one JSON object from stdin: `--action create|validate|plan|revise|advance|render`. The `advance` request is `{ "state", "plan", "confirmedPlanDigest", "branchIds", "lease?" }`; it calls the same strict native API. The CLI is stateless, so durable request intent, lost-reply resolution and exact-ID recovery remain with the caller (such as Deep's existing request journal). Cold `validate`, `plan` and `render` do not start Codex.

Execution status, retained input coverage, and answer adequacy remain distinct. A complete native turn only records what the bounded session returned; it does not prove truth, source completeness, or answer adequacy. Model confidence is not used as a stop condition. This addition does not change Document Recovery's page/section coverage and retry policy.
