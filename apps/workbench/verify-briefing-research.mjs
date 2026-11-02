import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createResearchNotebookFromBriefingSelection,
  createReport,
  projectReportClaimRegister,
  renderReport,
  renderResearchNotebook,
  validateResearchNotebook,
} from "@pradeeptathineni/research-ai";
import { refreshBriefing } from "../../packages/library/packages/corpus/src/briefing/ingest.ts";
import { createBriefingApi } from "../../packages/library/packages/corpus/src/briefing/store.ts";
import { briefingRoute } from "../../packages/library/packages/corpus/src/briefing/http.ts";
import {
  defaultSettings,
  saveSettings,
} from "../../packages/library/packages/corpus/src/search-settings.ts";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const root = await realpath(
  await mkdtemp(join(tmpdir(), "rx02-briefing-research-")),
);
try {
  const feedUri = "https://example.test/climate.json";
  const articleUri = "https://publisher.example.test/climate-report";
  const observedAt = "2026-10-28T10:00:00.000Z";
  const feed = {
    version: "https://jsonfeed.org/version/1",
    title: "Synthetic climate feed",
    items: [
      {
        id: "fixture-climate-report",
        url: articleUri,
        title: "Climate data report",
        content_text:
          "The climate data report publishes a new regional baseline.",
        date_published: "2026-10-28T09:30:00.000Z",
      },
    ],
  };
  const body = JSON.stringify(feed);
  const feedRequestId = "f8d1c18e-a6b7-4f03-9157-c6e91a6b900f";
  await saveSettings(
    {
      ...defaultSettings,
      queries: [
        {
          id: "climate-data",
          query: "climate data",
          enabled: true,
          everyDays: 1,
          offsetMinutes: 0,
          concepts: [],
        },
      ],
      followedSources: [
        {
          uri: feedUri,
          label: "Synthetic climate feed",
          enabled: true,
          interests: ["climate-data"],
        },
      ],
    },
    root,
  );
  const refresh = await refreshBriefing(root, {
    requestId: feedRequestId,
    clock: () => new Date(observedAt),
    fetch: async (uri) => ({
      uri,
      text: body,
      json: feed,
      digest: sha256(body),
      contentType: "application/feed+json",
      response: { status: 200, etag: "synthetic-v1" },
    }),
  });
  assert.equal(refresh.briefing.capturedDocuments, 1);
  assert.equal(refresh.sources[0].state, "fetched");

  const workbench = await briefingRoute(
    root,
    "briefing/workbench",
    false,
    undefined,
    0,
  );
  assert.equal(workbench.status, 200);
  const entry = workbench.body.ranked.find(({ input }) =>
    input.items.some(({ item }) => item.canonicalUrl === articleUri),
  );
  assert.ok(
    entry,
    "the existing Briefing workbench should rank the synthetic retained item",
  );
  const input = entry.input;
  const selected = input.items.find(
    ({ item }) => item.canonicalUrl === articleUri,
  );
  const { item, itemReference, source, sourceReference } = selected;
  assert.equal(input.story.representativeItemId, item.id);
  assert.equal(input.storyReference.kind, "briefing-story");
  assert.equal(itemReference.kind, "briefing-item");
  assert.equal(sourceReference.kind, "briefing-source");
  assert.equal(source.health.status, "healthy");
  assert.equal(entry.explanation.total >= 0, true);

  const storyReference = input.storyReference;
  const excerptSha256 = sha256(item.excerpt);
  const notebook = createResearchNotebookFromBriefingSelection(workbench.body, {
    storyReference,
    itemReferences: [itemReference],
    title: "Briefing story review",
  });
  const reopenedNotebook = validateResearchNotebook(
    JSON.parse(renderResearchNotebook(notebook)),
  );
  assert.deepEqual(reopenedNotebook, notebook);
  assert.deepEqual(reopenedNotebook.sources[0].briefingOrigin, {
    schemaVersion: 1,
    kind: "signals-briefing-item",
    storyReference,
    itemReference,
    sourceReference,
    contentDigest: item.contentDigest,
    excerptSha256,
    observedAt: item.observedAt,
    sourceHealth: source.health,
    canonicalUrl: item.canonicalUrl,
    sourceTerms: {
      sourceId: source.id,
      termsRef: null,
      status: "unknown",
      termsUrl: null,
      reviewedAt: null,
    },
    assessmentStatus: "unassessed-lead",
  });

  const sourceIdentityNotes = [
    `Signals story reference: ${storyReference.kind}/${storyReference.id}@${storyReference.revision}.`,
    `Signals item reference: ${itemReference.kind}/${itemReference.id}@${itemReference.revision}; content digest ${item.contentDigest}.`,
    `Signals source reference: ${sourceReference.kind}/${sourceReference.id}@${sourceReference.revision}.`,
  ];
  const report = createReport({
    version: "research-outline-v1",
    topic: `Selected Briefing story: ${item.title}`,
    sources: [
      {
        uri: item.canonicalUrl,
        text: item.excerpt,
        sha256: excerptSha256,
        observedAt: item.observedAt,
        omissions: [
          ...sourceIdentityNotes,
          "One retained feed excerpt only; source completeness and rights are not assessed.",
        ],
      },
    ],
    sections: [
      {
        id: "selected-story",
        title: item.title,
        points: [
          {
            text: item.excerpt,
            citations: [
              {
                source: 0,
                start: 0,
                end: item.excerpt.length,
                quote: item.excerpt,
              },
            ],
          },
        ],
        gaps: [
          "Caller-authored source handoff; no model research or independent verification was run.",
        ],
      },
    ],
    origin: { type: "caller-authored" },
    limits: [
      "This report is a caller-authored transfer of one exact Signals Briefing excerpt, not a Research answer or support judgment.",
      ...sourceIdentityNotes,
      `Briefing score ${entry.explanation.total} is a discovery ranking, not evidence strength.`,
    ],
  });
  const claimRegister = projectReportClaimRegister(report);
  assert.equal(claimRegister.citedClaims.length, 1);
  assert.equal(claimRegister.citedClaims[0].source.sha256, excerptSha256);
  assert.equal(claimRegister.citedClaims[0].citation.quote, item.excerpt);
  const rendered = renderReport(report);
  for (const note of sourceIdentityNotes) assert.ok(rendered.includes(note));
  assert.ok(rendered.includes("entailment or truth"));
  assert.ok(rendered.includes(item.title));
  assert.equal((await createBriefingApi(root).listStories()).length, 1);

  console.log(
    JSON.stringify({
      schema: "rx02-briefing-research-consumer-flow.v1",
      storyReference,
      itemReference,
      sourceReference,
      sourceHealth: source.health.status,
      rankingTotal: entry.explanation.total,
      notebookSourceCount: reopenedNotebook.sources.length,
      reportVersion: report.version,
      citedClaimCount: claimRegister.citedClaims.length,
      modelInvoked: false,
      networkUsed: false,
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
