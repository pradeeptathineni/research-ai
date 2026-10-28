#!/usr/bin/env node

// bin/research-documents.mjs - Answer a question from explicitly supplied complete pages.
// Usage: node bin/research-documents.mjs --input FROZEN-DOCUMENTS.json [--profile quick|wide]
//
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { codexReadiness, prepareDocumentResearch, profiles, researchDocuments } from "../src/index.mjs";

const inputLimit = 512 * 1024;
const usage = `Usage: research-documents --input FROZEN-DOCUMENTS.json [--profile quick|wide] [--model MODEL] [--effort EFFORT]

FROZEN-DOCUMENTS.json is one explicit UTF-8 JSON file:
  {"question":"...","documents":[{"id","title","sha256","pages":[{"number","text","sha256"}]}]}

Every supplied page is sent in one frozen, schema-bound session; no page is
preselected and no web source is fetched. The caller's raw-document SHA-256
cannot be checked without the original bytes. Nothing is retained by this CLI.`;

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === "--help") return { help: true };
    if (!["--input", "--profile", "--model", "--effort"].includes(key)
        || Object.hasOwn(options, key) || !args[index + 1] || args[index + 1].startsWith("--"))
      throw new Error("invalid usage; run with --help");
    options[key] = args[++index];
  }
  if (!options["--input"]) throw new Error("--input is required; run with --help");
  const profile = options["--profile"] ?? "quick";
  if (!Object.hasOwn(profiles, profile)) throw new Error("unknown profile");
  return { input: options["--input"], profile, model: options["--model"], effort: options["--effort"] };
}

async function readInput(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > inputLimit) throw new Error("input must be a regular non-symlink file no larger than 512 KiB");
    const chunks = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, inputLimit + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > inputLimit) throw new Error("input grew beyond 512 KiB");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const bytes = Buffer.concat(chunks);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).sort().join() !== "documents,question")
      throw new Error("input must contain only question and documents");
    return value;
  } finally {
    await handle?.close();
  }
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); return 1; }
  if (options.help) { process.stdout.write(`${usage}\n`); return 0; }
  try {
    const input = await readInput(options.input);
    prepareDocumentResearch(input.question, input.documents);
    const readiness = await codexReadiness();
    if (!readiness.available) {
      process.stderr.write(`${JSON.stringify({ status: "unavailable", readiness })}\n`);
      return 1;
    }
    const result = await researchDocuments(input.question, input.documents, {
      profile: options.profile, model: options.model, effort: options.effort,
    });
    process.stdout.write(`${JSON.stringify({ status: result.status, draft: result.draft }, null, 2)}\n`);
    process.stderr.write(`${JSON.stringify(result.receipt)}\n`);
    return result.status === "complete" ? 0 : result.status === "partial" || result.status === "cancelled" ? 2 : 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "failed", error: error.message })}\n`);
    return 1;
  }
}

process.exitCode = await main();
