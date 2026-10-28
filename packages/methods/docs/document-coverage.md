# Complete-document coverage

`src/document-coverage.mjs` investigates caller-extracted documents that are too
large for the single-session document API (`researchDocuments`, 48,000 combined
UTF-16 units and 50 pages per document). It does not change that API or its CLI.

It reviews every supplied UTF-16 unit in bounded frozen passes, keeps
host-validated exact quotes, then makes one synthesis call that may cite only
those quotes. Output is fallible research and exact occurrence, never verified
truth.

## What it does

1. **Prepare (no inference).** `prepareDocumentCoverage(question, documents, policy?)`
   validates input, splits every page into ordered windows and packs windows into
   passes. It returns a plan with `inputDigest` and `planDigest`.
2. **Confirm and run.** `researchDocumentCoverage(question, documents, options)`
   prepares the plan again and refuses before any lease unless
   `options.confirmedPlanDigest === plan.planDigest`. It then runs one
   `withCodexWorkspace` session per pass in order, using the same lease, and
   finally one synthesis session.
3. **Validate offline.** `validateDocumentCoverage(value)` replays the plan,
   hashes, windows, quote bindings, statuses, accounting and content digest.
4. **Render.** `renderDocumentCoverage(value, { format })` validates first.

## Input and policy

Documents use the existing `ResearchDocumentInput` shape:
`{ id, title, sha256, pages: [{ number, text, sha256 }] }`, with pages numbered
1..N. The limits are up to 8 documents, 2,000 pages in total and 1,000,000 UTF-16
units in total. Each page `sha256` must be the SHA-256 of the exact UTF-8 page
text. The document `sha256` is the caller's raw-byte digest and is not verified.

| Policy key       | Default | Accepted    | Meaning                                  |
|------------------|---------|-------------|------------------------------------------|
| `maxCalls`       | 12      | 2–64        | Review passes plus one synthesis call    |
| `passUtf16Units` | 24000   | 1000–48000  | Raw page text per pass (and per window)  |
| `maxSeconds`     | 600     | 1–3600      | Aggregate deadline for the whole run     |

These are conservative host bounds, not measured provider limits. A plan that
needs more than `maxCalls` is refused, and no window is ever dropped to make it
fit. Raise `maxCalls` or `passUtf16Units`, or split the input.

## Windows and passes

- Each page becomes ordered, non-overlapping `[start, end)` windows of at most
  `passUtf16Units`. Together they cover every unit exactly once. A cut prefers
  whitespace in the last quarter of a full window and never splits a surrogate
  pair. Each window records its page, offsets and the SHA-256 of its exact
  substring.
- An empty page gets one zero-length window, and the plan limits flag it as a
  possible extraction gap.
- Passes are filled greedily in window order, up to 32 windows and
  `passUtf16Units` of text each. `counts.maximumCalls = passes.length + 1`.
- `planDigest` binds `inputDigest`, policy, windows and passes. Changing the
  question or any page changes both digests. Changing only the policy changes
  only `planDigest`.

The plan digest binds the question, source closure and pass policy. Consumers
must also bind consent to the configured recipient and source-owner identity.
An approval for the single-session route does not authorize multiple passes.

## Evidence binding

A review pass returns evidence as `{ id, windowId, quote, relation, occurrence }`.
`occurrence` is `null` when the quote occurs exactly once in that window's text.
Otherwise it is the zero-based index among all occurrences in the window. The
model never supplies offsets. The host locates the quote and derives offsets
local to the original page. It checks code-point boundaries and the exact page
substring, and assigns global IDs `pNN-eNN`.

The host rejects the whole pass output for any of these:

- an ambiguous quote with a `null` occurrence;
- an absent quote;
- an impossible or out-of-range occurrence;
- a window outside the pass;
- extra fields such as model offsets;
- unknown or uncited evidence IDs;
- a coverage contradiction;
- output over the per-pass bounds (24 paragraphs of at most 1,200 units,
  48 evidence items, 4,000-unit quotes, 12 gaps).

Excess output is never trimmed. A rejected pass stops the run.

## Synthesis

Synthesis runs only when every pass completed with validated findings. Its input
holds only the question, the document IDs and titles, the validated evidence
pool and each pass's answer, coverage and gaps. It includes exact quoted spans;
complete pages remain in the retained plan. If that
JSON body exceeds 48,000 UTF-16 units, synthesis is `not_run` with the reason.
Evidence is never trimmed, and all pass findings stay inspectable. Every
synthesized paragraph must cite 1–8 existing global evidence IDs. An unknown ID,
an uncited paragraph or inconsistent coverage fails the synthesis, and no draft
is returned. The draft's `evidence` is exactly the cited validated evidence.

