#!/usr/bin/env node
import { open, stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  codexReadiness,
  profiles,
  researchQuestion,
  groundedResearchQuestion,
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
  if (values.readiness) {
    const state = await codexReadiness();
    process.stdout.write(`${JSON.stringify(state)}\n`);
    return state.available ? 0 : 1;
  }
  const question = positionals.join(" ").trim();
  if (!question) return fail(usage);
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
