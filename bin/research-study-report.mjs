#!/usr/bin/env node
// Create the existing editable Research report from a retained Study answer; never runs a provider.
import { createReport, createResearchStudyReportBasis } from "../src/index.mjs";

const actions = ["basis", "create"];
const fail = (error) => { process.stderr.write(`${error.message ?? error}\n`); process.exitCode = 1; };
async function read() {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) throw new Error("stdin exceeds the 16 MiB request limit");
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(`Usage: research-study-report --action basis|create\nRead {study,questionId} JSON from stdin. Both actions are offline and do not run a provider.\n`);
    return;
  }
  if (args.length !== 2 || args[0] !== "--action" || !actions.includes(args[1])) throw new Error("choose one supported --action; use --help");
  const input = await read();
  if (!input || typeof input !== "object" || Array.isArray(input) || !Object.hasOwn(input, "study") || typeof input.questionId !== "string"
      || Object.keys(input).some((key) => !["study", "questionId"].includes(key))) throw new Error("request requires exactly study and questionId");
  const basis = createResearchStudyReportBasis(input.study, input.questionId);
  process.stdout.write(`${JSON.stringify(args[1] === "basis" ? basis : createReport(basis), null, 2)}\n`);
}
main().catch(fail);
