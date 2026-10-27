# Literature sets

`createLiteratureSet` and `addLiteraturePaper` compose caller-supplied citation metadata with exact notebook source pointers. A paper row stores the notebook ID and digest, source ID and digest, and document ID and digest. It never copies retained text into another library. `resolveLiteratureSet` requires the exact notebook snapshot and refuses a missing or changed owner record; its document references can then enter the existing notebook question and study/coverage APIs. Cited passages are inspected through those existing APIs. `availability: "available"` means the exact retained source exists; it does not mean retraction screening found the work clear. If `statusEvidence` is null, status is unknown.

`deduplicateLiteraturePapers` reports same-DOI and exact title/author/year matches as duplicate suggestions, leaving removal to a person. Similar titles are explicit ambiguity candidates and remain distinct. No row is merged automatically. A missing paper has no retained-source pointer. A retracted paper keeps the exact retained source pointer and must carry an explicit caller qualification and dated status evidence (`assertedBy`, `observedAt`, `verification: "asserted-unverified"`, and detail); the set does not infer or verify source status.

Caller-supplied `finding`, `stance`, and `claimKey` values can organize reported positions. `exportLiteratureSet` is a cold-open JSON export; `formatLiteratureSet` creates a Markdown bibliography with exact retained-source identities, availability qualifications, caller findings, and groups whose caller-reported stances differ. A differing stance is labelled as a conflict in reported positions, not a synthesis or truth assessment. Bibliographic metadata and findings remain unverified.

`prepareLiteratureQuestion` is a thin bridge to `prepareNotebookQuestion` for papers in one notebook at a time. It includes exact available source IDs, deduplicates repeated pointers to the same source record, and returns a coverage row for every paper. Papers from other notebooks remain in coverage as `outside-selected-notebook-cross-notebook-not-joined`; this first slice does not combine them into one question. Missing sources are explicitly marked not searched. Retracted sources are excluded by default but remain visible with exact identity and dated qualification; a caller can explicitly set `includeRetracted: true` to study them. Run and retain the question with the existing notebook/coverage owner; cited passage opening and saved answers remain with those owner APIs. It does not launch a model or claim coverage by itself. Both exports state the one-notebook scope limit.

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

The Signals owner remains responsible for acquisition and retained files. This module accepts frozen IDs, hashes and metadata supplied by the caller; it fetches no sources and provides no new research execution engine or durable store.
