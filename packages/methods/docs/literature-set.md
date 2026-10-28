# Literature sets

`createLiteratureSet` and `addLiteraturePaper` compose caller-supplied citation metadata with exact notebook source pointers. A paper row stores the notebook ID and digest, source ID and digest, and document ID and digest. It never copies retained text into another library. `resolveLiteratureSet` requires the exact notebook snapshot and refuses a missing or changed owner record; its document references can then enter the existing notebook question and study/coverage APIs. Cited passages are inspected through those existing APIs. `availability: "available"` means the exact retained source exists; it does not mean retraction screening found the work clear. If `statusEvidence` is null, status is unknown.

`deduplicateLiteraturePapers` reports same-DOI and exact title/author/year matches as duplicate suggestions, leaving removal to a person. Similar titles are explicit ambiguity candidates and remain distinct. No row is merged automatically. A missing paper has no retained-source pointer. A retracted paper keeps the exact retained source pointer and must carry an explicit caller qualification and dated status evidence (`assertedBy`, `observedAt`, `verification: "asserted-unverified"`, and detail); the set does not infer or verify source status.

Caller-supplied `finding`, `stance`, and `claimKey` values can organize reported positions. `exportLiteratureSet` is a cold-open JSON export; `formatLiteratureSet` creates a Markdown bibliography with exact retained-source identities, availability qualifications, caller findings, and groups whose caller-reported stances differ. A differing stance is labelled as a conflict in reported positions, not a synthesis or truth assessment. Bibliographic metadata and findings remain unverified.

`prepareLiteratureQuestion` remains the v1 bridge to `prepareNotebookQuestion` for a single notebook. Existing v1 export text retains its historical one-notebook scope qualification for compatibility; it describes that legacy helper. The additive multi-notebook API is separate. For a bounded multi-notebook question, `prepareLiteratureStudyQuestion(set, notebooks, question, policy, { paperIds, includeRetracted })` prepares selected exact paper records through the existing `prepareDocumentCoverage` engine. `paperIds` must explicitly name 1–100 unique records. Exact aliases of the same full source binding become one review document; the existing coverage engine then enforces its limit of eight unique documents and refuses a larger plan. It checks all set metadata, then opens only selected eligible source pointers; a missing or stale selected notebook/source refuses preparation. Missing records, unselected records and default-excluded retracted records stay visible in `coverage` with their original status evidence and caller qualifications. Only `includeRetracted: true` opts a selected retracted source into review.

Execution documents deduplicate only when the full notebook/source/document binding is identical. Every aliased paper record remains in the `sourceMap`, and projected citations point back to all of them with a same-source alias label. Distinct bindings remain separate even when their bytes match; independence is unknown. The preparation is a frozen metadata-and-document closure with a deterministic coverage plan, not search evidence or a stored result. Before a new run, `checkLiteratureStudyQuestionSources(prepared, currentSet, notebooks)` returns `{ schema: "research-literature-study-currentness-v1", literatureSet: { status, expectedSha256, currentSha256 }, sources }`. The set status is `current` or `changed`; each selected unique source row has `coverageDocumentId`, `status`, `notebookId` and `sourceId`, plus current notebook/source/document digests when present. Source status is `current`, `changed` or `missing`. If the notebook is absent, the digest fields are omitted; if the notebook exists but its source is absent, digest/document fields are `null`. The host must check the set and all selected source rows before dispatch. `validateLiteratureStudyQuestion(prepared)` cold-validates its embedded closure without current notebooks; cold validity does not establish currentness. After the existing `researchDocumentCoverage` owner runs, `projectLiteratureStudyEvidence(prepared, result)` checks the exact plan and restores paper/source identities to each validated citation. This API starts no session and adds no acquisition or persistence.

```js
const set = createLiteratureSet("Question title");
const next = addLiteraturePaper(set, {
  id: "paper:...", metadata: { title: "...", authors: ["..."], year: 2025 },
  availability: "available",
  source: { notebookId, notebookSha256, sourceId, sourceDigest, documentId, documentSha256 },
  finding: null, stance: null, claimKey: null, qualification: [],
});
const reopened = resolveLiteratureSet(next, [exactNotebookSnapshot]);
```

Example:

```js
const prepared = prepareLiteratureStudyQuestion(set, [notebookA, notebookB],
  "What findings do these selected papers report?", { maxCalls: 8 },
  { paperIds: [paperA.id, paperB.id] });
const currentness = checkLiteratureStudyQuestionSources(prepared, set, [notebookA, notebookB]);
if (currentness.literatureSet.status !== "current" || currentness.sources.some(row => row.status !== "current")) {
  throw new Error("Review the changed selected literature sources before dispatch.");
}
const result = await researchDocumentCoverage(prepared.request.question, prepared.request.documents,
  { ...prepared.request.policy, confirmedPlanDigest: prepared.preview.planDigest });
const attributed = projectLiteratureStudyEvidence(prepared, result);
```

If all selected rows are missing or excluded by status, `request` and `preview` are `null`; there is no coverage run to dispatch. The Signals owner remains responsible for acquisition and retained files. This module accepts frozen IDs, hashes and metadata supplied by the caller; it fetches no sources and provides no new research execution engine or durable store.

After a retained coverage job returns, `exportLiteratureStudyPlanningSource(prepared, result, requestId)` creates a bounded Planning source from that exact prepared closure and result. It preserves the admission UUID, set and preparation digests, source and paper map, selected availability/status qualifications, reported execution status and answer coverage separately, exact citations and quotes, and stated gaps. `validateLiteratureStudyPlanningSource` recomputes the source from those same frozen values and refuses altered citations. Exported currentness is explicitly `frozen-snapshot-origin-not-checked`; the host must check owner currentness separately before a new dispatch. The exporter refuses text over 16,000 UTF-16 units or binding/qualification over 16 KiB; it never truncates papers or citations.

```js
const source = exportLiteratureStudyPlanningSource(prepared, result, requestId);
const checked = validateLiteratureStudyPlanningSource(prepared, result, requestId, source);
```
