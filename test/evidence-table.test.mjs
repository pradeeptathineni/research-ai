import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEvidenceTable, evidenceTableResearch, renderEvidenceTable, reviseEvidenceTable, validateEvidenceTable } from "../src/index.mjs";
import { fakeCodex, message } from "./fake-codex.mjs";

const sources = [
  { uri: "https://example.org/a", text: "The service retains logs for 7 days.", observedAt: "2026-10-20", omissions: ["Retention scope not specified."] },
  { uri: "https://example.org/b", text: "The service retains logs for 30 days. Backups are weekly." },
];
const columns = [
  { id: "retention", title: "Log retention", question: "How long are logs retained?" },
  { id: "backups", title: "Backups", question: "How often are backups made?" },
];
const modelRows = [
  { source: 0, cells: [
    { columnId: "retention", text: "7 days", citations: [{ source: 0, start: 29, end: 35 }], gap: "" },
    { columnId: "backups", text: "", citations: [], gap: "The capture does not describe backup frequency." },
  ] },
  { source: 1, cells: [
    { columnId: "retention", text: "30 days", citations: [{ source: 1, start: 29, end: 36 }], gap: "" },
    { columnId: "backups", text: "Weekly", citations: [{ source: 1, start: 50, end: 56 }], gap: "" },
  ] },
];
const reply = (rows) => [message(JSON.stringify({ rows })), { type: "turn.completed" }];

test("create, draft, edit, reopen and export source-bound comparison", async () => {
  const initial = createEvidenceTable("Compare retention and backup claims", { sources, columns });
  assert.equal(initial.rows.length, 2);
  assert.equal(initial.rows[0].cells[0].gap, "Not assessed.");
  const fixture = await fakeCodex({ events: reply(modelRows) });
  try {
    const result = await evidenceTableResearch(initial.question, { sources, columns, lease: fixture.lease, model: "fixture" });
    assert.equal(result.status, "complete");
    assert.equal(result.draft.version, "research-evidence-table-v1");
    assert.equal(result.draft.rows[0].cells[0].citations[0].quote, "7 days");
    assert.match(result.draft.rows[0].cells[1].gap, /does not describe/);
    assert.equal(result.draft.rows[1].cells[0].citations[0].quote, "30 days");
    assert.equal(result.receipt.outcome.nativeSessions, 1);
    const changedRows = structuredClone(result.draft.rows);
    changedRows[0].cells[0].text = "Seven days";
    const edited = reviseEvidenceTable(result.draft, { rows: changedRows });
    assert.equal(edited.origin.type, "user-modified");
    const reopened = validateEvidenceTable(JSON.parse(JSON.stringify(edited)));
    assert.deepEqual(reopened.sources, result.draft.sources);
    assert.match(renderEvidenceTable(reopened), /Seven days/);
    const exported = renderEvidenceTable(reopened, { format: "json" });
    assert.doesNotThrow(() => JSON.parse(exported), exported);
    assert.deepEqual(JSON.parse(exported).rows, edited.rows);
    const mismatch = structuredClone(edited);
    mismatch.rows[0].cells[0].citations[0].quote = "5 days";
    assert.throws(() => renderEvidenceTable(mismatch), /invalid_evidence_table/);
    const stale = structuredClone(edited);
    stale.sources[0].text += " Changed.";
    assert.throws(() => validateEvidenceTable(stale), /invalid_evidence_table/);
    assert.ok((await fixture.record()).args.includes("--output-schema"));
  } finally { await fixture.cleanup(); }
});

