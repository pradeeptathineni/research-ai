# Architecture

research-ai owns reusable, bounded research execution and opt-in retained-source
claim/support methods. Consumers own acquisition policy, storage and purpose-specific
assessments. A support estimate does not become a consumer confidence score.

## Modules

`src/investigation.mjs` owns guided investigation state, identity validation,
editable bounded question trees, explicit clarify/expand/investigate/synthesize
actions and offline rendering. Callers retain and resume JSON state. It runs
selected branches sequentially through `withCodexWorkspace`, charging native
searches, reads, monotonic duration and calls cumulatively. Historical attempts
retain their original identity; edits invalidate the current report without
rewriting prior findings. Output remains fallible research.

`src/grounding.mjs` owns the additive `claim-support-v1` frozen-answer contract.
It checks exact span occurrence and derives qualified support/contribution labels
from explicit judgments; it does not verify source truth. Consumers retain its
self-contained closure and replay `validateGrounding` without model calls.
Native creation uses one bounded, schema-bound frozen session; stopped or invalid
structured output is failed, never promoted from interim narrative.

| File                  | Owns                                                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/codex.mjs`       | Codex readiness probes, the exclusive lease, the ephemeral working directory, model/effort selection, the hardened argument vector, the minimal environment, JSONL stream supervision, checkpoints, limits, deadline/abort and process-group kill |
| `src/research.mjs`    | Ordinary research: profiles, a generic prompt with the question as labelled data, and mapping one session to `complete`/`partial`/`failed`                                                                                                        |
| `src/perspectives.mjs` | `perspectives-v1`: heading-grounded lens candidates, a basic-facts lens first, one frozen schema-bound session per lens in order, exact-span validation and comparable assembly with omissions, unanswered questions and partial/cancelled states |
| `src/outline.mjs` | `research-outline-v1`: one frozen schema-bound session, source-bound editable points and gaps, offline replay validation and Markdown/JSON export |
| `src/evidence-table.mjs` | `research-evidence-table-v1`: source-indexed question columns, row-local exact spans, offline validation/revision and Markdown/JSON export |
| `src/document-research.mjs` | `research-document-answer-v1`: complete ordered caller-extracted page input, one frozen schema-bound answer, exact document/page spans, explicit coverage/gaps and offline replay |
| `src/report.mjs` | `research-report-v1`: table-to-outline conversion, versioned cited section writing/revision, explicit one-section frozen sessions and full report assembly |
| `src/index.d.ts`      | The public types                                                                                                                                                                                                                                  |
| `bin/research-ai.mjs` | The CLI: argument parsing, readiness gate, stdout answer, stderr receipt, exit codes                                                                                                                                                              |

`codex.mjs` does not know about any consumer. It takes the prompt, schema,
budget, lease name, directory prefix and note reader as inputs. It returns
an outcome object for the caller to interpret.

## Readiness

`codexReadiness` separately observes bounded version, login status and execution
help without inference. Version evidence survives login failure. Authentication
and advertised profile support remain nullable; availability is derived only
from known ready observations. Public probe metadata includes source, UTC time,
exit code and machine failure, not raw auth output. The CLI uses the same error
and remedy as its machine readiness result before starting a session. Help
advertisement is distinct from native protocol or permission qualification.

## Session lifecycle

1. Acquire the lease (`mkdir`, mode 0700). A live owner gives `runner_busy`.
   A missing owner file gives `runner_interrupted_lease`. A dead owner without
   a recorded child needs inspection. A still-running orphan child is never
   displaced. A dead owner and dead child are recovered under a `.recovery`
   guard.
2. Create the empty temporary working directory. If a schema is given, write it
   there.
3. Select the model and effort, emit one progress line, call `beforeSpawn`, then
   spawn `codex exec … -` detached with the minimal environment. Record the
   child PID in the lease.
4. Supervise stdout JSONL. It tracks usage, error events, web actions against
   the search/read budget, forbidden tools, completed agent messages and byte
   caps. Completed messages are sorted into `checkpointed`, `duplicate`,
   `unreadable`, `limited`, `afterStop` or `schema`. Checkpoints are bounded to
   24,000 UTF-16 units or 64 notes, with an explicit omission notice.
5. Any guard, the deadline or an abort SIGKILLs the process group. Every leader
   exit also stops remaining group members, including on zero/nonzero normal
   exits. `close` waits for bounded group-absence confirmation before settling.
   Confirmed cleanup releases the directory/lease; unknown cleanup retains both
   with owned leader/group/directory metadata for inspection.

`sessionCompleted` requires exactly one `turn.completed`, no failed terminal or
fatal/malformed protocol event, a clean zero exit, nonempty final text, no abort,
no start error, no guard trigger and confirmed group cleanup. `terminal` preserves explicit event counts
and a sticky protocol reason; `failureReason` explains ineligibility separately
from stderr diagnostics. Readable completed notes remain partial evidence on
failure. Known thread/turn starts or item lifecycle activity after a terminal
set a sticky protocol failure. Unknown nonterminal extensions are ignored. A final JSONL record without
a newline is accepted; malformed/truncated UTF-8 is never complete.

## Bounded outcome contract (`research-outcome-v1`)

This freezes the producer boundary consumed by direct callers and later R04/S01
package/Signals qualification. It is an offline-qualified contract, not proof of
native permissions, protocol compatibility, research quality or verified claims.
Existing public field names and status enums remain; lower-level options own mode
and schema policy. Readiness's advertised profile is a separate observation.

| Surface | Meaning |
| --- | --- |
| `complete` | Exactly one supported successful terminal, nonempty exact final message, clean zero exit/signal, no start/abort/guard/protocol contradiction. |
| `partial` | Completion is ineligible, but eligible completed Markdown notes remain in the bounded checkpoint buffer. |
| `failed` | No eligible readable checkpoint remains; raw reasoning/tool text never becomes an answer. |
| `receipt.mode` | `frozen` for caller-supplied sources; omitted means live, preserving the existing compatibility convention. The executor's `live` option controls lower-level sessions. |
| `receipt.source` | Present only for frozen input; ordered URI, exact UTF-8 SHA-256, caller observation note/omissions. Identifies supplied bytes, not verification, currentness or independence. |
| `model` / `effort` | Actual explicit/config selection when known; optional in SessionOutcome and `host-default` in research receipts when the CLI chose. No model is invented from usage. |
| `usage` / `provider` | Unvalidated provider-reported usage; null means unknown, never zero or free. No billing/quota inference. |
| `termination` | Exit code, process signal and first host guard/stop trigger stay independent from provider terminal evidence. |
| `cleanup` | `complete:true` only after the owned POSIX group is confirmed absent (or no child spawned). Unknown/failed cleanup is explicit and prevents completion; lease/workspace remain available for inspection. |
| `terminal` | Explicit success/failure counts and sticky protocol failure. Unknown nonterminal extensions remain tolerated; known post-terminal lifecycle activity contradicts completion. |
| `failureReason` / `receipt.failure` | Start error, cancellation, then first host guard; otherwise explicit protocol/conflicting/failed terminal cause before generic bad exit or missing terminal/text. Nonzero exit and cause remain in separate fields. |
| `actionCounts.messages` | Every received completed agent message enters exactly one category: checkpointed, unreadable, duplicate, limited, afterStop or schema. Categories sum to completed. |
| `final` / `readable` | Complete final text is exact. Capped final is a whole-code-point UTF-8 prefix within the cap. Readable notes are separately bounded to 24,000 UTF-16 units/64 notes with an omission marker. |

Frozen inputs are fully validated before lease acquisition. Failure never falls
back to live mode or discovers source paths. Even if a frozen runner reports web
activity despite disabled web configuration, it is stopped as a forbidden tool;
post-terminal contradiction evidence is retained alongside that host stop. Existing
command/MCP stops and action/byte/deadline/process-group restrictions remain.
Precharged searches may equal their budget but may not exceed it at dispatch.

Callbacks are trusted synchronous host code. `progress`/`onCheckpoint` are
ephemeral observations, not durable process records, storage acknowledgments or
permissions. Before spawn, a throw rejects and workspace cleanup runs. After
spawn, observation loss stops/drains the group with `progress_callback_failed`
or `checkpoint_callback_failed`; already accepted notes remain readable. A
throwing/invalid note reader stops with `read_note_failed`, counts the message as
unreadable and retains earlier notes. This is host failure, not malformed provider
protocol. Promise-returning callbacks are refused; rejection is handled, but their
side effects are not awaited or authorized. Callers must perform asynchronous work
outside these callbacks and must not mutate received notes.

Workspace callback return/throw drains pending work before release. Every owned
leader exit, including success/nonzero exit, starts remaining-group termination.
Abort, deadline and guards start that same bounded cleanup even if the leader
never exits. The supervisor uses at most one second of group-absence polling; it retains
`cleanup.complete:false` / `process_group_cleanup_failed` and ownership if absence
cannot be confirmed. The supervisor closes its own pipe handles on unconfirmed
cleanup and unreferences the child so a denied live leader or inherited descendant
pipes cannot keep the API pending forever;
unreceived output is not invented or promoted. Settlement is one-time: subsequent
data/exit/close callbacks cannot mutate the returned evidence or release retained
ownership. If no exit was observed, exitCode/signal stay null. The original exit/signal and cancellation/guard causes remain
separate. A retained lease records group/leader/directory and requires inspection;
a stale live group is never displaced even if its leader is gone. Legacy detached
runner leases are probed using their recorded child PID as the group ID. Stale lease
inspection only probes existence and never signals user processes. A live lease
owner or still-running orphan is never displaced. Cancellation after an observed
final frame remains cancellation, not completion. Guards kill the POSIX process
group, including descendants. Windows and real native enforcement remain separate
qualification. Progress has no durable ID, resume cursor, implied heartbeat or
K13 controller coverage; disappearing observation cannot finish a session.

## Consumers

- **Signals** (first consumer) calls `codexReadiness`, `withCodexWorkspace` and
  `sessionCompleted` from its `search-runner`. It passes its own lease name
  (`signals-ai-…`), budgets and acquisition-charged searches. It also passes
  `recoverOriginalAnswer` as the note reader, its provider schema and a
  `beforeSpawn` timing hook. Signals keeps prompts, acquisition, schema
  restore/admission, scoring, persistence, receipts and record meanings.
- **Deep** reaches research through Signals' local API today. It could later
  call `researchQuestion` directly for no-storage asks. That is not done here.
- **Principles** keeps its corpus, taxonomy, source identities and human
  activation gates. research-ai can supply research text as candidate evidence,
  but it never writes, drafts or activates Principles content.
- **Deep** may pass selected retained records to `outlineResearch`, preserving
  their existing source qualifications. A draft remains ephemeral until that
  consumer explicitly chooses to retain or export it.

## Next seam (proposed, not implemented)

The next useful step is a small, consumer-neutral **evidence furnishing** step.
It would use bounded public-source acquisition and a frozen review that returns
fallible source-bound notes. Signals' acquisition modules are the candidates to
generalise. They would move only once a second consumer (Deep or Principles
furnishing) needs the same contract, and without Signals' scores or record
types. Evidence, entailment, provenance/independence and currentness would stay
separate fields. Until then, Signals keeps acquisition.


`table-query.mjs` extends registered-table analysis to explicit named multi-table
SELECTs. It owns input identity, preview, native worker supervision, result
representation and pure artifact validation. `table-query-worker.mjs` uses the
optional installed DuckDB parser and engine, with external access/extensions off,
locked configuration and finite memory/time/output bounds. Consumers retain exact
registered inputs/results; this module creates no store and starts no provider.
