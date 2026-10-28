import { cp, mkdtemp, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-built-browser-')));
await cp('signals', join(root, 'signals'), { recursive: true });
const server = spawn(process.execPath, ['--import', 'tsx', 'scripts/workbench.ts'], {
  stdio: 'inherit',
  env: { ...process.env, SIGNALS_PORT: '5191', SIGNALS_WORKSPACE: root },
});
process.once('SIGTERM', () => server.kill('SIGTERM'));
server.once('exit', () => {
  void rm(root, { recursive: true, force: true }).then(() => process.exit());
});
