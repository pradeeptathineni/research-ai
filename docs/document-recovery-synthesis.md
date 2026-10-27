# Cross-section synthesis for document recovery

`research-document-recovery-synthesis-v1` adds one bounded synthesis call over validated section-review evidence from an existing `research-document-recovery-v1`. It does not change or rewrite section attempts, add a document parser, or create a second storage or research engine. `prepareDocumentRecoverySynthesis(recovery, policy?)` seals a pure plan to the exact recovery SHA and selected attempt history; `runDocumentRecoverySynthesis(recovery, plan, { confirmedPlanSha256, ... })` recomputes that closure and requires its exact plan digest before making at most one frozen call. The result embeds the original recovery and plan, so `validateDocumentRecoverySynthesis(JSON.parse(renderDocumentRecoverySynthesis(result, {format: "json"})))` cold-validates without another generation.

```js
const plan = prepareDocumentRecoverySynthesis(recovery, { maxSeconds: 120, maxResponseBytes: 128000 });
const result = await runDocumentRecoverySynthesis(recovery, plan, {
  confirmedPlanSha256: plan.planDigest,
  lease,
});
const portableJson = renderDocumentRecoverySynthesis(result, { format: "json" });
```

The evidence pool contains only `page_quote` records rebound to the exact retained original page: source ID, document SHA-256, page number, page SHA-256, UTF-16 span and literal quote. The synthesis cannot introduce an evidence ID or quote. Every answer row must cite supplied page quotes; each conflict must cite at least two sections and distinct original pages. Any malformed or unbound output fails as a whole. These checks establish citation occurrence and closure, not entailment, fairness, truth, independence or completeness.

Known settled omissions can be synthesized over and stay visible: partial or insufficient section answers, failed/cancelled/not-run sections, unreviewed windows, recovery gaps and caller-declared extraction gaps. A caller-declared OCR/table/layout gap remains unverified metadata. `not_run` means no section result was retained; its exact retained pages are listed as unreviewed. Any section with an `unknown` provider dispatch outcome blocks planning. Synthesis conflicts also force host coverage to `partial`; model-reported `answered` cannot upgrade a host qualification. With no cited answer but missing scope, coverage is `insufficient`.

`availability` remains the R05 term for the exact retained source being present; it is not a retraction or status-screening result. Status screening is unknown unless separately evidenced. This synthesis does not screen publications, verify retraction claims, or infer that a source is clean.

## Dispatch and recovery boundary

The result uses a deterministic `executionId` derived from recovery ID/SHA and plan digest. The direct API and CLI return only after the call settles and do not provide durable dispatch journaling across process loss. Deep or another durable caller should supply `dispatchSynthesis(request)` and persist its write-ahead intent before any provider start. On replay with the same ID, the callback must return the durable exact outcome, or `{ status: "unknown", reason }` for a pending intent; it must never start that same action twice. A throw is recorded as unknown. Research validates a returned `SessionOutcome` and output closure but cannot observe or provide the caller's journal. A section retry changes the recovery SHA, making any old synthesis plan stale.

The plan allows one additional synthesis call, at most 600 seconds and 512,000 response bytes, and caps evidence input at the existing 48,000 UTF-16-unit synthesis-input limit. It does not silently truncate evidence: an oversized plan is refused. The CLI accepts a single JSON request: `research-document-recovery-synthesis --action plan|run|validate|render`; `run` requires the recovery, exact plan and confirmation digest. For example:

```sh
research-document-recovery-synthesis --action plan < recovery.json
research-document-recovery-synthesis --action run < confirmed-plan-request.json
research-document-recovery-synthesis --action render < synthesis-result.json
```

## First-slice limits

The synthesis joins one `ResearchDocumentRecovery` artifact. A paper set distributed across independent recovery artifacts is not yet a cross-workspace query. It does not parse PDFs, retrieve sources, conduct status checks, update the source, independently assess claim support, create an editable outline, or export a full report. Answer prose is a fallible interpretation; the renderer always retains original quote locations and every mandatory known gap.

Public method references were inspected at the exact portfolio pins: PaperQA `c692d0dfeac4a0296599f7fe21a253a58b7ac12a` (Apache-2.0; separated evidence gathering and answer generation), and Haystack `7a71a93731162ba15057960b96a190f8771301bd` (Apache-2.0; evidence-plus-question prompt construction). No donor code was copied or adapted. Their licenses do not cover source documents, model weights or OCR assets.
