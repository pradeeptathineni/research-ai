// Hierarchy/unsafe-construct negative cases adapted from SurfSense, copyright (c) SurfSense,
// Apache-2.0, e3de9e0d293b2ebb1fb813628ecc1d6f26909396. Changed for cited JSON trees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMindMap, validateMindMap, reviseMindMap, renderMindMap, mindMapResearch, mindMapLimits } from "../src/index.mjs";
import { fakeCodex, message } from "./fake-codex.mjs";

const sources = [
  { uri: "https://example.org/local", text: "Local search retains files on device.", observedAt: "synthetic capture", omissions: ["Retention duration unknown."] },
  { uri: "https://example.org/cloud", text: "Cloud indexing sends selected text to the provider.", omissions: ["Provider policy omitted."] },
];
const cite = (source, start = 0, end = sources[source].text.length) => ({ source, start, end, quote: sources[source].text.slice(start, end) });
const node = (id, label, citations = [], gap = null, children = []) => ({ id, label, relation: "elaborates", citations, gap, children });
const root = () => ({ ...node("root", "Where does search run?", [], null, [
  node("local", "Files stay on device for local search", [cite(0)]),
  { ...node("cloud", "Selected text goes to the cloud provider", [cite(1)]), relation: "contrasts" },
  node("retention", "Retention policy remains unknown", [], "Neither capture gives retention duration."),
]), relation: null });
const create = () => createMindMap("Where does search run?", { sources, root: root() });
const rawDraft = { rootLabel: "Where does search run?", nodes: [
  { parent: -1, label: "Files stay on device for local search", relation: "elaborates", citations: [{ source: 0, start: 0, end: sources[0].text.length }], gap: null },
  { parent: -1, label: "Selected text goes to the provider", relation: "contrasts", citations: [{ source: 1, start: 0, end: sources[1].text.length }], gap: null },
  { parent: 1, label: "Provider retention remains unknown", relation: "qualifies", citations: [], gap: "No retention policy in the captures." },
] };
const reply = (raw = rawDraft) => [message(JSON.stringify(raw)), { type: "turn.completed" }];
const tree = (map) => JSON.parse(renderMindMap(map, { format: "tree" }));

test("offline consumer selects exact captures, opens spans, edits, exports and reopens the same closure", () => {
  const map = create();
  assert.equal(map.origin.type, "caller-authored");
  for (const child of map.root.children) for (const citation of child.citations) {
    assert.equal(map.sources[citation.source].text.slice(citation.start, citation.end), citation.quote);
  }
  assert.deepEqual(map.sources.map(({ sha256, ...input }) => input), sources);
  const before = tree(map);
  const revised = reviseMindMap(map, { nodes: [{ id: "local", label: "Local files remain on the device", citations: [cite(0, 0, 12)] }] });
  assert.equal(revised.origin.type, "user-modified");
  assert.equal(map.root.children[0].label, root().children[0].label);
  assert.notEqual(tree(revised).contentSha256, before.contentSha256);
  const json = renderMindMap(revised, { format: "json" });
  const reopened = validateMindMap(JSON.parse(json));
  assert.equal(renderMindMap(reopened, { format: "json" }), json);
  assert.equal(tree(reopened).contentSha256, tree(revised).contentSha256);
  assert.deepEqual(reopened.sources, map.sources);
  assert.match(renderMindMap(reopened), /Retention policy remains unknown/);
  assert.deepEqual(before.nodes.map(({ id, level, position, setSize }) => [id, level, position, setSize]), [
    ["root", 1, 1, 1], ["local", 2, 1, 3], ["cloud", 2, 2, 3], ["retention", 2, 3, 3],
  ]);
  assert.match(before.nodes[3].accessibleName, /knowledge gap/);
  assert.equal(before.sources[0].text, undefined);
  assert.throws(() => validateMindMap(before), /invalid_mindmap/);
});

test("contradictory evidence stays in separate cited branches with an explicit unresolved gap", () => {
  const contradictory = [{ uri: "https://example.org/a", text: "Files stay local." }, { uri: "https://example.org/b", text: "Files leave the device." }];
  const conflictRoot = { ...root(), children: [
    node("a", "First capture says files stay local", [{ source: 0, start: 0, end: 17, quote: "Files stay local." }]),
    { ...node("b", "Second capture says files leave", [{ source: 1, start: 0, end: contradictory[1].text.length, quote: contradictory[1].text }]), relation: "contrasts" },
    node("unresolved", "The captures disagree", [], "Scope and dates needed to resolve disagreement."),
  ] };
  const map = createMindMap("Do files leave?", { sources: contradictory, root: conflictRoot });
  assert.deepEqual(tree(map).nodes.slice(1, 3).map((n) => n.citations[0].source), [0, 1]);
  assert.match(renderMindMap(map), /The captures disagree/);
});