test("closed dimensions, row-local citation bindings and safe URI export reject malformed tables", () => {
  const rows = modelRows.map((row) => ({ ...row, cells: row.cells.map((cell) => ({ ...cell, citations: cell.citations.map((citation) => ({ ...citation, quote: sources[citation.source].text.slice(citation.start, citation.end) })) })) }));
  const draft = { ...createEvidenceTable("Compare", { sources, columns }), rows };
  assert.equal(validateEvidenceTable(draft).rows[1].cells[1].text, "Weekly");
  for (const mutate of [
    (table) => { table.rows.reverse(); },
    (table) => { table.columns[1].id = "retention"; },
    (table) => { table.rows[0].cells[0].citations[0].source = 1; },
    (table) => { table.rows[0].cells[0].citations[0].start += 1; },
    (table) => { table.rows[0].extra = true; },
  ]) {
    const bad = structuredClone(draft);
    mutate(bad);
    assert.throws(() => validateEvidenceTable(bad), /invalid_evidence_table/);
  }
  const unsafe = createEvidenceTable("<b>Question</b>", { sources: [{ uri: "https://example.org/`x", text: "Capture" }], columns: [{ id: "facts", title: "Facts", question: "What is stated?" }] });
  const markdown = renderEvidenceTable(unsafe);
  assert.match(markdown, /``https:\/\/example\.org\//);
  assert.doesNotMatch(markdown, /<b>/);
  assert.doesNotMatch(markdown, /\]\(https:\/\/example\.org/);
  const unicode = createEvidenceTable("Unicode", { sources: [{ uri: "https://example.org/emoji", text: "A 😀 B" }], columns: [{ id: "x", title: "X", question: "Where?" }] });
  const split = structuredClone(unicode);
  split.rows[0].cells[0] = { columnId: "x", text: "emoji", gap: "", citations: [{ source: 0, start: 3, end: 4, quote: "\ude00" }] };
  assert.throws(() => validateEvidenceTable(split), /invalid_evidence_table/);
});

test("malformed output and cancellation preserve receipts without promoting cells", async () => {
  const badRows = structuredClone(modelRows);
  badRows[0].cells[0].citations[0].end = 4000;
  const malformed = await fakeCodex({ events: reply(badRows) });
  try {
    const result = await evidenceTableResearch("Compare", { sources, columns, lease: malformed.lease });
    assert.equal(result.status, "failed");
    assert.equal(result.draft, null);
    assert.equal(result.receipt.failure, "invalid_evidence_table");
  } finally { await malformed.cleanup(); }
  const fixture = await fakeCodex({ hang: true });
  const controller = new AbortController();
  try {
    setTimeout(() => controller.abort(), 100);
    const result = await evidenceTableResearch("Compare", { sources, columns, lease: fixture.lease, signal: controller.signal });
    assert.equal(result.status, "cancelled");
    assert.equal(result.draft, null);
    assert.equal(result.receipt.outcome.cleanup.complete, true);
  } finally { await fixture.cleanup(); }
});

test("offline CLI creates, reopens, edits and exports without provider probes", async () => {
  const fixture = await fakeCodex();
  const bin = fileURLToPath(new URL("../bin/research-ai.mjs", import.meta.url));
  const sourcesFile = join(fixture.root, "sources.json");
  const columnsFile = join(fixture.root, "columns.json");
  const tableFile = join(fixture.root, "table.json");
  const editFile = join(fixture.root, "edit.json");
  await writeFile(sourcesFile, JSON.stringify(sources));
  await writeFile(columnsFile, JSON.stringify(columns));
  const cli = (...args) => new Promise((resolve) => execFile(process.execPath, [bin, ...args], { env: fixture.env }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })));
  try {
    const created = await cli("--evidence-create", "--sources", sourcesFile, "--evidence-columns", columnsFile, "Compare");
    assert.equal(created.code, 0, created.stderr);
    await writeFile(tableFile, created.stdout);
    await writeFile(editFile, JSON.stringify({ question: "Compare current captured values" }));
    const edited = await cli("--evidence-input", tableFile, "--evidence-edit", editFile);
    assert.equal(edited.code, 0, edited.stderr);
    assert.match(edited.stdout, /^\s*\{/, JSON.stringify(edited));
    assert.doesNotThrow(() => JSON.parse(edited.stdout), JSON.stringify(edited));
    assert.equal(JSON.parse(edited.stdout).origin.type, "user-modified");
    await writeFile(tableFile, edited.stdout);
    const markdown = await cli("--evidence-input", tableFile, "--evidence-format", "markdown");
    assert.match(markdown.stdout, /^# Compare current captured values/);
    assert.deepEqual(await fixture.probes(), []);
    await fixture.scenario({ events: reply(modelRows) });
    const drafted = await cli("--evidence-draft", "--sources", sourcesFile, "--evidence-columns", columnsFile, "--model", "fixture", "Compare retention and backups");
    assert.equal(drafted.code, 0, drafted.stderr);
    assert.equal(JSON.parse(drafted.stdout).draft.version, "research-evidence-table-v1");
    assert.equal((await fixture.probes()).filter((args) => args[0] === "exec" && args[1] !== "--help").length, 1);
  } finally { await fixture.cleanup(); }
});
