import { test } from "node:test";
import assert from "node:assert/strict";
import {
  groundedAnswer,
  groundedResearchQuestion,
  validateGrounding,
  assessGroundedAnswer,
} from "../src/index.mjs";
import { fakeCodex, message } from "./fake-codex.mjs";

const j = (verdict) => ({
  verdict,
  reason: `Authored ${verdict} judgment; not a model evaluation.`,
});
const sources = [
  {
    uri: "https://example.org/guide#exports",
    text: "# Exports\nPlain files export. 😀\nOffline mode is unavailable.",
    observedAt: "2026-10-22",
    omissions: ["Pricing not captured"],
  },
  {
    uri: "https://example.net/manual",
    text: "Offline mode works. Exports require an account.",
  },
];
const cite = (source, quote, alone = "supports", without = "insufficient") => ({
  source,
  start: sources[source].text.indexOf(quote),
  end: sources[source].text.indexOf(quote) + quote.length,
  alone: j(alone),
  without: j(without),
});
const claims = [
  {
    text: "Plain files export.",
    joint: j("supports"),
    citations: [cite(0, "Plain files export.")],
  },
  {
    text: "Offline mode works.",
    joint: j("supports"),
    citations: [
      cite(0, "Offline mode is unavailable.", "contradicts"),
      cite(1, "Offline mode works."),
    ],
  },
  {
    text: "Pricing is unknown in these captures.",
    joint: j("insufficient"),
    citations: [],
  },
];
const judge = { id: "authored-offline-fixture", kind: "synthetic" };
test("caller judge sees only selected evidence and cannot settle a cancelled assessment", async () => {
  const calls = [];
  const input = {
    sources,
    claims: [
      {
        text: "Compound claim.",
        citations: [
          cite(0, "Plain files export."),
          cite(1, "Offline mode works."),
        ].map(({ source, start, end }) => ({ source, start, end })),
      },
    ],
  };
  const result = await assessGroundedAnswer(input, {
    identity: judge,
    judge: async (request) => {
      calls.push(request);
      return j(request.passages.length === 2 ? "supports" : "insufficient");
    },
  });
  assert.equal(calls.length, 5);
  assert.equal(result.grounding.claims[0].support, "supported");
  assert.ok(
    calls.every((c) => c.passages.every((p) => !p.quote.includes("account"))),
  );
  const controller = new AbortController();
  await assert.rejects(
    assessGroundedAnswer(input, {
      identity: judge,
      signal: controller.signal,
      judge: async () => {
        controller.abort();
        return j("supports");
      },
    }),
    { name: "AbortError" },
  );
});
test("exact UTF16 spans, provenance, unsupported and conflicting claims survive replay", () => {
  const { answer, grounding } = groundedAnswer({ sources, claims, judge });
  assert.deepEqual(
    grounding.claims.map((c) => c.support),
    ["supported", "conflicting", "unsupported"],
  );
  assert.equal(grounding.estimates.supportRecall, null);
  assert.equal(grounding.sources[0].omissions[0], "Pricing not captured");
  assert.deepEqual(
    validateGrounding(answer, structuredClone(grounding)),
    grounding,
  );
  for (const claim of grounding.claims)
    assert.equal(answer.slice(claim.start, claim.end), claim.text);
  for (const mutate of [
    (g) => (g.sources[0].text += "tampered"),
    (g) => (g.claims[0].citations[0].quote = "invented"),
    (g) => (g.claims[2].support = "supported"),
    (g) => (g.estimates.supportRecall = 1),
    (g) => (g.judge.extra = true),
  ]) {
    const copy = structuredClone(grounding);
    mutate(copy);
    assert.throws(() => validateGrounding(answer, copy), /invalid_grounding/);
  }
  assert.throws(
    () => validateGrounding(answer + "!", grounding),
    /invalid_grounding/,
  );
});
test("ALCE joint, alone and leave-one-out distinguish joint necessity from overcitation", () => {
  const { grounding } = groundedAnswer({
    sources,
    judge,
    claims: [
      {
        text: "A compound synthetic claim.",
        joint: j("supports"),
        citations: [
          cite(0, "Plain files export.", "insufficient", "insufficient"),
          cite(1, "Offline mode works.", "insufficient", "supports"),
        ],
      },
    ],
  });
  assert.deepEqual(
    grounding.claims[0].citations.map((c) => c.contribution),
    ["necessary", "unnecessary"],
  );
  assert.deepEqual(grounding.estimates, {
    supportRecall: 1,
    citationPrecision: 0.5,
  });
});
test("abstentions and malformed or uncited support never earn supported status", () => {
  const claim = {
    text: "Uncertain.",
    joint: j("unknown"),
    citations: [cite(0, "Plain files export.", "unknown")],
  };
  assert.equal(
    groundedAnswer({ sources, claims: [claim], judge }).grounding.claims[0]
      .support,
    "unknown",
  );
  for (const citations of [
    [{ ...cite(0, "Plain files export."), source: 9 }],
    [cite(0, "Plain files export."), cite(0, "Plain files export.")],
    [{ ...cite(0, "Plain files export."), end: 9999 }],
    [],
  ])
    assert.throws(
      () =>
        groundedAnswer({
          sources,
          judge,
          claims: [{ text: "Bad.", joint: j("supports"), citations }],
        }),
      /invalid_grounding/,
    );
});
test("one frozen native session binds schema output; cancellation and invalid spans fail closed", async () => {
  const fixture = await fakeCodex({
    events: [message(JSON.stringify({ claims })), { type: "turn.completed" }],
  });
  try {
    const run = (extra = {}) =>
      groundedResearchQuestion("What do these captures establish?", {
        sources,
        lease: fixture.lease,
        model: "fixture",
        ...extra,
      });
    const result = await run();
    assert.equal(result.status, "complete");
    assert.equal(result.grounding.judge.kind, "same-session-model");
    const record = await fixture.record();
    assert.ok(record.args.includes("--output-schema"));
    assert.match(record.args.join(" "), /web_search="disabled"/);
    assert.match(record.prompt, /untrusted data/);
    const invalid = structuredClone(claims);
    invalid[0].citations[0].source = 99;
    await fixture.scenario({
      events: [
        message(JSON.stringify({ claims: invalid })),
        { type: "turn.completed" },
      ],
    });
    assert.equal((await run()).receipt.failure, "invalid_grounding");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(run({ signal: controller.signal }), {
      name: "AbortError",
    });
  } finally {
    await fixture.cleanup();
  }
});
