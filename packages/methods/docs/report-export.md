# Portable report export

`exportReportHtml(report)` validates a `research-report-v1` value, then returns a
deterministic self-contained HTML report. It exports only each section's current
revision, or its original outline content when no revision exists. Earlier
versions and attempts are not shown as current. Unwritten sections and recorded
gaps remain visible.

Both Markdown and HTML include a revision-bound review register of current
validated citation spans and saved unresolved gaps. Span matching confirms
occurrence only; it does not establish entailment or truth. JSON remains the
complete validated report state.

Each current citation links to a retained source span containing the exact quote,
URI as plain text, source SHA-256, UTF-16 offsets and caller observation or
omission notes. Repeated citations share a span when source URI, content digest
and offsets match. The report includes the retained report revision, parent hash
and a digest of the validated state. Those identifiers detect changes; they do
not authenticate an author or verify a claim.

The HTML embeds its stylesheet and has a restrictive content security policy.
It makes no network requests and loads no scripts, images or remote fonts. Text
and URIs are escaped. Open the file in a browser and use its Print command to
save a PDF. This uses the installed browser's print support; it is not a native
PDF or DOCX export engine.

The standalone CLI reads one explicit UTF-8 JSON file (up to 1 MiB), rejects
duplicate JSON object keys, validates the report and writes HTML to stdout:

```sh
node bin/research-report-export.mjs --input report.json > report.html
```

For a create-only output file, use `--output`. Existing paths and symlinks are
refused; remove or rename a file yourself before exporting again:

```sh
node bin/research-report-export.mjs --input report.json --output new-report.html
```

The output is capped at 8 MiB. The command exits 0 on success and 1 on input,
validation, size or write errors. No provider call occurs.

The export stylesheet adapts the donor's print typography, spacing and
blockquote style, using local system fonts. The citation renderer and offline
HTML policy are specific to this report format. The adjacent
`src/report-export-NOTICE.txt` contains the required Apache-2.0 license and
source pin.
