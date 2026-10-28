# Search saved knowledge and reopen topics

Signals searches its saved Library together with explicitly exported Planning decisions,
reviews and reflections, and Principles accepted principles or private study sessions.
This operation uses literal text retrieval, makes no model calls and sends no text to a remote
service. The standalone Library keeps its existing routes and behavior.

Create each export with its producer, then configure the exact file and chosen store instance
ID. Reader paths are operator CLI configuration only; HTTP clients and record content cannot
supply paths, commands or readers. Configure only trusted exports.

```sh
npm run knowledge -- --root /private/signals-workspace configure '[{"owner":"planning-ai","path":"/private/exports/planning.json","instance_id":"my-planning-store"}]'
npm run knowledge -- --root /private/signals-workspace search 'a remembered decision'
npm run knowledge -- --root /private/signals-workspace create 'Project choices'
```

Foreign exports are frozen snapshots. Explicitly regenerate them to refresh; `export_as_of`
reports the producer generation time or null when unknown. Search reports coverage for all
three owners, including unconfigured, unavailable and partial native stores. Foreign native
record JSON is searched in memory along with metadata; summaries omit whole record bodies.
Retrieval rank never establishes evidence strength, applicability, mastery or empirical benefit.

Results carry `selection:{ref:{owner,kind,id,revision,digest},instance_id,owner_epoch}`.
`read SELECTION_JSON` opens that exact record; changed digests are refused. Foreign reads
validate the configured file, owner/store, JSON, kinds and every digest, rejecting symlinks.
Native reads reuse the existing exact provider. No successor is substituted silently.

Topics retain names, selected exact summaries/references, relationships and open questions,
without copying foreign record bodies. Commands: `topics`, `open UUID`, `update UUID PATCH_JSON`
and `export UUID`. `graph UUID --format json|markdown` shows exact owner statuses and declared
dependency paths. Shell-quote JSON arguments. Update body:

```json
{
  "revision": 1,
  "name": "Project choices",
  "selections": [],
  "links": [],
  "questions": ["What would change this choice?"]
}
```

