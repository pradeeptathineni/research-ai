# Context for changing research-ai

Start from the change you want users or consumers to see. Then find its owner:

- Session restriction, limit, lease or cleanup: `src/codex.mjs`. Check every
  consumer-visible outcome field in `src/index.d.ts` still means the same thing.
- Ordinary research wording, profiles or status mapping: `src/research.mjs`.
- Retained-source claim/support bindings, generated judgments or replay:
  `src/grounding.mjs`. Consumers retain the complete closure; no UI reimplementation.
- Perspective lenses, heading candidates or their assembly: `src/perspectives.mjs`.
  It reuses frozen-source validation and the executor; it adds no store.
- CLI flags, output streams or exit codes: `bin/research-ai.mjs` and
  `test/cli.test.mjs`.

See [authoring.md](authoring.md) for change rules.
