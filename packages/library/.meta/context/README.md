# Authoring context

This folder owns guidance for changing Signals. Product meaning stays in the
[requirements](../../docs/product.yaml), [architecture](../../ARCHITECTURE.md),
[evidence contract](../../docs/signals-contract.md) and [data map](../../docs/architecture/schema.md).
Read those sources when a change crosses their boundaries; do not copy them into prompts.

| Task                                                 | Read                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------ |
| Change code, dependencies, names or product behavior | [authoring.md](authoring.md)                                             |
| Broad analysis or noisy tool output                  | [context-engineering skill](skills/signals-context-engineering/SKILL.md) |
| Reconcile accumulated code, guidance and local state | [repo-squash skill](skills/repo-squash/SKILL.md)                         |
| Discover public knowledge using the invoking AI      | [signal-search skill](skills/signal-search/SKILL.md)                     |

`AGENTS.md` routes repository instructions here. `.agents/skills` contains discovery
entrypoints; `.codex/hooks.json` adapts the optional output compressor. Those files route
here rather than maintaining separate procedures. `pack.json` and `compression.json`
configure existing tools. Generated maps, normalized/redacted command recovery and
command metrics belong in ignored `local/`. None outranks source; command metrics
can contain private arguments. `npm run clean` clears this generated output; archive
needed recovery and diagnostic receipts in planning first.

Keep project constraints here, reusable procedures in focused skills, and volatile
plans/results in `signals-ai-planning`. Git preserves older decisions; current guidance
describes current behavior. A new instruction needs a concrete decision or recurring
mistake it improves. Avoid copied manuals, recipes without authority, and mandatory
receipts for routine edits.

This is locally maintained context, not an active managed Context AI installation.
Context AI can later own reusable selection/materialization once it supports this
layout; Planning can own project plans without making them always-loaded instructions.
The product's Context evidence exchange and project handoff are separate capabilities.

The layout uses the [AGENTS.md entrypoint](https://agents.md/) and focused procedures.
Local guidance adapts engineering principles from
[Context AI at its prior pin](https://github.com/pradeeptathineni/context-ai/tree/3f5acec9e4297fe34c645b1ca37ecbd70221a1c3).
The prior installation, exact selection and notices are preserved in planning and Git.
