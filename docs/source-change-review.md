# Source change review

Source change review uses Signals' existing immutable source captures. It compares two directly linked versions of the same source and returns a deterministic, bounded line diff with exact text digests, capture provenance, and each version's retained capture/extraction coverage. A retained review carries the same coverage snapshots so cold reopen does not need to recompute or reinterpret them. Older reviews remain readable without that additive field.

The versions are the normalized text retained by the capture owner, not copies of the original HTTP response. Fetch captures retain a raw-response digest but not the raw response bytes. Coverage reports capture truncation and extractor omissions; it does not prove the source was complete.

The reviewer classifies the observed change, selects exact saved confidence observations it may affect, marks each assertion current or needing review, and retains or revises the judgment. A revised status is retained in the review record as a human successor judgment; it does not rewrite the canonical entity or its earlier assessment. Meaningfulness and confidence impact are never inferred from text similarity.

Use the CLI with an isolated private root:

```sh
npm run source-change-reviews -- --root /path/to/private-root list
npm run source-change-reviews -- --root /path/to/private-root preview PRIOR_CAPTURE_UUID NEW_CAPTURE_UUID
npm run source-change-reviews -- --root /path/to/private-root create REQUEST_JSON
npm run source-change-reviews -- --root /path/to/private-root open REVIEW_UUID
```

The POST `source-change-reviews` API creates one immutable review record. GET on that route lists retained reviews; GET `source-change-reviews/compare?prior=UUID&next=UUID` prepares a diff; GET `source-change-reviews/UUID` reopens the exact prior review. All routes use Signals' loopback, origin, session and owner binding checks. Provide a stable `request_id`; if the write reply is lost, read that exact UUID rather than automatically retrying. Repeating the same request ID and payload returns its original record, while reusing it with different content is refused.

## Saved section watches

A Source Watch rechecks one literal section in retained captures for the same source. Start with an existing capture and copy its complete `ref` object from `open`:

```sh
npm run source-captures -- --root /path/to/private-root open BASELINE_CAPTURE_UUID
```

Use that exact ref in a reviewed create request. The UUIDs and digest below are illustrative: replace them with a fresh request UUID and the values from the selected capture's actual `ref` before running the command.

```sh
npm run source-watches -- --root /path/to/private-root create '{"request_id":"11111111-2222-4333-8444-555555555555","label":"Policy section","rationale":"Check whether the retained policy section changed before deciding whether it affects our assessment.","baseline_capture_ref":{"owner":"signals-ai","kind":"source_capture","id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","revision":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"start_marker":"BEGIN POLICY","end_marker":"END POLICY","ignore_lines":[]}'}
```

The command returns the immutable `watch` and its exact `ref`. Save that output for the later check; cold reads are available by UUID:

```sh
npm run source-watches -- --root /path/to/private-root list
npm run source-watches -- --root /path/to/private-root read WATCH_UUID_FROM_CREATE
```

After obtaining a new capture that explicitly supersedes the selected baseline, compare its retained section by passing the exact watch ref and exact new capture ref as JSON. Copy both complete ref objects from their owner responses; do not reconstruct or broaden them.

```sh
npm run source-watches -- --root /path/to/private-root check '{"owner":"signals-ai","kind":"source-watch","id":"WATCH_UUID_FROM_CREATE","revision":"sha256:WATCH_DIGEST_FROM_CREATE","digest":"WATCH_DIGEST_FROM_CREATE"}' '{"owner":"signals-ai","kind":"source_capture","id":"NEW_CAPTURE_UUID","revision":"sha256:NEW_CAPTURE_DIGEST","digest":"NEW_CAPTURE_DIGEST"}'
```

The result is limited to the selected retained text and reports capture coverage. Missing/ambiguous markers, unavailable refs, or an unverified same-source predecessor chain return `unresolved`; they do not mean unchanged. A changed result is a textual difference, not a finding about truth, importance, support, or currentness. A person must inspect the retained excerpts and context, then explicitly decide whether any assessment or action should change. Source Watches do not fetch, notify, or make that decision.

To prepare the existing full-source change-review preview from a resolved watch check, run:

```sh
npm run source-watches -- --root /path/to/private-root review-preview '{"owner":"signals-ai","kind":"source-watch","id":"WATCH_UUID_FROM_CREATE","revision":"sha256:WATCH_DIGEST_FROM_CREATE","digest":"WATCH_DIGEST_FROM_CREATE"}' '{"owner":"signals-ai","kind":"source_capture","id":"NEW_CAPTURE_UUID","revision":"sha256:NEW_CAPTURE_DIGEST","digest":"NEW_CAPTURE_DIGEST"}'
```

This command returns both the selected-section check and `previewSourceChange` output for the complete normalized capture text. It is preview-only and does not create a review. It refuses unresolved watch checks, and the existing full-source preview additionally requires the new capture to directly supersede the baseline; a watch can check a descendant up to 100 versions later, but that multi-version result cannot be promoted through this command. Watch diff line references use filtered-section coordinates after exact ignored lines are removed; full-source preview references use the original normalized capture text. Keep those coordinate systems separate when a person prepares a review.

Diff output retains at most 40 changed lines and 5,000 UTF-8 bytes for each side. It includes hashes and omitted-line counts for larger changes, and keeps a marked excerpt when a single changed line exceeds the byte limit. The per-version coverage snapshot separately reports capture mode, original/retained/omitted text sizes, extraction kind, and declared omissions. An unchanged pair can be recorded as unchanged, but still carries no truth, source-currentness, or support conclusion. Missing and stale exact references fail closed.

Each confidence observation is bound to the exact saved entity revision and its canonical observation ID. A source change review preserves the original signal and assertion history. Cold reopen reads retained review state without fetching the source or regenerating the diff.

The Deep panel reads its Signals contract binding from the active provider configuration. Receipts identify the canonical contract digest kind, provider instance, and owner epoch; a source commit appears only when Signals reports one. An uncertain write keeps that binding with its request UUID, so recovery reads the UUID only through the same provider instance and epoch.
