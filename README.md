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
project. [LICENSE](LICENSE) keeps the original notice. No third-party code is
included apart from the reproduced citation-support method credited above.

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