test("SurfSense hierarchy limits and negative cases refuse the whole closed tree", () => {
  const cases = [
    (m) => { m.root.children = []; },
    (m) => { m.root.children[0].label = ""; },
    (m) => { m.root.children[0].label = "x".repeat(121); },
    (m) => { m.root.children[0].id = "Bad ID"; },
    (m) => { m.root.children[0].id = "root"; },
    (m) => { m.root.children[0].extra = true; },
    (m) => { m.root.children[0].citations = []; },
    (m) => { m.root.children[0].gap = "Also a gap"; },
    (m) => { m.root.children = Array.from({ length: 9 }, (_, i) => node(`n${i}`, "Gap", [], "Unknown")); },
    (m) => { let cursor = m.root; for (let i = 0; i < 6; i++) { cursor.children = [node(`deep${i}`, "Gap", [], "Unknown")]; cursor = cursor.children[0]; } },
    (m) => { m.root.children = Array.from({ length: 8 }, (_, i) => node(`b${i}`, "Gap", [], "Unknown", Array.from({ length: 7 }, (_, j) => node(`b${i}-${j}`, "Gap", [], "Unknown")))); },
    (m) => { m.sources[0].sha256 = "0".repeat(64); },
    (m) => { m.root.children[0].citations[0].quote = "fabricated"; },
    (m) => { m.root.children[0].citations[0].end = 99999; },
    (m) => { m.root.children[0].citations[0].source = 8; },
    (m) => { m.root.children[0].citations.push(m.root.children[0].citations[0]); },
    (m) => { m.root.children[0].children = new Array(1); },
    (m) => { m.sources[0] = null; },
    (m) => { m.limits = []; },
  ];
  for (const mutate of cases) {
    const map = create();
    mutate(map);
    assert.throws(() => renderMindMap(map), /invalid_mindmap/);
  }
  const cycle = create();
  cycle.root.children[0].children.push(cycle.root);
  assert.throws(() => validateMindMap(cycle), /invalid_mindmap/);
  assert.throws(() => reviseMindMap(create(), { root: null }), /invalid_mindmap/);
  assert.throws(() => reviseMindMap(create(), { nodes: [{ id: "absent", label: "Unknown" }] }), /invalid_mindmap/);
  assert.equal(mindMapLimits.nodes, 60);
});

test("a full 60-node hierarchy fits; an oversized reopenable closure is refused", () => {
  const largeRoot = root();
  largeRoot.children = Array.from({ length: 7 }, (_, i) => node(`b${i}`, "Cited concept", [cite(0)], null,
    Array.from({ length: i < 3 ? 8 : 7 }, (_, j) => node(`b${i}-${j}`, "Cited detail", [cite(0)]))));
  const map = createMindMap("Full tree", { sources, root: largeRoot });
  assert.equal(tree(map).nodes.length, 60);
  const texts = Array.from({ length: 4 }, (_, i) => ({ uri: `https://example.org/${i}`, text: "\u001b".repeat(4000) }));
  const huge = structuredClone(largeRoot);
  const expand = (n) => {
    n.citations = texts.map(({ text }, i) => ({ source: i, start: 0, end: text.length, quote: text }));
    n.children.forEach(expand);
  };
  huge.children.forEach(expand);
  assert.throws(() => createMindMap("Oversized", { sources: texts, root: huge }), /exceeds 1 MiB/);
});

test("ported unsafe constructs and additional directive/scheme cases reject labels and gaps", () => {
  for (const label of ["[link](https://example.com)", "<script>alert(1)</script>", "```python", "~~~python", "::: directive", "![image][asset]", "[link][target]", "%%{init:bad}%%", "javascript:evil", "www.example.org", "<any text>", "Line\nTwo", "hidden\u202e", "split\ud800"]) {
    for (const field of ["label", "gap"]) {
      const map = create();
      map.root.children[field === "gap" ? 2 : 0][field] = label;
      assert.throws(() => validateMindMap(map), /invalid_mindmap/, JSON.stringify(label));
    }
  }
});

