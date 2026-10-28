# Public knowledge records

`signals/entities/*.json` contains reusable native entities. `signals/<type>/*.json` contains reviewed historical findings. Both are canonical public knowledge; browser indexes, interchange downloads and Pages are generated under `dist/`.

Native entities use stable URI identities independent of kind, name or question. They retain immutable source evidence, model observations and a declared assessment policy. Active native brief v5 selects `signal-strength-v8`; earlier policies retain their original meaning. Query relevance, project decisions, personal notes and saved question context belong outside public entities.

Historical type folders provide one level of organization. Domain/category and concept tags are metadata rather than duplicate directory trees. One historical finding may compare several options from shared sources. Its `signal-review-v1` admission requires a separately attributed review with every relevance, evidence, usefulness and clarity rating at least 3/4 and no fatal blocker or unresolved material claim.

Humans ask questions; agents acquire sources and construct assessments. Native automatic admission requires supported defining evidence, resolved identity, direct relevance and the configured intrinsic strength threshold. Private manual saving can retain unassessed leads. Saving and publication are separate operations.

Evidence digests verify bytes, not truth. Corrections append native judgment successors or create newly reviewed historical finding identities. Frozen source dates and first-fetch bytes do not change when reviewed. `review.state: withdrawn` excludes historical options from default results while preserving their exact downloads and history.

Keep private questions, annotations, raw acquisition and retained local history under ignored `.signals/`. Unknown files/fields, duplicate keys, ambiguous identities, private extensions and incomplete reviews fail public validation. See the [assessment contract](../docs/signals-contract.md) and [data map](../docs/architecture/schema.md).
