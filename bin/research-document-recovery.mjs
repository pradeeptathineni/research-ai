#!/usr/bin/env node
// Hierarchical document recovery delegates every review to the existing coverage owner.
import { createDocumentRecovery, renderDocumentRecovery, retryDocumentRecovery, runDocumentRecovery, validateDocumentRecovery } from "../src/index.mjs";

const actions = ["create", "validate", "run", "retry", "render"];
const usage = `Usage: research-document-recovery --action ${actions.join("|")}\nRead one bounded JSON object from stdin and write JSON (or Markdown for render) to stdout.\nRun and retry require confirmation of the exact current workflow sha256. See docs/document-recovery.md.`;
const fail = error => { process.stderr.write(`${error?.message ?? error}\n`); process.exitCode = 1; };
async function read() {
  const chunks = []; let bytes = 0;
  for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 64 * 1024 * 1024) throw new Error("stdin exceeds the 64 MiB request limit"); chunks.push(chunk); }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}
function fields(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key))
      || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error(`request requires only ${required.join(", ")}${optional.length ? ` and optional ${optional.join(", ")}` : ""}`);
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { process.stdout.write(`${usage}\n`); return; }
  if (args.length !== 2 || args[0] !== "--action" || !actions.includes(args[1])) throw new Error("choose a supported --action; use --help");
  const action = args[1], input = await read();
  if (action === "create") { fields(input, ["question", "documents", "sections"], ["id", "policy"]); process.stdout.write(`${JSON.stringify(createDocumentRecovery(input.question, input), null, 2)}\n`); return; }
  if (action === "validate") { fields(input, ["workflow"]); process.stdout.write(`${JSON.stringify(validateDocumentRecovery(input.workflow), null, 2)}\n`); return; }
  if (action === "render") { fields(input, ["workflow"], ["format"]); process.stdout.write(renderDocumentRecovery(input.workflow, { format: input.format ?? "markdown" })); return; }
  const options = Object.fromEntries(["confirmedSha256", "profile", "model", "effort"].filter(key => input[key] !== undefined).map(key => [key, input[key]]));
  if (action === "run") { fields(input, ["workflow", "confirmedSha256"], ["profile", "model", "effort"]); process.stdout.write(`${JSON.stringify(await runDocumentRecovery(input.workflow, options), null, 2)}\n`); return; }
  fields(input, ["workflow", "sectionIds", "confirmedSha256"], ["profile", "model", "effort"]);
  process.stdout.write(`${JSON.stringify(await retryDocumentRecovery(input.workflow, input.sectionIds, options), null, 2)}\n`);
}
main().catch(fail);
