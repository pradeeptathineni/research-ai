# research-ai

Bounded, read-only, ephemeral research sessions through your installed and
authenticated [Codex CLI](https://github.com/openai/codex). It returns
**fallible** Markdown research with a receipt. It maintains no corpus or durable
research store, and does not verify claims or score sources.

`@pradeeptathineni/research-ai` 0.4.0-rc.1 (local candidate) · MIT · Node 24 · zero runtime dependencies ·
no build step (`.mjs` plus hand-written `.d.ts`).

## Run

```sh
git clone https://github.com/pradeeptathineni/research-ai.git
cd research-ai
node bin/research-ai.mjs "Which portable note formats survive app migrations?"
node bin/research-ai.mjs --profile wide --context "single user, offline first" "..."
node bin/research-ai.mjs --readiness   # installation/auth/profile observations; no model call
```

Use Node 24.19 or later within Node 24. No package install or build is needed
to run from the checkout. Live research requires your separately installed and
authenticated Codex CLI; `--help` and the offline tests do not.

When installed as a package, the same CLI is `research-ai`.

- The answer goes to stdout with one added newline; progress and one final JSON
  receipt go to stderr. The API preserves answer bytes without that CLI newline.
- Complete API answers preserve the final message exactly. The prompt's 24,000
  character target is advisory; the captured wire has a hard byte cap. Interim
  notes have a separate bounded buffer with an explicit omission marker.
- Exit codes: `0` complete, `2` partial (stopped, but completed interim notes
  exist), `1` failure or usage error.
- `quick` (default) allows 8 searches, 20 reads and 240 s. `wide` allows 24
  searches, 60 reads and 600 s. These are limits, not quality guarantees.
- Before a CLI research session it observes `codex --version`, `codex login status`
  and `codex exec --help`, with a 5-second limit and 64 KiB per output stream
  for each probe. Missing,
  logged-out, unknown authentication and unsupported execution profiles stop
  before any session. `--readiness` performs only these observations.
- Model and effort: `--model`/`--effort`, otherwise the `model` and
  `model_reasoning_effort` keys in `~/.codex/config.toml`, otherwise the CLI
  default. Only those model-selection keys are used from that config file;
  authentication stays with the installed Codex CLI.

## API

```js
import {
  researchQuestion,
  codexReadiness,
  withCodexWorkspace,
} from "@pradeeptathineni/research-ai";

const { status, answer, receipt } = await researchQuestion("question", {
  profile: "quick",
  signal: AbortSignal.timeout(300_000),
  onCheckpoint: (note) => console.error(note.text), // bounded interim notes
});
```

### Live activity (`research-activity-v1`)

`activity(event)` on `researchQuestion` or `workspace.run` receives typed,
synchronous observations while a session runs: `version`, a per-session
`sequence` starting at 1, ISO `observedAt`, `kind` and a closed `detail`.
`researchActivity.kinds` lists the supported kinds; `researchActivity.unsupported`
lists facts never reported (fetch/HTTP status, verification, queries, page
content, partial answer text, reasoning, non-web items).

- Native: `thread.started`, `turn.started`, `web.started`, `web.completed`
  (action type, counts and a `url` only when the native report has an http(s)
  URL with no credentials, query or fragment; otherwise `url: null` with
  `urlStatus` `absent` or `withheld`), `runner.error`, `turn.completed`, `turn.failed`.
- Host: `session.started`, `checkpoint` (note count, UTF-16 units, bytes,
  omission flag; the note itself still goes to `onCheckpoint`), `protocol.failed`,
  `session.stopped` (first trigger), `activity.limited` and `session.settled`.
  `session.settled` comes last, after terminal/protocol/cleanup checks, and its
  `completed` equals `sessionCompleted(outcome)`.
- At most 512 events are delivered before `activity.limited`; later ones are
  dropped and counted in `session.settled.omitted`.
- A web completion is a native report, not proof of access, source truth or
  entailment. Events are ephemeral: no store, resume cursor or permission.
- A throwing or promise-returning observer stops the session with
  `activity_callback_failed`, like the other callbacks; it is not called again.

`--activity-jsonl` (ordinary research only) writes these events to stderr as
JSON lines instead of progress text. The last stderr line is the usual receipt.
Stdout and exit codes are unchanged.

### Readiness observations

`codexReadiness()` and `--readiness` return additive schema version 1. Existing
`installed`, `available` and `runner` fields remain. `installed` means the version
executable ran; a failed login probe does not erase that observation. `version`
is nullable, and `authenticated` and `supportedProfile` are independently nullable:
null means unknown, never logged-out or unsupported. `available` requires a
recognized version, confirmed authentication and advertised execution options.

`probes` provides each command's source, UTC observation time, exit code and
machine failure. `error` and `remedy` explain the first blocking observation.
Known `Not logged in` output (exit 0 or 1) is distinct from other failed or
unrecognized login output. No raw authentication text is returned or retained.

The `codex-exec-json-v1` profile checks that help advertises the options this
executor uses: config overrides, isolation flags, JSON, schema, cwd and model.
It does not guess support from a minimum version number. An older version
missing options is unsupported; unrecognized help leaves support unknown.
Advertised options do not qualify native permission enforcement, JSONL behavior,
model access, funding or research quality. The library's lower-level session API
retains its existing caller-managed readiness policy. Signals integration and
package version/pin coordination require separate acceptance.

### Frozen sources

To reuse material you already captured instead of a live web search, pass it
explicitly. Without `sources`, behaviour and receipts are unchanged.

```js
await researchQuestion("question", {
  sources: [
    {
      uri: "https://example.org/a",
      text: "...",
      observedAt: "caller note",
      omissions: ["gap"],
    },
  ],
});
```

```sh
node bin/research-ai.mjs --sources captured.json "question"
```

- `sources` (or the `--sources FILE` JSON array, a regular file of at most
  256 KiB that you name; no path is discovered or copied into the package) holds
  1–8 `{ uri, text, observedAt?, omissions? }`. `text` is text, never a path.
  `uri` is an http(s) citation identity: printable ASCII, at most 2,000
  characters, unique, no credentials. Combined text is at most 48,000 UTF-16
  units; `observedAt` is one line of at most 64 characters; `omissions` is at
  most 8 single-line strings of at most 500 characters. With sources, `context`
  is at most 8,000 units.
- Anything empty, malformed or over a limit is refused (`invalid_sources`)
  before a lease or session; it is never truncated and never falls back to live.
- Web search is disabled and nothing is fetched or followed. The supplied text,
  URIs and notes are sent to the provider as untrusted data; keep private
  material out of the file. The prompt tells the model that dates, coverage and
  independence are unknown unless the text says so, and to report unanswered
  parts and stale-information limits.
- The receipt adds `mode: 'frozen'` and `source: [{ uri, sha256, observedAt?,
omissions? }]` (SHA-256 of the exact UTF-8 text, caller notes verbatim). This
  identifies what was supplied; it does not verify, date or certify anything.

### Complete-document questions

`prepareDocumentResearch(question, documents)` checks caller-provided extracted
pages and returns a consent-preview digest. `researchDocuments(question,
documents, options)` then sends every page together in one frozen, schema-bound
session. It does not choose passages or fetch links. Limits are four documents,
50 ordered pages each, and 48,000 combined UTF-16 units. Page hashes are checked
against their UTF-8 text; a document's raw-byte digest remains caller-asserted.

`validateDocumentResearch` checks the retained page closure, answer evidence IDs
and exact page-local UTF-16 spans. `renderDocumentResearch` exports JSON or
Markdown. A complete answer requires a valid citation for every answer paragraph;
insufficient source coverage returns an empty answer and explicit gaps. Citation
relations are fallible model judgments, not verification. Non-complete sessions
retain their receipt but never promote interim text to an answer. See
[`docs/document-research.md`](docs/document-research.md).

```sh
research-documents --input captured-documents.json --profile quick
```

The CLI reads only the explicitly named JSON input, prints the result to stdout
and the session receipt to stderr, and retains no document corpus.

`withCodexWorkspace({ lease, prefix }, async (workspace) => workspace.run(options))`
is the lower-level executor. Callers supply the prompt, live or frozen mode,
budget, optional JSON output schema, response byte cap, checkpoint reader and
their own absolute lease path and a simple temporary-directory prefix. Those
paths and callbacks are trusted host configuration, never model/source input.
Each workspace allows one session. Returning or throwing
from its callback drains the owned group before releasing the lease;
later or additional calls are refused. Invalid options and cancelled requests
fail before native dispatch. Budget limits are finite: at most 10,000 searches
and reads each, 3,600 seconds, and an optional response cap of 1–3,000,000 bytes.
Signals uses it for live research and frozen,
schema-bound evidence review. See [`src/index.d.ts`](src/index.d.ts) for exact types.

### Claim support from retained sources

`groundedResearchQuestion(question, { sources, ...options })` returns a
`claim-support-v1` closure alongside its answer. It uses one frozen schema-bound
session: ordered claim paragraphs, exact source spans, and same-session support
judgments. Each whole claim is supported, unsupported, conflicting or unknown;
each citation records its judgment alone and with that citation removed. Source
text, SHA256, URI, original caller notes and UTF16 offsets stay in the closure.
No source is fetched. Invalid bindings fail the result without accepting a partial
structured answer. Ordinary `researchQuestion` retains its existing behavior.

```sh
node bin/research-ai.mjs --grounded --sources captured.json "What do these sources establish?" > grounded.json
```

`groundedAnswer({ sources, claims, judge })` validates caller-produced judgments
and creates the same closure without inference. `assessGroundedAnswer` instead
accepts an explicit caller-selected judge callback; it sends only the selected
spans, performs at most nine calls per claim and checks cancellation before and
after each reply. That callback owns its cost, deadline and provider permission;
no alternate model is installed or selected. `validateGrounding(answer, closure)`
replays bindings and derived labels offline before retention or reopening.

The ALCE joint/alone/leave-one-out method is reproduced with explicit claim units
instead of automatic sentence splitting. Unknown/conflicting judgments suppress
aggregate estimates. A citation that supports a claim alone earns contribution
credit even if another also supports it, matching ALCE's definition. These are
support estimates, not truth scores. Exact occurrence proves only that the text
is in the supplied capture. Self-assessment is especially fallible and is labeled
as such; fixtures establish mechanics only. See [source reuse](THIRD-PARTY-NOTICES.md).

### Perspectives from retained sources

`perspectiveResearch(topic, { sources, perspectives, questions })` looks at one
topic through several question lenses, using only the sources you supply. A
neutral **Basic facts** lens always runs first. Other lenses come from headings
in your sources (`perspectiveCandidates(sources)` lists them with exact offsets;
`"auto"` takes the first three) or from your own `{ label, focus }`, at most six
in total. Each lens runs as its own frozen, schema-bound session, one after
another, so no lens sees another's answers. It asks up to `questions` (1–4,
default 3) questions, answers each from exact source spans or marks it partial
or unanswered, and lists what it would need that the sources lack.

