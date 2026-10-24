# Independent branches and explicit comparison

Ask contrasting questions about the same retained sources, investigate each
question separately and compare them only when you ask to. Output is fallible
research. A comparison's agreements, disagreements and unknowns are model
interpretations, not computed truth, consensus or confidence.

## What it adds

- An optional `branchContext: "independent"` on guided investigations
  (`createInvestigation`, `reviseInvestigation`). In this mode, an investigate prompt
  includes the shared topic, goal, scope and frozen sources, plus only that branch's
  own compatible earlier attempts. Sibling findings are withheld. Branches still
  run one at a time under the existing exclusive lease. "Independent" means
  withheld context, not faster or parallel runs.
- `compareInvestigation(state, { branchIds, attempts?, signal?, lease? })` runs one
  frozen, schema-bound session and returns `{ investigation, comparison }`. It uses
  the investigation's own call and time budget. It is recorded as a `compare` attempt
  with its receipt, and it is blocked by the same uncertain-cleanup rule as other
  actions. By default it uses the latest current completed attempt for each branch.
  To use an earlier attempt, pin it with `attempts: { branchId: attemptId }`. Sibling
  answers appear only in this comparison prompt.
- `validateComparison(value)` checks a saved artifact offline. It recomputes the
  source SHA-256 values, attempt snapshot digests, every branch quote (it must occur in
  the cited `answer` or `findings[N]`), every source quote occurrence and span, the
  preserved gaps and omissions, and the artifact digest. It throws on any mismatch.
- `comparisonCurrentness(comparison, state)` reports a comparison as stale when
  the topic, goal, scope, sources, budget or mode changed, when a selected branch
  question was edited, or when an unpinned branch has a newer completed attempt.
  Old attempts and artifacts stay valid history.
- `renderComparison(comparison, { format, investigation? })` produces readable
  Markdown or JSON. Rendering never generates anything.

## Compatibility

- Without `branchContext`, the state, identity hashes, prompts and behaviour of
  `guided-investigation-v1` are unchanged. Saved investigation JSON validates and
  replays as before. The mode is part of both identity hashes only when present.
  Switching modes therefore makes earlier attempts historical, so shared-mode
  results never count as independent.
- `advanceInvestigation` actions and status values are unchanged. History may also
  contain `action: "compare"`, but only after `compareInvestigation` is used.
- `branch-comparison-v1` is a new, separate, self-contained artifact. It keeps
  the frozen source text, selected attempt snapshots, receipt and preserved
  gaps and omissions, so it can be revalidated after the investigation changes.

## Comparison output rules

Every agreement and disagreement needs positions from at least two selected
attempts. Each position quotes its attempt exactly. Where the model says a source
supports the position, it also gives an exact source quote and occurrence, and code
computes the span. A position without a source quote is rendered as "branch claim
only, not source evidence". Any unknown, unselected or stale ID, missing quote,
wrong occurrence or malformed shape rejects the whole output as
`invalid_comparison_output`, and the receipt is kept. Partial or cancelled sessions
keep their text, labelled as unvalidated. A quote check only proves that the text
occurs; it does not prove that the text supports the stance.

## CLI

`node bin/research-branches.mjs` takes explicit input and output files. It never
overwrites an existing file, and it never retries.

```
research-branches create --spec SPEC.json --out S0.json
research-branches run --in S0.json --branch cost --out S1.json
research-branches run --in S1.json --branch life --out S2.json
research-branches compare --in S2.json --branch cost --branch life --out S3.json --comparison C.json
research-branches export --comparison C.json --in S3.json --out C.md
research-branches edit --in S3.json --edit EDIT.json --out S4.json
```

Before a native run, `run` and `compare` write the output state with a failed
attempt that has no receipt (`dispatch_outcome_unknown`). If the process dies, that
saved state blocks further native work and nothing is replayed. Whether to resume
from the earlier input is the caller's decision, made after confirming no session
is still running. These stateless functions do not provide durable network
idempotence. Consumers that admit requests, such as Deep and Signals, keep their own
admission and compare-and-swap wrapper.

Inputs are bounded regular UTF-8 files; FIFOs and final symlinks refuse before
reading. Existing outputs and aliased state/comparison destinations refuse before
dispatch. New files use private permissions. Native output slots retain their
admitted descriptors, and final state/comparison snapshots are saved as
`OUTPUT.result-UUID.json` before publication. If a destination changes during the
run, it is left untouched and the error names the retained result. Both the
pending intent and final snapshots remain for inspection; they are never replayed
or automatically removed. These are cooperative file guards, not OS containment.

A complete comparison must retain a successful native receipt whose structured
output reproduces its interpreted result. Rehashing an artifact cannot remove a
failed or missing receipt or substitute a different result. This checks internal
consistency; a hash or supplied receipt does not authenticate the original writer.

From a source checkout, `node examples/independent-branches.mjs --out DIR` runs the CLI flow in fresh
processes against `test/fake-codex.mjs` and synthetic documents. No model is called.

## Limits

- Frozen, caller-supplied sources only. Live-web independent branches are
  unavailable rather than weakening source grounding.
- 2 to 8 branches per comparison; 12 agreements, 12 disagreements and 12 unknowns;
  8 positions per point. The existing 64-attempt history limit applies.
- A digest identifies bytes, not model truth. Passing tests prove transport and
  binding rules, not research quality.

## Method source

The split/merge idea is adapted from `deepResearch` in dzhng/deep-research at
`1f8f3e285bbc23e80b98a66a64effab9069f3ad4` (MIT, Copyright (c) 2025 David Zhang).
There, sibling queries share prior learnings, build up branch-local learnings, and
the parent merges them. This is a method reproduction on top of the existing
investigation; no donor code was copied. See `src/independent-branches-NOTICE.txt`.

Independent-mode states and compare history require the updated SDK. Earlier shared-mode states, identities and prompts remain compatible; old SDKs must not consume the new mode merely because its base investigation version is unchanged.
