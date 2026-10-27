# Offline notebook source and note search

`searchResearchNotebooks` searches only the validated notebooks explicitly
passed by the caller. A fresh in-memory MiniSearch 7.2.0 index covers complete
retained source pages and, by default, each note's latest version. Choose
`noteVersions: "all"` to search retained historical versions. Notebook
questions and answers are not indexed implicitly.

```js
import { searchResearchNotebooks, openNotebookSearchHit } from "@pradeeptathineni/research-ai";

const result = searchResearchNotebooks([notebook], "battery cycle", {
  mode: "fuzzy", kinds: ["document", "note"], noteVersions: "latest", limit: 20,
});
const opened = openNotebookSearchHit([notebook], result, result.hits[0].id);
// `opened.source` is the exact original page or note version behind the hit.
```

Modes are `exact` (default), `prefix`, and bounded `fuzzy` (0.2); terms are
combined with OR using a fixed Unicode letter/number tokenizer. Search scores
rank lexical relevance only. They do not express truth, confidence, entailment,
currentness, or source independence. Note titles are visibly prefixed
`Unverified note:` because every note, including human-authored notes, is
unverified content.

Every result is closed, versioned, digest-bound data. Hits identify an exact
source page or note version. Match offsets are UTF-16 ranges into the original
title or text; occurrence lists are capped at 64 per hit and report omissions.
The excerpt is at most 600 UTF-16 units. A title-only match has no fabricated
body range. `openNotebookSearchHit` validates the result and replays it against
the same notebook states before returning the retained original. Changed,
tampered, or stale input refuses; the function never substitutes a newer note.

The CLI reads one JSON request from stdin and writes JSON to stdout:

```sh
research-notebook-search --action search <<'JSON'
{"notebooks":[{"...":"validated notebook state"}],"query":"battery cycle"}
JSON
```

For `--action open`, provide `notebooks`, a complete returned `result`, and
`hitId`. The CLI has no file path or URL input and creates no durable index.
Both actions work offline in fresh processes without provider configuration.

The notebook state validator remains the owner of source and note integrity.
Search allows at most 8 notebooks, 8,000 indexed records, 4,000,000 combined
UTF-16 title/text units, 200 query units, 50 returned hits, 64 reported ranges
per hit, and a 600-unit excerpt. These conservative caps cause refusal; no
pages or notes are silently dropped. Results do not expand question scope: a
consumer must explicitly choose a hit before preparing a question.

## Reuse and limits

The shipped lexical engine is copied intact from MiniSearch 7.2.0 under its
MIT license. The source/note discovery workflow and explicit scope are
independently reproduced from concepts in `lfnovo/open-notebook`, pinned at
`a0f6f3081ae06328f0a451b3a3ef2959ca25721d`; no donor code or schema is copied.
See [`src/notebook-search-NOTICE.txt`](../src/notebook-search-NOTICE.txt) and
[`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md). Vector/semantic search,
provider calls, persistence, acquisition, and UI are outside this owner.

## Frozen retrieval arm export

`exportResearchRetrievalArm(notebooks, questions, { mode, researchRevision })`
exports one exact, prefix, or fuzzy lexical arm for offline comparison. Supply
the exact validated notebook corpus, an ordered list of unique `{ id, text }`
questions, and the pinned Research revision string. Run it once per mode, then
combine the returned `corpus`, `questions`, and `arm` objects in the Sandbox
retrieval comparison input. Its shape uses Sandbox's `corpus.source_ids`,
question IDs, provenance, and per-question ordered `rankings` fields.

The corpus contains every selected retained document page and every retained
note version. Stable `notebook-hit-…` IDs identify these records; a canonical
SHA-256 over the ordered IDs and exact record hashes forms `corpus.id`. Thus
changing only the retrieval mode preserves corpus identity, while changing a
page or note-version hash changes it. `corpus.sources` maps each hit ID to the
exact selected notebook, source or note record, page or note version, title,
and retained content hash. It contains no page or note body and no data from
unselected notebooks. Each question returns all matching hits
up to the existing 50-hit search bound; an over-bound ranking is refused.
Question lists are limited to 32, and the existing notebook count, record, text,
and query limits apply. No query expansion, model, network, judgment, ground
truth, or metric is involved. This is a producer arm, not a comparison result;
the caller and Sandbox own evaluation.
