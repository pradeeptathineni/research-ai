import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createResearchNotebook, reviseResearchNotebook, validateResearchNotebook,
  searchResearchNotebooks, openNotebookSearchHit } from "../src/index.mjs";

const sha = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const page = (number, text) => ({ number, text, sha256: sha(text) });
const doc = (id, title, pages) => ({ id, title, sha256: sha(`caller assertion ${id}`), pages });
const id = (prefix) => `${prefix}:${randomUUID()}`;
function notebook(title = "Synthetic lab") {
  let value = createResearchNotebook(title);
  value = reviseResearchNotebook(value, { type: "add-source", document: doc("source-one", "Cell report", [
    page(1, "Earlier page about storage."),
    page(2, "\r\n🧪 The retained superconducting qubit stabilized after cooling.\r\n"),
  ]) });
  value = reviseResearchNotebook(value, { type: "add-note", title: "Human review", text: "A reviewer notes the qubit result remains unverified." });
  return value;
}

test("exact, prefix, fuzzy source and note search is explicit, scoped and deterministic", () => {
  const first = notebook("First");
  let second = createResearchNotebook("Unselected");
  second = reviseResearchNotebook(second, { type: "add-source", document: doc("outside", "Outside", [page(1, "qubit")]) });
  const original = structuredClone(first);
  const exact = searchResearchNotebooks([first], "superconducting");
  assert.equal(exact.counts.records, 3);
  assert.deepEqual(exact.hits.map((hit) => hit.kind), ["document"]);
  const pageHit = exact.hits[0];
  assert.equal(pageHit.page, 2);
  assert.equal(pageHit.matches[0].text, "superconducting");
  assert.equal("qubit" in pageHit, false);
  const note = searchResearchNotebooks([first], "unverified", { kinds: ["note"] });
  assert.equal(note.hits[0].kind, "note");
  assert.match(note.hits[0].title, /^Unverified note:/);
  assert.equal(searchResearchNotebooks([first], "qubit", { kinds: ["document"] }).counts.totalHits, 1);
  assert.equal(searchResearchNotebooks([first], "qubit", { kinds: ["note"] }).counts.totalHits, 1);
  assert.equal(searchResearchNotebooks([first], "superconduct", { mode: "prefix" }).counts.totalHits, 1);
  const fuzzy = searchResearchNotebooks([first], "superconductng", { mode: "fuzzy" });
  assert.equal(fuzzy.counts.totalHits, 1);
  assert.equal(fuzzy.hits[0].matches.find((entry) => entry.field === "text").text, "superconducting",
    "fuzzy hits highlight the matched retained token rather than the misspelled query");
  assert.equal(searchResearchNotebooks([first], "superconduct", { mode: "exact" }).counts.totalHits, 0);
  assert.equal(searchResearchNotebooks([first], "qubit", { mode: "prefix" }).sha256,
    searchResearchNotebooks([first], "qubit", { mode: "prefix" }).sha256);
  assert.equal(searchResearchNotebooks([first, second], "qubit").hits.some((hit) => hit.notebookId === second.id), true);
  assert.equal(searchResearchNotebooks([first], "qubit").hits.some((hit) => hit.notebookId === second.id), false);
  assert.deepEqual(first, original, "search does not revise notebook state");
});

test("UTF-16 offsets and excerpts slice the original Unicode and CRLF text", () => {
  const state = notebook();
  const result = searchResearchNotebooks([state], "qubit");
  const hit = result.hits.find((entry) => entry.kind === "document");
  const match = hit.matches.find((entry) => entry.field === "text");
  assert.equal(match.text, "qubit");
  const pageText = state.sources[0].document.pages[1].text;
  assert.equal(pageText.slice(match.start, match.end), "qubit");
  assert.equal(hit.excerpt.text, pageText.slice(hit.excerpt.start, hit.excerpt.end));
  assert.equal(pageText.charCodeAt(hit.excerpt.start) >= 0xdc00 && pageText.charCodeAt(hit.excerpt.start) <= 0xdfff, false);
});

