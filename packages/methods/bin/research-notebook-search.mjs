#!/usr/bin/env node
// Offline lexical search over explicit portable Research notebooks.
import { openNotebookSearchHit, searchResearchNotebooks } from "../src/index.mjs";

const maxBytes = 32 * 1024 * 1024;
const fail = (message) => { process.stderr.write(`${message.slice(0, 500)}\n`); process.exitCode = 1; };
async function input() {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("stdin exceeds the 32 MiB request limit");
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}
function object(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || required.some((key) => !Object.hasOwn(value, key))
      || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key)))
    throw new Error(`request must contain ${required.join(", ")} and no unknown fields`);
}
function action(args) {
  if (args.length === 1 && args[0] === "--help") return "help";
  if (args.length !== 2 || args[0] !== "--action" || !["search", "open"].includes(args[1]))
    throw new Error("choose --action search or --action open; run with --help");
  return args[1];
}
const usage = `Usage: research-notebook-search --action search|open
Read one UTF-8 JSON request from stdin and write a closed JSON result to stdout.
Search input: {"notebooks":[...],"query":"...","options":{...}}
Open input: {"notebooks":[...],"result":{...},"hitId":"notebook-hit-..."}
No paths, URLs, implicit notebook selections, persistence, or inference are used.`;

try {
  const selected = action(process.argv.slice(2));
  if (selected === "help") { process.stdout.write(`${usage}\n`); }
  else {
    const request = await input();
    let result;
    if (selected === "search") {
      object(request, ["notebooks", "query"], ["options"]);
      result = searchResearchNotebooks(request.notebooks, request.query, request.options);
    } else {
      object(request, ["notebooks", "result", "hitId"]);
      result = openNotebookSearchHit(request.notebooks, request.result, request.hitId);
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} catch (error) { fail(error instanceof Error ? error.message : "search_failed"); }