```sh
node bin/research-ai.mjs --sources captured.json --list-perspectives      # no session
node bin/research-ai.mjs --sources captured.json --perspectives auto "Home battery storage" > lenses.json
```

The `perspectives-v1` result keeps each lens's status (`complete`, `failed`,
`cancelled` or `not_run`), questions, exact quotes, omissions and receipt, plus a
comparison row per lens, the unanswered questions and all omissions. Overall
status is `complete`, `partial`, `failed` or `cancelled`; completed lenses survive
a later failure or cancellation. A reply with any bad span fails that lens whole.
Lenses steer questions; they are not people or expertise, and a perspective
missing from your headings stays missing. Nothing is fetched or stored. The
method adapts STORM's persona step; see [notices](THIRD-PARTY-NOTICES.md).

### Cited outlines from retained sources

`outlineResearch(topic, { sources, maxSections })` arranges explicitly selected
frozen captures into an ordered, editable outline. Each point has exact source
spans, and missing or conflicting material belongs in section gaps. A matching
quote proves occurrence only; it does not prove that the source supports the
point. The `research-outline-v1` draft keeps the supplied captures and exact
SHA-256 digests for later validation.

```sh
node bin/research-ai.mjs --outline --sources captured.json --max-sections 6 "Home battery storage"
node bin/research-ai.mjs --outline-input draft.json --outline-format markdown
```

