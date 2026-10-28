# Portable cross-notebook study sessions

`research-study-v1` is a small composition record for carrying explicitly chosen
source pages and note versions from multiple Research notebooks into one
question. This is an original Research implementation and contains no copied donor code. The notebooks remain the source of truth. A selected page hit is an
anchor for discovery; the study retains the complete selected source document
for question preparation. A selected note keeps its exact version and its
`Unverified note:` label.

The study embeds only the selected source documents or note versions, rather
than copying entire notebooks. Each selection also records the origin notebook
ID and digest, search query/options/scope and result digest, exact hit identity,
source or note identity, and content digest. This makes a study self-contained
for cold reopen. `validateResearchStudy` checks the embedded closure without
requiring current notebooks. `checkResearchStudyOrigins` separately reports
whether the current origin notebook is current, changed or missing, and whether
the selected record version still matches. An unrelated later notebook edit
can make the origin status `changed` while leaving the embedded historical
study and its citations readable. New evidence requires an explicit new
selection.

An inspected hit from a frozen lexical retrieval preview can also be added
through `reviseResearchStudy` with `type: "select-retrieval-hit"`. This variant
requires a fresh result from Research's existing notebook search and hit opener;
it refuses a source ID or selected page/note digest that does not match that
current native hit. The Study keeps its ordinary full-document or exact
note-version snapshot and adds a separate `origin.retrieval` record containing
the preview, optional comparison, corpus, question, source, selected passage
digest, exact UTF-16 bounds, and the full canonical source digest; each lexical
arm digest is separate. The new native search input/result digests
remain distinct from the retrieval preview and its ranks. A document search hit
still selects the complete document; its chosen page remains an explicit
provenance anchor. This binds the source and reviewed passage without claiming
that lexical rank establishes relevance, support, entailment, or truth.

Question preparation names 1–8 selected records and reuses the complete-document
coverage planner. The preview shows selected origins, counts and the exact plan
digest. `recordResearchStudyQuestion` requires the exact study commitment,
selection, and plan; repeating the same retained result is idempotent. Citation
reopen uses the exact selected version stored in the study. Citations identify
text occurrence, not entailment, truth or currentness. No source is fetched and
this workflow makes no model call by itself.

```js
import {
  createResearchStudy, reviseResearchStudy, searchResearchNotebooks,
  prepareResearchStudyQuestion, researchDocumentCoverage,
  recordResearchStudyQuestion, getResearchStudyCitation, saveResearchStudyQuestionAsNotebookNote, validateResearchStudy,
} from "@pradeeptathineni/research-ai";

const notebooks = [methodsNotebook, resultsNotebook];
const hits = searchResearchNotebooks(notebooks, "retention", { kinds: ["document", "note"], noteVersions: "all" });
let study = createResearchStudy("Retention comparison");
study = reviseResearchStudy(study, {
  type: "select-hit", notebooks, search: hits, hitId: hits.hits[0].id,
});
const prepared = prepareResearchStudyQuestion(study, {
  id: "study-question:4f7d831d-fb2b-4a4b-89f4-c06c8f086999",
  question: "What retention periods do the selected sources state?",
  selectionIds: [study.selections[0].id],
});
// Present the preview and require explicit confirmation before any research run.
const result = await researchDocumentCoverage(prepared.request.question, prepared.request.documents, {
  ...prepared.request.policy,
  confirmedPlanDigest: prepared.preview.planDigest,
});
study = recordResearchStudyQuestion(study, prepared, result);
const reopened = validateResearchStudy(JSON.parse(JSON.stringify(study)));
const evidenceId = reopened.questions[0].result.draft?.evidence[0]?.id;
if (evidenceId) console.log(getResearchStudyCitation(reopened, prepared.spec.id, evidenceId));
const destination = saveResearchStudyQuestionAsNotebookNote(reopened, answerNotebook, prepared.spec.id);
```

`saveResearchStudyQuestionAsNotebookNote(study, notebook, questionId, options)`
adds a versioned note to the chosen notebook. It requires a complete synthesized
answer whose every claim cites retained evidence, labels cited source titles,
and carries the reported coverage and gaps into the note. Its typed `study`
origin records the study ID, question ID, study SHA-256, and a digest of the
complete retained result. Editing later note versions preserves that origin;
the original study JSON still contains its source snapshots and remains able to
reopen every citation independently. The note stores a concise answer projection,
not copied source documents. `research-study --action save-note` accepts
`{study, notebook, questionId, title?, id?}` and returns the revised notebook.

## CLI

`research-study --action create|select|deselect|validate|origins|preview|record|citation|save-note|render`
reads one JSON request from stdin. `select` needs explicit current notebooks,
the retained search result and one hit ID; it validates and opens that hit before
copying its bounded selected evidence. `origins` needs current notebook values.
`preview`, `record`, `citation`, `validate` and `render` operate offline on the
study value. The command never performs source acquisition or starts a model.

The study holds at most 16 selected records, 32 questions and 16 MiB of JSON;
each question can use at most 8 records, matching the existing complete-document
coverage API. Different origin notebooks that use the same document ID cannot
be combined into one question because the coverage engine requires unique
per-question document IDs; the API reports this explicitly. Search ranking is
lexical relevance only. Answers remain fallible research and note-derived
content remains unverified.
