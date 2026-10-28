# Signals AI

Signals researches questions, explains worthwhile findings, and retains knowledge for personal interests and projects. The Library combines saved native entities and reviewed historical findings. Your AI supplies interpretation; code checks evidence bindings, computes versioned scores, and preserves portable records.

The local workspace opens on Home with retained discoveries and recent searches. Search offers Library, Online and Combined scopes. Projects connects selected repository or folder snapshots to findings. Following manages interests and sources. The [public Corpus](https://pradeeptathineni.github.io/signals-ai/) is a read-only view of approved public records.

## Start locally

Use Node 24.19 or later in the Node 24 series and npm 12.1 or later in the npm 12 series.

```sh
npm ci
npm run build
npm run start
```

Open [the workbench](http://127.0.0.1:5178/signals-ai/). Browsing saved knowledge starts no research or source scan. For development, use `npm run dev`.

Other installed applications can use the [local provider interface](docs/provider-interface.md) to negotiate owner capabilities and read exact retained records over loopback HTTP, without sibling source imports. Native readiness and permission to start research remain separate.

[Connected knowledge](docs/connected-knowledge.md) adds explicit Planning/Principles export readers and private named topics. Search across retained owners, select exact records, keep links and open questions, then reopen after restart with visible changed, missing or unavailable source status. [Project-topic relevance](docs/project-topic-relevance.md) records a human judgment against exact topic and project versions. These deterministic operations require no model service.

[Opportunity briefs](docs/project-opportunity-brief.md) retain a human-authored opportunity plan inside an existing project opportunity, bound to exact topic, project, relevance and evidence references. Source currentness remains separate from human confidence.

Library returns immediate phrase, prefix and typo matches over retained metadata. In Settings → Personal Library, you can permit one no-web meaning match per submitted question. Its disclosure lists the metadata sent to your authenticated AI host; notes, projects, source text and credentials are excluded. Literal results remain available if matching is disabled, unavailable or cancelled. Public Pages uses literal retrieval only.

```sh
npm run research -- library-query 'remembered purpose'
npm run research -- library-query 'remembered purpose' --public
```

## Research with your AI

The [signal-search skill](.meta/context/skills/signal-search/SKILL.md) uses the invoking AI's permitted search and reading tools without launching another AI. Ask an ordinary question; the agent creates the structured assessment. Other Agent Skills hosts can use the [same protocol](.meta/context/skills/signal-search/references/protocol.md).

Headless research uses an installed, authenticated Codex CLI through the first-party [`@pradeeptathineni/research-ai`](docs/dependencies.md) executor. That package also runs standalone ordinary research with no storage. Queries and selected evidence go to its configured provider; credentials stay with the CLI. Settings reports runner readiness and lets you select model, effort and research depth. Local control does not imply local inference.

```sh
npm run signal-search -- --capability
npm run signal-search -- --query 'Which research tools preserve portable data and provenance?' --profile wide --save never
npm run signal-search -- --query 'Describe this resource and its limits' --url https://example.com/resource --save never
npm run signal-search -- --query 'model context protocol' --sources-only
```

Research preserves the original answer even when individual record metadata fails validation. Results expose interpreted needs and constraints, evidence passages, source gaps, comparison, and follow-up over selected frozen evidence. Cancellation and configured acquisition limits apply throughout. Capture URL is user-seeded acquisition; a returned locator alone is an unassessed lead.

HTML source text is an inert DOM projection. Hidden or accessibility-marked content and inert script data can contain terms or conditions omitted from it. Results and frozen checks disclose that scope, including measured excluded-text counts where available. A complete normalized snapshot or a zero exclusion count does not prove complete source coverage. Historical material without these counters remains unmeasured. No scripts or interactions run to recover excluded content.

For offline inspection of an explicitly supplied `DocumentMaterial` JSON snapshot, use:

```sh
npm run material-preview -- list --snapshot material.json --offset 0 --windows 4
npm run material-preview -- select --snapshot material.json --sha256 TEXT_SHA256 --start START --end END
```

Replace the digest and range placeholders with values from the list output. Navigation windows are mechanical aids, not complete prose sections. Ranges use zero-based UTF16 positions in the exact normalized text, with start included and end excluded. Selections preserve the exact slice and report the full normalized digest, input-file digest, outside-range scope and extraction warnings. A stale digest, split surrogate pair or selection over48,000 units is refused. `--source-uri HTTPS_URL` adds only a validated caller label; it does not establish transport identity or freshness. Table coordinates stay original and cell geometry is omitted. The command fetches nothing and writes only stdout. Previews remain separate from claim checks and do not establish whole-source coverage, factual support or Signal.

`--profile quick` selects a smaller acquisition budget; `wide` selects the larger one. `--model` and `--effort` override runner references. Repeat `--source` to constrain source families or `--site HTTPS_URL` to add website/path scopes. Global and per-interest supplemental sites share a twenty-scope effective limit and the existing research budget. Access denial remains a gap.

`--save never --cache memory` requires no existing Corpus and creates no repository state; the AI host may retain its own logs. `--cache private` retains run history locally. `--context` exports frozen schema-v1 interchange with separate native assessment extensions. Explicit `--review` requests a bounded no-web reassessment over fetched material; ordinary research uses one native task. See [optional providers](docs/providers.md) for acquisition and extraction settings.

### Keep a native research answer

In the local workbench, a newly typed question starts with **Answer first; assess selected citations later**; a visible note says the answer is unassessed and its citations can be checked. **Research with evidence assessment** and **Check a proposition against primary sources** remain under Research options, and the method you select is kept for the rest of the session. Citation assessments, URL captures, primary checks and saved-question runs still request native research explicitly. The CLI, API, scheduler and saved-question defaults are unchanged: they use native research unless answer-first is requested, and earlier results are not migrated. The CLI exposes the same opt-in route:

```sh
npm run signal-search -- --query 'Your research question' --method answer-first --cache private --save never
```

Within Answer first, **Suggest a few decision-critical checks (unverified)** optionally offers up to three editable hypotheses in the same answer session. It performs no checks automatically. The CLI adds `--suggest-checks`; ordinary answer-first keeps its plain-answer prompt. Suggestions should concern currently identified resources that cited material can resolve; missing user requirements remain questions. Malformed suggestion metadata is omitted while a valid complete answer remains available for manual selection. Private history retains a bounded diagnostic of the parsed rejected suggestion field, with explicit omissions or missing payload; this does not capture runner output or reasoning. Confidence stays Unknown; the whole answer and whole-item Signal remain unassessed.

Each explicit suggestion check uses its own retained answer and original cited URLs through the existing linked checker. The private history preserves the ordered offered list and records the submitted proposition, including edits. For a CLI linked selection, supply `--assessment-of RUN_ID --claim 'Edited proposition' --url ORIGINAL_CITATION --suggestion-index INDEX --offered-digest DIGEST --profile quick --cache private`; the index starts at zero and the digest comes from that answer's `checkSuggestions`. Nominations and their rationale are unverified metadata, not primary evidence or source independence. A memory-only answer is not silently saved to enable linked checks; an already retained private parent is required.

Without suggestions, this uses one authenticated Codex session to obtain ordinary Markdown without the assessment schema. The complete answer appears before citation assessment, with **Confidence Unknown** and an explicit unassessed state. Private Library indexes the entire answer locally; reopen it from Library or Activity and discuss a selected answer as prior synthesis. Whole answer text is excluded from remote meaning-match metadata. Automatic public admission is unavailable on this route. Select **Assess this citation** to obtain a separate source-grounded assessment linked to the immutable answer. Assessing does not rewrite the earlier narrative. This route has no demonstrated research-quality or speed advantage yet.

For a narrower check, enter a **Proposition to check** and select its citation. The same route is available in the CLI:

```sh
npm run signal-search -- --query 'Original question' --assessment-of ANSWER_RUN_UUID --url https://example.org/primary --claim 'The exact proposition to check' --profile quick --cache private --save never
```

This checks one proposition against one or two selected cited sources, with no broad discovery or scoring. When no selected primary text is usable, the check returns an acquisition outcome without inference. Missing-source gaps remain visible when other selected text is reviewed. One frozen native review may return supported, contradicted or uncertain; matched quotes prove occurrence rather than entailment. The bounded text snapshot, original dates and negative/partial checks remain linked to the original answer. Confidence stays Unknown. `--cache memory` returns proof without saving history. A source access denial says nothing about the claim's truth or permission. This focused route has no measured quality or speed advantage yet.

For a proposition and primary URLs you supply directly, choose **Check a proposition against primary sources** in Online → Research options. Enter the exact proposition and one or two public HTTPS URLs, then select **Check primary sources**. The same opt-in route is available without creating a research answer in the CLI:

```sh
npm run signal-search -- --query 'The factual question' --claim-origin request --claim 'The exact proposition' --url https://example.org/primary --profile quick --cache private --save never
```

This acquires one or two selected primary documents before at most one frozen review. Acquisition failures, partial scope and Unknown confidence remain explicit. It creates no entity or numeric Signal. Direct checks preserve the question, context, proposition and selected URLs in their own request-origin receipt. Reopen private results from Activity. Linked answer checks keep their original citation and parent requirements. Direct history, including negative or incomplete checks, survives ordinary temporary-run cleanup. `--cache memory` creates no history or source-cache state. Historical source references, broad acquisition, enrichment and offline ingestion are unavailable on the direct route. A scoped verdict is not a full item assessment or installation permission. Comparative research quality, calibrated accuracy and human usefulness remain unmeasured. The `--context` entity-evidence export does not carry claim-check verdicts or snapshots and explicitly reports this omission. Inspect the original private receipt when making a scoped consumer decision.

You can also bring an ordinary Markdown answer from your AI into the Personal Library. This command preserves the original answer and observation time, lists its inline citations, and makes no model call:

```sh
npm run research-answer -- --query 'Your original question' --answer-file /path/to/answer.md --observed-at '2026-10-12T07:43:44.655Z' --root /path/to/private-library
```

Inspect that plan, then add `--retain` to save the answer privately. Repeat `--select HTTPS_URL` for each cited source you choose to retain as an unassessed lead. With no selected sources, only the answer is saved. The command reports saved paths and a recovery receipt; inspect any partial or uncertain outcome before explicitly trying again.

```sh
npm run research-answer -- --root /path/to/private-library --rediscover 'remembered source or purpose'
```

The private Library searches and reopens complete imported answers alongside selected leads, including earlier imports read in place without migration. This CLI rediscovery command searches selected saved leads. Repeated explicit saves preserve answer receipts and deduplicate normalized citation locators. Citation occurrence does not verify a claim; confidence, source publication date, license and access remain unknown. Neither import nor answer-first creates a public record. Answers are limited to 100,000 characters and the existing private byte budget; an oversized answer fails visibly rather than silently truncating. Selected-answer discussion passes complete answers within a disclosed discussion budget and reports omitted answers.

## Retain, compare and refresh

Manual personal saving accepts unassessed leads. Optional automatic personal saving is off by default and requires completed assessment, supported resolved identity, relevance at least 75 and the chosen Signal threshold, initially 75. Public inclusion and publication have separate review and owner boundaries. CLI `--save eligible` writes eligible public entities locally; it does not commit or push.

Cards distinguish intrinsic Signal, query relevance, contextual priority and saved state. Evidence strength is a versioned policy judgment, not probability or demonstrated usefulness. Native brief v7 uses `signal-strength-v10`; older records replay their declared numerical policies, while current admission retains unresolved decisive history across refresh formats. The [assessment contract](docs/signals-contract.md) defines these meanings.

Notes, feedback, dismissals, followed sources, inbox entries and saved question/interest associations remain private under `.signals/`. Personal novelty stays unknown until you supply feedback. A source scan records acquisition and newly exposed links; repeated scans do not invent discoveries or usefulness. Changed source content requires assessment before becoming a meaningful claim change. [Source change review](docs/source-change-review.md) compares retained versions and records explicit human impact decisions against exact saved confidence observations.

Primary checks and refresh target the selected card's public or private store. An ambiguous duplicate requires an explicit destination:

```sh
npm run signal-search -- --check-primary ENTITY_ID --destination private
npm run signal-search -- --query 'What do my retained findings establish?' --corpus-only
npm run discovery -- save-run RUN_ID ENTITY_ID
```

Primary checks use HTTP validators or content digests before inference. Unchanged material requires no model call and does not renew claims. Access failure preserves the last good record. Follow-ups stay within selected frozen evidence; explicitly research online when new evidence is needed.

Projects reads an explicitly selected public GitHub repository or local folder through bounded documentation/manifest previews. Inspect the source basis and edit constraints before registration or external research. Updates mark earlier opportunities stale; disconnect preserves findings and decisions. General project opportunities belong to Signals. AI setup requests are advisory input to Context, which owns equipment selection, permissions, pins, delivery and undo.

## Interests and jobs

Settings and Following manage editable interests, query lists, supplemental sites and followed feeds/pages. Setup adds starter interests without enabling recurrence. One-shot lists select enabled interests, or the IDs supplied after `--once`; `--limit` overrides the configured batch size.

```sh
npm run discovery -- setup
npm run discovery -- status
npm run discovery -- plan-list
npm run discovery -- run-list --once --limit 3 --profile quick
npm run discovery -- run-list --once --resume BATCH_UUID --limit 3
```

`setup-concepts` adds the checked-in Context research catalog as interests. Its source snapshot is research input, separate from AI authoring guidance. Compatible interests can share unassessed acquisition; their conclusions remain separate. `run-list --once --no-share` disables shared acquisition for that activation. Completed, failed, cancelled and uncertain attempts remain inspectable; resume processes pending questions.

To opt into due query research or saved-entity refresh:

```sh
npm run discovery -- enable query
npm run discovery -- enable corpus
npm run discovery -- run-due --once
npm run discovery -- timer
npm run discovery -- disable both
```

Due slots coalesce missed intervals, and a durable lease prevents cooperating overlap. Completed slots replay without inference. Interrupted paid attempts become uncertain; inspect them before explicitly using `retry JOB_KEY`. The timer works only while its process and laptop are awake and registers no OS timer.

Publication defaults to local-only. `npm run discovery -- publish` performs an explicit reviewed Git commit/push from a clean, verified checkout. Unattended publication requires an explicit setting and uses the same Pages CI.

## Inspect and develop

```sh
npm run corpus -- check
npm run corpus -- search '--query=water meter' --category=Household
npm run research -- library-query 'How can I recover verbose test output?'
npm run verify
```

`library-query` reads the unified current collection with the same literal matching and optional metadata-only meaning matching as the workspace. `corpus search` inspects historical-format public records with exact type/category/concept/sourceClass/freshness/disposition filters and literal text. Its former `--textMode=ranked` mode is removed; `library-query QUESTION --public` provides unified public ranking with Library preferences, rather than the historical exact filters. `signal-search --corpus-only` selects eligible retained facts with the same Library lexical rules over titles and fact text, and states when nothing matched. `corpus digest FILE.json` checks frozen evidence encoding. `research admit DRAFT.json TYPE` validates and admits a reviewed historical-format record.

`verify` checks structure, privacy, evidence replay and isolated development/built browser fixtures without a model service. `test:built` requires a current build. `library:coverage` reports public Library lexical coverage over the concept catalog, including native and historical findings; matches are not graded relevance or a quality benchmark. Its diagnostic output stays in ignored authoring context. These checks establish behavior under their conditions; live research quality, independent review and human usefulness require separate evidence. `clean` removes generated build/test output and `.meta/context/local/` maps, diagnostics and command recovery; archive needed receipts first. It preserves private product state.

See [product intent](docs/product.yaml), [architecture](ARCHITECTURE.md), [data map](docs/architecture/schema.md), [dependencies](docs/dependencies.md) and [AI authoring context](.meta/context/README.md). Signals is pre-1 software. Candidate installation/execution, arbitrary crawling, hosted authentication and cloud/model fallback are outside its authority.

### Checking saved stopped notes

Open a saved cancelled or failed research note in Activity. **Check a claim from these retained notes** lets you edit one proposition and select an original citation for a fresh source check. The original notes remain incomplete and unassessed; the separate scoped verdict keeps confidence Unknown and creates no entity or numeric Signal.

A private check retains a copy of the bounded notes and primary snapshots after the original run expires or is deleted. Deleting the original does not delete copies in separately saved checks. An unavailable original disables its navigation action without restoring it; a present changed or unsafe parent produces a lineage error. The copied note remains visible within the child. Memory-only notes are not saved implicitly. A memory check against an already retained parent writes no new history.

Original context was not persisted in stopped notes and remains explicitly missing. Notes beyond the new selection bounds stay readable without a claim-selection action. No usable primary material means no inference and a null verdict. Source failures, extraction omissions and adverse findings remain visible. Reopening checks does not refresh sources, resume a native process or assess the whole narrative. `SIGNALS_PARTIAL_CHECKS=0` disables new retained-note check creation while compatible saved-check reading remains available.

### Registered selected PDF evidence

An experimental host-only selected-primary check can consume the already validated offline page-window packet from an explicitly registered public PDF capture. It is unavailable through default API/CLI creation: requests cannot upload text, specify local paths or install producers. The host must verify the capture and full extraction before readiness. No new PDF acquisition or parser is included.

The native check receives selected windows, exact page/global UTF16 provenance and unread coverage. It remains partial with Confidence Unknown; matching text is not whole-source support or personal applicability. Private history explicitly retains a separate bounded full normalized extraction copy for deep reopening, while raw PDF bytes stay outside the child. Memory mode saves nothing. Existing answer, direct and retained-note checks keep their meanings.

#### When a selected source is refused

If a direct check fails with `unsupported_content`, the receipt stays failed and unreviewed: null verdict, no usable source, no answer parent, and the exact proposition, selected URL and code are shown together. The next check explains that nothing was reviewed. A `.pdf` suffix does not prove PDF identity, parser execution or extraction readiness, and other unsupported shapes are not promised a converter.

For an explicitly acquired supported `DocumentMaterial` snapshot, use the existing `material-preview list` and `select` commands above to inspect exact normalized ranges. For a separately approved closed PDF extraction, use `material-preview pages` below. These commands inspect supplied evidence; they do not acquire, convert or review an unsupported format. A new selected-primary check additionally requires trusted host registration of the PDF capture, raw bytes, full extraction and exact packet as described below, with a deliberate memory/private storage choice. Default API/CLI selected-primary creation stays refused, and the synthetic example is not a real-PDF converter or source verification. If you cannot supply those prerequisites, keep the check unreviewed or deliberately select a different supported primary source for a new check.

Reopening a blocked, denied or cancelled result shows its saved work and next action only. It does not fetch, resume a native session, add context, change the source or start a model, and it never resubmits itself. Denied, authorization and rate-limit codes (`source_denied_401`, `source_denied_403`, `source_denied_429`) are not a prompt to bypass them. Existing receipts are not rewritten.

#### Run the synthetic registered-host example

This complete [host example](scripts/examples/selected-primary.ts) authors public fixture bytes and uses a scripted runner. It fetches nothing, parses no PDF, probes no login and invokes no native model. It is a runnable example, not a default PDF transport or an authenticated publisher capture.

```sh
EXAMPLE_ROOT="$(mktemp -d)"
EXAMPLE_ROOT="$(node --import tsx scripts/examples/selected-primary.ts prepare "$EXAMPLE_ROOT")"
read -r INPUT_SHA SOURCE_SHA TEXT_SHA < "$EXAMPLE_ROOT/digests"
npm run --silent material-preview -- pages \
  --snapshot "$EXAMPLE_ROOT/extraction.json" \
  --input-sha256 "$INPUT_SHA" --source-sha256 "$SOURCE_SHA" --text-sha256 "$TEXT_SHA" \
  --source-uri https://example.org/manual.pdf \
  --claim 'Water cooling is approved.' --anchors '["Only water c"]' \
  > "$EXAMPLE_ROOT/packet.json"
node --import tsx scripts/examples/selected-primary.ts review "$EXAMPLE_ROOT" private --retain-extraction-copy
```

The last command deliberately chooses private storage and acknowledges its separate full normalized extraction copy before creation. Choose `review "$EXAMPLE_ROOT" memory` instead to write no product history. Scripted review counts are not actual provider sessions; the example reports `actualNativeCalls: 0`.

`prepare` writes new `source.pdf`, `extraction.json`, `capture.json`, `acquisition.json` and digest files without overwriting existing inputs. The ordinary preview command creates the canonical packet. The host then registers `selectedPrimary` in its `signalSearch` dependencies, binds the selected URI and packet digest, verifies the capture-receipt digest, and supplies the exact raw, extraction and packet bytes. The existing kernel checks all source/projection/window bindings before the scripted review. Request JSON cannot supply this dependency.

Producer input is bounded: raw bytes at most 20 MiB, full extraction JSON 250,000 bytes, capture metadata 16,384 characters, and the canonical packet at most 48,000 UTF16 units and 300,000 bytes. The private result keeps its existing 2 MB limit. This does not enlarge default URL-fetch budgets. `captureChecked` pins `pypdf6.20.1` and extraction-worker SHA256 `db181d4f30169cc576fb4be26886c7e2dd064298c71ff95dcec5d3f88818be0e`. Setting those fields in an authored fixture does not prove a parser ran. A real registered host must establish its acquisition and approved extraction separately; no parser is shipped or activated here.

To reopen the saved synthetic result through Activity → Open result, use the existing workspace setting:

```sh
npm run build
SIGNALS_WORKSPACE="$EXAMPLE_ROOT/history" npm run start
```

Open the printed loopback address. Reopening uses the saved child, with no new producer or review. Selected pages 1–2 and unread pages 3–4 remain visible. These authored declarations establish no real source truth, installation permission, whole-document assessment or human usefulness. Keep or remove the explicitly created temporary example directory yourself when finished.

### Import private documents

Explicitly import local PDF, Markdown, HTML or plain-text bytes, reopen extracted pages, and select up to eight pages for the existing frozen Research input. Import makes no model call, network request, OCR attempt or project change. HTTP import accepts bounded base64 bytes rather than file paths. The local CLI accepts only an explicitly named file:

```sh
npm run private-documents -- --root /path/to/private-state import /path/to/handbook.pdf
npm run private-documents -- --root /path/to/private-state list
npm run private-documents -- --root /path/to/private-state open DOCUMENT_UUID
npm run private-documents -- --root /path/to/private-state select "$(cat selection.json)" --origin http://127.0.0.1:5178
```

`selection.json` contains the exact `document_ref` printed by `list` and the selected `pages` array. PDF extraction uses the text layer from optional `pypdf==6.15.0`; create an isolated Python environment and install the exact requirement with:

```sh
python3 -m venv /path/to/pdf-python
/path/to/pdf-python/bin/python -m pip install -r requirements-private-documents.txt
npm run private-documents -- --root /path/to/private-state import /path/to/handbook.pdf --python /path/to/pdf-python/bin/python
```

Import refuses encrypted, malformed, image-only and oversized PDFs; there is no OCR or automatic dependency installation. A document is limited to 4 MiB, 256 PDF pages and 256,000 UTF16 units/768,000 UTF8 bytes of extracted text; private storage is bounded to 20 documents and 12 MiB of original bytes. HTML is parsed inertly, with no scripts or linked resources executed or fetched. Extraction order and tables may be imperfect, and imported content is untrusted text rather than a truth, authenticity or coverage claim. Original bytes and page text stay under `.signals/private-documents.json` and are never part of public Pages output.

The private reader retains a page and exact text-layer annotations separately in `.signals/private-reader.json`. It uses one-based PDF viewer page numbers and UTF16 offsets into the extracted pypdf page string; those offsets are not PDF.js glyph coordinates. Its authenticated owner route returns original PDF bytes only when the complete document ref and raw SHA-256 still match. List/open/page APIs continue withholding original bytes. Use `private-reader` with explicit JSON request files to list, open, create, revise or freeze selected annotation passages; no source is sent automatically.