`validateOutline` checks the closed draft shape, source digests and UTF-16 quote
bindings. Generated drafts also carry a digest over their topic, sources and
sections; it detects edits, but does not authenticate who created a file.
Markdown identifies generated origin as caller-declared and unverified. Use
`reviseOutline` to apply topic or section edits and mark the result
user-modified. `renderOutline` validates before exporting Markdown or JSON and
includes each source digest and caller omission/qualification note. Source URIs
are displayed as text, never turned into links. The formatting CLI path opens
only the explicit draft file and makes no model call. Drafts are ephemeral
unless a consumer chooses to keep them. This adapts STORM's
curated-conversation outline refinement to frozen caller text and user edits;
it omits STORM's unconstrained parametric draft and Wikipedia fetching. See
[notices](THIRD-PARTY-NOTICES.md).

### Evidence-linked mind maps

`createMindMap(question, { sources, root })` creates an explanatory concept
hierarchy from exact retained captures. Each descendant has cited UTF-16 spans
or an explicit knowledge gap; `elaborates`, `qualifies` and `contrasts` describe
its relationship to its parent. This explains concepts and tradeoffs, while
outlines arrange reading order and investigations track questions/actions.

```sh
node bin/research-ai.mjs --mindmap-create --sources captures.json --mindmap-root root.json 'Where does search run?' > map.json
node bin/research-ai.mjs --mindmap-input map.json --mindmap-edit edits.json > edited.json
node bin/research-ai.mjs --mindmap-input edited.json --mindmap-format markdown
node bin/research-ai.mjs --mindmap-input edited.json --mindmap-format tree
node bin/research-ai.mjs --mindmap-draft --sources captures.json 'Where does search run?' > result.json
```

