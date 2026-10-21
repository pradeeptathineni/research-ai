# 0.3.0-rc.1 local candidate compatibility

This is a local pre-1 candidate, not a published release or a registry reservation.
The preceding package version was 0.2.0. The accepted producer checkpoint is
`9edd19e2ab55333f498277ceecc97364f3deecc5`; this package change preserves its
runtime code and declarations. Runtime dependencies remain zero, with no build.

## Required cleanup boundary

`SessionOutcome.cleanup` and `ResearchResult.receipt.cleanup` are required:

```ts
{ complete: boolean; error: "process_group_cleanup_failed" | null }
```

This required field is a compatibility boundary, not an unqualified additive
change. A complete outcome requires confirmed cleanup as well as successful
terminal evidence, a clean exit and readable final text. `sessionCompleted`
returns false when cleanup is absent or unconfirmed. Old manually constructed
TypeScript outcomes must supply evidence for this field; a cast or a fabricated
`complete: true` does not establish cleanup.

Historical saved receipts without cleanup may remain readable and retain their
original bytes and historical status. Their execution cleanup is **unconfirmed**;
do not promote them to current complete execution evidence or silently rewrite
them. A consumer can display an explicit historical/unconfirmed annotation
without changing the saved receipt. Signals owns that reader and its migration.

A returned promise is not always a process-death barrier. If cleanup is denied
or group absence cannot be confirmed within the bound, the outcome remains
non-complete and its lease/workspace are retained for inspection. Exit code and
signal may both be null while a leader is alive. Preserve protocol cause,
termination trigger/exit, partial answer and cleanup independently. A later exit
does not rewrite returned evidence or release retained ownership. Never delete
an unknown lease as a migration step.

## Consumer and rollback gate

The current Signals archive pin remains
`b8a7b068dd4aacd3916e04647b9eaf5b13d0a4de` (Research 0.1.0).
This unit changes no consumer pin, lock or schema. Preserve that pin and the
accepted producer checkpoint for rollback. S01 must qualify actual answer-first,
assessment and frozen callers, literal fallback, historical reading and result
mapping against the exact candidate archive before adopting it. The producer
package fixture is not composed Signals acceptance.

The offline package gate exercises an extracted local archive using its installed
CLI bin, package-name ESM exports and actual TypeScript compiler. It checks
Unicode/newline fidelity, CLI complete/partial/failed exits 0/2/1, frozen-source
SHA-256, cause/exit/count/model/effort/unknown-usage receipts, required cleanup,
and owned POSIX process groups at the lease-release boundary. The CLI appends one
newline to a nonempty answer; the API returns the original answer bytes.

Fake version/login/help observations establish advertised support in that
fixture only. They do not qualify real native permissions, provider behavior,
account/model access, funding, research quality, Windows, or escaped process
groups. No native provider was invoked for this package qualification. Runtime
Node support is `>=24.19.0 <25`; pinned compiler/types are development tooling,
not part of the shipped runtime.
