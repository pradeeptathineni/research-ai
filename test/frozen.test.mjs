import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ordinaryResearchPrompt, researchQuestion } from "../src/index.mjs";
import { fakeCodex, message } from "./fake-codex.mjs";

const bin = fileURLToPath(new URL("../bin/research-ai.mjs", import.meta.url));
let fixture;
beforeEach(async () => {
  fixture = await fakeCodex({
    events: [message("Frozen answer. Coverage unknown.")],
  });
});
afterEach(async () => {
  await fixture.cleanup();
});

const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const sources = () => [
  {
    uri: "https://example.org/guide",
    text: "Synthetic guide: format A exports plain files. Naïve ✓ 😀",
    observedAt: "caller says 2020-01-02",
    omissions: ["pricing page not captured", "comments omitted"],
  },
  {
    uri: "http://example.net/notes?x=1#top",
    text: "Synthetic notes: format B needs an app.",
  },
];
const run = (options = {}) =>
  researchQuestion("Which format fits?", {
    lease: fixture.lease,
    model: "fixture",
    ...options,
  });
const last = (stderr) => JSON.parse(stderr.trim().split("\n").at(-1));

describe("researchQuestion with sources", () => {
  it("runs frozen with search disabled and a labelled receipt; live is unchanged", async () => {
    const supplied = sources();
    const result = await run({
      sources: supplied,
      context: "single user",
      effort: "high",
    });
    assert.equal(result.status, "complete");
    assert.equal(result.answer, "Frozen answer. Coverage unknown.");
    assert.equal(result.receipt.mode, "frozen");
    assert.deepEqual(result.receipt.source, [
      {
        uri: supplied[0].uri,
        sha256: sha(supplied[0].text),
        observedAt: "caller says 2020-01-02",
        omissions: ["pricing page not captured", "comments omitted"],
      },
      { uri: supplied[1].uri, sha256: sha(supplied[1].text) },
    ]);
    assert.ok(!JSON.stringify(result.receipt).includes("Synthetic guide"));
    assert.equal(result.receipt.model, "fixture");
    assert.equal(result.receipt.effort, "high");
    const { args, prompt } = await fixture.record();
    assert.ok(args.includes('web_search="disabled"'));
    assert.ok(!args.includes('web_search="live"'));
    assert.ok(args.includes('model_reasoning_effort="high"'));
    assert.ok(
      prompt.includes(
        JSON.stringify({
          question: "Which format fits?",
          context: "single user",
        }),
      ),
    );
    assert.ok(prompt.includes(JSON.stringify(supplied)));
    for (const phrase of [
      /web search is disabled/,
      /untrusted data/,
      /citation identity/,
      /unknown unless the text itself says so/,
      /unchecked caller notes/,
      /leave unanswered/,
      /conditional on this material/,
      /stale/,
      /provisional/,
      /not verified truth/,
    ])
      assert.match(prompt, phrase);
    assert.ok(!prompt.includes("with your native web tools"));

    const live = await run();
    assert.equal(live.receipt.mode, undefined);
    assert.equal("source" in live.receipt, false);
    const record = await fixture.record();
    assert.ok(record.args.includes('web_search="live"'));
    assert.equal(
      record.prompt,
      ordinaryResearchPrompt("Which format fits?", undefined),
    );
  });

  it("accepts the exact combined text limit and keeps source order", async () => {
    const text = "é".repeat(24000);
    const result = await run({
      sources: [
        { uri: "https://example.org/a", text },
        { uri: "https://example.org/b", text },
      ],
    });
    assert.deepEqual(
      result.receipt.source.map((s) => s.uri),
      ["https://example.org/a", "https://example.org/b"],
    );
  });

  const big = "x".repeat(24001);
  const ok = { uri: "https://example.org/a", text: "text" };
  const refused = {
    "empty list": [],
    null: null,
    "not an array": { uri: ok.uri, text: ok.text },
    "nine sources": Array.from({ length: 9 }, (_, i) => ({
      ...ok,
      uri: `${ok.uri}/${i}`,
    })),
    hole: [ok, , { ...ok, uri: "https://example.org/b" }],
    "string entry": ["https://example.org/a"],
    "extra key": [{ ...ok, path: "/etc/hosts" }],
    "missing text": [{ uri: ok.uri }],
    "blank text": [{ ...ok, text: "  \n" }],
    "lone surrogate": [{ ...ok, text: "a\ud800b" }],
    "combined overflow": [
      { ...ok, text: big },
      { uri: "https://example.org/b", text: big },
    ],
    ftp: [{ ...ok, uri: "ftp://example.org/a" }],
    "file path": [{ ...ok, uri: "/tmp/private.txt" }],
    "file url": [{ ...ok, uri: "file:///tmp/private.txt" }],
    credentials: [{ ...ok, uri: "https://user:pw@example.org/a" }],
    "whitespace uri": [{ ...ok, uri: "https://example.org/a b" }],
    "duplicate uri": [ok, ok],
    "long uri": [{ ...ok, uri: `https://example.org/${"a".repeat(2000)}` }],
    "long observedAt": [{ ...ok, observedAt: "d".repeat(65) }],
    "multiline observedAt": [{ ...ok, observedAt: "a\nb" }],
    "too many omissions": [
      { ...ok, omissions: Array.from({ length: 9 }, () => "gap") },
    ],
    "omission not text": [{ ...ok, omissions: [3] }],
    "sparse omission array": [{ ...ok, omissions: Array(1) }],
    "omissions not array": [{ ...ok, omissions: "gap" }],
    "long omission": [{ ...ok, omissions: ["g".repeat(501)] }],
  };
  for (const [name, bad] of Object.entries(refused))
    it(`refuses ${name} before any lease or native session`, async () => {
      await assert.rejects(run({ sources: bad }), /invalid_sources/);
      assert.equal(await fixture.launched(), false);
      assert.equal(await exists(fixture.lease), false);
    });

  it("refuses oversized context in frozen mode only", async () => {
    await assert.rejects(
      run({ sources: [ok], context: "c".repeat(8001) }),
      /invalid_sources/,
    );
    await assert.rejects(run({ sources: [ok], context: 3 }), /invalid_sources/);
    assert.equal(await fixture.launched(), false);
    assert.equal((await run({ context: "c".repeat(8001) })).status, "complete");
  });

  it("never falls back to live when the native runner is absent", async () => {
    process.env.PATH = fixture.tmp;
    const result = await run({ sources: [ok] });
    assert.equal(result.status, "failed");
    assert.equal(result.receipt.nativeSessions, 0);
    assert.equal(result.receipt.mode, "frozen");
    assert.equal(result.receipt.source[0].sha256, sha("text"));
    assert.match(result.receipt.failure, /ENOENT/);
    assert.equal(await fixture.launched(), false);
  });

  it("returns a frozen partial after a runner failure, still without live search", async () => {
    await fixture.scenario({
      events: [message("Provisional note.")],
      exitCode: 1,
    });
    const result = await run({ sources: [ok] });
    assert.equal(result.status, "partial");
    assert.equal(result.answer, "Provisional note.");
    assert.equal(result.receipt.failure, "runner_failed");
    assert.equal(result.receipt.mode, "frozen");
    assert.ok((await fixture.record()).args.includes('web_search="disabled"'));
  });

  it("keeps the source receipt when interrupted", async () => {
    await fixture.scenario({
      events: [message("Provisional finding.")],
      hang: true,
    });
    const controller = new AbortController();
    const result = await run({
      sources: [ok],
      signal: controller.signal,
      onCheckpoint: () => controller.abort(),
    });
    assert.equal(result.status, "partial");
    assert.equal(result.receipt.failure, "cancelled");
    assert.equal(result.receipt.source.length, 1);
    assert.equal(await exists(fixture.lease), false);
  });
});

