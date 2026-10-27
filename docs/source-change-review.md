# Source change review

Source change review uses Signals' existing immutable source captures. It compares two directly linked versions of the same source and returns a deterministic, bounded line diff with exact text digests and capture provenance. It does not acquire or archive source material.

The reviewer classifies the observed change, selects exact saved confidence observations it may affect, marks each assertion current or needing review, and retains or revises the judgment. A revised status is retained in the review record as a human successor judgment; it does not rewrite the canonical entity or its earlier assessment. Meaningfulness and confidence impact are never inferred from text similarity.

Use the CLI with an isolated private root:

```sh
npm run source-change-reviews -- --root /path/to/private-root list
npm run source-change-reviews -- --root /path/to/private-root preview PRIOR_CAPTURE_UUID NEW_CAPTURE_UUID
npm run source-change-reviews -- --root /path/to/private-root create REQUEST_JSON
npm run source-change-reviews -- --root /path/to/private-root open REVIEW_UUID
```

The POST `source-change-reviews` API creates one immutable review record. GET on that route lists retained reviews; GET `source-change-reviews/compare?prior=UUID&next=UUID` prepares a diff; GET `source-change-reviews/UUID` reopens the exact prior review. All routes use Signals' loopback, origin, session and owner binding checks. Provide a stable `request_id`; if the write reply is lost, read that exact UUID rather than automatically retrying. Repeating the same request ID and payload returns its original record, while reusing it with different content is refused.

Diff output retains at most 40 changed lines and 5,000 UTF-8 bytes for each side. It includes hashes and omitted-line counts for larger changes. An unchanged pair can be recorded as unchanged, but still carries no truth, source-currentness, coverage or support conclusion. Missing and stale exact references fail closed.

Each confidence observation is bound to the exact saved entity revision and its canonical observation ID. A source change review preserves the original signal and assertion history. Cold reopen reads retained review state without fetching the source or regenerating the diff.
