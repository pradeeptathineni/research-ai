#!/usr/bin/env node
// One additional bounded cited synthesis over a settled document-recovery artifact.
import { prepareDocumentRecoverySynthesis, renderDocumentRecoverySynthesis,
  runDocumentRecoverySynthesis, validateDocumentRecoverySynthesis } from "../src/index.mjs";

const actions = ["plan", "run", "validate", "render"];
const usage = `Usage: research-document-recovery-synthesis --action ${actions.join("|")}\nRead one bounded JSON object from stdin. A run requires exact plan confirmation; see docs/document-recovery-synthesis.md.`;
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
  const [action, input] = [args[1], await read()];
  if (action === "plan") { fields(input, ["recovery"], ["policy"]); process.stdout.write(`${JSON.stringify(prepareDocumentRecoverySynthesis(input.recovery, input.policy), null, 2)}\n`); return; }
  if (action === "validate") { fields(input, ["result"]); process.stdout.write(`${JSON.stringify(validateDocumentRecoverySynthesis(input.result), null, 2)}\n`); return; }
  if (action === "render") { fields(input, ["result"], ["format"]); process.stdout.write(renderDocumentRecoverySynthesis(input.result, { format: input.format ?? "markdown" })); return; }
  fields(input, ["recovery", "plan", "confirmedPlanSha256"], ["profile", "model", "effort"]);
  const options = Object.fromEntries(["confirmedPlanSha256", "profile", "model", "effort"].filter(key => input[key] !== undefined).map(key => [key, input[key]]));
  process.stdout.write(`${JSON.stringify(await runDocumentRecoverySynthesis(input.recovery, input.plan, options), null, 2)}\n`);
}
main().catch(fail);
