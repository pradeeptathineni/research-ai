import { spawn } from "node:child_process";

const usage = `Usage:
  research-ai reuse --help|--version
  research-ai reuse source compare|comparison [Shoulda options]
  research-ai reuse subsystem-fit record|show [Shoulda options]

This command forwards to the installed Shoulda CLI. Shoulda owns state, receipt,
schema, and option validation. No research session or source acquisition runs.`;

/** Handle the explicit Shoulda reuse bridge; return null for ordinary research. */
export function runReuseDispatch(args, spawnCommand = spawn) {
  if (args[0] !== "reuse") return Promise.resolve(null);

  const forwarded = args.slice(1);
  if (forwarded.length === 1 && ["--help", "-h", "--version"].includes(forwarded[0])) {
    return runShoulda([forwarded[0]], spawnCommand);
  }

  const allowed =
    (forwarded[0] === "source" &&
      ["compare", "comparison"].includes(forwarded[1])) ||
    (forwarded[0] === "subsystem-fit" &&
      ["record", "show"].includes(forwarded[1]));
  if (!allowed) {
    process.stderr.write(`${usage}\n`);
    return Promise.resolve(1);
  }
  return runShoulda(forwarded, spawnCommand);
}

function runShoulda(args, spawnCommand) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnCommand("shoulda", args, {
        shell: false,
        stdio: "inherit",
      });
    } catch {
      process.stderr.write("Could not start the installed Shoulda CLI.\n");
      resolve(1);
      return;
    }
    child.once("error", () => {
      process.stderr.write("Could not start the installed Shoulda CLI.\n");
      resolve(1);
    });
    child.once("close", (code, signal) => {
      resolve(typeof code === "number" ? code : signal ? 1 : 0);
    });
  });
}
