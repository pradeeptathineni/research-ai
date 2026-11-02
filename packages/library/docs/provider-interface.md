# Local Signals provider

Consumers connect to an explicitly configured loopback HTTP endpoint without sibling TypeScript imports or a mandatory SDK. Start the existing workbench from its installed Signals root with `npm start`; `SIGNALS_WORKSPACE` selects the owned data root and `SIGNALS_PORT` selects its loopback port. The standalone workbench and existing API remain available.

Register the complete trusted base URL, for example `http://127.0.0.1:5178/signals-ai/__signals/api/`, and the expected owner instance/epoch. Never obtain endpoints, commands, paths or credentials from record content. Browser integrations use a same-origin host bridge to this registered endpoint. Existing origin/session checks remain; direct cross-origin browser requests are refused.

## Negotiate capabilities

`GET provider/capabilities` accepts `x-signals-provider-version: 1.0` (also the default when omitted). Other major/minor versions return `426 unsupported_provider_version`; no version substitution occurs. The response wrapper contains:

- `capabilities`: closed `OwnerCapabilities` v1, with `owner:"signals-ai"`, durable `instance_id`, installed product version, contract versions, operations, record kinds, observation time and availability/reason.
- `deduplication`: accepted S02 identity, epoch and durable request retention contract.
- `access`: relative routes and origin/session requirements, describing this endpoint rather than authorizing arbitrary discovery or execution.

Capability reads never initialize storage, probe a native CLI or start research. Available means the HTTP owner contract is available; native generation readiness remains separate. `process_observation:true` advertises K13's bounded owner snapshot. Consumers check required operations and target kinds as well as versions. Unsupported operations disable only that action, not unrelated products. K12 now advertises bounded `search_library` and exact owner reads for its supported kinds.

Identity reuses S02's durable scope. Missing/corrupt/unreadable scope yields `503 provider_unavailable`, never an invented instance or repaired ledger. For an explicitly selected fresh workspace, obtain the existing session token and explicitly `POST request-scope` with `{}`. Session acquisition includes native readiness and is separate from capability/record reads. Never initialize another scope to resolve uncertain work, storage loss or restore. Already registered callers can pin `x-signals-instance-id` and `x-signals-owner-epoch` while negotiating.

## Personal-saving settings

The optional `owner-settings` v1 contract advertises `read_owner_settings`,
`preview_owner_settings` and authority-required `edit_owner_settings` for
`private-library-settings`. Existing provider identity, loopback Origin and session-token
boundaries apply. These operations do not start research or alter authentication.

`GET library-settings` discovers the three existing private automatic-saving controls:
`automaticSaving.enabled`, `automaticSaving.signalThreshold` and
`automaticSaving.relevanceThreshold`. No query parameters or caller-selected paths are accepted.
The `owner.settings.v1` projection uses the shared settings field shape: owner/component, category,
default, effective value, source, scope, constraints, editability, timing and explicit limitations.
The semantic owner is Research Library. The HTTP provider retains its historical `signals-ai`
identity. Consumers must bind the registered provider instance/epoch and configured scope.

`POST library-settings` accepts a closed request:

```json
{
  "action": "preview",
  "expectedRevision": "<revision from GET library-settings>",
  "updates": { "automaticSaving.signalThreshold": 85 },
  "resets": []
}
```

Preview returns proposed values without writing. Use `action: "save"` with the same original
`expectedRevision` after review. `baseRevision` preserves that original revision in preview/save
responses. Revisions are opaque equality tokens over validated preferences, including unexposed
consent. Formatting changes do not invalidate a revision. A changed preference returns
`409 settings_changed`. Saves use the existing native validator, writer lock and private JSON
store. Unknown save outcomes require a fresh read, without automatic replay.

Reset requires all three IDs in `resets` and no updates. The owner stores this as one optional
group, so reset removes the complete group and restores false/75/75. Individual override removal
is unsupported. Manual saving, public admission, recurrence, meaning-matching consent and provider
cost settings remain separate. Reads return no consent value or credentials. The native workbench
reads the saving policy at completion, so a running operation can observe a saved change.
Memory-only requests, claim checks and refresh remain outside automatic personal saving.

The standalone exposes the same operations without a running server:

```sh
npm run library:settings -- --root /absolute/private-workspace show
npm run library:settings -- --root /absolute/private-workspace edit '{"action":"preview","expectedRevision":"<current revision>","updates":{"automaticSaving.signalThreshold":85},"resets":[]}'
```

The workbench's persistent controls stay in Settings → Personal Library. Its search covers these
three controls, with saved/default/source/scope values beside each. The form previews, saves,
reloads and resets through the same owner route. It never resubmits the separate consent flag.

## Read exact retained records

`GET provider/records?ref=<URL-encoded JSON RecordRef>` requires:

```text
x-signals-provider-version: 1.0
x-signals-instance-id: <trusted registered instance_id>
x-signals-owner-epoch: <trusted registered epoch>
```

The closed reference has `owner`, `kind`, `id`, `revision`, `digest`. Supported owner is `signals-ai`. `answer`, `research_run` and `research_note` use UUID IDs selecting existing private `.signals/runs` snapshots; answers require a valid answer receipt, while notes require an incomplete narrative without one. `imported_answer` uses the older answer's run UUID and opens its unchanged `.signals/queries` record. `entity` IDs have `public:` or `private:` before the native entity ID, preserving duplicate visibility identities. `lead` and `project` use their existing owner IDs and open deterministic validated per-record JSON projections from their aggregate stores. Legacy published bundles have no exact per-record reader and are excluded from this provider search. Arbitrary paths/open commands and extra reference fields are unsupported. Missing data never triggers research.

The response includes bounded UTF8 JSON in `content`, `content_type:"application/json"`, `encoding:"utf8"`, owner instance/epoch, a storage label and a resolved `ref`. Runs, imports and native entities return their exact original file bytes. Lead and project records return the canonical validated per-record JSON projection. Digest is lowercase SHA256 over those returned bytes; revision is `sha256:<digest>`. Original run CRLF, Unicode, partial/failed status, narrative, dates and limits survive. The historical reader validates the snapshot, but its recalculated replay projection is not substituted for original bytes. A change during validation is refused. These reads write no records, Library selections or job state.

This follows the existing cooperative immutable-store boundary. The before/after comparison is not an atomic transaction against external editors or pathname swaps that ignore that boundary.

Null revision/digest explicitly resolves the current retained immutable snapshot. Preserve the returned complete reference to reopen that exact version. Mismatched non-null revision/digest returns `409 provider_record_changed`; no successor is substituted. Retained history is not automatically a saved Library answer. Memory-only content without a snapshot stays unavailable after restart. Successful private loopback reading grants no public/export authority; private data remains excluded from public assets.

## Search the retained Library

An answer/import may optionally carry Research's `claim-support-v1` closure.
Native runs use `grounding`; imports retain it at `result.input.grounding` in
their exact original bytes. Signals replays Research's validator on reading;
consumers display the supplied annotations without deriving support judgments.
Absence means unavailable assessment, not unsupported claims. See
[grounded answers](grounded-answers.md) for creation, retention and limits.

`GET provider/library?q=<Unicode text>&limit=<1..100>&kinds=<comma-separated kinds>&project_ref=<encoded RecordRef>&cursor=<opaque>` requires the same trusted owner headers as record reads. All filters are optional. Empty `q` returns recent saved records; default limit is 30, maximum 100. Supported kind filters are `answer`, `research_note`, `imported_answer`, `entity` and `lead`. A project filter must name a current Signals `project` ref; stale project digest/revision is refused. Unknown or repeated filters fail explicitly. Search reuses the owner Library's phrase, prefix and typo index; retrieval rank never becomes evidence strength.

The K12 v1 page contains `records`, `next_cursor` and `owner_coverage`. Each summary contains an owner-qualified exact ref, title, bounded description, kind, associated project refs, visibility, qualification, observation time and `open_capability`. A missing or invalid original appears as `unavailable`, never regenerated content. The cursor binds the filters and current result snapshot; a changed or malformed cursor returns `409` for a fresh first-page search. A corrupt run can reduce answer coverage while valid unrelated stores remain searchable; `owner_coverage.reason` reports that gap. These aggregate summaries include no private answer text or personal notes. Unsaving removes an item from aggregate selection without deleting its original history or its previously issued exact ref.

