import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { runReuseDispatch } from "../src/reuse-dispatch.mjs";

test("reuse bridge forwards only fixed Shoulda commands with shell disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "research-ai-reuse-"));
  try {
    const executable = join(root, "shoulda");
    await writeFile(
      executable,
      `#!/usr/bin/env node\nconst fs = require('node:fs'); fs.writeFileSync(process.env.B2_CAPTURE, JSON.stringify(process.argv.slice(2))); process.exitCode = process.argv.includes('--fail') ? 7 : 0\n`,
    );
    await chmod(executable, 0o755);
    const originalPath = process.env.PATH ?? "/usr/bin:/bin";
    const spawnWithFixturePath = (command, args, options) => {
      assert.equal(command, "shoulda");
      assert.equal(options.shell, false);
      return spawn(command, args, {
        ...options,
        env: {
          ...process.env,
          PATH: `${root}:${originalPath}`,
          B2_CAPTURE: join(root, "captured.json"),
        },
      });
    };

    assert.equal(
      await runReuseDispatch(
        ["reuse", "source", "comparison", "scc_123"],
        spawnWithFixturePath,
      ),
      0,
    );
    assert.equal(
      await readFile(join(root, "captured.json"), "utf8"),
      '["source","comparison","scc_123"]',
    );
    assert.equal(
      await runReuseDispatch(
        ["reuse", "subsystem-fit", "show", "--assessment-id", "sfa_abc"],
        spawnWithFixturePath,
      ),
      0,
    );
    assert.equal(
      await readFile(join(root, "captured.json"), "utf8"),
      '["subsystem-fit","show","--assessment-id","sfa_abc"]',
    );
    assert.equal(
      await runReuseDispatch(
        ["reuse", "source", "compare", "--fail"],
        spawnWithFixturePath,
      ),
      7,
    );
    assert.equal(
      await readFile(join(root, "captured.json"), "utf8"),
      '["source","compare","--fail"]',
    );
    assert.equal(await runReuseDispatch(["reuse", "github", "apply"]), 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary research arguments are not claimed by the reuse bridge", async () => {
  assert.equal(await runReuseDispatch(["ordinary", "question"]), null);
});

test("the actual research-ai entrypoint delegates reuse before research parsing", async () => {
  const root = await mkdtemp(join(tmpdir(), "research-ai-reuse-cli-"));
  try {
    const executable = join(root, "shoulda");
    await writeFile(
      executable,
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.B2_CAPTURE, JSON.stringify(process.argv.slice(2)))\n`,
    );
    await chmod(executable, 0o755);
    const cli = new URL("../bin/research-ai.mjs", import.meta.url);
    const child = spawn(
      process.execPath,
      [cli.pathname, "reuse", "--version"],
      {
        shell: false,
        stdio: "inherit",
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          B2_CAPTURE: join(root, "captured.json"),
        },
      },
    );
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status) => resolve(status));
    });
    assert.equal(code, 0);
    assert.equal(
      await readFile(join(root, "captured.json"), "utf8"),
      '["--version"]',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
