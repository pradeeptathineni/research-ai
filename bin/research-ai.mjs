#!/usr/bin/env node
import { open, stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  codexReadiness,
  profiles,
  researchQuestion,
  groundedResearchQuestion,
  perspectiveCandidates,
  perspectiveResearch,
  outlineResearch,
  renderOutline,
} from "../src/index.mjs";

const sourcesFileLimit = 256 * 1024;

/** Reads one explicit regular file of at most 256 KiB as a JSON array; nothing else is opened. */
async function readSourcesFile(path) {
  const refuse = (why) => new Error(`--sources ${why}`);
  const regular = (info) => info.isFile() && info.size <= sourcesFileLimit;
  let handle;
  try {
    if (!regular(await stat(path)))
      throw refuse("must be a regular file of at most 256 KiB");
    handle = await open(path, "r");
    if (!regular(await handle.stat()))
      throw refuse("must be a regular file of at most 256 KiB");
    const buffer = Buffer.alloc(sourcesFileLimit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > sourcesFileLimit) throw refuse("file grew beyond 256 KiB");
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, bytesRead),
      ),
    );
  } catch (failure) {
    if (failure.message?.startsWith("--sources")) throw failure;
    throw refuse(
      failure instanceof SyntaxError || failure instanceof TypeError
        ? "must be UTF-8 JSON"
        : `cannot be read (${failure.code ?? "error"})`,
    );
  } finally {
    await handle?.close();
  }
}

const usage = `Usage: research-ai [options] <question>

Runs one bounded, read-only, ephemeral Codex research session and prints a
fallible Markdown answer to stdout and a JSON receipt to stderr. Nothing is saved.

Options:
  --profile quick|wide   action/time budget (default quick: 8 searches, 20 reads, 240s)
  --context TEXT         extra untrusted context for the question
  --sources FILE         frozen review of supplied sources instead of live web search:
                         FILE is a JSON array (1-8, regular file <=256 KiB) of
                         {"uri","text","observedAt"?,"omissions"?[]}. Its contents are sent
                         to the provider; nothing is fetched. Context is then <=8,000 chars.
  --grounded             with --sources, print a claim-support-v1 JSON result instead
                         of Markdown (same-session judgments, not verification)
  --perspectives auto|FILE
                         with --sources, treat the question as a topic and print a
                         perspectives-v1 JSON result: a basic-facts lens plus heading
                         lenses (auto) or a JSON array of heading ids/{label,focus};
                         one frozen session per lens, run in order; partial or
                         cancelled lenses exit 2
  --questions N          questions per lens, 1-4 (default 3)
  --list-perspectives    with --sources, print heading lens candidates; no session
  --outline              with --sources, create a cited research-outline-v1 JSON draft
  --max-sections N       outline section limit, 1-8 (default 6)
  --outline-input FILE   validate and format an existing outline draft without a session
  --outline-format FMT   markdown|json (default markdown)
  --model NAME           Codex model (default: ~/.codex/config.toml or CLI default)
  --effort LEVEL         reasoning effort (default: config or CLI default)
  --readiness            report installation/auth/profile observations without inference
  -h, --help             show this help

Exit codes: 0 complete, 2 partial answer, 1 failure or usage error.
Answers are research, not verified truth; sources and claims need checking.`;

const fail = (text) => {
  process.stderr.write(`${text}\n`);
  return 1;
};

