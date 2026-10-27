#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  validateAnalysis,
  prepareAnalysisQuery,
  validateAnalysisRun,
  exportAnalysisBundle
} from "../src/table-notebook.mjs";

const usage =
  "Usage: research-table-notebook <validate|preview|validate-run|export> < input.json";
try {
  const command = process.argv[2];
  if (
    !["validate", "preview", "validate-run", "export"].includes(command) ||
    process.argv.length !== 3
  )
    throw new Error(usage);
  const input = JSON.parse(readFileSync(0, "utf8"));
  if (command === "validate")
    process.stdout.write(
      JSON.stringify(validateAnalysis(input.analysis), null, 2) + "\n"
    );
  else if (command === "preview")
    process.stdout.write(
      JSON.stringify(
        prepareAnalysisQuery(input.analysis, input.tables, input.target),
        null,
        2
      ) + "\n"
    );
  else if (command === "validate-run")
    process.stdout.write(
      JSON.stringify(
        validateAnalysisRun(input.run, {
          analysis: input.analysis,
          ...(input.tables ? { tables: input.tables } : {})
        }),
        null,
        2
      ) + "\n"
    );
  else
    process.stdout.write(
      exportAnalysisBundle(input.analysis, input.run, input.options ?? {})
    );
} catch (error) {
  process.stderr.write(`${error.code ?? "invalid_input"}: ${error.message}\n`);
  process.exitCode = 1;
}
