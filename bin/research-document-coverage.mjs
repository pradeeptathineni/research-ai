#!/usr/bin/env node

// bin/research-document-coverage.mjs - Review every window of supplied complete documents.
// Usage: node bin/research-document-coverage.mjs --input FILE --preview
//        node bin/research-document-coverage.mjs --input FILE --confirm PLAN_DIGEST
//        node bin/research-document-coverage.mjs --render RESULT.json [--format markdown|json]
//
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  codexReadiness, prepareDocumentCoverage, profiles, renderDocumentCoverage, researchDocumentCoverage,
} from "../src/index.mjs";

const inputLimit = 8 * 1024 * 1024;
const renderLimit = 32 * 1024 * 1024;
const usage = `Usage:
  research-document-coverage --input FILE --preview [--max-calls N] [--pass-units N] [--seconds N]
  research-document-coverage --input FILE --confirm PLAN_DIGEST [--max-calls N] [--pass-units N] [--seconds N]
                             [--profile quick|wide] [--model MODEL] [--effort EFFORT]
  research-document-coverage --render RESULT.json [--format markdown|json]

FILE is one explicit UTF-8 JSON file of at most 8 MiB:
  {"question":"...","documents":[{"id","title","sha256","pages":[{"number","text","sha256"}]}]}

--preview prints the deterministic plan without page text and starts nothing.
--confirm repeats preparation from the same file and policy flags, refuses unless
the plan digest matches exactly, checks Codex readiness, then reviews every window
in bounded frozen passes and synthesizes once. Ctrl-C cancels and keeps completed
pass findings. --render validates a saved result offline. Nothing is stored.
Exit codes: 0 complete, 2 partial or cancelled, 1 failed or refused.`;

const valued = new Set(["--input", "--confirm", "--max-calls", "--pass-units", "--seconds", "--profile", "--model", "--effort", "--render", "--format"]);

function parseArgs(args) {
  const options = {};
  let preview = false;
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === "--help") return { help: true };
    if (key === "--preview" && !preview) { preview = true; continue; }
    if (!valued.has(key) || Object.hasOwn(options, key) || !args[index + 1] || args[index + 1].startsWith("--"))
      throw new Error("invalid usage; run with --help");
    options[key] = args[++index];
  }
  const given = (...names) => names.filter((name) => Object.hasOwn(options, name));
  const modes = [preview, Object.hasOwn(options, "--confirm"), Object.hasOwn(options, "--render")].filter(Boolean).length;
  if (modes !== 1) throw new Error("choose exactly one of --preview, --confirm or --render; run with --help");
  if (options["--render"] !== undefined) {
    if (given("--input", "--max-calls", "--pass-units", "--seconds", "--profile", "--model", "--effort").length)
      throw new Error("--render accepts only --format");
    const format = options["--format"] ?? "markdown";
    if (!["markdown", "json"].includes(format)) throw new Error("--format must be markdown or json");
    return { mode: "render", file: options["--render"], format };
  }
  if (!options["--input"]) throw new Error("--input is required; run with --help");
  if (given("--format").length) throw new Error("--format applies only to --render");
  if (preview && given("--profile", "--model", "--effort").length) throw new Error("--profile, --model and --effort apply only to --confirm");
  const policy = {};
  for (const [flag, key] of [["--max-calls", "maxCalls"], ["--pass-units", "passUtf16Units"], ["--seconds", "maxSeconds"]]) {
    if (options[flag] === undefined) continue;
    if (!/^[1-9][0-9]{0,6}$/.test(options[flag])) throw new Error(`${flag} must be a positive integer`);
    policy[key] = Number(options[flag]);
  }
  const profile = options["--profile"] ?? "quick";
  if (!Object.hasOwn(profiles, profile)) throw new Error("unknown profile");
  return { mode: preview ? "preview" : "confirm", input: options["--input"], confirm: options["--confirm"],
    policy, profile, model: options["--model"], effort: options["--effort"] };
}

async function readJson(path, limit) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error(`input must be a regular non-symlink file no larger than ${limit / 1048576} MiB`);
    const chunks = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(1024 * 1024, limit + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > limit) throw new Error(`input grew beyond ${limit / 1048576} MiB`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    await handle?.close();
  }
}

async function readInput(path) {
  const value = await readJson(path, inputLimit);
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join() !== "documents,question")
    throw new Error("input must contain only question and documents");
  return value;
}

// Metadata only: no page text leaves the preview.
const preview = (plan) => ({
  version: plan.version, question: plan.question, inputDigest: plan.inputDigest, planDigest: plan.planDigest,
  policy: plan.policy, counts: plan.counts,
  documents: plan.documents.map(({ id, title, sha256, pages }) => ({ id, title, sha256, pages: pages.length })),
  windows: plan.windows, passes: plan.passes, limits: plan.limits,
});

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); return 1; }
  if (options.help) { process.stdout.write(`${usage}\n`); return 0; }
  try {
    if (options.mode === "render") {
      process.stdout.write(renderDocumentCoverage(await readJson(options.file, renderLimit), { format: options.format }));
      return 0;
    }
    const input = await readInput(options.input);
    const plan = prepareDocumentCoverage(input.question, input.documents, options.policy);
    if (options.mode === "preview") {
      process.stdout.write(`${JSON.stringify(preview(plan), null, 2)}\n`);
      return 0;
    }
    if (options.confirm !== plan.planDigest) {
      process.stderr.write(`${JSON.stringify({ status: "refused", error: "plan digest does not match this input and policy; rerun --preview" })}\n`);
      return 1;
    }
    const readiness = await codexReadiness();
    if (!readiness.available) {
      process.stderr.write(`${JSON.stringify({ status: "unavailable", readiness })}\n`);
      return 1;
    }
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.once("SIGINT", interrupt);
    let result;
    try {
      result = await researchDocumentCoverage(input.question, input.documents, {
        ...options.policy, confirmedPlanDigest: options.confirm, profile: options.profile,
        model: options.model, effort: options.effort, signal: controller.signal,
      });
    } finally {
      process.removeListener("SIGINT", interrupt);
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.stderr.write(`${JSON.stringify(result.receipt)}\n`);
    return result.status === "complete" ? 0 : result.status === "partial" || result.status === "cancelled" ? 2 : 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "failed", error: error.message })}\n`);
    return 1;
  }
}

process.exitCode = await main();