test("UTF-16 spans reject surrogate splits; hostile originals and qualifications reopen byte-exactly", () => {
  const text = "A \ud83d\ude00 <script>bad</script>\u001b\u202e\u{e0001}";
  const map = createMindMap("Unicode", { sources: [{ uri: "https://example.org/a`b", text, omissions: ["<img src=x> [click](javascript:evil)\u202e"] }], root: {
    ...root(), children: [node("emoji", "An emoji", [{ source: 0, start: 2, end: 4, quote: text.slice(2, 4) }]), node("raw", "Original text", [{ source: 0, start: 4, end: text.length, quote: text.slice(4) }])],
  } });
  const split = structuredClone(map);
  split.root.children[0].citations[0] = { source: 0, start: 3, end: 4, quote: text.slice(3, 4) };
  assert.throws(() => validateMindMap(split), /surrogate/);
  const markdown = renderMindMap(map);
  assert.doesNotMatch(markdown, /\u001b|\u202e/);
  assert.match(markdown, /\\u001b/);
  assert.match(markdown, /Caller omission\/qualification: &lt;img/);
  assert.match(markdown, /``https:\/\/example.org\/a`b``/);
  assert.equal(JSON.parse(renderMindMap(map, { format: "json" })).sources[0].text, text);
  assert.deepEqual(validateMindMap(JSON.parse(renderMindMap(map, { format: "json" }))), map);
});

test("generated map binds content, sources and limitations; edits preserve the historical receipt", async () => {
  const reordered = structuredClone(rawDraft);
  reordered.nodes[0].citations[0] = { end: sources[0].text.length, start: 0, source: 0 };
  const fixture = await fakeCodex({ events: reply(reordered) });
  const activity = [];
  try {
    const result = await mindMapResearch("Where does search run?", { sources, lease: fixture.lease, model: "fixture", activity: (event) => { activity.push(event); } });
    assert.equal(result.status, "complete");
    assert.equal(result.map.origin.type, "model-generated");
    assert.equal(tree(result.map).contentSha256, result.map.origin.receipt.contentSha256);
    assert.equal(result.receipt.outcome.cleanup.complete, true);
    const invocation = await fixture.record();
    assert.match(invocation.args.join(" "), /web_search="disabled"/);
    assert.ok(invocation.args.includes("--output-schema"));
    assert.equal(activity.at(-1).kind, "session.settled");
    assert.doesNotMatch(JSON.stringify(activity), /rootLabel|Files stay|reasoning/);
    for (const change of [(m) => { m.root.children[0].label = "Edited"; }, (m) => { m.sources[0].observedAt = "changed note"; }, (m) => { m.limits.push("New limitation"); }]) {
      const direct = structuredClone(result.map); change(direct);
      assert.throws(() => validateMindMap(direct), /content does not match/);
    }
    const revised = reviseMindMap(result.map, { nodes: [{ id: "n1", label: "Local search keeps files on device" }] });
    assert.equal(revised.origin.type, "user-modified");
    assert.equal(revised.origin.receipt.contentSha256, result.map.origin.receipt.contentSha256);
    assert.notEqual(tree(revised).contentSha256, tree(result.map).contentSha256);
    assert.equal(reviseMindMap(result.map, {}).origin.type, "model-generated");
    assert.match(renderMindMap(result.map), /not authenticated/);
    const replacement = structuredClone(result.map.root);
    const saved = JSON.stringify(replacement);
    reviseMindMap(result.map, { root: replacement, nodes: [{ id: "n1", label: "A changed label" }] });
    assert.equal(JSON.stringify(replacement), saved);
  } finally { await fixture.cleanup(); }
});

test("malformed/hostile native output never returns a successful map", async () => {
  for (const mutate of [
    (r) => { r.unexpected = true; },
    (r) => { r.nodes[0].citations[0].quote = "not accepted from model"; },
    (r) => { r.nodes[0].citations[0].end = 9999; },
    (r) => { r.nodes[0].parent = 0; },
    (r) => { r.nodes[0].label = "<script>unsafe</script>"; },
    (r) => { r.nodes[0].citations = []; },
  ]) {
    const raw = structuredClone(rawDraft); mutate(raw);
    const fixture = await fakeCodex({ events: reply(raw) });
    try {
      const result = await mindMapResearch("Question", { sources, lease: fixture.lease });
      assert.equal(result.status, "failed");
      assert.equal(result.map, null);
      assert.equal(result.receipt.failure, "invalid_mindmap_output");
      assert.equal(result.receipt.outcome.cleanup.complete, true);
    } finally { await fixture.cleanup(); }
  }
});

test("native failure, cancellation and protocol contradiction keep outcome distinctions without a map", async () => {
  for (const [scenario, cancelled] of [
    [{ events: [message(JSON.stringify(rawDraft)), { type: "turn.failed" }] }, false],
    [{ events: [message("not JSON"), { type: "turn.completed" }] }, false],
    [{ events: [...reply(), { type: "turn.started" }] }, false],
    [{ events: [], hang: true }, true],
  ]) {
    const fixture = await fakeCodex(scenario);
    const controller = new AbortController();
    try {
      if (cancelled) setTimeout(() => controller.abort(), 100);
      const result = await mindMapResearch("Question", { sources, lease: fixture.lease, signal: controller.signal });
      assert.equal(result.status, cancelled ? "cancelled" : "failed");
      assert.equal(result.map, null);
      assert.ok(result.receipt.failure);
      assert.equal(result.receipt.outcome.cleanup.complete, true);
    } finally { await fixture.cleanup(); }
  }
});

test("invalid sources refuse before session and activity observer failure drains the guarded session", async () => {
  const fixture = await fakeCodex({ events: reply() });
  try {
    await assert.rejects(mindMapResearch("Question", { sources: [], lease: fixture.lease }), /invalid_sources/);
    assert.equal(await fixture.launched(), false);
    const result = await mindMapResearch("Question", { sources, lease: fixture.lease, activity: () => { throw new Error("observer failed"); } });
    assert.equal(result.status, "failed");
    assert.equal(result.map, null);
    assert.equal(result.receipt.outcome.termination.trigger, "activity_callback_failed");
    assert.equal(result.receipt.outcome.cleanup.complete, true);
  } finally { await fixture.cleanup(); }
});

test("CLI create/edit/export stay offline and native draft is explicit with strict mixed modes", async () => {
  const fixture = await fakeCodex({ events: reply() });
  const bin = fileURLToPath(new URL("../bin/research-ai.mjs", import.meta.url));
  const sourceFile = join(fixture.root, "sources.json");
  const rootFile = join(fixture.root, "root.json");
  const mapFile = join(fixture.root, "map.json");
  const editFile = join(fixture.root, "edits.json");
  const cli = (...args) => new Promise((resolve) => execFile(process.execPath, [bin, ...args], { env: fixture.env }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })));
  try {
    await writeFile(sourceFile, JSON.stringify(sources));
    await writeFile(rootFile, JSON.stringify(root()));
    await writeFile(editFile, JSON.stringify({ nodes: [{ id: "local", label: "Local files stay on device" }] }));
    const created = await cli("--mindmap-create", "--sources", sourceFile, "--mindmap-root", rootFile, "Where does search run?");
    assert.equal(created.code, 0, created.stderr);
    await writeFile(mapFile, created.stdout);
    const edited = await cli("--mindmap-input", mapFile, "--mindmap-edit", editFile);
    assert.equal(edited.code, 0, edited.stderr);
    assert.equal(JSON.parse(edited.stdout).origin.type, "user-modified");
    for (const format of ["markdown", "json", "tree"]) {
      assert.equal((await cli("--mindmap-input", mapFile, "--mindmap-format", format)).code, 0);
    }
    assert.deepEqual(await fixture.probes(), []);
    assert.equal(await fixture.launched(), false);
    for (const args of [["--readiness"], ["--outline"], ["--model", "bad"], ["--report-create"]]) {
      assert.equal((await cli("--mindmap-input", mapFile, ...args)).code, 1);
    }
    assert.equal((await cli("--mindmap-format", "tree", "Question")).code, 1);
    await writeFile(mapFile, Buffer.from([0xff]));
    assert.equal((await cli("--mindmap-input", mapFile)).code, 1);
    await writeFile(mapFile, " ".repeat(1048577));
    assert.equal((await cli("--mindmap-input", mapFile)).code, 1);
    const drafted = await cli("--mindmap-draft", "--sources", sourceFile, "Where does search run?");
    assert.equal(drafted.code, 0, drafted.stderr);
    const result = JSON.parse(drafted.stdout);
    assert.equal(result.map.origin.type, "model-generated");
    assert.equal(result.receipt.outcome.cleanup.complete, true);
    assert.equal((await fixture.probes()).filter((args) => args[0] === "exec" && args[1] !== "--help").length, 1);
  } finally { await fixture.cleanup(); }
});
