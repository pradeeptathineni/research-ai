# Architecture

research-ai owns reusable, bounded research **execution**. Consumers own what
the research is for, and what its output means.

## Modules

| File                  | Owns                                                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/codex.mjs`       | Codex readiness probes, the exclusive lease, the ephemeral working directory, model/effort selection, the hardened argument vector, the minimal environment, JSONL stream supervision, checkpoints, limits, deadline/abort and process-group kill |
| `src/research.mjs`    | Ordinary research: profiles, a generic prompt with the question as labelled data, and mapping one session to `complete`/`partial`/`failed`                                                                                                        |
| `src/index.d.ts`      | The public types                                                                                                                                                                                                                                  |
| `bin/research-ai.mjs` | The CLI: argument parsing, readiness gate, stdout answer, stderr receipt, exit codes                                                                                                                                                              |

`codex.mjs` does not know about any consumer. It takes the prompt, schema,
budget, lease name, directory prefix and note reader as inputs. It returns
an outcome object for the caller to interpret.

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
5. Any guard, the deadline or an abort SIGKILLs the process group. `close`
   settles the outcome. The directory and lease are always removed.

`sessionCompleted` requires exactly one `turn.completed`, no failed terminal or
fatal/malformed protocol event, a clean zero exit, nonempty final text, no abort,
no start error and no guard trigger. `terminal` preserves explicit event counts
and a sticky protocol reason; `failureReason` explains ineligibility separately
from stderr diagnostics. Readable completed notes remain partial evidence on
failure. Unknown nonterminal extensions are ignored. A final JSONL record without
a newline is accepted; malformed/truncated UTF-8 is never complete.

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

## Next seam (proposed, not implemented)

The next useful step is a small, consumer-neutral **evidence furnishing** step.
It would use bounded public-source acquisition and a frozen review that returns
fallible source-bound notes. Signals' acquisition modules are the candidates to
generalise. They would move only once a second consumer (Deep or Principles
furnishing) needs the same contract, and without Signals' scores or record
types. Evidence, entailment, provenance/independence and currentness would stay
separate fields. Until then, Signals keeps acquisition.