`root.json` is a node with exactly `{id,label,relation,citations,gap,children}`:
root relation is null; other relations are `elaborates|qualifies|contrasts`.
For example, a child can be
`{"id":"local","label":"Files remain on device","relation":"elaborates","citations":[{"source":0,"start":0,"end":37,"quote":"Local search retains files on device."}],"gap":null,"children":[]}`.
A gap child instead has `citations:[]` and a nonempty `gap`. Root needs a child.
Each citation uses a zero-based source index and half-open UTF-16 offsets.
`edits.json` accepts `{question?,root?,nodes?:[{id,label?,relation?,citations?,gap?}]}`.

`validateMindMap` checks the complete `research-mindmap-v1` closure, including
exact source text/hashes and caller qualifications. `reviseMindMap` marks content
edits user-modified and retains the historical generation binding.
`renderMindMap` exports Markdown, reopenable JSON or a `research-mindmap-tree-v1`
view with deterministic preorder, parent/child IDs, levels, positions and
accessible names. The view omits original source text: retain the complete
document and select `sources[citation.source].text.slice(start,end)` when opening
evidence. Render all labels, notes and quotes as text; do not execute arbitrary
HTML, Markdown or Mermaid. UI collapse/pan/zoom and persistence belong to the
consumer.

Bounds are 60 nodes, depth 6 including root, 8 children/node, labels 120 UTF-16
units, gaps 300, 4 citations/node, quotes 4000 and exported JSON <=1 MiB.
Malformed/unknown fields, invalid spans, surrogate splits and unsafe label
constructs refuse the whole map. Originals are never truncated or repaired.
Mandatory limitations stay visible: matching text proves occurrence only,
not entailment, truth, completeness, currentness or source independence.

Offline creation/edit/reopen/export never calls a model. `mindMapResearch`
explicitly drafts in one frozen schema-bound guarded session, returning
`{status,map,receipt}`; failure/cancellation returns no map and keeps the native
outcome. `result.map` is the document to retain. Model provenance is
caller-declared and content-bound, not authenticated. Existing `progress` and
`activity` synchronous callback rules apply; no schema/thinking callback is
exposed. Tests use synthetic providers only. See [reuse notices](THIRD-PARTY-NOTICES.md).

### Comparative evidence tables

`createEvidenceTable` starts a caller-owned comparison from 1–8 frozen captures
and 1–8 question columns. `evidenceTableResearch` can fill cells in one frozen,
schema-bound session. Each answer must cite an exact span in its own source row;
unanswered cells keep an explicit gap. `reviseEvidenceTable` applies human edits,
and `renderEvidenceTable` validates before exporting Markdown or JSON. The table
shows what each capture says without choosing which source is correct.

```sh
node bin/research-ai.mjs --evidence-create --sources captures.json --evidence-columns columns.json "Compare retention policies" > table.json
node bin/research-ai.mjs --evidence-input table.json --evidence-format markdown
node bin/research-ai.mjs --evidence-draft --sources captures.json --evidence-columns columns.json "Compare retention policies" > draft-result.json
```

The columns file is a JSON array of `{ "id", "title", "question" }`. Offline
create/edit/export opens only the named JSON files; native drafting is explicit.
Reopening checks exact source hashes and row-local UTF-16 quote bindings. Quotes
prove occurrence only, not entailment, currentness, independence or truth.

### Cited report authoring

`exportReportHtml(report)` exports a validated report's current sections as
self-contained offline HTML, with exact citation navigation, gaps and source
qualifications. The installed `research-report-export --input report.json
--output new-report.html` command creates a new file; open it in a browser and
use Print to save a PDF. No provider call occurs. See [portable report export](docs/report-export.md)
for input/output limits and the standalone checkout command.

