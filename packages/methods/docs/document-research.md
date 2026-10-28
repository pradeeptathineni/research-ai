# Complete-document question answering

`prepareDocumentResearch(question, documents)` validates and hashes caller-frozen extracted pages before any session. It accepts 1–4 documents, 1–50 ordered pages per document, and at most 48,000 combined UTF-16 units of page text. Page SHA-256 values are checked over exact UTF-8 text. The document SHA-256 identifies the original bytes as supplied by the caller; Research cannot verify that value because it does not receive the original file bytes.

`researchDocuments(question, documents, options)` sends every supplied page together in one frozen, schema-bound session with web search disabled. It does not choose passages lexically, fetch links, or infer that the caller's extracted pages are complete. Input validation fails before the session lease is acquired. Pages and question are untrusted data, never instructions.

```js
import {
  prepareDocumentResearch,
  researchDocuments,
  validateDocumentResearch,
  renderDocumentResearch,
} from "@pradeeptathineni/research-ai";

const prepared = prepareDocumentResearch(question, documents);
const result = await researchDocuments(prepared.question, prepared.documents, { profile: "quick" });
if (result.status === "complete") {
  const answer = validateDocumentResearch(result.draft);
  process.stdout.write(renderDocumentResearch(answer));
}
```

The `research-document-answer-v1` closure keeps the entire ordered page input, its validated page digests, an input digest, answer paragraphs linked to evidence IDs, exact page-local UTF-16 spans, coverage and gaps. An answer paragraph cannot be returned without at least one exact evidence span. If the supplied pages do not support an answer, the model must return an empty answer and explicit gaps. `supporting`, `conflicting` and `context` describe fallible model judgments; exact occurrence is checked locally, but entailment and source truth are not.

The current `research-document-input-v2-quoted-evidence` preview and its digest bind the `research-document-quoted-evidence-v2` prompt/schema contract. The model names the exact document and page, returns an exact quote and an occurrence index only when that quote repeats; the host derives page-local UTF-16 bounds from the frozen page. Missing quotes and ambiguous quotes without an in-range occurrence fail the one completed result. No normalization or provider retry is used. Retained answer-v1 drafts from the earlier numeric-span contract remain readable only when their exact stored quote and span still match the retained page and their legacy input/content digests validate.

`complete` means one clean schema-valid session and passing source-span validation. `partial`, `failed` and `cancelled` retain the session receipt and return no promoted draft. A malformed or incomplete provider response never becomes a complete answer. The result is ephemeral unless a consumer deliberately retains it.

The standalone `research-documents --input FILE` command accepts one explicitly named UTF-8 JSON file no larger than 512 KiB, with only `question` and `documents` at the top level. It writes the result to stdout and the bounded session receipt to stderr. It does not save an answer or create a reusable document corpus. The API is the preferred path when a consumer already owns exact source bytes and can supply its own acquisition and extraction provenance.
