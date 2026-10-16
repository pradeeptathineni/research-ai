# research-ai

Bounded, read-only, ephemeral research sessions through your installed and
authenticated [Codex CLI](https://github.com/openai/codex). It returns
**fallible** Markdown research with a receipt. It maintains no corpus or durable
research store, and does not verify claims or score sources.

`@pradeeptathineni/research-ai` 0.2.0 · MIT · Node 24 · zero runtime dependencies ·
no build step (`.mjs` plus hand-written `.d.ts`).

## Run

```sh
git clone https://github.com/pradeeptathineni/research-ai.git
cd research-ai
node bin/research-ai.mjs "Which portable note formats survive app migrations?"
node bin/research-ai.mjs --profile wide --context "single user, offline first" "..."
node bin/research-ai.mjs --readiness   # installed/login state; no model call
```

Use Node 24.19 or later within Node 24. No package install or build is needed
to run from the checkout. Live research requires your separately installed and
authenticated Codex CLI; `--help` and the offline tests do not.

When installed as a package, the same CLI is `research-ai`.

- The answer goes to stdout; progress and one final JSON receipt go to stderr.
- Complete API answers preserve the final message exactly. The prompt's 24,000
  character target is advisory; the captured wire has a hard byte cap. Interim
  notes have a separate bounded buffer with an explicit omission marker.
- Exit codes: `0` complete, `2` partial (stopped, but completed interim notes
  exist), `1` failure or usage error.
- `quick` (default) allows 8 searches, 20 reads and 240 s. `wide` allows 24
  searches, 60 reads and 600 s. These are limits, not quality guarantees.
- Before a session it runs `codex --version` and `codex login status` only. If
  Codex is missing or logged out, it stops without launching a session.
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
from its callback aborts and drains unfinished work before releasing the lease;
later or additional calls are refused. Invalid options and cancelled requests
fail before native dispatch. Budget limits are finite: at most 10,000 searches
and reads each, 3,600 seconds, and an optional response cap of 1–3,000,000 bytes.
Signals uses it for live research and frozen,
schema-bound evidence review. See [`src/index.d.ts`](src/index.d.ts) for exact types.

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
- The receipt records counts, model/effort selection, timing and termination.
  An over-limit wire keeps a digest and byte counts, never its text.

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

## Develop

```sh
npm test        # node --test; offline, synthetic, no model
```

See [ARCHITECTURE.md](ARCHITECTURE.md) and [AGENTS.md](AGENTS.md).

## Origin

Extracted from the native Codex runner in the MIT-licensed first-party Signals
project. [LICENSE](LICENSE) keeps the original notice. No third-party code is
included.
