# Architecture

Signals has one bounded research operation shared by the local workbench, CLI, query jobs and saved-entity refresh. It accepts a question, gathers public evidence, validates identity and observations, computes a declared assessment policy, and returns a readable brief with findings and gaps. The invoking AI or one explicitly configured headless Codex session supplies interpretation. Code owns transport, permissions, integrity, scoring and storage.

## Owners

Connected knowledge reuses exact Library reads and adds explicit producer export files in
`packages/corpus/src/knowledge.ts`. Foreign bytes remain with the producer; only reference
metadata and topic annotations persist in private `.signals` state. Its CLI configures readers;
HTTP consumers share the existing owner, session and origin boundary. See
[connected knowledge](docs/connected-knowledge.md) for snapshot semantics and limits.

| Location              | Responsibility                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `packages/domain/src` | Closed protocols, evidence decoding, identity, literal retrieval, bounded query interpretation and pure policy reducers |
| `packages/corpus/src` | Acquisition, native host adapter, validated storage, private state, projects, local API, scheduling and exports         |
| `packages/contracts`  | Frozen schema-v1 peer interchange                                                                                       |
| `apps/corpus`         | Home, Search, Projects, Library, Following and settings; public read-only Pages                                         |
| `scripts`             | CLI and development/verification entry points                                                                           |
| `signals`             | Canonical public native entities and reviewed historical findings                                                       |
| `.signals`            | Private collections, annotations, questions, projects, settings and retained history                                    |
| `dist`                | Disposable indexes, downloads and Pages assets                                                                          |

Git-held JSON is the public Corpus authority. MiniSearch indexes approved native and historical metadata into a derived Library view. Local retrieval additionally reads private records and annotations. Browsing and literal search invoke no model. Explicit Library meaning matching performs one no-web selection over permitted bounded metadata, validates returned IDs and hydrates original records. Failure leaves literal results available.

## Research and assessment

An explicitly linked proposition check acquires only its selected cited primary material before inference. Its bounded private `claimCheck` receipt owns the exact input snapshot, separate document/snapshot digests, acquisition outcomes, native-review state and parent binding. No usable material means no native call. One frozen review can return a fallible scoped verdict; code binds quotes and rejects explicit label/scope inconsistencies. No entity or numeric Signal is created. Memory mode returns proof without history writes; private negative/partial receipts remain recoverable after temporary source caches expire.

The native task retains its original Markdown before item validation. Invalid metadata affects individual candidates rather than discarding valid siblings or the answer. Active brief v7 carries query interpretation, `query-relevance-v1` and source-bound `signal-strength-v10` rubrics. Older brief/proposal formats are ingestion readers. A separately requested frozen review is a no-web specialist; ordinary research has no second interpretation stage.

An opt-in direct proposition check uses the same kernel with one or two caller-selected primary URLs. Its closed request-origin receipt binds the original question, context, proposition and ordered targets without manufacturing an answer parent. It accepts fresh material only and does not inherit broader source settings or request enrichment. Linked version-1 checks retain their original parent and citation rules. Valid direct checks, including negative and incomplete outcomes, survive ordinary temporary-run cleanup. Neither origin establishes a full item assessment, calibrated confidence or installation permission.

An opt-in answer-first method uses the same authenticated, cancellable runner without a scoring schema. Its complete Markdown and citation-reference receipt remain unassessed, with Unknown confidence; no deterministic aftercare can establish entailment or source independence. Private answer runs and existing query imports project into Library as immutable answer records, with full-text local retrieval and complete reopening. Remote meaning matching receives bounded metadata rather than answer text. Explicit citation assessment uses the existing native evidence kernel and retains a separate linked run. Whole selected answers can be supplied to frozen discussion as unverified prior synthesis; they never become scored observations. Answer receipts survive ordinary temporary-run cleanup. Oversized answers and omitted discussion records remain visible.

Headless observations bind to safely fetched text. An invoking native agent grounds observations with its own permitted tools. Quote occurrence is checked deterministically; entailment and independence remain fallible model judgments. Ranking, intrinsic strength, contextual advice and personal usefulness have [separate contracts](docs/signals-contract.md).

Optional [providers](docs/providers.md) supply unassessed acquisition or extraction within the same bounds. Original outlinks and heading/table addresses survive parsing. A source scan runs outside the writer lock, and supplemental state failures remain visible without disabling native research. Configured-source exposures and explicit per-entity feedback retain verified parent provenance; unknown historical provenance earns no invented credit.

## Persistence and jobs

Entity evidence is immutable. Claim wording and judgment bind to entity/source/quote identities; corrections append successors. Scoring excludes superseded judgments, and replay cannot restore retired credit. URI identity is independent of kind/query/name. Monorepo subresources stay distinct; conflicting aliases fail closed. Atomic per-file rename and a cooperating writer lock support retries without claiming batch transactions.

Projects owns explicit registrations, bounded source snapshots and contextual opportunities. User decisions remain separate from source snapshots and intrinsic evidence. Updating a snapshot marks old opportunities stale; disconnect preserves retained knowledge. Context receives advisory setup requests and owns equipment selection/application. The [data map](docs/architecture/schema.md) describes canonical, derived and private state.

Query lists freeze selected interests and compatible acquisition pools. Different needs retain separate reasoning. Due slots coalesce missed intervals; a process-owned lease prevents overlap. Completion follows retained results and saves. Interrupted inference becomes uncertain rather than silently repeating. Refresh checks validators/digests before inference, preserving the last good record after denial. One-shot activation does not enable recurrence. Publication defaults to local-only and uses ordinary reviewed Git operations plus Pages CI.

## Access boundaries

The installed CLI owns authentication. The disposable read-only headless runner disables shell, hooks, plugins, apps, memories, MCP execution and delegation. Process-group cancellation and output/time/tool limits bound it. That generic executor (readiness, lease, hardened arguments, minimal environment, stream supervision, checkpoints and termination) is the first-party `@pradeeptathineni/research-ai` package; `packages/corpus/src/search-runner.ts` keeps Signals' prompts, acquisition, schemas, output interpretation, receipts and failures and passes its own lease name, budgets and note reader. Retrieved instructions cannot grant permissions. Safe HTTPS transport validates DNS, pins the connected address, validates redirects and limits bytes/time. Failed sources remain inspectable.

Local API mutations require loopback Host, same Origin and a random session token. Closed operations select server-owned results rather than arbitrary commands or paths. Development and built serving share the handler. Asset allowlists deny private files and symlink escapes. Public Pages contains approved public records only and cannot invoke a local runner.

Private document import is an explicit local Signals owner operation. It stores immutable original bytes and validated per-page text under `.signals`; list/open return metadata or page text without raw bytes. PDF extraction uses the exact optional pypdf 6.15.0 helper over stdin with bounded input/output/time, and text/HTML import stays inert. Selecting exact pages supplies the existing frozen Research boundary; import itself has no model or network call.

There is no database service, general agent runtime or candidate executor. [Product intent](docs/product.yaml) defines required capabilities; [AI authoring context](.meta/context/README.md) governs repository work. Evidence replay, fixtures, configured-live research, independent review and human usefulness remain distinct.
