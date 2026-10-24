# Registered-table analysis

`registerTable(table)` accepts a closed `research-table-v1` object with a
caller-authored label, typed columns, and primitive rows. It validates the
shape and limits, computes SHA-256 over canonical JSON, and returns a frozen
copy with that digest. It does not read or verify external sources.

`analyzeTable(registered, query, { engineRoot, signal, timeoutMs })` supports
`count`, `sum`, `avg`, `min`, and `max`, optional grouping, and one typed
equality filter. It accepts no SQL or paths in the query. `engineRoot` is an
absolute package directory supplied by trusted host configuration; never pass
it from a request. The optional worker requires `@duckdb/node-api` 2.0.0-r.1
and matching native bindings. The package has no DuckDB runtime dependency.

The worker creates an in-memory database, uses generated column identifiers
and parameterized input values, and verifies external access and extension
install/autoload are disabled, one thread is configured, memory is limited to
64 MB (reported by DuckDB as 61.0 MiB), and the temporary-disk byte limit is
zero. It starts as a separate process, accepts at most 1,000 rows, 16 columns,
and 1,000,000 bytes of canonical input,
returns no more than 1,000 groups, and is stopped at a maximum two-second
deadline plus a bounded 300 ms cleanup grace. A timeout or abort returns
`status: "unknown"`; the API waits up to that cleanup grace for worker exit and reports
`worker_cleanup_unconfirmed` if its process group may remain. A result is
ephemeral and is never persisted by this module.

Result values preserve nulls and primitive types. The current 1,000-row cap
keeps count results within JavaScript's safe integer range. Sum and average
use DuckDB floating-point arithmetic and the result says so; non-finite or
unsafe integer-valued floating results are refused. These are arithmetic
summaries of supplied values, not sourced evidence or truth judgments.

The implementation was exercised with DuckDB Node API 2.0.0-r.1 and the
Darwin x64 native binding from the official npm registry. Both are MIT
licensed. No DuckDB code or native binary is included in this package. Other
operating systems and architectures require separate qualification.

The `research-table-analysis --engine-root ABSOLUTE_PATH` CLI reads one JSON
object `{ "table": ..., "query": ... }` from stdin and writes one result JSON
to stdout. The engine path is host configuration, not request content. It exits
0 for a complete result, 1 for a failure, and 2 for an unknown result.
