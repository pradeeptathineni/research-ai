# Context for changing research-ai

Start from the change you want users or consumers to see. Then find its owner:

- Session restriction, limit, lease or cleanup: `src/codex.mjs`. Check every
  consumer-visible outcome field in `src/index.d.ts` still means the same thing.
- Ordinary research wording, profiles or status mapping: `src/research.mjs`.
- CLI flags, output streams or exit codes: `bin/research-ai.mjs` and
  `test/cli.test.mjs`.

See [authoring.md](authoring.md) for change rules.
