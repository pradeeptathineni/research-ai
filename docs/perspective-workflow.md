# Perspective research workflow

The portable `research-perspective-workflow-v1` composes existing Research owners over one exact frozen source set. It does not add storage or another execution engine. Create a workflow, run selected perspectives, start an independent investigation with at least two explicit questions, run the branches, compare chosen attempts, draft an outline, and revise it with copy-on-write history. JSON export embeds the exact source snapshots and each owner artifact; cold validation and rendering never rerun work.

```js
let workflow = createPerspectiveWorkflow(topic, { sources, perspectives: "auto" });
workflow = await runWorkflowPerspectives(workflow, { lease });
workflow = startWorkflowInvestigation(workflow, { questions });
workflow = await runWorkflowBranches(workflow, ["q-a"], { lease });
workflow = await runWorkflowBranches(workflow, ["q-b"], { lease });
workflow = await compareWorkflowBranches(workflow, { branchIds: ["q-a", "q-b"], lease });
workflow = await draftWorkflowOutline(workflow, { lease });
workflow = reviseWorkflowOutline(workflow, { sections: editedSections });
const portableJson = renderPerspectiveWorkflow(workflow, { format: "json" });
```

`perspectiveSpanContribution` compares exact source SHA-256/offset/quote identities across completed lenses. It includes source URI and digest, plus perspective and outline claims whose every cited span would disappear if that lens were removed. This is a deterministic set difference, not a quality or truth score. Failed, cancelled and not-run lenses remain separate from completed lenses with no unique span. This version does not add perspectives after comparison; start a new workflow for a changed selection. Existing comparison history is never relabelled.

Independent branches use the existing investigation owner, which withholds sibling findings from a branch. `compareWorkflowBranches` preserves explicit branch attempt IDs and exact source quotes; disagreements remain attributed to their branch and source. Every comparison remains versioned history, and currentness can be checked separately.

The outline stage delegates to the existing source-only `outlineResearch` engine. It does not feed comparison output into a second synthesis model. Reported disagreements are carried alongside the outline as set aside items with this reason; a person can edit the outline using exact frozen-source spans. User edits append a new outline version. If an edit changes a claim or its citations, the export marks citation review as required; `reviewWorkflowOutlineCitations` records explicit caller confirmation for that exact revision. Removing a span cited in a recorded conflict requires `conflictSetAsideReason`, retained beside the removed span in the new outline history entry.

Workflow capture identity is immutable: each cited passage remains bound to its exact frozen source version and offsets. Stage records retain their owning artifacts and digests; a partial/failed/cancelled stage is not reported as a completed empty search. This first slice is one frozen source closure for a workflow. It does not provide an independent-workspace multi-notebook merger, automatic perspective additions after comparison, or a comparison-fed outline generator. A caller can restart on a changed source/perspective selection; doing so creates a new workflow rather than silently migrating citations.

The CLI is `research-perspective-workflow --action create|validate|perspectives|investigation-start|branches|compare|outline|outline-edit|outline-review|contribution|render`; each action reads bounded JSON on stdin. Model-running actions are explicit and use the same installed Codex CLI, frozen input and existing budget/cleanup semantics. Tests use `test/fake-codex.mjs` only.

Methods adapt STORM's persona and curated-outline ideas from the public MIT-licensed revision `fb951af7744dab086e34962e9bc6fe878e145f83`; no donor code is copied. The exact upstream source and license are recorded in `THIRD-PARTY-NOTICES.md`.
