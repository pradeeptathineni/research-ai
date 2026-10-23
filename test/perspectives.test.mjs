import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  basicFacts,
  chooseLenses,
  perspectiveCandidates,
  perspectiveResearch,
} from "../src/index.mjs";
import { fakeCodex, message } from "./fake-codex.mjs";

const sources = [
  {
    uri: "https://example.org/storage",
    text: "# Home batteries\n## Costs\nPack prices fell to $139/kWh in 2023.\n## Safety\nThermal runaway is rare but severe.\n## References\n1. Synthetic list.",
    observedAt: "2026-10-22",
    omissions: ["Warranty terms not captured"],
  },
  {
    uri: "https://example.net/grid",
    text: "## Costs\nInstallation adds labor.\n## Grid services\nBatteries can provide frequency response.",
  },
];
const span = (source, quote) => {
  const start = sources[source].text.indexOf(quote);
  return { source, start, end: start + quote.length };
};
const reply = (questions, omissions = []) => [
  message(JSON.stringify({ questions, omissions })),
  { type: "turn.completed" },
];
const answered = (question, source, quote) => ({
  question,
  status: "answered",
  answer: `Authored fixture answer quoting "${quote}".`,
  citations: [span(source, quote)],
});
const unanswered = (question) => ({
  question,
  status: "unanswered",
  answer: "Authored fixture: the capture does not say.",
  citations: [],
});

test("heading candidates are grounded in exact source offsets, generic sections excluded", () => {
  const candidates = perspectiveCandidates(sources);
  assert.deepEqual(
    candidates.map((c) => c.label),
    ["Costs", "Home batteries", "Safety", "Grid services"],
  );
  const costs = candidates[0];
  assert.equal(costs.origin, "heading");
  assert.deepEqual(new Set(costs.evidence.map((e) => e.source)), new Set([0, 1]));
  for (const c of candidates)
    for (const e of c.evidence)
      assert.equal(sources[e.source].text.slice(e.start, e.end), e.heading);
  assert.ok(!candidates.some((c) => c.label === "References"));
});

test("basic facts is always first; explicit lenses and ids are validated", () => {
  const auto = chooseLenses(sources, "auto");
  assert.equal(auto[0], basicFacts);
  assert.equal(auto.length, 4);
  const chosen = chooseLenses(sources, [
    "heading-safety",
    "basic-facts",
    { label: "Renter", focus: "What matters to someone who cannot modify the building?" },
  ]);
  assert.deepEqual(
    chosen.map((l) => [l.id, l.origin]),
    [
      ["basic-facts", "default"],
      ["heading-safety", "heading"],
      ["explicit-renter", "explicit"],
    ],
  );
  for (const bad of [["heading-pricing"], [{ label: "x" }], Array(7).fill("heading-costs"), [{ label: "a", focus: "b", role: "expert" }]])
    assert.throws(() => chooseLenses(sources, bad), /invalid_perspectives/);
});

test("distinct lens sessions assemble comparable, provenance-bound results", async () => {
  const fixture = await fakeCodex({
    sessions: [
      { events: reply([answered("What do batteries cost?", 0, "Pack prices fell to $139/kWh in 2023."), unanswered("Who installs them?")], ["Installer names"]) },
      { events: reply([answered("What is the main risk?", 0, "Thermal runaway is rare but severe.")]) },
      // Out-of-range offsets reject this lens rather than accepting part of it
      { events: reply([{ ...answered("Bad", 1, "Installation adds labor."), citations: [{ source: 1, start: 0, end: 9999 }] }]) },
    ],
  });
  try {
    const states = [];
    const result = await perspectiveResearch("Should a household add battery storage?", {
      sources,
      perspectives: ["heading-safety", "heading-grid-services"],
      lease: fixture.lease,
      model: "fixture",
      onLens: (event) => states.push(`${event.id}:${event.state}`),
    });
    assert.equal(result.version, "perspectives-v1");
    assert.equal(result.status, "partial");
    assert.deepEqual(
      result.lenses.map((l) => [l.lens.id, l.status]),
      [
        ["basic-facts", "complete"],
        ["heading-safety", "complete"],
        ["heading-grid-services", "failed"],
      ],
    );
    assert.equal(result.lenses[2].reason, "invalid_perspective_output");
    assert.equal(result.lenses[0].questions[0].citations[0].quote, "Pack prices fell to $139/kWh in 2023.");
    assert.deepEqual(result.comparison[0], {
      lens: "basic-facts", status: "complete", answered: 1, partial: 0, unanswered: 1, sourcesCited: [0],
    });
    assert.deepEqual(result.unanswered, [{ lens: "basic-facts", question: "Who installs them?", status: "unanswered" }]);
    assert.deepEqual(
      result.omissions.map((o) => o.by + ":" + o.note),
      [
        "caller:Warranty terms not captured",
        "lens:Installer names",
        "runner:Lens failed: invalid_perspective_output",
      ],
    );
    assert.ok(result.sources.every((s) => !("text" in s) && s.sha256.length === 64));
    assert.deepEqual(states, [
      "basic-facts:running", "basic-facts:complete",
      "heading-safety:running", "heading-safety:complete",
      "heading-grid-services:running", "heading-grid-services:failed",
    ]);
    const first = await fixture.session(0);
    const second = await fixture.session(1);
    assert.ok(first.args.includes("--output-schema"));
    assert.match(first.args.join(" "), /web_search="disabled"/);
    assert.match(first.prompt, /"label":"Basic facts"/);
    assert.match(second.prompt, /"label":"Safety"/);
    // Lenses never see another lens's answers
    assert.doesNotMatch(second.prompt, /Who installs them/);
    assert.match(second.prompt, /not an identity or expertise/);
  } finally {
    await fixture.cleanup();
  }
});

