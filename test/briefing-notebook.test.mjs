import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { createResearchNotebookFromBriefingSelection } from "../src/briefing-notebook.mjs";
import { renderResearchNotebook, validateResearchNotebook } from "../src/notebook.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const reference = (kind, id, bytes) => ({
  owner: "signals-ai",
  kind,
  id,
  revision: `sha256:${sha(bytes)}`,
});
const health = {
  status: "healthy",
  lastGoodAt: "2026-10-28T11:00:00.000Z",
  lastAttemptAt: "2026-10-28T11:00:00.000Z",
  lastAttemptStatus: "fetched",
  lastSuccessfulLinkCount: 1,
  failureClass: null,
  expectedIntervalSec: null,
};

function fixture() {
  const storyReference = reference("briefing-story", "story:research-seed", "story bytes");
  const firstItemReference = reference("briefing-item", "item:seed-a", "item A bytes");
  const secondItemReference = reference("briefing-item", "item:seed-b", "item B bytes");
  const firstSourceReference = reference("briefing-source", "source:seed-a", "source A bytes");
  const secondSourceReference = reference("briefing-source", "source:seed-b", "source B bytes");
  const first = {
    item: {
      id: firstItemReference.id,
      title: "Synthetic source A",
      canonicalUrl: "https://publisher.example.test/a?source=exact",
      excerpt: "First owner-retained excerpt.",
      contentDigest: sha("original captured A bytes"),
      observedAt: "2026-10-28T10:59:00.000Z",
    },
    itemReference: firstItemReference,
    source: { id: firstSourceReference.id, termsRef: null, health },
    sourceReference: firstSourceReference,
  };
  const second = {
    item: {
      id: secondItemReference.id,
      title: "Synthetic source B",
      canonicalUrl: "https://publisher.example.test/b",
      excerpt: "Second owner-retained excerpt.",
      contentDigest: sha("original captured B bytes"),
      observedAt: "2026-10-28T10:58:00.000Z",
    },
    itemReference: secondItemReference,
    source: { id: secondSourceReference.id, termsRef: "terms:seed-b", health: { ...health, status: "stale" } },
    sourceReference: secondSourceReference,
  };
  return {
    storyReference,
    firstItemReference,
    secondItemReference,
    workbench: {
      schema: "signals.briefing-workbench.v1",
      ranked: [{ input: {
        story: { id: storyReference.id, itemIds: [first.item.id, second.item.id] },
        storyReference,
        items: [first, second],
      } }],
      sourceTerms: [{
        id: "terms:seed-b",
        sourceId: second.source.id,
        termsUrl: "https://publisher.example.test/terms",
        status: "recorded",
        reviewedAt: "2026-10-27T00:00:00.000Z",
      }],
    },
  };
}

test("explicit Briefing story selection seeds exact unassessed leads and survives cold reopen", () => {
  const value = fixture();
  const notebook = createResearchNotebookFromBriefingSelection(value.workbench, {
    storyReference: value.storyReference,
    itemReferences: [value.firstItemReference, value.secondItemReference],
    id: "notebook:12345678-1234-4234-8234-123456789abc",
  });
  const reopened = validateResearchNotebook(JSON.parse(renderResearchNotebook(notebook)));
  assert.deepEqual(reopened, notebook);
  assert.equal(reopened.sources.length, 2);
  const [first, second] = reopened.sources;
  assert.equal(first.briefingOrigin.storyReference.revision, value.storyReference.revision);
  assert.equal(first.briefingOrigin.itemReference.revision, value.firstItemReference.revision);
  assert.equal(first.briefingOrigin.canonicalUrl, "https://publisher.example.test/a?source=exact");
  assert.equal(first.briefingOrigin.sourceTerms.status, "unknown");
  assert.equal(first.briefingOrigin.sourceTerms.termsRef, null);
  assert.equal(first.briefingOrigin.assessmentStatus, "unassessed-lead");
  assert.equal(first.briefingOrigin.sourceHealth.status, "healthy");
  assert.equal(second.briefingOrigin.sourceTerms.status, "recorded");
  assert.equal(second.briefingOrigin.sourceTerms.termsUrl, "https://publisher.example.test/terms");
  assert.equal(second.briefingOrigin.sourceHealth.status, "stale");
  assert.match(renderResearchNotebook(notebook, { format: "markdown" }), /Unassessed Library lead/);
  assert.match(renderResearchNotebook(notebook, { format: "markdown" }), /Terms policy: unknown/);
  assert.match(renderResearchNotebook(notebook, { format: "markdown" }), /Terms policy: recorded/);
});

test("Briefing seed includes only explicit members and refuses unresolved or blocked input", () => {
  const value = fixture();
  const one = createResearchNotebookFromBriefingSelection(value.workbench, {
    storyReference: value.storyReference,
    itemReferences: [value.secondItemReference],
  });
  assert.equal(one.sources.length, 1);
  assert.equal(one.sources[0].briefingOrigin.itemReference.id, value.secondItemReference.id);
  assert.throws(() => createResearchNotebookFromBriefingSelection(value.workbench, {
    storyReference: value.storyReference,
    itemReferences: [reference("briefing-item", "item:missing", "missing")],
  }), /not uniquely present/);
  assert.throws(() => createResearchNotebookFromBriefingSelection(value.workbench, {
    storyReference: value.storyReference,
    itemReferences: [value.secondItemReference, value.secondItemReference],
  }), /must be unique/);
  const blocked = structuredClone(value.workbench);
  blocked.sourceTerms[0].status = "blocked";
  assert.throws(() => createResearchNotebookFromBriefingSelection(blocked, {
    storyReference: value.storyReference,
    itemReferences: [value.secondItemReference],
  }), /terms policy blocks/);
  const detachedPolicy = structuredClone(value.workbench);
  detachedPolicy.sourceTerms = [];
  assert.throws(() => createResearchNotebookFromBriefingSelection(detachedPolicy, {
    storyReference: value.storyReference,
    itemReferences: [value.secondItemReference],
  }), /does not match the exact source reference/);
});