// Exit codes are set, not forced, so asynchronous pipe writes are never truncated.
async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        profile: { type: "string" },
        context: { type: "string" },
        sources: { type: "string" },
        grounded: { type: "boolean" },
        perspectives: { type: "string" },
        questions: { type: "string" },
        "list-perspectives": { type: "boolean" },
        outline: { type: "boolean" },
        "max-sections": { type: "string" },
        "outline-input": { type: "string" },
        "outline-format": { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        readiness: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (failure) {
    return fail(`${failure.message}\n${usage}`);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  if (values.readiness && (values["outline-input"] !== undefined || values.outline || values.sources || values.grounded || values.perspectives !== undefined || values["list-perspectives"] || positionals.length)) return fail("--readiness cannot be combined with a research mode");
  if (values.readiness) {
    const state = await codexReadiness();
    process.stdout.write(`${JSON.stringify(state)}\n`);
    return state.available ? 0 : 1;
  }
  if (values["outline-input"] !== undefined) {
    if (values.outline || values.sources || values.grounded || values.perspectives !== undefined || values["list-perspectives"] || positionals.length || values.model || values.effort || values.context || values["max-sections"] || values.readiness)
      return fail("--outline-input cannot be combined with research/session options");
    try {
      const file = await readSourcesFile(values["outline-input"]);
      process.stdout.write(renderOutline(file, { format: values["outline-format"] ?? "markdown" }));
      return 0;
    } catch (failure) {
      return fail(`research-ai: ${failure.message}`);
    }
  }
  if (values["outline-format"] !== undefined && !["markdown", "json"].includes(values["outline-format"])) return fail("--outline-format must be markdown or json");
  if (values["outline-format"] !== undefined && values["outline-input"] === undefined) return fail("--outline-format requires --outline-input");
  if (values.outline && (values.grounded || values.perspectives !== undefined || values["list-perspectives"])) return fail("choose --outline, --grounded or --perspectives");
  if (values.outline && values.context !== undefined) return fail("--outline uses only supplied frozen sources; --context is unsupported");
  if (values.outline && !values.sources) return fail("--outline requires --sources");
  if (values["max-sections"] !== undefined && (!/^[1-8]$/.test(values["max-sections"]))) return fail("--max-sections must be an integer from 1 to 8");
  if (values["max-sections"] !== undefined && !values.outline) return fail("--max-sections requires --outline");
  if (values["list-perspectives"]) {
    if (!values.sources) return fail("--list-perspectives requires --sources");
    try {
      const candidates = perspectiveCandidates(
        await readSourcesFile(values.sources),
      );
      process.stdout.write(`${JSON.stringify(candidates)}\n`);
      return 0;
    } catch (failure) {
      return fail(`research-ai: ${failure.message}`);
    }
  }
  const question = positionals.join(" ").trim();
  if (!question) return fail(usage);
  if (values.perspectives !== undefined && !values.sources)
    return fail("--perspectives requires --sources");
  if (values.perspectives !== undefined && values.grounded)
    return fail("choose --grounded or --perspectives");
  const questions =
    values.questions === undefined ? undefined : Number(values.questions);
  let perspectives;
  if (values.perspectives !== undefined && values.perspectives !== "auto") {
    try {
      perspectives = await readSourcesFile(values.perspectives);
    } catch (failure) {
      return fail(
        `research-ai: ${failure.message.replace("--sources", "--perspectives")}`,
      );
    }
  }
  if (values.profile !== undefined && !Object.hasOwn(profiles, values.profile))
    return fail(
      `research-ai: unknown profile ${JSON.stringify(values.profile)}`,
    );
  let sources;
  if (values.grounded && !values.sources)
    return fail("--grounded requires --sources");
  if (values.sources !== undefined) {
    try {
      sources = await readSourcesFile(values.sources);
    } catch (failure) {
      return fail(`research-ai: ${failure.message}`);
    }
  }
  // Non-inference readiness probes refuse an unusable CLI before any session.
  const ready = await codexReadiness();
  if (!ready.available)
    return fail(`research-ai: ${ready.error}: ${ready.remedy}`);
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  try {
    if (values.outline) {
      const result = await outlineResearch(question, {
        sources, maxSections: values["max-sections"] === undefined ? undefined : Number(values["max-sections"]),
        profile: values.profile, model: values.model, effort: values.effort,
        signal: controller.signal, progress: (event) => process.stderr.write(`${event}\n`),
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return result.status === "complete" ? 0 : 1;
    }
    if (values.perspectives !== undefined) {
      const result = await perspectiveResearch(question, {
        sources,
        perspectives: perspectives ?? "auto",
        questions,
        profile: values.profile,
        context: values.context,
        model: values.model,
        effort: values.effort,
        signal: controller.signal,
        progress: (event) => process.stderr.write(`${event}\n`),
        onLens: ({ id, state }) =>
          process.stderr.write(`Lens ${id}: ${state}\n`),
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return result.status === "complete"
        ? 0
        : result.status === "failed"
          ? 1
          : 2;
    }
    const result = await (
      values.grounded ? groundedResearchQuestion : researchQuestion
    )(question, {
      profile: values.profile,
      context: values.context,
      sources,
      model: values.model,
      effort: values.effort,
      signal: controller.signal,
      progress: (event) => process.stderr.write(`${event}\n`),
    });
    if (values.grounded) process.stdout.write(`${JSON.stringify(result)}\n`);
    else if (result.answer) process.stdout.write(`${result.answer}\n`);
    process.stderr.write(
      `${JSON.stringify({ status: result.status, ...result.receipt })}\n`,
    );
    return result.status === "complete"
      ? 0
      : result.status === "partial"
        ? 2
        : 1;
  } catch (failure) {
    return fail(
      `research-ai: ${failure instanceof Error ? failure.message : failure}`,
    );
  }
}

process.exitCode = await main();