test("cancellation stops the running lens and leaves later lenses not run", async () => {
  const fixture = await fakeCodex({
    sessions: [{ events: reply([answered("Cost?", 1, "Installation adds labor.")]) }, { hang: true, events: [] }],
  });
  const controller = new AbortController();
  try {
    const result = await perspectiveResearch("Battery storage", {
      sources,
      perspectives: ["heading-costs", "heading-safety"],
      lease: fixture.lease,
      signal: controller.signal,
      onLens: ({ id, state }) => {
        if (id === "heading-costs" && state === "running") setTimeout(() => controller.abort(), 200);
      },
    });
    assert.equal(result.status, "cancelled");
    assert.deepEqual(
      result.lenses.map((l) => l.status),
      ["complete", "cancelled", "not_run"],
    );
    assert.equal(result.lenses[1].receipt.cleanup.complete, true);
    assert.equal(result.lenses[0].questions.length, 1, "completed lens output is kept");
  } finally {
    await fixture.cleanup();
  }
});

test("invalid sources or topic refuse before any session", async () => {
  const fixture = await fakeCodex();
  try {
    await assert.rejects(perspectiveResearch("t", { sources: [], lease: fixture.lease }), /invalid_sources/);
    await assert.rejects(perspectiveResearch(" ", { sources, lease: fixture.lease }), /topic_required/);
    await assert.rejects(
      perspectiveResearch("t", { sources, questions: 9, lease: fixture.lease }),
      /invalid_question_limit/,
    );
    assert.equal(await fixture.launched(), false);
  } finally {
    await fixture.cleanup();
  }
});

test("CLI lists candidates without a session and runs perspectives with exit codes", async () => {
  const fixture = await fakeCodex({
    sessions: [{ events: reply([answered("Cost?", 1, "Installation adds labor.")]) }],
  });
  const bin = fileURLToPath(new URL("../bin/research-ai.mjs", import.meta.url));
  const file = join(fixture.root, "sources.json");
  await writeFile(file, JSON.stringify(sources));
  const cli = (...args) =>
    new Promise((resolve) =>
      execFile(process.execPath, [bin, ...args], { env: fixture.env }, (error, stdout, stderr) =>
        resolve({ code: error ? error.code : 0, stdout, stderr })),
    );
  try {
    const listed = await cli("--sources", file, "--list-perspectives");
    assert.equal(listed.code, 0);
    assert.equal(JSON.parse(listed.stdout)[0].id, "heading-costs");
    assert.equal(await fixture.launched(), false);
    assert.equal((await cli("--perspectives", "auto", "topic")).code, 1, "requires --sources");
    const lenses = join(fixture.root, "lenses.json");
    await writeFile(lenses, JSON.stringify(["heading-costs"]));
    const run = await cli("--sources", file, "--perspectives", lenses, "--questions", "1", "Battery storage");
    assert.equal(run.code, 0);
    const result = JSON.parse(run.stdout);
    assert.deepEqual(result.lenses.map((l) => l.lens.id), ["basic-facts", "heading-costs"]);
    assert.match(run.stderr, /Lens heading-costs: complete/);
  } finally {
    await fixture.cleanup();
  }
});