`createReport` accepts a cited outline or an evidence table. For a table, each
question column becomes a report section, each cited cell becomes a point, and
unanswered cells remain section gaps. `draftReportSection` explicitly writes
one selected section from the retained frozen captures while carrying prior
section drafts as context. `reviseReport` appends a human version and keeps the
older wording available. `renderReport` validates source bindings and assembles
the current sections into a full Markdown report or JSON state.

```sh
node bin/research-ai.mjs --report-create --report-input evidence-table.json > report.json
node bin/research-ai.mjs --report-input report.json --report-draft retention > report-draft.json
node bin/research-ai.mjs --report-input report-draft.json --report-edit section-edit.json > reviewed-report.json
node bin/research-ai.mjs --report-input reviewed-report.json --report-format markdown
```

Each native action drafts one section only. Failed, cancelled or malformed
attempts keep their receipt without replacing valid prose. Report state keeps
up to 16 versions per section and 64 explicit attempts; assembly refuses the
whole report if it exceeds 24,000 UTF-16 units. Before dispatch, the producer
reserves room for the largest schema-valid section version; a report too near
the 1 MiB state cap gets a `not_run` capacity attempt and no native call. Large
runner payloads in retained receipts are represented by SHA-256 and byte count,
while terminal, cleanup, and usage accounting remain available. Source quotes
establish occurrence, not entailment or truth. No provider call occurs on
create, edit, reopen or export.

## What each session enforces

- `codex exec --ephemeral --sandbox read-only --ignore-user-config --ignore-rules`
  in an empty temporary directory that is removed afterwards.
- Shell, multi-agent delegation, hooks, plugins, memories and apps are off.
  Approval is `never`. Web search is `live`, or `disabled` for frozen review.
- The child gets only `PATH`, `HOME`, `CODEX_HOME` and `TMPDIR`.
- One exclusive lease per user and lease name. A live or orphaned owner is never
  displaced, and an interrupted lease needs inspection.
- Search/read action limits, forbidden-tool kill (command execution, MCP),
  stdout and response byte caps, deadline and abort. Each stop SIGKILLs the
  whole process group.
