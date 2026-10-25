#!/usr/bin/env node

// bin/research-notebook.mjs - Create and reopen explicit portable notebook state.
// Usage: research-notebook --action create|revise|preview|ask|record|citation|save-note|render
//
import {
  codexReadiness, createResearchNotebook, getNotebookCitation, prepareNotebookQuestion,
  recordNotebookQuestion, renderResearchNotebook, reviseResearchNotebook,
  researchDocumentCoverage, saveNotebookQuestionAsNote, validateResearchNotebook,
} from "../src/index.mjs";

const inputLimit = 16 * 1024 * 1024;
const output = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const fail = (message) => { process.stderr.write(`${message}\n`); process.exitCode = 1; };
const usage = `Usage: research-notebook --action create|revise|preview|ask|record|citation|save-note|render

Read one UTF-8 JSON request from stdin and write JSON to stdout. No paths, URLs,
source discovery, or implicit notebook selections are accepted.

Examples:
  echo '{"title":"Battery evidence","topic":"Cell cycle life"}' | research-notebook --action create
  cat request.json | research-notebook --action preview
  cat confirmed-request.json | research-notebook --action ask
  cat saved-notebook.json | research-notebook --action render`;

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > inputLimit) throw new Error("stdin exceeds the 16 MiB request limit");
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}

function object(value, required, name, optional = []) {
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
  if (!value || typeof value !== "object" || Array.isArray(value)
      || required.some((key) => !Object.hasOwn(value, key))
      || keys.some((key) => !required.includes(key) && !optional.includes(key)))
    throw new Error(`${name} must contain ${required.join(", ")}${optional.length ? ` and only optional ${optional.join(", ")}` : ""}`);
  return value;
}

function parseAction(args) {
  if (args.length === 1 && args[0] === "--help") return "help";
  if (args.length !== 2 || args[0] !== "--action" || !["create", "revise", "preview", "ask", "record", "citation", "save-note", "render"].includes(args[1]))
    throw new Error("choose one supported --action; run with --help");
  return args[1];
}

async function main() {
  let action;
  try { action = parseAction(process.argv.slice(2)); }
  catch (error) { fail(error.message); return; }
  if (action === "help") { process.stdout.write(`${usage}\n`); return; }
  try {
    const input = await readInput();
    if (action === "create") {
      object(input, ["title"], "create input", ["topic"]);
      output(createResearchNotebook(input.title, { topic: input.topic }));
      return;
    }
    if (action === "revise") {
      object(input, ["notebook", "edit"], "revise input");
      output(reviseResearchNotebook(input.notebook, input.edit));
      return;
    }
    if (action === "preview") {
      object(input, ["notebook", "spec"], "preview input", ["policy"]);
      output(prepareNotebookQuestion(input.notebook, input.spec, input.policy));
      return;
    }
    if (action === "record") {
      object(input, ["notebook", "prepared", "result"], "record input");
      output(recordNotebookQuestion(input.notebook, input.prepared, input.result));
      return;
    }
    if (action === "citation") {
      object(input, ["notebook", "questionId", "evidenceId"], "citation input");
      output(getNotebookCitation(input.notebook, input.questionId, input.evidenceId));
      return;
    }
    if (action === "save-note") {
      object(input, ["notebook", "questionId"], "save-note input", ["title", "id"]);
      output(saveNotebookQuestionAsNote(input.notebook, input.questionId, { title: input.title, id: input.id }));
      return;
    }
    if (action === "render") {
      object(input, ["notebook"], "render input", ["format"]);
      process.stdout.write(renderResearchNotebook(input.notebook, { format: input.format ?? "markdown" }));
      return;
    }
    object(input, ["notebook", "spec", "confirmNotebookDigest", "confirmScopeDigest", "confirmPlanDigest"], "ask input",
      ["policy", "profile", "model", "effort", "lease"]);
    const preview = prepareNotebookQuestion(input.notebook, input.spec, input.policy);
    if (input.confirmNotebookDigest !== preview.notebookDigest || input.confirmScopeDigest !== preview.scopeDigest
        || input.confirmPlanDigest !== preview.preview.planDigest)
      throw new Error("notebook, scope, or plan confirmation does not match; preview again");
    // A conservative state-cap reserve; it is a storage policy estimate, not a provider capacity claim.
    const retainedBytes = Buffer.byteLength(JSON.stringify(input.notebook), "utf8");
    const requestBytes = Buffer.byteLength(JSON.stringify(preview.request), "utf8");
    if (retainedBytes + requestBytes * 2 + 1024 * 1024 > inputLimit)
      throw new Error("notebook has insufficient reserved storage for a retained result; save a smaller explicit scope first");
    const readiness = await codexReadiness();
    if (!readiness.available) {
      output({ status: "unavailable", readiness });
      process.exitCode = 1;
      return;
    }
    const result = await researchDocumentCoverage(preview.request.question, preview.request.documents, {
      ...preview.request.policy, confirmedPlanDigest: preview.preview.planDigest,
      profile: input.profile ?? "quick", model: input.model, effort: input.effort, lease: input.lease,
    });
    try {
      const notebook = recordNotebookQuestion(input.notebook, preview, result);
      output({ status: result.status, notebook, result });
    } catch (error) {
      output({ status: "unattached", notebookId: input.notebook.id, notebookDigest: input.notebook.sha256,
        result, reason: error.message });
      process.exitCode = 2;
      return;
    }
    process.exitCode = result.status === "complete" ? 0 : result.status === "partial" || result.status === "cancelled" ? 2 : 1;
  } catch (error) {
    fail(error?.message ?? String(error));
  }
}

await main();
