import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Fixed reviewed bridge, selected environment keys only, bounded output and owned process group. */
export async function runProviderProcess(
  python: string,
  bridge: string,
  input: unknown,
  keyEnv: string[] = [],
  signal?: AbortSignal,
) {
  const home = await mkdtemp(join(tmpdir(), 'signals-provider-'));
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const child = spawn(python, [bridge], {
        cwd: home,
        detached: process.platform !== 'win32',
        env: {
          PATH: '/usr/bin:/bin',
          HOME: home,
          ...Object.fromEntries(
            keyEnv.filter((key) => process.env[key]).map((key) => [key, process.env[key]!]),
          ),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '',
        error = '';
      const stop = () => {
        try {
          if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          /* Process already exited. */
        }
      };
      const timer = setTimeout(stop, 120000);
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (Buffer.byteLength(output) > 2000000) stop();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (error.length < 1000) error += chunk.toString().slice(0, 1000 - error.length);
      });
      child.once('error', reject);
      child.once('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        if (signal?.aborted) {
          reject(new Error('cancelled'));
          return;
        }
        try {
          const parsed: unknown = JSON.parse(output);
          if (code !== 0) throw new Error('provider_unavailable');
          resolve(parsed);
        } catch {
          reject(new Error(`provider_unavailable:${error.slice(0, 120)}`));
        }
      });
      child.stdin.end(JSON.stringify(input));
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
