# Retained-source claim support

Research owns `claim-support-v1`: exact captured source text and hashes, URI and
caller notes, ordered answer claims, exact UTF16 spans, judge identity/kind,
fallible joint/alone/leave-one-out judgments, and derived support annotations.
Exact occurrence is separate from generated entailment. Neither proves truth,
freshness, independence or complete coverage. Native creation is one frozen
generation/self-assessment session, labeled `same-session-model`.

Create the JSON using the separately installed Research CLI, explicitly naming
captured sources. No sources are fetched by this operation:

```sh
research-ai --grounded --sources captured.json "What do these captures establish?" > grounded.json
npm run research-answer -- --query "What do these captures establish?" --grounded-file grounded.json --observed-at 2026-10-22T12:00:00Z --retain --root /absolute/private/workspace
```

Without `--retain`, the second command previews validation and retention only.
Signals accepts only a complete grounded result and calls Research's validator
before storing it. The original `grounding` closure stays inside the ordinary
private query import's `result.input`. `importedAnswers` projects it to
`SearchResult.grounding`; optional native run closures are also validated on
write/read. No scores, entities, source access or independent verification are
created by importing. Imported answers retain their existing consumer eligibility;
this does not grant a new planning or follow-up operation.

Library searches the answer as before. The existing exact owner reader returns
the original immutable import bytes as `imported_answer`; consumers preserve its
full ref and digest. Deep renders the owner's annotations and retained spans.
After restart or deletion of the external input file, the copied closure remains
readable without model calls. Altered text, source hashes, spans, labels or derived
estimates are refused. Historical records without a closure stay unassessed.

For a read-only synthetic HTTP demonstration, run `npm run demo:grounding --
/absolute/new/demo-directory`. It prints the port and fresh owner scope; Ctrl-C
stops the server. `--reopen` opens the same demo store without generating or
rewriting its answer. This fixture server refuses mutations and native-token
acquisition. Deep's `tests/grounding-demo.mjs` drives this producer through its
real consumer bridge, keyboard interaction, narrow view and cold reopening.
Authored judgments demonstrate mechanics only.
