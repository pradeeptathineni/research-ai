#!/usr/bin/env node
// Composes the existing perspective, independent investigation, comparison and outline owners.
import {
  addWorkflowPerspective, compareWorkflowBranches, createPerspectiveWorkflow, draftWorkflowOutline, renderPerspectiveWorkflow,
  perspectiveSpanContribution, reviseWorkflowOutline, reviewWorkflowOutlineCitations, runWorkflowBranches, runWorkflowPerspectives, startWorkflowInvestigation,
  validatePerspectiveWorkflow,
} from "../src/index.mjs";

const actions = ["create", "validate", "perspectives", "perspective-add", "investigation-start", "branches", "compare", "outline", "outline-edit", "outline-review", "contribution", "render"];
const usage = `Usage: research-perspective-workflow --action ${actions.join("|")}
Read one bounded UTF-8 JSON request from stdin and write JSON to stdout (render writes Markdown or JSON text).
Actions map to existing Research owners; native actions are frozen and run only when explicitly requested.
Create requires { topic, sources, perspectives? }. Other actions pass the full workflow as workflow.
See docs/perspective-workflow.md for request fields and limits.`;
const write = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const fail = error => { process.stderr.write(`${error?.message ?? error}\n`); process.exitCode = 1; };
async function read() {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 16 * 1024 * 1024) throw new Error("stdin exceeds the 16 MiB request limit"); chunks.push(chunk); }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}
function requireFields(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) || required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) throw new Error(`request requires ${required.join(", ")}`);
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { process.stdout.write(`${usage}\n`); return; }
  if (args.length !== 2 || args[0] !== "--action" || !actions.includes(args[1])) throw new Error("choose one supported --action; use --help");
  const action = args[1], input = await read();
  if (action === "create") { requireFields(input, ["topic", "sources"], ["id", "perspectives"]); write(createPerspectiveWorkflow(input.topic, input)); return; }
  if (action === "validate") { requireFields(input, ["workflow"]); write(validatePerspectiveWorkflow(input.workflow)); return; }
  if (action === "render") { requireFields(input, ["workflow"], ["format"]); process.stdout.write(renderPerspectiveWorkflow(input.workflow, { format: input.format ?? "markdown" })); return; }
  if (action === "contribution") { requireFields(input, ["workflow"]); write(perspectiveSpanContribution(input.workflow)); return; }
  if (action === "perspective-add") {
    requireFields(input, ["workflow", "choice"], ["profile", "model", "effort", "lease"]);
    const options = Object.fromEntries(["profile", "model", "effort", "lease"]
      .filter(key => input[key] !== undefined).map(key => [key, input[key]]));
    write(await addWorkflowPerspective(input.workflow, input.choice, options));
    return;
  }
  const required = { perspectives: ["workflow"], "investigation-start": ["workflow", "questions"], branches: ["workflow", "branchIds"],
    compare: ["workflow", "branchIds"], outline: ["workflow"], "outline-edit": ["workflow", "edits"], "outline-review": ["workflow", "confirmRevision"] }[action];
  const optional = action === "perspectives" ? ["profile", "model", "effort", "lease"] : action === "investigation-start" ? ["goal", "scope", "budget"]
    : action === "branches" ? ["model", "effort", "lease"] : action === "compare" ? ["attempts", "model", "effort", "lease"]
      : action === "outline" ? ["model", "effort", "lease", "maxSections"] : action === "outline-edit" ? ["conflictSetAsideReason"] : [];
  requireFields(input, required, optional);
  if (action === "perspectives") write(await runWorkflowPerspectives(input.workflow, input));
  else if (action === "investigation-start") write(startWorkflowInvestigation(input.workflow, input));
  else if (action === "branches") write(await runWorkflowBranches(input.workflow, input.branchIds, input));
  else if (action === "compare") write(await compareWorkflowBranches(input.workflow, input));
  else if (action === "outline") write(await draftWorkflowOutline(input.workflow, input));
  else if (action === "outline-edit") write(reviseWorkflowOutline(input.workflow, input.edits, { conflictSetAsideReason: input.conflictSetAsideReason ?? null }));
  else write(reviewWorkflowOutlineCitations(input.workflow, { confirmRevision: input.confirmRevision }));
}
main().catch(fail);