- The receipt records counts, model/effort selection, timing, termination and
  separate terminal/protocol evidence. Unknown usage stays unknown. See the
  [bounded outcome contract](ARCHITECTURE.md#bounded-outcome-contract-research-outcome-v1).
  An over-limit wire keeps a digest and byte counts, never its text.

Progress and checkpoint callbacks are synchronous ephemeral observations. If one
fails after spawn, research stops with a named callback trigger and preserves
eligible partial notes. Async callback returns are refused. Workspace callback
return/throw drains the process group before cleanup. The outcome contract keeps
protocol cause and process exit separate, including on partial/failed answers.
`cleanup` confirms whether the owned POSIX group is absent, including descendants
after a normal leader exit. Failed/unknown cleanup prevents completion and retains
the lease/workspace for inspection; it never silently frees their ownership.

## Limitations

- Answers are model-written research from sources that may be wrong,
  stale, dependent on each other or misquoted. Citations show where a claim came
  from, not that the source supports it, that it is current or that sources are
  independent. Check sources before relying on them.
- Codex is the only provider. There is no source acquisition, crawling, caching,
  storage, scoring or claim verification here.
- POSIX process groups are assumed; Windows is untested.
- Tests use a synthetic stand-in for `codex`. They prove transport behaviour,
  not research quality.

## Package compatibility

This local candidate requires `cleanup` in both `SessionOutcome` and
`ResearchResult.receipt`. It is a compatibility boundary for constructed typed
outcomes and consumers of older receipts. See [migration and qualification
limits](docs/compatibility.md) before adopting it; historical missing-cleanup
receipts must remain unconfirmed. This version has not been published.

## Develop

```sh
npm ci --ignore-scripts --no-audit --no-fund  # pinned development compiler/types
npm test                                   # serial, offline, synthetic, no model
```

Runtime use needs no install from the checkout. Development installs TypeScript
6.0.3 and Node 24 typings only; they are not runtime dependencies or archive
members. The package test packs and installs a local tarball into an external
consumer with isolated offline npm configuration, then runs the installed CLI,
package-name ESM imports and the actual compiler. An already-provisioned offline
compiler/type closure can be selected with `RESEARCH_AI_TYPECHECK_ROOT` pointing
to its `node_modules` directory. `RESEARCH_AI_PACKAGE_EVIDENCE` selects a new empty
owned directory to retain that test's archive, consumer and reports. Otherwise
they are temporary. Keep the process suites serial to avoid timing contention.

See [ARCHITECTURE.md](ARCHITECTURE.md) and the repository's
[authoring instructions](https://github.com/pradeeptathineni/research-ai/blob/main/AGENTS.md).

## Origin

Extracted from the native Codex runner in the MIT-licensed first-party Signals
project. [LICENSE](LICENSE) keeps the original notice. Adapted third-party
portions and reproduced methods are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Guided investigations

`createInvestigation` makes a local, editable question tree without inference.
`advanceInvestigation` explicitly clarifies scope, proposes more questions,
investigates only caller-selected branches, or synthesizes retained findings.
The returned JSON is caller-owned state: save it where you choose, reload it,
and pass it to the next explicit action. Every native run uses the existing
read-only ephemeral Codex workspace, and cumulative search, read, time and call
limits remain charged across saved continuations. Reports show coverage and
gaps; citations identify supplied or model-reported URIs and do not verify them.

```js
const study = createInvestigation("Portable capture formats", {
  goal: "Compare export options", scope: "One offline-first user",
});
const clarified = await advanceInvestigation(study, { action: "clarify" });
const reportState = await advanceInvestigation(clarified, { action: "synthesize" });
```

CLI state forms use explicit files and write each state to stdout for caller-
managed redirection: `--investigation-create`, `--investigation-input`,
`--investigation-edit`, `--investigation-action`, `--branches`, and
`--investigation-format`. Reading, editing and rendering are offline; only an
explicit action performs readiness checks and sends supplied scope/source
content to the selected provider. State files are regular UTF-8 JSON files up
to 1 MiB. The API refuses state/history beyond its caps (32 questions, depth 4,
64 attempts) rather than trimming caller data. Append-only expansion can reuse
an unchanged branch only while its exact question and full topic, scope, budget,
and frozen source capture/qualification context still match. Changed questions
or source notes remain historical and stay out of the next synthesis.

The question-frontier, continuation from retained findings/gaps, explicit
clarification and cited synthesis adapt methods in dzhng/deep-research. The
package's recursive crawler, provider framework and dependencies are not used.

No activity is delivered when the prepared process fails to spawn. A later native process error is labeled `native_process_error`; raw process diagnostics remain outside the activity projection.

## Registered-table analysis

`registerTable` binds a bounded caller-authored typed table to its canonical
digest. `analyzeTable` supports closed aggregate operations in an optional,
host-configured DuckDB worker; Research has no runtime dependency on DuckDB.
See [the table-analysis contract](docs/table-analysis.md) for limits, host
setup, and numeric qualifications.

`importTableCsv` can turn a supplied UTF-8 CSV string or byte buffer into a
bounded text-only table. It requires a host-configured optional CSV parser and
does not infer types or evaluate formulas. See [CSV import](docs/table-csv.md)
for parser setup and refusal limits.


### Cross-dataset queries

`prepareTableQuery` previews named registered tables, their SQL column mapping,
and a SELECT with bound parameters. `queryTables` runs it in an optional isolated
DuckDB worker: join datasets, compare missing records, group results or use window
functions. Exact input/query/result digests accompany the output. Big integers
and decimals remain strings. `validateTableQueryResult` reopens a completed
artifact offline, optionally checking its original registered tables, without
running SQL. Consumers own persistence. See [query examples and limits](docs/table-query.md).

## Portable Research notebooks

`createResearchNotebook` keeps complete retained documents, versioned editable
notes and explicit question results in one portable JSON value. Questions bind
only explicitly selected source records and note versions. `prepareNotebookQuestion`
returns exact full inputs and consent digests; callers confirm those digests
before using the existing complete-document coverage runner. Citations reopen
the original source or note version, and saved answers become editable notes
with question origin. Validation, reading, editing, citation lookup and export
work offline. See [notebook usage and limits](docs/notebook.md). The standalone
entry point is `research-notebook --action ...`.

`searchResearchNotebooks(notebooks, query, options)` searches only the explicit
validated notebook selection for retained source pages and note versions.
`openNotebookSearchHit` revalidates and replays a result before returning the
exact retained page or version. The standalone `research-notebook-search`
command supports offline `search` and `open` actions. See
[notebook search](docs/notebook-search.md).
