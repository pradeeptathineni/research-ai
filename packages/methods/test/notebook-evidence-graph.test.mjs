import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fakeCodex, message } from "./fake-codex.mjs";
import { createResearchNotebook, reviseResearchNotebook, prepareNotebookEvidenceGraph,
  researchNotebookEvidenceGraph, validateNotebookEvidenceGraph, assertNotebookEvidenceGraphEdge,
  checkNotebookEvidenceGraphSources, renderNotebookEvidenceGraph } from "../src/index.mjs";

const sha = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const id = (prefix) => `${prefix}:${randomUUID()}`;
const textA = "Local indexing keeps selected records on the device.";
const textB = "Cloud analysis sends selected content to a provider.";
const noteText = "Scope\n\nA user note limits this comparison to selected passages.";
const doc = (docId, text) => ({ id: docId, title: `Synthetic ${docId}`, sha256: sha(`caller-asserted raw bytes for ${docId}`),
  pages: [{ number: 1, text, sha256: sha(text) }] });

test("cross-notebook graph binds exact pages, separates extracted and asserted edges, and cold-reopens as a list", async (t) => {
  const firstWithSource = reviseResearchNotebook(createResearchNotebook("Local evidence"), { type: "add-source", document: doc("local-doc", textA) });
  const first = reviseResearchNotebook(firstWithSource, { type: "add-note", title: "Scope", text: "A user note limits this comparison to selected passages." });
  const second = reviseResearchNotebook(createResearchNotebook("Cloud evidence"), { type: "add-source", document: doc("cloud-doc", textB) });
  const question = "How do the retained sources describe processing location?";
  const prepared = prepareNotebookEvidenceGraph(question, [first, second], [
    { notebookId: first.id, kind: "document", recordId: first.sources[0].id, page: 1 },
    { notebookId: second.id, kind: "document", recordId: second.sources[0].id, page: 1 },
    { notebookId: first.id, kind: "note", recordId: first.notes[0].id, version: 1 },
  ]);
  const tampered = structuredClone(prepared);
  tampered.sources[0].text += " Changed after preview.";
  const { sha256: _previewDigest, ...unsignedTampered } = tampered;
  tampered.sha256 = sha(canonical(unsignedTampered));
  await assert.rejects(researchNotebookEvidenceGraph(tampered, [first, second]), /do not match the supplied Notebook snapshots/u);
  const raw = { rootLabel: question, nodes: [
    { parent: -1, label: "One source describes local indexing", relation: "contrasts", citations: [{ source: 0, start: 0, end: textA.length }], gap: null },
    { parent: -1, label: "The other describes provider-side analysis", relation: "contrasts", citations: [{ source: 1, start: 0, end: textB.length }], gap: null },
    { parent: -1, label: "A caller note limits the comparison", relation: "qualifies", citations: [{ source: 2, start: 0, end: noteText.length }], gap: null },
    { parent: 1, label: "Provider retention remains unknown", relation: "qualifies", citations: [], gap: "Neither selected page states a retention period." },
  ] };
  const fixture = await fakeCodex({ events: [message(JSON.stringify(raw)), { type: "turn.completed" }] });
  t.after(() => fixture.cleanup());
  const result = await researchNotebookEvidenceGraph(prepared, [first, second], { lease: fixture.lease, model: "fixture" });
  assert.equal(result.status, "complete");
  assert.equal(result.graph.sources.length, 3);
  assert.deepEqual(result.graph.sources.map((s) => [s.reference.notebookId, s.reference.documentId, s.reference.page]), [
    [first.id, "local-doc", 1], [second.id, "cloud-doc", 1], [first.id, null, null],
  ]);
  assert.equal(result.graph.sources[2].reference.kind, "note");
  assert.equal(result.graph.sources[2].reference.version, 1);
  const listed = JSON.parse(renderNotebookEvidenceGraph(result.graph, { format: "list" }));
  assert.equal(listed.coverage, "partial");
  assert.equal(listed.edges.length, 4);
  assert.equal(listed.edges[0].basis, "model-extracted");
  assert.equal(listed.edges[0].citations[0].quote, textA);
  assert.equal(listed.edges[1].citations[0].reference.documentId, "cloud-doc");
  assert.equal(listed.edges.find((edge) => edge.citations[0]?.reference.kind === "note").citations[0].reference.version, 1);
  assert.match(listed.nodes.find((node) => node.id === "n4").gap, /retention period/u);
  assert.match(listed.qualifications.join(" "), /not entailment/u);

  const asserted = assertNotebookEvidenceGraphEdge(result.graph, { id: "assertion-related", from: "n1", to: "n2",
    label: "Both concern processing location", relation: "related", assertedBy: "Researcher" });
  const cold = validateNotebookEvidenceGraph(JSON.parse(renderNotebookEvidenceGraph(asserted, { format: "json" })));
  assert.equal(renderNotebookEvidenceGraph(cold, { format: "json" }), renderNotebookEvidenceGraph(asserted, { format: "json" }));
  const coldList = JSON.parse(renderNotebookEvidenceGraph(cold, { format: "list" }));
  assert.equal(coldList.edges.at(-1).basis, "user-asserted");
  assert.deepEqual(coldList.edges.at(-1).citations, []);
  assert.equal(coldList.edges.length, listed.edges.length + 1);

  const newerFirst = reviseResearchNotebook(first, { type: "add-note", title: "Later scope", text: "This new note is outside the selected graph." });
  const currentness = checkNotebookEvidenceGraphSources(cold, [newerFirst, second]);
  assert.deepEqual(currentness.sources.map(({ status, notebookSnapshot }) => [status, notebookSnapshot]), [["current", "changed"], ["current", "current"], ["current", "changed"]]);
  assert.throws(() => prepareNotebookEvidenceGraph(question, [first], [
    { notebookId: first.id, kind: "document", recordId: first.sources[0].id, page: 1 },
    { notebookId: first.id, kind: "document", recordId: first.sources[0].id, page: 1 },
  ]), /duplicate selected record version/u);
});
