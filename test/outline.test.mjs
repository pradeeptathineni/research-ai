import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { outlineResearch, renderOutline, reviseOutline, validateOutline } from "../src/index.mjs";
import { fakeCodex, message } from "./fake-codex.mjs";

const sources = [
  { uri: "https://example.org/a", text: "# Cost\nPack prices reached $139/kWh in 2023.\n" },
  { uri: "https://example.org/b", text: "## Safety\nThermal runaway is rare but severe." },
];
const modelDraft = { sections: [
  { title: "Costs", points: [{ text: "Captured prices reached $139/kWh in 2023.", citations: [{ source: 0, start: 7, end: 44 }] }], gaps: ["Warranty terms are absent from these captures."] },
  { title: "Safety", points: [{ text: "Thermal runaway is described as rare but severe.", citations: [{ source: 1, start: 10, end: 43 }] }], gaps: [] },
] };
const reply = (draft) => [message(JSON.stringify(draft)), { type: "turn.completed" }];

test("one frozen session returns source-bound ordered outline and honest gaps", async () => {
  const fixture = await fakeCodex({ events: reply(modelDraft) });
  try {
    const result = await outlineResearch("Home batteries", { sources, lease: fixture.lease, model: "fixture" });
    assert.equal(result.status, "complete");
    assert.equal(result.draft.version, "research-outline-v1");
    assert.deepEqual(result.draft.sections.map((section) => section.title), ["Costs", "Safety"]);
    assert.equal(result.draft.sections[0].points[0].citations[0].quote, "Pack prices reached $139/kWh in 2023.");
    assert.match(result.draft.sections[0].gaps[0], /Warranty/);
    assert.equal(result.receipt.outcome.nativeSessions, 1);
    assert.equal((await fixture.record()).args.includes("--output-schema"), true);
    assert.match((await fixture.record()).args.join(" "), /web_search="disabled"/);
  } finally { await fixture.cleanup(); }
});

test("validated user edits render in Markdown and JSON; broken source spans refuse the whole export", async () => {
  const fixture = await fakeCodex({ events: reply(modelDraft) });
  try {
    const { draft } = await outlineResearch("Home batteries", { sources, lease: fixture.lease });
    const revised = reviseOutline(draft, { sections: [...draft.sections].reverse().map((section, i) => i ? section : { ...section, title: "Safety notes" }) });
    assert.equal(revised.origin.type, "user-modified");
    assert.match(renderOutline(revised), /Safety notes/);
    assert.deepEqual(JSON.parse(renderOutline(revised, { format: "json" })).sections.map((s) => s.title), ["Safety notes", "Costs"]);
    const corrupt = structuredClone(revised);
    corrupt.sections[1].points[0].citations[0].quote = "fabricated";
    assert.throws(() => renderOutline(corrupt), /invalid_outline/);
    assert.throws(() => validateOutline({ ...revised, sections: [{ ...revised.sections[0], id: "oops", points: [{ text: "x", citations: [{ source: 0, start: 8, end: 8, quote: "" }] }] }] }), /invalid_outline/);
  } finally { await fixture.cleanup(); }
});

test("invalid inputs refuse before spawn and malformed generated spans never produce a draft", async () => {
  const fixture = await fakeCodex({ events: reply(modelDraft) });
  try {
    await assert.rejects(outlineResearch("topic", { sources: [], lease: fixture.lease }), /invalid_sources/);
    await assert.rejects(outlineResearch("topic", { sources, maxSections: 0, lease: fixture.lease }), /invalid_outline_limit/);
    assert.equal(await fixture.launched(), false);
  } finally { await fixture.cleanup(); }
  const bad = structuredClone(modelDraft);
  bad.sections[0].points[0].citations[0].end = 9999;
  const malformed = await fakeCodex({ events: reply(bad) });
  try {
    const result = await outlineResearch("topic", { sources, lease: malformed.lease });
    assert.equal(result.status, "failed");
    assert.equal(result.draft, null);
    assert.equal(result.receipt.failure, "invalid_outline");
  } finally { await malformed.cleanup(); }
});

test("failed and cancelled native outcomes keep receipts and never yield complete drafts", async () => {
  for (const [scenario, expected] of [
    [{ events: [message(JSON.stringify(modelDraft)), { type: "turn.failed", error: { message: "fixture failure" } }] }, "failed"],
    [{ hang: true, events: [] }, "cancelled"],
  ]) {
    const fixture = await fakeCodex(scenario);
    const controller = new AbortController();
    try {
      if (expected === "cancelled") setTimeout(() => controller.abort(), 100);
      const result = await outlineResearch("Home batteries", { sources, lease: fixture.lease, signal: controller.signal });
      assert.equal(result.status, expected);
      assert.equal(result.draft, null);
      assert.equal(result.receipt.outcome.cleanup.complete, true);
    } finally { await fixture.cleanup(); }
  }
});

test("offline validation uses UTF-16 boundaries and exports control characters visibly", () => {
  const text = "A 😀 B\u001b\u202e";
  const draft = {
    version: "research-outline-v1", topic: "Topic", sources: [{ uri: "https://example.org/a`b", text, sha256: createHash("sha256").update(text).digest("hex") }],
    sections: [{ id: "section-1", title: "Unicode", points: [{ text: "An emoji.", citations: [{ source: 0, start: 2, end: 4, quote: "😀" }] }, { text: "Control example.", citations: [{ source: 0, start: 6, end: 8, quote: text.slice(6, 8) }] }], gaps: [] }],
    origin: { type: "caller-authored" }, limits: [],
  };
  assert.equal(validateOutline(draft).sections[0].points[0].citations[0].quote, "😀");
  const split = structuredClone(draft);
  split.sections[0].points[0].citations[0] = { source: 0, start: 3, end: 4, quote: text.slice(3, 4) };
  assert.throws(() => validateOutline(split), /invalid_outline/);
  const markdown = renderOutline(draft);
  assert.match(markdown, /\\u001b/);
  assert.match(markdown, /\\u202e/);
  assert.match(markdown, /``https:\/\/example\.org\/a`b``/);
  assert.doesNotMatch(markdown, /\u001b|\u202e/);
  assert.equal(JSON.parse(renderOutline(draft, { format: "json" })).sources[0].text, text);
});

test("outline CLI exports JSON and formats drafts without another model session", async () => {
  const fixture = await fakeCodex({ events: reply(modelDraft) });
  const bin = fileURLToPath(new URL("../bin/research-ai.mjs", import.meta.url));
  const sourceFile = join(fixture.root, "sources.json");
  const draftFile = join(fixture.root, "draft.json");
  await writeFile(sourceFile, JSON.stringify(sources));
  const cli = (...args) => new Promise((resolve) => execFile(process.execPath, [bin, ...args], { env: fixture.env }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })));
  try {
    const created = await cli("--sources", sourceFile, "--outline", "--max-sections", "2", "Home batteries");
    assert.equal(created.code, 0);
    const result = JSON.parse(created.stdout);
    await writeFile(draftFile, JSON.stringify(result.draft));
    const formatted = await cli("--outline-input", draftFile);
    assert.equal(formatted.code, 0);
    assert.match(formatted.stdout, /## Costs/);
    const json = await cli("--outline-input", draftFile, "--outline-format", "json");
    assert.equal(JSON.parse(json.stdout).version, "research-outline-v1");
    assert.equal((await fixture.probes()).filter((args) => args[0] === "exec" && args[1] !== "--help").length, 1);
    assert.equal((await cli("--outline-input", draftFile, "--outline", "topic")).code, 1);
  } finally { await fixture.cleanup(); }
});
