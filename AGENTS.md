# research-ai authoring

Read [README.md](README.md), [ARCHITECTURE.md](ARCHITECTURE.md) and
[.meta/context/README.md](.meta/context/README.md) before changing behaviour.

research-ai owns bounded research execution and retained-source claim/support
methods. It does not own storage, consumer ranking/confidence scores, entities,
source acquisition policy or any consumer's records. Support estimates remain
fallible research judgments, separate from consumer assessments. Keep
`src/codex.mjs` free of consumer imports and vocabulary. Consumers pass in
prompts, schemas, budgets, lease names and note readers.

Code owns permissions, transport, limits and cleanup. The model owns
interpretation. Output is fallible research, never verified truth. Keep
evidence, entailment, provenance/independence and currentness separate.

Do not weaken a session restriction (read-only, ephemeral, ignored user config,
no shell/delegation/hooks/plugins/memories/apps, minimal environment, lease,
limits, process-group kill) without explicit authority. Signals depends on
these exact semantics and on the outcome field meanings. Treat a change to
either as a breaking change for consumers.

Keep runtime dependencies at zero and keep shipping `.mjs` with `.d.ts`. Update
`src/index.d.ts` with every exported change. Tests must stay offline and must
use `test/fake-codex.mjs`. Never launch a model or the real Codex CLI from tests.

`npm test` is the gate. Green tests prove transport behaviour, not research
quality or usefulness.
