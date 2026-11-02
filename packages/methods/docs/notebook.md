# Portable Research notebooks

A Research notebook keeps complete retained documents, editable note versions,
and explicit question results in one caller-owned JSON value. It creates no
database, network connection, embedding, or provider call by itself. Reading,
editing, citation lookup, validation, and export work offline.

```js
import {
  createResearchNotebook, reviseResearchNotebook, prepareNotebookQuestion,
  researchDocumentCoverage, recordNotebookQuestion, getNotebookCitation,
  saveNotebookQuestionAsNote, validateResearchNotebook,
} from "@pradeeptathineni/research-ai";
import { createHash } from "node:crypto";

const sha = value => createHash("sha256").update(value, "utf8").digest("hex");
const pageText = "The retained test cell delivered 1,200 cycles at 80% capacity.";
let notebook = createResearchNotebook("Battery evidence", { topic: "Cycle life" });
notebook = reviseResearchNotebook(notebook, { type: "add-source", document: {
  id: "cell-report", title: "Synthetic cell report", sha256: "a".repeat(64),
  pages: [{ number: 1, text: pageText, sha256: sha(pageText) }],
} });
notebook = reviseResearchNotebook(notebook, {
  type: "add-note", title: "Scope", text: "Compare only the supplied test reports.",
});

const spec = {
  id: "question:4f7d831d-fb2b-4a4b-89f4-c06c8f086999",
  question: "What cycle life did the test report?",
  sourceIds: [notebook.sources[0].id],
  notes: [{ id: notebook.notes[0].id, version: 1 }],
};
const prepared = prepareNotebookQuestion(notebook, spec);
// Show prepared.preview to the user and ask them to confirm its three digests.
const result = await researchDocumentCoverage(prepared.request.question, prepared.request.documents, {
  ...prepared.request.policy, confirmedPlanDigest: prepared.preview.planDigest,
});
notebook = recordNotebookQuestion(notebook, prepared, result);
const evidenceId = notebook.questions[0].result.draft?.evidence[0]?.id;
if (evidenceId) console.log(getNotebookCitation(notebook, spec.id, evidenceId));
notebook = saveNotebookQuestionAsNote(notebook, spec.id, { title: "Answer: cycle life" });
notebook = validateResearchNotebook(JSON.parse(JSON.stringify(notebook)));
```

Question scopes must name at least one notebook source or an exact note version.
An empty scope refuses before preparation; nothing expands to all notebook
content. The topic and title organize the notebook and are not added to the
model request. Each selected note becomes one complete page labelled
`Unverified note:`. Its exact version and digest remain attached to the result
after later edits.

The preview returns the complete request separately from a compact consent
projection. The projection binds the notebook, selected scope and deterministic
coverage plan; it omits page text while reporting each selected item, page
count, input digest, policy and bounded coverage counts. A caller displays
these exact values and requires fresh confirmation before execution.

`recordNotebookQuestion` validates the existing coverage result and its exact
source, note version, question and plan bindings. It can append to a notebook
that has newer notes, preserving those newer revisions. Questions retain
complete results, including partial or failed coverage. A result that cannot be
attached because the notebook reached its storage cap remains available to
the caller and must not be discarded or rerun automatically.

`getNotebookCitation` returns the retained evidence, exact page and the
original source record or selected note version. It never substitutes a newer
document or note. A saved answer is marked as question-originated and stays an
unverified prior synthesis. It can be edited in a later note version; the
original answer and citations remain unchanged.

## Briefing investigation seed

`createResearchNotebookFromBriefingSelection(workbench, selection)` converts a
current native `signals.briefing-workbench.v1` response into a portable Notebook
for one exact story. The caller must pass the story reference and the exact item
references the user selected; the operation never includes sibling items or
matches by URL. Selection is limited to the Notebook's existing source capacity.

```js
const notebook = createResearchNotebookFromBriefingSelection(workbench, {
  storyReference: selectedStory.reference,
  itemReferences: selectedItems.map((item) => item.itemReference),
  title: "Investigate selected Briefing story",
});
```

Each source retains only the owner-supplied excerpt, canonical URL, exact story,
item and source revisions, content and excerpt digests, observation time,
source health, and the matching source-terms record (or explicit unknown). A
known blocked source-terms policy refuses the handoff. Sources are marked as
unassessed leads; recording a Notebook does not assess claims or legal rights.
The function performs no persistence, fetch, inference or provider call. The
caller may present the returned Notebook and save it only through the existing
Notebook owner after the user's explicit action. Markdown rendering exposes
the unassessed classification and retained source policy details.

## CLI

`research-notebook --action create|revise|preview|ask|record|citation|save-note|render`
reads one JSON request from stdin and writes JSON to stdout. The commands take
no paths or URLs. Create a notebook, add complete documents and notes with
`revise`, then build a request with `preview`. For `ask`, submit the same
notebook and question spec together with the preview's exact notebook, scope,
and plan digests. `ask` checks readiness and invokes the existing frozen
coverage runner once. It does not ask again if the run's result cannot be
attached. Every other action is offline.

Use `record` to attach an already-held result, `citation` to reopen one evidence
item, `save-note` to make an answer editable, and `render` to export the full
notebook as JSON or readable Markdown. Markdown text is escaped as text; it is
not interpreted as HTML, Mermaid, or executable content.

The state format rejects unknown fields, digest mismatches, malformed source
pages, invalid quote closure, duplicate IDs and bounds beyond its conservative
host policy. Document-level hashes are caller assertions; page text hashes are
recomputed. Limits are policy bounds, not measured provider capacity. Results
are fallible research, not verified truth. Exact quote occurrence does not
establish entailment, currentness or source independence.

## Reuse and limits

The notebook/source/note relationships and the retained insight-to-note flow
are independently reproduced from concepts in the pinned MIT-licensed
`lfnovo/open-notebook` project. No donor source code or schema is included.
Research's existing complete-document planner, quote validator, result
validator and frozen runner are reused directly. The donor's database, model
stack, embeddings, vector retrieval, audio and cloud services are not included.
See [the notice and exact license](../src/notebook-NOTICE.txt) and
[third-party notices](../THIRD-PARTY-NOTICES.md).