Copy complete selected identities into `selections`. Links are `{from,to,label,relation?}` using
`JSON.stringify([owner,instance_id,kind,id,revision,digest])` as each member key. Relation may be
`related` (the default for old links), `depends_on`, `supports` or `contradicts`; each is a
caller-authored claim. Only `depends_on` means that `from` depends on `to` and can produce a
possible-review path from a changed or missing dependency to its declared dependents. Unavailable
status is indeterminate. Paths do not establish truth, source invalidity or automatic succession;
the graph returns one deterministic shortest witness per dependent and keeps cycles finite. A stale
topic revision requires reopening. Compact graph JSON is capped at 4 MiB, charged as serialized
node/edge bytes and each witness path as it is added. Larger projections return `409
`knowledge_graph_too_large` and ask for a smaller topic; paths are not silently dropped. Removing
selections removes membership only. Existing
frozen selections can retain annotations while an owner is offline; adding a record verifies
its current exact identity first.

After restart, opening compares saved references against the configured owner snapshot:
`current`, `changed`, `missing` or `unavailable`. Current matches the configured frozen export,
not the live underlying source. A successor requires explicit selection. Markdown exports
include original identities, qualification, questions, links and current comparison status;
they are references rather than a complete source archive.

Private `.signals/knowledge-owners.json` and `.signals/topics.json` use existing writer locks,
atomic replacement and private file modes, excluded from public assets. Limits: two readers,
100 topics, 100 members per topic, two million stored UTF8 bytes; failed validation/capacity
preserves the earlier file. Each foreign export allows ten million UTF8 bytes/5,000 records.
No recursive discovery, public admission or native generation occurs.

## Retain reference metadata

Attach a user-supplied bibliographic description to an exact currently selected topic member.
The full selection identity, including owner epoch, determines a stable `ref-<sha256>` ID.
Metadata hashes use UTF8 JSON with recursively sorted object keys, preserved array order, and no
spacing. Changed descriptions append immutable metadata revisions; equal canonical metadata is
an idempotent no-op. Topic revision checks govern edits, while removal of a member leaves its
metadata history detached and exportable.

```sh
npm run knowledge -- --root /private/signals-workspace reference-set TOPIC_UUID '{"revision":2,"selection":{},"metadata":{"type":"article","title":"A user-entered title","authors":[{"family":"Lovelace","given":"Ada"}],"year":1843,"doi":"10.1234/example.1","url":"https://example.org/paper"}}'
npm run knowledge -- --root /private/signals-workspace references TOPIC_UUID
npm run knowledge -- --root /private/signals-workspace references-export TOPIC_UUID '{"revision":3,"reference_ids":["REFERENCE_ID_FROM_REFERENCES"]}'
```

Replace the selection placeholder with the complete selected owner identity. Metadata is closed
to `article|book|webpage|report`, title, optional author names, year, container, publisher, DOI,
and HTTP(S) URL. These values are user descriptions, not verified bibliography; Signals does not
look up DOI/URL metadata. `references` returns current rows and a separate selected/changed/missing/
unavailable/detached availability list. Export preserves the caller's chosen ID order and returns
only `{schema:"signals.reference-list.v1",topic,references}`. It may describe a detached historic
selection and does not validate the source's currentness or include its body. Each topic retains up
to 100 references and 32 metadata versions per reference under the existing two MiB topic-store
limit; overflow refuses the whole write without truncating history. These owner commands add no
HTTP route or automatic provider/publication path.

## Record project relevance for a topic

Use [project-topic relevance](project-topic-relevance.md) to retain a human judgment about
one exact topic revision for one connected project's declared purpose and optional saved
opportunity. The immutable review can cite an exact source-change review as context, but
Signals does not decide whether that change affects the project. A changed topic, project
purpose or constraint, opportunity, or selected source identity is surfaced for review;
the prior judgment stays readable and is not silently transferred.

## Save, triage and freeze a query

Smart collections save a bounded text query with optional explicit owners, result kinds,
inclusive timezone-qualified update bounds, triage state and a maximum of 100 results.
Empty owner/kind selections include the supported owners/kinds. Rerun a saved collection to
see current native Library and configured export results; each run reports owner coverage,
frozen-export timestamps and whether the retrieval or result cap may omit matches. Unknown
timestamps remain visible as `date_status: "unknown"`, including when date bounds are active.
Search ordering is retrieval rank, not evidence quality. Each result retains its full
owner/store/epoch/kind/ID/revision/digest identity.
Kind filters use exact owner-reference kinds (`entity`, `lead`, `answer`, `imported_answer`,
`research_note`, `decision`, `review`, `reflection`, `principle`, `study-session`), not
the entity's descriptive category.

```sh
npm run smart-collections -- --root /private/signals-workspace create '{"operation_id":"CALLER_UUID","name":"Rollout decisions","query":{"text":"rollout","owners":["signals-ai","planning-ai"],"kinds":["lead","decision"],"updated_after":"2026-01-01T00:00:00Z","triage":"all","limit":50}}'
npm run smart-collections -- --root /private/signals-workspace run COLLECTION_UUID
npm run smart-collections -- --root /private/signals-workspace triage COLLECTION_UUID '{"operation_id":"CALLER_UUID","revision":1,"digest":"QUERY_DIGEST","changes":[{"selection":{},"state":"dismiss","reason":"Not the decision I need."}]}'
npm run smart-collections -- --root /private/signals-workspace freeze COLLECTION_UUID '{"operation_id":"CALLER_UUID","revision":1,"digest":"QUERY_DIGEST","name":"Reviewed rollout choices","selections":[{}],"questions":["What changed?"]}'
```

Replace each `{}` selection placeholder with the complete `selection` object returned by
`run`, including its owner, store instance, epoch where applicable, kind, record ID,
revision and digest.

Triage is reversible metadata tied to exact result versions; a changed record begins
unreviewed. The complete selected set is validated before any verdict is stored. Freezing
creates an ordinary topic with only explicitly selected current references, the saved name
and questions, exact qualification, and a collection revision/digest plus owner-coverage
snapshot. It copies no foreign content. Collection creation, edits, triage and freeze use
caller UUID idempotency keys; edits and triage use the current revision/digest. Changed
retries conflict, while uncertain same-meaning operations reopen their original result.
Private state is bounded under `.signals/` and uses the existing writer lock and atomic
replacement. Owner configuration remains operator-only; no provider calls are made.

## HTTP consumers

Use [provider instance/epoch headers](provider-interface.md) on every route below. Existing
loopback Host/origin guards apply; POST also requires JSON and `x-signals-token`. Reader
configuration stays CLI only; `GET knowledge/owners` returns redacted owner/instance status.

| Route                                        | Shape                                                                                                                                                |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET provider/knowledge?q=TEXT&limit=1..100` | `{schema_version:"1.0",records:[{selection,title,summary,updated_at,qualification}],owner_coverage:[{owner,state,observed_at,export_as_of,reason}]}` |
| `POST knowledge/record`                      | `{selection}` → `{selection,content,content_type,export_as_of}`                                                                                      |
| `GET topics`                                 | `{topics:[Topic]}`                                                                                                                                   |
| `POST topics`                                | `{name}` → Topic                                                                                                                                     |
| `GET topics/UUID`                            | `{topic,statuses:[{selection,state,reason,current_ref,export_as_of}]}`                                                                               |
| `POST topics/UUID`                           | Update body above → Topic                                                                                                                            |
| `GET topics/UUID/graph`                      | `{schema_version,topic,nodes,edges,impacts,qualifications}`; read-only owner-derived projection                                                      |
| `GET topics/UUID/references`                 | Current retained metadata rows and separate availability                                                                                             |
| `POST topics/UUID/references`                | `{revision,selection,metadata}` → exact member metadata/history update                                                                               |
| `POST topics/UUID/references/export`         | `{revision,reference_ids}` → `signals.reference-list.v1`, only explicitly selected metadata                                                          |
| `GET topics/UUID/export`                     | `{content_type:"text/markdown",content}`                                                                                                             |
| `GET smart-collections`                      | `{collections:[SavedCollection]}`                                                                                                                    |
| `POST smart-collections`                     | `{operation_id,name,query}` → `{collection,operation_replayed}`                                                                                      |
| `GET smart-collections/UUID`                 | `{collection}`                                                                                                                                       |
| `POST smart-collections/UUID`                | `{operation_id,revision,name,query}` → `{collection,operation_replayed}`                                                                             |
| `GET smart-collections/UUID/run`             | `{collection,records,owner_coverage,partial,date_window,retrieval_note}`                                                                             |
| `POST smart-collections/UUID/triage`         | `{operation_id,revision,digest,changes:[{selection,state,reason?}]}`                                                                                 |
| `POST smart-collections/UUID/freeze`         | `{operation_id,revision,digest,name,selections,questions}` → `{topic,operation_replayed}`                                                            |

Topic: `{id,name,revision,created_at,updated_at,members,links,questions,collection_snapshot?}`;
members are frozen search summaries. Errors have bounded code/reason without private paths.
Provider operations add `read_smart_collections`, `save_smart_collection`,
`triage_smart_collection`, and `freeze_smart_collection`; availability grants no authority.

Producer envelope: `{schema_version:"1.0",owner,instance_id,exported_at?,source_revision?,freshness?,records}`.
Records: `{ref,title,summary,updated_at,qualification,content}`. Content is deterministic native
JSON; digest is SHA256 UTF8 content; revision `sha256:<digest>`. Kinds: Planning
`decision|review|reflection`, Principles `principle|study-session`. Extra fields, duplicate
identities, wrong owner/store, unknown kinds and invalid content produce unavailable coverage.
