# Query retained datasets

Use `prepareTableQuery(tables, query)` to inspect the selected datasets and their
column mapping. `queryTables(tables, query, {engineRoot})` runs one parsed SELECT
in the existing optional DuckDB binding, `@duckdb/node-api` 2.0.0-r.1 with matching
native bindings. The host supplies its absolute package root; no package is
installed, model called or source acquired. The existing registered-table API and
CSV importer provide inputs without changing their semantics.

```js
const tables = [{name: 'projects', table: projectTable}, {name: 'trials', table: trialTable}];
const query = {
  sql: `SELECT p._row AS project_row, t._row AS trial_row,
               p.c0 AS project, t.c1 AS latency,
               ROW_NUMBER() OVER (ORDER BY p.c0) AS rank
        FROM projects p LEFT JOIN trials t ON p.c0=t.c0
        WHERE p.c1 >= ? ORDER BY p.c0`,
  parameters: [10],
};
const preview = prepareTableQuery(tables, query);
const result = await queryTables(tables, query, {engineRoot});
```

A binding is `{name,table}` where `table` is a complete `registerTable` result.
Names are unique lowercase identifiers of at most 32 characters. The engine sees
columns `c0`, `c1`, etc., in source order, plus `_row`, a zero-based source row
ordinal. `preview.inputs` supplies `{name,id,sha256,row_count,row_column,origin,
columns}`; each column retains its original `{id,label,type}` and adds `sql_name`.
Use that mapping rather than guessing a label is an identifier. Imported CSV
values remain text; explicit SQL casts may fail rather than silently correct data.
Duplicate join keys can multiply rows, null join keys follow SQL semantics, and
an outer join preserves missing matches as nulls. No confidence score is computed.

The result contains exact input/query digests, engine/native versions, columns,
primitive rows, qualifications and a digest of its complete content. Integer SQL
types that exceed 32 bits use `integer-string`; decimals use `decimal-string`,
retaining exact native text. Floating results use finite, safe JavaScript numbers
and can round decimal arithmetic. Unsafe integer-valued floating results and
non-finite results are refused. Temporal values are strings. Unsupported nested,
BLOB or other rich result types refuse the result; cast explicitly to an intended
scalar type if appropriate. SQL column labels are retained with unique `q0`, `q1`
IDs. Source/query identity is not proof of source truth, entailment or arithmetic
correctness. Provenance binds the selected datasets and query, without inferring
per-result row or cell lineage. Select `_row` explicitly when linking source rows.

## Read-only execution and limits

The engine parses the query, requires exactly one statement, prepares it and
requires the native SELECT classification. Parameters are bound through the
native API. No hand-written SQL parser is used. Settings are checked: external
access and extension installation/autoload are off, one thread, 64 MB memory, zero
disk spill. Configuration is locked before user query preparation. Source values
are inserted through parameters; table/column identifiers are owned and bounded.
The worker uses an in-memory database and a minimal environment, not project
scripts or an operating-system security sandbox. Trusted engine binaries retain
normal process privileges; the engine's configuration is the data-access boundary.

Limits: four tables, each retaining the existing 1,000-row/16-column bound,
2,000,000 combined input bytes, 8,000 SQL UTF-16 units, 32 parameters (strings up to
4,096 units), 1,000 output rows, 32 result columns and 2,000,000 result bytes. A
worker has at most 2,000 ms plus 300 ms cleanup grace, 64 MB native database memory and
a 128 MB Node heap. An over-limit result is refused whole, never presented as a
complete prefix. Timeout/abort returns `unknown` with no partial rows; unconfirmed
cleanup has its own reason. Query/setup failures return `failed` with a bounded
machine error. No automatic retry occurs.

Use explicit `ORDER BY` for stable ordering. Volatile functions such as random
values or current time can change on a new run; a request digest is not a promise
of identical future output.

## Retain and reopen

Research is ephemeral. A consumer may keep the selected registered tables, exact
query and completed result in its private journal. `validateTableQueryResult`
checks the closed artifact shape, declared input/query bindings and result digest
without starting an engine. Supply `{tables: originalBindings}` to also revalidate
the complete original registered tables against the recorded inputs. Reopening
must call this validator, never rerun the SELECT. No file path is part of the API.

Integrity hashes do not authenticate who produced an imported artifact or verify
its conclusions. A consumer accepting exports must distinguish an imported
assertion from a result captured from its own actual owner execution. The first
Deep journal can restrict admission to its server-captured owner outputs. A
changed source, query or result is a new artifact, not a rewrite of the old one.

## CLI

`research-table-query --preview` reads `{tables,query}` JSON from stdin and emits
the preview. `research-table-query --engine-root ABSOLUTE_PACKAGE_PATH` runs the
query. Both read only supplied stdin, with no filename/URL acquisition. Exit 0
means preview/complete, 1 failed/invalid input and 2 unknown. `--help` needs no
engine. For a checkout use `node bin/research-table-query.mjs`.

This integrates the installed official DuckDB package intact (MIT; package and
native-binding licenses retained with their distributions). No DuckDB source is
copied into Research. Existing owned table-analysis settings and worker lifecycle
methods are reused in new code; the old aggregate API/worker remain unchanged.
Runtime qualification uses synthetic tables and the actual installed Darwin x64
binding, not fixture-generated SQL answers. Other native platforms require their
own binding qualification.
