# Bibliographies from retained references

`validateReferenceList` checks the closed `signals.reference-list.v1` export,
selection-derived reference IDs, metadata hashes and the supported metadata
subset. Missing author, year, DOI and URL fields stay missing. The descriptions
are user supplied and unverified; validation does not establish truth, source
identity or entailment.

`formatBibliography(list, { format })` emits plain text, a deliberately small
BibTeX subset or CSL-JSON. The CSL output uses mappings for article, book,
webpage and report. It is not a full CSL processor and makes no APA/MLA claim.
BibTeX output escapes control syntax and keeps Unicode; it does not execute raw
TeX. No dependency or network access is used.

`exportReportWithReferences(report, list, bindings)` takes explicit
`{ source, reference_id }` bindings to the report's frozen source indices. Each
source index may be bound once; IDs and indices are checked. The standalone
HTML keeps the existing exact source URI, hash, quote, citation spans and gaps,
then adds a separately hashed bibliography and labels associations
user-assigned and unverified. That digest covers the report state digest,
source URI and hash for each binding, each selected reference row, and its
explicit source-to-reference association. Swapping bindings changes the
bibliography digest while leaving report evidence unchanged. It includes no
remote assets or scripts.

```sh
node bin/research-bibliography.mjs --input references.json --format bibtex
node bin/research-bibliography.mjs --input references.json --report report.json --bindings bindings.json
```

Inputs are explicitly named regular UTF-8 JSON files up to 1 MiB and output is
written to stdout for caller-controlled redirection. IDs never become paths.