describe("research-ai --sources", () => {
  const cli = (...args) =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [bin, ...args],
        { env: fixture.env },
        (error, stdout, stderr) =>
          resolve({ code: error ? error.code : 0, stdout, stderr }),
      );
    });
  const file = async (content, name = "sources.json") => {
    const path = join(fixture.root, name);
    const raw = typeof content === "string" || Buffer.isBuffer(content);
    await writeFile(path, raw ? content : JSON.stringify(content));
    return path;
  };

  it("runs frozen from an explicit file and keeps the output contract", async () => {
    const supplied = sources();
    const path = await file(supplied);
    const { code, stdout, stderr } = await cli(
      "--sources",
      path,
      "--context",
      "ctx",
      "--model",
      "fixture",
      "--profile",
      "wide",
      "Which",
      "format?",
    );
    assert.equal(code, 0);
    assert.equal(stdout, "Frozen answer. Coverage unknown.\n");
    const receipt = last(stderr);
    assert.equal(receipt.status, "complete");
    assert.equal(receipt.mode, "frozen");
    assert.equal(receipt.profile, "wide");
    assert.equal(receipt.source[0].sha256, sha(supplied[0].text));
    assert.deepEqual(receipt.source[0].omissions, supplied[0].omissions);
    assert.ok(!stderr.includes("Synthetic guide"));
    const { args, prompt } = await fixture.record();
    assert.ok(args.includes('web_search="disabled"'));
    assert.ok(prompt.includes('"question":"Which format?","context":"ctx"'));
    assert.ok(prompt.includes(JSON.stringify(supplied)));

    const live = await cli("--model", "fixture", "Which", "format?");
    assert.equal(live.code, 0);
    assert.equal("mode" in last(live.stderr), false);
    assert.ok((await fixture.record()).args.includes('web_search="live"'));
  });

  it("exits 2 with the partial answer bytes", async () => {
    await fixture.scenario({
      events: [message("Provisional note.")],
      exitCode: 1,
    });
    const { code, stdout, stderr } = await cli(
      "--sources",
      await file(sources()),
      "q",
    );
    assert.equal(code, 2);
    assert.equal(stdout, "Provisional note.\n");
    assert.equal(last(stderr).status, "partial");
    assert.equal(last(stderr).mode, "frozen");
  });

  const negatives = async () => {
    await mkdir(join(fixture.root, "dir"));
    return {
      "missing file": join(fixture.root, "absent.json"),
      "a directory": join(fixture.root, "dir"),
      "malformed JSON": await file('[{"uri":'),
      "empty file": await file(""),
      "invalid UTF-8": await file(Buffer.from([0x5b, 0x22, 0xff, 0x22, 0x5d])),
      "oversized file": await file([
        { uri: "https://example.org/a", text: "x".repeat(262144) },
      ]),
      "empty list": await file("[]"),
      "object not list": await file(
        '{"uri":"https://example.org/a","text":"t"}',
      ),
      "bad source": await file([{ uri: "file:///etc/passwd", text: "t" }]),
    };
  };

  it("refuses unusable files without a session or fallback to live", async () => {
    for (const [name, path] of Object.entries(await negatives())) {
      const { code, stdout, stderr } = await cli("--sources", path, "q");
      assert.equal(code, 1, name);
      assert.equal(stdout, "", name);
      assert.match(stderr, /research-ai: .*(--sources|invalid_sources)/, name);
      assert.equal(await fixture.launched(), false, name);
    }
  });

  it("refuses oversized frozen context and a missing value", async () => {
    const path = await file(sources());
    const big = await cli(
      "--sources",
      path,
      "--context",
      "c".repeat(8001),
      "q",
    );
    assert.equal(big.code, 1);
    assert.match(big.stderr, /invalid_sources/);
    assert.equal((await cli("--sources")).code, 1);
    assert.equal(await fixture.launched(), false);
  });

  it("documents the file contract in help", async () => {
    const { stdout } = await cli("--help");
    assert.match(stdout, /--sources FILE/);
    assert.match(stdout, /sent\s+to the provider/);
  });
});