## Explore a complete Library snapshot

`GET provider/library-explore?q=<Unicode text>&kinds=<comma-separated kinds>&project_ref=<encoded RecordRef>` reuses the same saved-record query, supported kinds, current project binding and owner coverage as `provider/library`. It requires the same trusted owner headers. Empty filters mean the current complete saved Library. Pagination is performed by the owner; consumers receive no cursor and must not combine their own pages. More than 1000 items or 4 MiB is an explicit `413 library_explore_too_large` refusal, never a partial dataset.

The `signals-library-explore-v1` response contains the exact filters, a lowercase SHA256 snapshot, complete `items`, actual `facets`, `owner_coverage` and qualifications. Each item wraps the existing Library summary and an opaque lowercase SHA256 `key` bound to its exact `RecordRef`. `facets.dated_keys` and `undated_keys` partition all item keys; kind facets report owner-supported kinds with actual counts and keys, including zero counts. Chart dates are normalized from retained `updated_at` only when an explicit timezone is present. Unknown, malformed and ambiguous local-time values remain null/undated; the original summary stays unchanged. The summary's per-read `observed_at` and coverage observation timestamps are excluded from the stable snapshot digest. Owner observation is not publication time, freshness, evidence quality or relevance.

Select exact rows with the read-only POST route. It retains the ordinary session token, same-origin and CSRF checks in addition to owner binding:

```json
{
  "snapshot": "LOWERCASE_SNAPSHOT_SHA256",
  "filters": {
    "q": "literal search text",
    "kinds": ["answer", "entity"],
    "project_ref": null
  },
  "keys": ["LOWERCASE_ITEM_KEY_SHA256"]
}
```

The response uses `signals-library-selection-v1` and returns the snapshot, selected keys and their existing summaries in owner order. Empty selection is valid. Duplicate, malformed or non-member keys return `400`; any changed current snapshot returns `409 library_explore_snapshot_changed` without dropping rows or substituting successors. Reads and selection do not write Library state, launch a model, score evidence or refresh sources. `library_explore` is separately advertised as a nonmutating capability; existing Library routes and admission behavior are unchanged.

Missing owner bindings return `428 provider_owner_binding_required`. Wrong instance/epoch/reference owner returns `409`. Missing snapshots return `404 provider_record_not_found`. Malformed references/extra query fields return `400`. Unsafe, oversized, corrupt or unsupported snapshots return `503 provider_record_unavailable`. Errors provide bounded `code` and actionable `reason` without private paths. Unavailable transport never causes inference fallback or automatic owner rebinding.

## Existing actions and recovery

Advertised `search`, `cancel`, `lookup_request` and `request_configuration` use the existing API; capabilities do not grant execution authority. Mutations retain loopback Host, same-Origin/cross-site protection and random `x-signals-token`. The exact pre-effect `403 csrf_token_required` and cross-origin `403 untrusted_origin` remain unchanged.

Supplied provider-version and instance headers also bind existing actions: an incompatible version or wrong configured instance/epoch is refused before body parsing or effects. Legacy callers that omit these optional headers retain existing behavior. These checks follow the existing origin and CSRF refusals, preserving their exact pre-effect responses.

