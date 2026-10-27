# Review topic relevance for a project

Project-topic relevance records how an operator judges one exact connected topic for one
registered project purpose, optionally narrowed to a saved opportunity. It records
`relevant`, `not-relevant`, or `uncertain` with a rationale. It does not rank evidence,
change a Signal, or infer project impact from source changes.

The review binds the exact topic revision and chosen member identities, project source
snapshot and purpose/constraints fingerprint, and optional opportunity. It may also bind
one exact S04 source-change review with its two retained capture references. The source
change is context supplied by the reviewer; Signals does not infer whether it matters to
the project. Project paths and file excerpts are not copied into this review store.

```sh
npm run project-topic-relevance -- --root /private/signals-workspace list
npm run project-topic-relevance -- --root /private/signals-workspace preview BASIS_JSON
npm run project-topic-relevance -- --root /private/signals-workspace create REVIEW_JSON
npm run project-topic-relevance -- --root /private/signals-workspace open REVIEW_UUID
```

`BASIS_JSON` contains `topic_id`, `topic_revision`, `member_selections`, and `project_id`,
with optional `opportunity_id` and exact `source_change_review_ref`. Each selected member
is copied as the complete `selection` object from the opened topic. Preview returns the
closed `basis` object; `REVIEW_JSON` contains that exact `basis`, a caller-generated
`request_id`, `relevance`, and `rationale`. A changed basis between preview and create is
refused and needs a new preview. Use a
stable UUID for a write; after an uncertain reply open that UUID. Repeating the same UUID
and request is idempotent, while different content under that UUID conflicts.

`open` preserves the original record and reports basis state as `current`, `needs-review`,
`missing`, or `unavailable`. A changed topic or project context never silently inherits
the old judgment. Source member changes and missing/unavailable members are also visible.
The store uses the existing private writer lock and atomic replacement and is capped at
1,000 reviews and 4 MB. It is separate from, and never rewrites, topic membership,
project context, project opportunity, source capture, or source-change review history.

The guarded local API uses `GET project-topic-relevance`, `POST
project-topic-relevance/preview`, `POST project-topic-relevance`, and `GET
project-topic-relevance/REVIEW_UUID`. It retains Signals' loopback, origin, session and
owner binding checks. Preview uses POST only because its exact basis is a structured body;
it performs no write.
