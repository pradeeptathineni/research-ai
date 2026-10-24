# CSV to typed table

`importTableCsv(csv, { parserRoot, label })` parses UTF-8 content already
provided by the caller. `csv` may be a string or `Uint8Array`; `parserRoot` is
an absolute package directory from trusted host configuration, and `label` is
a short display name with path separators refused. Neither a file path nor a
URL is accepted as CSV content. The operation does not read files, acquire
records, call a provider, or persist the import.

The host must provide the qualified optional `csv-parse` 7.0.3 package at
`parserRoot`. Research verifies its package name, exact version, and MIT
license before dynamically loading `lib/sync.js`. This dependency is not added
to the package's runtime dependencies and no parser code is copied into this
package.

The parser uses fixed options: UTF-8, BOM-aware parsing, first row as headers,
no casting, no skipped empty lines or malformed records, strict quote/column
counts, and a 64 KiB maximum record size. Options are not request-controlled.
Header values must be unique, nonempty, plain text and no longer than 120
characters. There may be at most 16 columns and 1,000 data rows. CSV input is
capped at exactly 1,000,000 UTF-8 bytes; input which exceeds a limit is refused,
never truncated. Header validation happens on the first parser record and the
row cap rejects from the parser record callback before an over-limit row is
retained. The canonical table representation must also fit Research's
1,000,000-byte table cap; JSON escaping can expand it, in which case
registration refuses it.

All imported columns and values have type `text`. Numeric-looking cells and
formula-like strings remain literal; formulas are never evaluated. Empty CSV
cells become the empty string. A consumer may later let a user explicitly
choose a type before analysis. A source label does not establish provenance or
truth: imported tables use `origin.type: "caller-supplied"`, while direct
typed tables may still use `caller-authored`.

The result is `{ table, import }`. Its import receipt binds the exact raw UTF-8
bytes as `csv_sha256` (including a supplied BOM), the canonical registered
table as `table_sha256`, parser identity, first-row header policy, and text-only
value policy. `table_sha256` matches `table.sha256` at import time. If a
consumer edits the table, it must register the edited table again and treat
the prior import binding as historical; the CSV digest does not follow later
table edits.

The `research-table-csv --parser-root ABSOLUTE_PATH --label DISPLAY_LABEL`
command reads CSV bytes only from stdin and emits `{table, import}` JSON. It
does not accept input or output filenames. Use it only with a host-configured
parser path. It exits 0 on success and 1 for invalid input, missing parser, or
limit errors.
