# Reports from retained Research Studies

`createResearchStudyReportBasis(study, questionId)` projects only the exact
answer paragraphs with retained evidence IDs into the existing `research-report-v1`
outline and report engine. It calls the native Study citation getter for every
answer citation, preserving the selected notebook, record/version, page, source
and page digests, Study/question/result identities, and exact UTF-16 quote span.
Rows without retained evidence IDs are not imported and are listed as explicit
gaps and limits. No answer wording is rewritten by this projection.

The source URI uses the closed `research-notebook:` scheme and is recomputed from
the complete retained-origin binding. Ordinary Research outlines continue to
require caller-supplied HTTP(S) source identities. A retained source entry is an
opaque locator to the selected Study snapshot, not a link to fetch and not a
statement that the current notebook still has that version.

The result can be passed to `createReport`, edited with `reviseReport`, reopened
with `validateReport`, and rendered or exported with the existing Markdown, JSON
and offline HTML functions. User-edited prose remains labeled separately from
the original Study answer. Exact quotation proves occurrence in the frozen
source only, not entailment or truth. The portable report retains source
lineage; Deep may separately recheck present-day source availability.

The offline CLI accepts a saved Study JSON value on stdin:

```sh
node bin/research-study-report.mjs --action create < saved-study-question.json > report.json
node bin/research-report-export.mjs --input report.json > report.html
```

Both commands validate the Study/report and do not invoke a provider.
