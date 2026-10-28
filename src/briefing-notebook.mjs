import { createHash } from "node:crypto";
import { createResearchNotebook, researchNotebookLimits, reviseResearchNotebook, validateResearchNotebook } from "./notebook.mjs";

const digestPattern = /^[a-f0-9]{64}$/;
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : plain(value) ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  : JSON.stringify(value);
const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const invalid = (reason) => { throw new Error(`invalid_briefing_notebook_seed: ${reason}`); };
const exactKeys = (value, expected) => plain(value)
  && Object.keys(value).sort().join() === [...expected].sort().join();

function recordReference(value, kind) {
  return exactKeys(value, ["owner", "kind", "id", "revision"])
    && value.owner === "signals-ai" && value.kind === kind
    && typeof value.id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(value.id)
    && typeof value.revision === "string" && /^sha256:[a-f0-9]{64}$/.test(value.revision);
}

function sourceTerms(workbench, source) {
  if (!(source.termsRef === null || (typeof source.termsRef === "string"
      && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(source.termsRef))))
    invalid("source terms reference is malformed");
  const matching = workbench.sourceTerms.filter((policy) => policy?.sourceId === source.id);
  let policy = null;
  if (source.termsRef !== null) {
    const exact = matching.filter((candidate) => candidate.id === source.termsRef);
    if (exact.length !== 1)
      invalid("source terms policy does not match the exact source reference");
    policy = exact[0];
  } else if (matching.length > 0) {
    invalid("source has a terms policy but no matching terms reference");
  }
  if (policy && (!exactKeys(policy, ["id", "sourceId", "termsUrl", "status", "reviewedAt"])
      || !["unknown", "recorded", "blocked"].includes(policy.status)
      || !(policy.termsUrl === null || (typeof policy.termsUrl === "string" && policy.termsUrl.length <= 2048))
      || !(policy.reviewedAt === null || (typeof policy.reviewedAt === "string"
        && policy.reviewedAt.length <= 40 && Number.isFinite(Date.parse(policy.reviewedAt))))))
    invalid("source terms policy is malformed");
  if (policy?.status === "blocked") invalid("source terms policy blocks Research handoff");
  return {
    sourceId: source.id,
    termsRef: source.termsRef,
    status: policy?.status ?? "unknown",
    termsUrl: policy?.termsUrl ?? null,
    reviewedAt: policy?.reviewedAt ?? null,
  };
}

/**
 * Builds a portable Research Notebook from one explicitly selected native Briefing story
 * and exact selected item references. This is an in-memory projection only: it performs
 * no reads, writes, inference, network requests or automatic item inclusion.
 */
export function createResearchNotebookFromBriefingSelection(workbench, selection) {
  if (!plain(workbench) || workbench.schema !== "signals.briefing-workbench.v1"
      || !Array.isArray(workbench.ranked) || !Array.isArray(workbench.sourceTerms))
    invalid("current Briefing workbench response required");
  if (!plain(selection) || !recordReference(selection.storyReference, "briefing-story")
      || !Array.isArray(selection.itemReferences) || selection.itemReferences.length < 1
      || selection.itemReferences.length > researchNotebookLimits.sources
      || Object.keys(selection).some((key) => !["storyReference", "itemReferences", "title", "topic", "id"].includes(key)))
    invalid("explicit story and item selection required");

  const selectedKeys = new Set();
  for (const reference of selection.itemReferences) {
    if (!recordReference(reference, "briefing-item")) invalid("selected item reference is malformed");
    const key = canonical(reference);
    if (selectedKeys.has(key)) invalid("selected item references must be unique");
    selectedKeys.add(key);
  }

  const storyMatches = workbench.ranked.filter((entry) =>
    plain(entry) && plain(entry.input)
      && canonical(entry.input.storyReference) === canonical(selection.storyReference));
  if (storyMatches.length !== 1) invalid("selected story must match exactly one ranked owner record");
  const input = storyMatches[0].input;
  if (!plain(input.story) || input.story.id !== selection.storyReference.id
      || !Array.isArray(input.story.itemIds) || !Array.isArray(input.items))
    invalid("selected story record is inconsistent");

  const prepared = [];
  for (const itemReference of selection.itemReferences) {
    const matches = input.items.filter((entry) => plain(entry)
      && canonical(entry.itemReference) === canonical(itemReference));
    if (matches.length !== 1) invalid("selected item is not uniquely present in the selected story");
    const entry = matches[0];
    const item = entry.item;
    const source = entry.source;
    if (!plain(item) || item.id !== itemReference.id || !input.story.itemIds.includes(item.id)
        || !plain(source) || !recordReference(entry.sourceReference, "briefing-source")
        || source.id !== entry.sourceReference.id
        || typeof item.title !== "string" || typeof item.canonicalUrl !== "string"
        || typeof item.excerpt !== "string" || item.excerpt.length === 0
        || !digestPattern.test(item.contentDigest ?? "")
        || typeof item.observedAt !== "string" || !Number.isFinite(Date.parse(item.observedAt)))
      invalid("selected item source content is incomplete or inconsistent");
    let url;
    try { url = new URL(item.canonicalUrl); } catch { invalid("selected item URL is invalid"); }
    if (!["http:", "https:"].includes(url.protocol) || item.canonicalUrl.length > 2048)
      invalid("selected item URL is invalid");
    const excerptSha256 = hash(item.excerpt);
    const identity = [selection.storyReference, itemReference, entry.sourceReference];
    const document = {
      id: `briefing-item-${hash(canonical(identity))}`,
      title: item.title,
      sha256: hash(`briefing-document-header\n${item.title}\n${excerptSha256}`),
      pages: [{ number: 1, text: item.excerpt, sha256: excerptSha256 }],
    };
    prepared.push({
      document,
      origin: {
        schemaVersion: 1,
        kind: "signals-briefing-item",
        storyReference: selection.storyReference,
        itemReference,
        sourceReference: entry.sourceReference,
        canonicalUrl: item.canonicalUrl,
        contentDigest: item.contentDigest,
        excerptSha256,
        observedAt: item.observedAt,
        sourceHealth: source.health,
        sourceTerms: sourceTerms(workbench, source),
        assessmentStatus: "unassessed-lead",
      },
    });
  }

  const title = selection.title ?? prepared[0].document.title;
  const topic = selection.topic ?? "";
  let notebook = createResearchNotebook(title, { topic, id: selection.id });
  for (const source of prepared) {
    notebook = reviseResearchNotebook(notebook, {
      type: "add-briefing-source",
      document: source.document,
      origin: source.origin,
    });
  }
  return validateResearchNotebook(notebook);
}