Follow the [durable request contract](signals-contract.md#durable-research-requests-v1): persist original key/envelope, owner epoch and `signals-execution-v1` configuration reference before send; pin `x-signals-execution-digest`. Negotiating capabilities must not recompute uncertain requests from current defaults. Recover through authoritative `requests/{key}` with its original scope/configuration. Neither a not-found nor a capability response authorizes replay. Actual Deep connection is qualified separately; this adds no controller, scheduler or mandatory service.

## Ask about saved research

`ask_saved_research` discusses one exact retained `answer` or `research_note` without new search. `POST followups` takes the closed [frozen-followup-request-v1](signals-contract.md#frozen-follow-up-requests-v1) envelope with the session token and `x-signals-owner-epoch`. It answers `202` with the durable receipt before any discussion finishes. `GET followups/{key}` (`lookup_followup`) reads that receipt back and adds `result_ref`, the exact retained child `answer`, once it exists. Read the child through `provider/records`; it is an ordinary unassessed private answer that Library search and exact planning references can select. Imported answers and other kinds are not accepted as parents.

A changed, missing, unsafe or wrong-kind parent is refused with the record-read codes above before any identity is admitted or model called. `409 runner_busy` admits nothing. The same key returns its original receipt without rechecking the parent or discussing again; changed meaning is `409 request_conflict`. An `unknown` receipt stays unknown after restart and is never replayed. `cancel/{job}` uses the receipt's `run_ref`. Ledger rows appear in `provider/processes` like other durable requests. Lookups take no writer lock, so a `503` read while the owner publishes a ledger update can clear on the next read of the same key; it never means the request is absent.

## Observe current research work

`GET provider/processes` returns one complete K13 v1 snapshot of known durable requests and in-process jobs. Pin the trusted provider version, instance ID and durable request epoch in the same headers used for record reads. `store_epoch` is an independent observation epoch; it changes when the HTTP owner restarts without retiring the durable request epoch. `sequence` changes with observed owner state, while repeated reads alone leave it unchanged. `snapshot_revision` combines the observation epoch and sequence. This v1 response has `cursor:null`, `event_cursor:null`, `full_snapshot:true` and `complete_coverage:true`; it refuses an over-2 MB response instead of truncating it. There is no public delta or pagination transport.

Rows identify exact job IDs and, for durable requests, the original request identity. Progress carries the last worker event and its time. Snapshot `as_of` is the read time and does not refresh a worker heartbeat. Unknown query scope, model and cost stay unknown. A live in-memory result can be reopened with the existing `runs/{job-id}` route; after restart, a durable receipt can remain complete or partial while its memory-only answer is unavailable. An unresolved receipt after restart is `unknown`, never proof of a live child. Direct jobs are only known in the current owner process; missing rows or a disconnected owner do not establish completion.

Each row advertises an exact `cancel` job target when a current worker can be interrupted. Cancellation intent leaves the lifecycle running until the owner confirms a terminal result. Durable rows also advertise reconciliation against the original idempotency key and owner epoch. Mutations require the existing session token and retain the pre-effect CSRF and origin checks. A consumer must preserve its last complete snapshot as stale on connection failure, reject older sequences in one observation epoch, and obtain a full snapshot when the observation epoch changes.

Copy [process-consumer.mjs](../scripts/examples/process-consumer.mjs) alone into a Node 24 directory and run it with the exact trusted endpoint, instance ID and durable request epoch. It prints a validated full snapshot without importing Signals code or invoking a model. Run `npm run build && npm run demo:processes` for the local [offline demo](../scripts/examples/process-demo.mjs). It uses the real built-asset HTTP handler with an explicitly authored callback and measures restart, stale evidence, cancellation, partial and failed work without provider calls.

### Read live Research activity

Capabilities advertise `research-activity` version `1.0`, nonmutating operation
`read_research_activity`, and `access.research_activity_route`.
`GET provider/research-activity?request_id=JOB_ID&after=0` reads actual native
session observations for the exact durable search job returned by POST `search`.
Provider version `1.0`, trusted instance ID and owner epoch headers are required;
the existing Host, Origin and no-store protections apply. Reads start no work.

The `signals-research-activity-v1` batch binds `instance_id`, `owner_epoch`,
`store_epoch` (the same HTTP observation epoch as K13), `request_id` and nullable
`session_id`. Events retain the closed `research-activity-v1` projection from the
pinned Research executor. Signals assigns one session ID to one actual workspace
run; it claims no native thread identity. Queries, prose, thinking, arguments and
raw diagnostics are absent. Unsafe URLs stay withheld without rewriting them.
Native web completion proves neither access nor source truth; `session.settled`
reports actual terminal/cleanup evidence, without accepting an answer.

Save `next_cursor`, `session_id` and `store_epoch`; supply all three on reconnect.
`after` defaults to zero; `limit` is 1–100, default100. Unknown or repeated query
keys refuse400. Missing reconnect binding refuses428; wrong scope or an ahead
cursor in an available buffer refuses409. Unknown durable jobs refuse404.
The ephemeral ring retains at most256 rows /256,000 event bytes, with4,096 bytes
per row, within the existing30-run retention. `first_sequence`, `last_sequence`,
`dropped`, cursor-relative `gap` and `observation_lost` expose missing coverage.
Callback failure marks loss synchronously and cannot stop the Research owner.

`availability`, `reason`, `last_observed_at`, `fresh`, `as_of` and a30-second stale
threshold distinguish missing, stale and available evidence without heartbeat
inference. `owner_settled` and `session_settled` are separate. `complete` requires
both, a drained cursor and no known loss; it describes observation delivery, not
research success. A known request without its current buffer returns unavailable
and lost, including after pruning/restart. No event replay or work dispatch is
fabricated; durable request receipts remain authoritative. Existing ledger
publication can return503 temporarily, as for other owner reads; retry only the
same read. Answer, checkpoint, cancellation and duplicate-POST behavior is unchanged.

## Consumer with no Signals imports

Copy [provider-consumer.mjs](../scripts/examples/provider-consumer.mjs) alone into a Node 24 directory. It uses built-in HTTP/crypto/assert support, validates the explicitly configured endpoint, refuses redirects, checks owner/version/operation availability and verifies content digest/revision:

```sh
node provider-consumer.mjs \
  http://127.0.0.1:5178/signals-ai/__signals/api/ \
  INSTANCE_UUID EPOCH_UUID \
  '{"owner":"signals-ai","kind":"answer","id":"RUN_UUID","revision":null,"digest":null}'
```

Supply actual IDs from trusted registration and selected retained history. The consumer performs no install, native readiness probe or model call. This demonstrates the provider protocol, not actual Deep integration or live research quality. The unchanged dependency audit remains a separate release gate.

Copy [library-consumer.mjs](../scripts/examples/library-consumer.mjs) alone into a Node 24 directory to search the owner and verify each returned exact read:

```sh
node library-consumer.mjs http://127.0.0.1:5178/signals-ai/__signals/api/ INSTANCE_UUID EPOCH_UUID "aurora"
```

The offline `library-built-demo.test.ts` runs an authored callback behind actual built Signals assets, restarts the HTTP owner with generation disabled, and exercises this external consumer plus standalone Library navigation. Its fixture observations are not native research-quality evidence.

## Retain annotated source captures

The optional `source-capture` v1 contract stores bounded immutable source observations and exact-quote personal annotations in private `.signals/source-captures.json`. Captures are explicitly selected from an exact current `entity` or `lead` record; fetching uses that selected source URI only. Paste mode retains caller-supplied text as unverified and never fetches. A later version may name an exact predecessor; concurrent successors are refused. Capture history and annotations are never added to public assets or Library search.

The owner routes are `GET/POST source-captures`, `GET source-captures/{capture_uuid}`, `GET source-captures/compare?left={uuid}&right={uuid}`, `POST source-captures/selection`, and `POST source-annotations`. They use the trusted provider version, instance, epoch, origin and session guards. POST bodies and query parameters are closed. Selection returns the exact capture and only explicitly requested exact annotation refs, suitable as a private research-source handoff; it is not an answer or support judgment. `read_record` supports exact `source_capture` and `source_annotation` refs.

### Optional exact raw-response archive

Source captures continue to retain bounded normalized text and the response-body digest. They do not retain original HTTP bytes by default. When byte-for-byte retention is needed, `source-archive` v1.0 provides an explicit additional operation over the same guarded fetch and exact selected source. The closed request is `{request_id, capture_request:{source_ref, mode:"fetch", supersedes?}}`; `request_id` reserves the resulting capture UUID. A response body is archived only when it is nonempty, at most 1,000,000 bytes, and its SHA-256 matches the raw digest recorded by the capture. This is the body surfaced by the existing fetch; transfer/content decoding may already have occurred. It is not a full HTTP or TLS wire archive and omits headers, cookies and redirect-chain bodies. Oversized or unavailable bytes do not prevent retaining the ordinary text capture; the request reports `capture-created-archive-unavailable` with a reason.

`POST source-archives` returns a readback receipt. If an admitted request has an uncertain result, `GET source-archives/requests/{request_uuid}` is readback only; it never retries the fetch. Cold `GET source-archives/{capture_uuid}?ref={encoded_exact_capture_ref}` verifies the exact capture ref, archived raw digest, byte count, archive ref and body SHA-256. Legacy captures without an explicit archive return `state:"unavailable"`; bytes are never reconstructed from normalized text. The private `.signals/source-archives.json` store is limited to 100 requests and 2,000,000 serialized bytes, so only a limited number of large bodies fit and no older archive is evicted; each body is stored as base64 with a digest-bound manifest. No response headers, credentials or request headers are archived. Reads return opaque base64 bytes as JSON and never serve them as HTML or execute them.

The standalone CLI accepts the same closed JSON request and exact capture ref:

```sh
npm run source-archives -- --root PRIVATE_ROOT create '{"request_id":"REQUEST_UUID","capture_request":{"source_ref":EXACT_CURRENT_SOURCE_REF,"mode":"fetch","supersedes":EXACT_PRIOR_CAPTURE_REF}}'
npm run source-archives -- --root PRIVATE_ROOT request REQUEST_UUID
npm run source-archives -- --root PRIVATE_ROOT read EXACT_CAPTURE_REF_JSON
npm run source-archives -- --root PRIVATE_ROOT export EXACT_CAPTURE_REF_JSON OUTPUT_PATH
```

Replace each `EXACT_*_REF` token with the full RecordRef object, not a quoted string. `read` prints bounded base64 inside JSON. `export` writes verified opaque bytes only to the explicit target using exclusive create, mode 0600 and no-follow; it refuses an existing target and does not create parent directories or execute/serve content. If a write is interrupted, the new target may be partial and is left in place for inspection; choose another new path after reviewing it.

When the optional exact `playwright@1.63.0` runtime and its matching local Chromium executable are available, Signals additionally advertises `source-capture-render` and the explicit `source_capture_render` operation. `POST source-captures/render` takes a fresh request UUID, exact current lead/entity ref and optional exact predecessor capture ref. It fetches once through the existing validated HTTPS acquisition, writes the unchanged v1 text capture, and attaches an offline static render of those same response bytes. JavaScript and service workers are disabled, the browser context is offline, and request interception aborts resource attempts. No cookies/profile, URL, HTML, paths, install or replay are accepted. These are browser-level controls, not an OS-level network sandbox. The retained fixed viewport PNG and inert DOM/ARIA text are qualified as a static capture, not a live-site reproduction. A missing browser leaves the original text capture available.

`GET source-captures/render-requests/{request_uuid}` is readback only; an uncertain or interrupted admitted request is never retried automatically. `GET source-captures/{capture_uuid}/render` discovers the sole immutable render attachment by the exact v1 capture UUID after a cold reload. Optional `?digest=...` asserts the exact manifest; mismatch is `409`. `GET source-captures/{capture_uuid}/render/blob?manifest=...&artifact=screenshot|dom|aria` returns an exact digest-checked PNG or plain-text artifact. `read_record` also supports the exact `source_capture_render` manifest ref; binary bytes are available only through the artifact route. The attachment manifest and blobs are private, independently bounded state and do not change v1 capture shape or enter Library/search/public assets.

Private collection query is an owner-local extension over previously imported `private_document` refs. `POST private-collection/preview` ranks bounded passage windows from every text-layer page; `GET private-collection` and `GET private-collection/{query_uuid}` reopen private preview metadata and revalidate exact document/page digests. `POST private-collection/selection` freezes only 1–8 explicitly chosen passage IDs as exact Research sources, with a page/range manifest and qualifications. Querying has no provider or network call. The returned snippets can be retained by the caller and supplied directly to Research `--sources FILE`. All routes use existing session, origin and owner epoch checks; paths and raw bytes are not accepted.

Private PDF reading adds `POST private-reader/bytes` with the closed `{document_ref,raw_sha256}` request. It returns the original PDF as base64 only after matching the current complete document ref, raw hash and PDF media type; response caching is disabled. Reader state is retained separately from source documents: `GET private-reader` lists safe metadata, `GET private-reader/{uuid}` reopens exact page/annotation bindings, `POST private-reader` creates or reopens an idempotent reader UUID, `POST private-reader/revise` uses expected revision/digest compare-and-swap, and `POST private-reader/selection` freezes only up to eight explicitly named annotations as `FrozenSource[]` plus a range/hash/qualification manifest. Every route uses the established session, origin and owner-epoch guards. The local CLI is `npm run private-reader -- --root PRIVATE_ROOT list|open|create|revise|select ...`. No route accepts caller paths or invokes a provider.

`POST private-documents/sections` accepts only `{document_ref,raw_sha256}` and reopens the exact retained PDF before reading its embedded bookmark outline with the already configured pypdf 6.15.0 helper. It returns `document_ref`, `raw_sha256`, `extractor`, `outcome`, `nodes` and `omitted`. Nodes have stable raw-digest/outline-position IDs, optional `parent_id`, title and one-based inclusive physical page bounds; printed PDF page labels are not inferred. A node ends before the next bookmark at the same or a higher outline level, or at the document end. These are navigation bounds, not semantic section boundaries. Inspection is bounded to 200 nodes, 16 levels and 300 title characters. `absent` means the parser found no outline; `unavailable` means outline reading could not be trusted. Invalid destinations are counted as omitted. This is navigation metadata only: it performs no OCR, heading inference, source verification or provider call and writes no state.

### Request shapes and anchors

Every POST accepts only the fields shown. `EXACT_SOURCE_REF` is a complete current Signals `entity` or `lead` ref; `EXACT_CAPTURE_REF` and `EXACT_ANNOTATION_REF` are complete retained refs with matching digest and revision. Fetch mode accepts no caller text or observation time. Paste mode requires both exact text and an ISO observation time, and does not acquire or verify the source. Either mode may include an exact prior capture ref in `supersedes`:

In these illustrative JSON bodies, each quoted `EXACT_*_REF` token stands for the full RecordRef object, not a string value to send literally.

```json
{
  "source_ref": "EXACT_SOURCE_REF",
  "mode": "fetch",
  "supersedes": "EXACT_CAPTURE_REF"
}
```

```json
{
  "source_ref": "EXACT_SOURCE_REF",
  "mode": "paste",
  "text": "Exact caller-supplied source text",
  "observed_at": "2026-10-23T12:00:00Z"
}
```

An annotation points to one exact capture and one exact substring. `text_sha256` is lowercase SHA256 of the capture's exact UTF8 text; `start` is inclusive and `end` exclusive, both measured in UTF16 code units (JavaScript string offsets). `quote` must equal that slice exactly, and an offset may not split a surrogate pair. A note is personal interpretation, not source evidence. An optional annotation `supersedes` must name an exact prior annotation on the same capture:

```json
{
  "capture_ref": "EXACT_CAPTURE_REF",
  "anchor": {
    "text_sha256": "SHA256_OF_EXACT_CAPTURE_TEXT_UTF8",
    "start": 15,
    "end": 34,
    "quote": "A quoted condition."
  },
  "note": "My interpretation of this passage",
  "supersedes": "EXACT_ANNOTATION_REF"
}
```

Selection carries no arbitrary text or source lookup: it names one exact capture and the exact annotation versions to include (or an empty list):

```json
{
  "capture_ref": "EXACT_CAPTURE_REF",
  "annotation_refs": ["EXACT_ANNOTATION_REF"]
}
```

Capture text is limited to 48,000 UTF16 units and 96,000 UTF8 bytes; retained history is bounded. Responses disclose transport/freshness provenance, extraction and capture truncation scope, and qualifications. Fetch records an observation time, not continuing freshness. Paste provenance is unverified, and annotations never upgrade evidence or support status. Predecessor links preserve prior versions; a second successor to the same version is rejected rather than silently rebased.

From the installed Signals root, `npm run source-captures -- --root PRIVATE_ROOT list` and `open CAPTURE_UUID` inspect local history. `capture EXACT_SOURCE_REF_JSON` fetches; `capture EXACT_SOURCE_REF_JSON --paste-file FILE --observed-at ISO` imports a bounded local UTF8 text file. `render REQUEST_JSON` performs one explicit owner-admitted capture; `render-open CAPTURE_UUID [MANIFEST_SHA256]` reopens its sole attachment, optionally asserting a known digest. `annotate REQUEST_JSON`, `compare LEFT_UUID RIGHT_UUID`, and `select REQUEST_JSON` accept the same closed request shapes as the HTTP contract. The standalone [consumer](../scripts/examples/source-capture-consumer.mjs) demonstrates exact selection and UTF16 quote-anchor verification without importing Signals modules. It requires a running trusted provider endpoint.
