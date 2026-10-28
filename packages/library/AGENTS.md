# Signals authoring

Read [.meta/context/README.md](.meta/context/README.md) for task-specific guidance.
Before cross-cutting changes, read `README.md`, `ARCHITECTURE.md`,
`docs/product.yaml`, `docs/signals-contract.md` and `docs/architecture/schema.md`.

Preserve canonical `signals/` records and useful private knowledge. Rehome historical
exports and implementation evidence in planning when no current product consumes them.
Evidence is immutable; corrections create successors and historical policies keep their meanings.
Native AI owns uncertain interpretation; code owns permissions, transport, validation,
scoring and storage. Findings grant no installation or execution authority. Recurrence,
billing and publication require explicit authority.

Name the observable improvement before changing a product route. Prefer removing an
obsolete owner or reusing an existing boundary over another layer. Use bounded native
subagents for scoped inspection/review or disjoint implementation when useful; ordinary
signal-search never recursively launches another AI. Use `apply_patch` for source edits.
Keep dependency pins and `docs/dependencies.md` aligned. Add negative tests when changing
privacy, authority, evidence binding or historical continuity.

`npm run verify` is the complete local gate; no database or model service is needed.
`npm run clean` removes generated build/test and local authoring output. Planning, studies, delivery
receipts and superseded guidance belong in the sister `signals-ai-planning` folder.
