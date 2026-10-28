#!/usr/bin/env node
// Minimal offline CLI for composing cross-notebook study sessions from exact search results.
import {
  checkResearchStudyOrigins, createResearchStudy, exportResearchStudyPlanningSource, getResearchStudyCitation, prepareResearchStudyQuestion,
  recordResearchStudyQuestion, renderResearchStudy, reviseResearchStudy, saveResearchStudyQuestionAsNotebookNote, validateResearchStudy, validateResearchStudyPlanningSource,
} from "../src/index.mjs";
const actions = ["create", "select", "deselect", "validate", "origins", "preview", "record", "citation", "planning-source", "validate-planning-source", "save-note", "render"];
const usage = `Usage: research-study --action ${actions.join("|")}\nRead one bounded UTF-8 JSON request from stdin and write JSON to stdout. Selection input names the origin notebooks, exact notebook-search result, and hit ID. Question preparation uses the full selected source document or exact unverified note version retained in the study.`;
const write = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const fail = (error) => { process.stderr.write(`${error.message ?? error}\n`); process.exitCode = 1; };
const requireFields = (value, required, optional = []) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || required.some((key) => !Object.hasOwn(value, key))
      || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) throw new Error(`request requires ${required.join(", ")}`);
};
async function read() {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 16 * 1024 * 1024) throw new Error("stdin exceeds the 16 MiB request limit"); chunks.push(chunk); }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { process.stdout.write(`${usage}\n`); return; }
  if (args.length !== 2 || args[0] !== "--action" || !actions.includes(args[1])) throw new Error("choose one supported --action; use --help");
  const action = args[1], input = await read();
  if (action === "create") { requireFields(input, ["title"], ["id"]); write(createResearchStudy(input.title, { id: input.id })); return; }
  if (action === "select") { requireFields(input, ["study", "notebooks", "search", "hitId"]); write(reviseResearchStudy(input.study, { type: "select-hit", notebooks: input.notebooks, search: input.search, hitId: input.hitId })); return; }
  if (action === "deselect") { requireFields(input, ["study", "selectionId"]); write(reviseResearchStudy(input.study, { type: "deselect-hit", selectionId: input.selectionId })); return; }
  if (action === "validate") { requireFields(input, ["study"]); write(validateResearchStudy(input.study)); return; }
  if (action === "origins") { requireFields(input, ["study", "notebooks"]); write(checkResearchStudyOrigins(input.study, input.notebooks)); return; }
  if (action === "preview") { requireFields(input, ["study", "spec"], ["policy"]); write(prepareResearchStudyQuestion(input.study, input.spec, input.policy)); return; }
  if (action === "record") { requireFields(input, ["study", "prepared", "result"]); write(recordResearchStudyQuestion(input.study, input.prepared, input.result)); return; }
  if (action === "citation") { requireFields(input, ["study", "questionId", "evidenceId"]); write(getResearchStudyCitation(input.study, input.questionId, input.evidenceId)); return; }
  if (action === "planning-source") { requireFields(input, ["study", "questionId"]); write(exportResearchStudyPlanningSource(input.study, input.questionId)); return; }
  if (action === "validate-planning-source") { requireFields(input, ["study", "questionId", "source"]); write(validateResearchStudyPlanningSource(input.study, input.questionId, input.source)); return; }
  if (action === "save-note") { requireFields(input, ["study", "notebook", "questionId"], ["title", "id"]); write(saveResearchStudyQuestionAsNotebookNote(input.study, input.notebook, input.questionId, { title: input.title, id: input.id })); return; }
  requireFields(input, ["study"], ["format"]); process.stdout.write(renderResearchStudy(input.study, { format: input.format ?? "markdown" }));
}
main().catch(fail);