test("excerpt stays well-formed and within its cap when both boundaries touch astral characters", () => {
  let state = createResearchNotebook("Excerpt boundary");
  const body = "😀" + "x".repeat(178) + " " + "needle" + " " + "x".repeat(411) + "😀tail";
  state = reviseResearchNotebook(state, { type: "add-note", title: "Boundary", text: body });
  const result = searchResearchNotebooks([state], "needle", { kinds: ["note"] });
  const hit = result.hits[0];
  assert.equal(hit.excerpt.start, 0);
  assert.ok(hit.excerpt.end - hit.excerpt.start <= 600);
  assert.equal(hit.excerpt.text.isWellFormed(), true);
  assert.equal(hit.excerpt.text, body.slice(hit.excerpt.start, hit.excerpt.end));
  const matched = hit.matches.find((range) => range.field === "text" && range.text === "needle");
  assert.ok(matched);
  assert.ok(hit.excerpt.start <= matched.start && matched.start < hit.excerpt.end,
    "the excerpt retains the first match while keeping valid UTF-16 boundaries");
});

test("latest/all note versions and exact offline reopen preserve the selected old version", () => {
  let state = notebook();
  const note = state.notes[0];
  const old = searchResearchNotebooks([state], "reviewer", { kinds: ["note"] });
  state = reviseResearchNotebook(state, { type: "edit-note", id: note.id, title: "Human review", text: "The revised note discusses qubit handling." });
  assert.equal(searchResearchNotebooks([state], "reviewer", { kinds: ["note"] }).counts.totalHits, 0);
  const all = searchResearchNotebooks([state], "reviewer", { kinds: ["note"], noteVersions: "all" });
  assert.equal(all.hits[0].version, 1);
  const opened = openNotebookSearchHit([state], all, all.hits[0].id);
  assert.equal(opened.source.version.text, "A reviewer notes the qubit result remains unverified.");
  assert.throws(() => openNotebookSearchHit([notebook("Different")], old, old.hits[0].id), /stale|replay/);
  const damaged = structuredClone(all); damaged.hits[0].title = "tampered";
  assert.throws(() => openNotebookSearchHit([state], damaged, all.hits[0].id), /digest|invalid|replay/);
});

test("bounds, malformed options, empty scope and title-only results are explicit", () => {
  const state = notebook();
  assert.deepEqual(searchResearchNotebooks([state], "nothing-matches").hits, []);
  assert.equal(searchResearchNotebooks([state], "Cell").hits[0].matches.every((entry) => entry.field === "title"), true);
  for (const [states, query, options] of [
    [[], "x", undefined], [[state], "x", { kinds: [] }], [[state], "x", { mode: "wildcard" }],
    [[state], "x\nno", undefined], [[state], "x", { limit: 51 }],
  ]) assert.throws(() => searchResearchNotebooks(states, query, options), /invalid_research_notebook_search/);
});

test("fresh-process CLI search then open returns the same exact retained source", () => {
  const state = notebook();
  const cli = fileURLToPath(new URL("../bin/research-notebook-search.mjs", import.meta.url));
  const run = (action, payload) => spawnSync(process.execPath, [cli, "--action", action], {
    input: JSON.stringify(payload), encoding: "utf8", timeout: 10000,
  });
  const searched = run("search", { notebooks: [state], query: "superconducting" });
  assert.equal(searched.status, 0, searched.stderr);
  const result = JSON.parse(searched.stdout);
  const opened = run("open", { notebooks: [state], result, hitId: result.hits[0].id });
  assert.equal(opened.status, 0, opened.stderr);
  assert.equal(JSON.parse(opened.stdout).source.page.text, state.sources[0].document.pages[1].text);
  const bad = run("search", { notebooks: [state], query: "" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /invalid_research_notebook_search/);
});