## Execution and stopping

- Each session is frozen, read-only, ephemeral and schema-bound, with web search,
  shell, delegation, hooks, plugins and apps disabled, through the existing
  `withCodexWorkspace`. There is no retry, resume, background work or storage.
- A session's `budget.seconds` is the smaller of the profile limit and the time
  left before the aggregate deadline. Preparation, every session, cleanup and
  synthesis all count toward `maxSeconds`.
- Nothing new starts after an abort, a deadline, a failed or malformed pass, or
  unconfirmed process-group cleanup. Completed, validated pass findings are kept.
  Later passes are `not_run`, and `inputCoverage.unreviewedWindows` lists exactly
  which windows were not reviewed.
- Caller input is copied during preparation, so changing it after the call
  cannot change later prompts or bindings.
- Callbacks are `progress` and `activity`, passed unchanged to each session. They
  are synchronous, as in `SessionOptions`.

## Result

`research-document-coverage-result-v1` contains `status`, the full `plan`,
`passes` (each with `status`, `findings`, the actual native `receipt.outcome` and
`failure`), `synthesis`, `inputCoverage`, `draft` and `receipt`. The `receipt`
holds `plannedMaximumCalls`, `startedCalls`, `cleanup`, `elapsedMs`, `stopReason`
and `contentSha256`. The result also carries `limits`.

- `complete` means every pass and the synthesis completed with validated output
  and confirmed cleanup. `cancelled` means an explicit abort or the deadline.
  Otherwise the status is `partial` when any validated pass findings are kept,
  and `failed` when none are.
- `inputCoverage.complete` means every window has a completed, validated review.
  It does not mean the model understood every passage. `reviewedPages` lists a
  page only when all its windows were reviewed.
- `receipt.cleanup` is `not_started` when no native process started,
  `unconfirmed` when any session's group cleanup was not confirmed, and
  `complete` otherwise. An unconfirmed cleanup leaves the lease for inspection,
  as in the rest of the package.
- `contentSha256` is a SHA-256 over the result serialized with sorted keys,
  excluding the digest field itself. It detects edits to a retained result. It
  does not prove who produced the result.

## CLI

```sh
# 1. Preview: metadata only (digests, counts, policy, windows, passes, limits). No page text, no model.
node bin/research-document-coverage.mjs --input input.json --preview --max-calls 16

# 2. Run: same file and policy flags, plus the exact planDigest from the preview.
node bin/research-document-coverage.mjs --input input.json --max-calls 16 --confirm <planDigest> > result.json

# 3. Reopen offline: validates, then renders. No readiness probe, no model.
node bin/research-document-coverage.mjs --render result.json --format markdown
```

`input.json` is one regular UTF-8 file of at most 8 MiB containing only
`{ "question": ..., "documents": [...] }`. The policy flags are `--max-calls`,
`--pass-units` and `--seconds`. `--confirm` also accepts `--profile`, `--model`
and `--effort`. There is no default execution: `--confirm` with a stale digest
refuses before the readiness check. On success, stdout holds the result and stderr
the top-level receipt. Ctrl-C cancels and keeps completed findings. Exit codes:
0 complete, 2 partial or cancelled, 1 failed or refused. The CLI writes no files
of its own.

## Integration contract

Consumers such as Deep should compose these four functions and show their own UI.
They should not reimplement windowing, binding or validation. Retain the whole
result and reopen it with `validateDocumentCoverage`. Show the execution coverage
(`inputCoverage`) apart from the model-reported answer coverage
(`draft.coverage`). List unreviewed windows by document, page and offsets. Never
present relations or answers as verified. This package does not parse PDFs,
judge extraction completeness, acquire sources, store results or assign
confidence scores.

## Limits

- Raw-document digests are unverified. Page hashes bind extracted text only.
- A pass sees only its own windows. A quote cannot cross a window boundary, and
  relationships across passes reach synthesis only through validated evidence.
- Relations and answers are fallible model judgments. Exact quotes establish
  occurrence only.
- The result embeds the complete documents twice, in the plan and in the draft,
  so retained results can be several times larger than the input.
- Tests use `test/fake-codex.mjs` only. Passing tests show transport, binding and
  stopping behaviour, not research quality.
