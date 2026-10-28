# Reproducible table analysis

`createAnalysis` creates an immutable analysis revision over exact registered
table identities. Ordered steps are SELECT bodies over the chosen tables and
earlier steps (`s1` through `s6`). `compileStep` expands the selected prefix to
one owner-compiled CTE SELECT. Row inspection is limited to 1,000 rows; profile
inspection runs a separate full-population `count(*)` plus per-column counts
for the columns supplied from a completed rows result (at most 31 null counts).
The profile returns counts as decimal text. It makes no inference about source
quality.

The first slice accepts no parameters, semicolons, comments, backtick/bracket
quoting, mutation or DDL tokens, dynamic query functions, file-reading
functions, or sequence/state-changing functions. A best-effort lexical scan
checks tokens throughout nested subqueries and CTEs, while respecting
single-quoted strings and double-quoted identifiers. It is layered over the
disposable in-memory worker, whose existing settings disable external access
and extension loading. The scan is not a formally complete SQL parser or an
operating-system sandbox. The direct table-query API is unchanged and retains
its existing behavior; notebook SQL always passes this owner admission first.

An actual-owner check with the installed DuckDB 2.0.0-r.1 binding confirmed that
`WITH ... SELECT` succeeds and a trailing second statement fails. It also found
that DuckDB accepts `WITH ... AS (DELETE ... RETURNING ...) SELECT ...`; the
notebook admission therefore rejects such mutation tokens before `queryTables`
is called. Native runtime qualification remains platform-specific.

Chart SQL is compiled by the owner after a completed step supplies its result
column schema. Bar and line charts require explicit aggregation in this slice;
bar x must be text, boolean or temporal, line x must be numeric or temporal,
and y must have a safely numeric representation. Exact integer and decimal
values stay strings in result artifacts and exports; the chart points retain
their exact text for tooltips. Series are limited to eight observed categories.
Scatter plots show co-occurrence only and are capped at 1,000 points.

`buildAnalysisRun` stores exact query and result digests plus explicit failed or
unknown outcomes. `validateAnalysisRun` and `exportAnalysisBundle` are cold:
they verify saved artifacts and do not run SQL. Without the original registered
tables, validation checks result and query integrity plus the embedded source
IDs and hashes; failed or unknown stage records have no full result artifact,
so their input digest can be rebound only when the original tables are supplied.
The JSON bundle is capped at 4 MB and excludes source rows. Use
`node bin/research-table-notebook.mjs` with
`validate`, `preview`, `validate-run`, or `export`; each reads one JSON payload
from stdin and writes deterministic JSON or the bundle to stdout.

This module composes the existing `prepareTableQuery`, `queryTables`, and
`validateTableQueryResult` APIs and the pinned DuckDB binding. It adds no SQL
engine, data acquisition, persistence, external reads, confidence score, or
automatic rerun.
