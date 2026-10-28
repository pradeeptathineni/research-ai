import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const project = fileURLToPath(new URL('../../', import.meta.url));
const worker = fileURLToPath(
  new URL('../../tests/fixtures/asset-guard-server.ts', import.meta.url),
);
const marker = 'REV02_SYNTHETIC_PRIVATE';
async function fixture(mode = 'dev', absent = false) {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'asset-authorization-')));
  for (const dir of ['app/src', 'public', 'output', '.signals/private', 'queries-real', 'bin'])
    await mkdir(resolve(root, dir), { recursive: true });
  await writeFile(
    resolve(root, '.signals/private/canary.json'),
    JSON.stringify({ secret: marker }),
  );
  await symlink(resolve(root, 'queries-real'), resolve(root, 'query-link'));
  const query = resolve(root, 'queries-real', absent ? 'later/q.json' : 'q.json');
  if (!absent) await writeFile(query, JSON.stringify({ secret: marker + '_QUERY' }));
  for (const [name, dir] of [
    ['app', 'app'],
    ['public', 'public'],
    ['preview', 'output'],
  ]) {
    for (const leaf of ['index', 'html']) await mkdir(resolve(root, dir!, `${name}-${leaf}`));
    for (const path of [
      `${name}-alias.html`,
      `${name}-index/index`,
      `${name}-html/index.html`,
      `${name}-encoded%3Fleaf.json`,
    ])
      await symlink(resolve(root, '.signals/private/canary.json'), resolve(root, dir!, path));
    await writeFile(
      resolve(root, dir!, `${name}-safe.js`),
      'export const safe = "public-control";',
    );
  }
  for (const dir of ['app', 'output'])
    await writeFile(resolve(root, dir, 'index.html'), '<!doctype html><h1>public-shell</h1>');
  await writeFile(resolve(root, 'app/src/main.tsx'), 'export const main = "public-main";');
  await writeFile(
    resolve(root, 'bin/codex'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${root}/readiness.log'\ncase "$*" in\n --version) echo 'codex fixture-only';;\n 'login status') echo 'Logged in using fixture';;\n *) exit 91;;\nesac\n`,
    { mode: 0o700 },
  );
  const child = spawn(
    process.execPath,
    ['--import', resolve(project, 'node_modules/tsx/dist/loader.mjs'), worker, mode, query],
    {
      cwd: root,
      env: {
        PATH: `${root}/bin:${resolve(process.execPath, '..')}:/usr/bin:/bin`,
        HOME: root,
        TMPDIR: root,
        SIGNALS_QUERY_DIRECTORY: resolve(root, 'query-link', absent ? 'later' : ''),
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  let errors = '';
  child.stderr!.on('data', (bytes: Buffer) => {
    errors += bytes.toString();
  });
  const ready = await new Promise<{ port: number; canonicalQueryAllowed: boolean }>(
    (done, reject) => {
      child.once('message', (message: { port: number; canonicalQueryAllowed: boolean }) =>
        done(message),
      );
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`fixture_exit_${code}: ${errors}`)));
    },
  );
  if (absent) {
    await mkdir(resolve(query, '..'), { recursive: true });
    await writeFile(query, JSON.stringify({ secret: marker + '_QUERY' }));
  }
  return { root, query, ...ready, child, errors: () => errors };
}
async function close(f: Awaited<ReturnType<typeof fixture>>) {
  const ended = once(f.child, 'exit');
  f.child.kill('SIGTERM');
  await ended;
  const probes = await readFile(resolve(f.root, 'readiness.log'), 'utf8').catch(() => '');
  expect(
    probes
      .split('\n')
      .filter(Boolean)
      // Research readiness also probes supported execution flags; no research invocation is allowed.
      .every((line) => ['--version', 'login status', 'exec --help'].includes(line)),
  ).toBe(true);
  await rm(f.root, { recursive: true, force: true });
}
function get(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
  body?: string,
) {
  return new Promise<{ status: number; type: string; body: string }>((done, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: { accept: 'text/html,*/*', ...headers },
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (part: Buffer) => parts.push(part));
        res.on('end', () =>
          done({
            status: res.statusCode!,
            type: res.headers['content-type'] ?? '',
            body: Buffer.concat(parts).toString(),
          }),
        );
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('fixture_request_timeout')));
    req.end(body);
  });
}
it.each(['dev', 'preview'])('keeps the public mount root usable in %s', async (mode) => {
  const f = await fixture(mode);
  try {
    // root.html is outside the mount and cannot be its HTML fallback.
    await symlink(
      resolve(f.root, '.signals/private/canary.json'),
      resolve(f.root, mode === 'dev' ? 'app.html' : 'output.html'),
    );
    const index = await get(f.port, '/signals-ai/');
    expect(index.status).toBe(200);
    expect(index.body).toContain('public-shell');
    expect(index.body).not.toContain(marker);
  } finally {
    await close(f);
  }
});
it.each(['dev', 'preview'])(
  'authorizes downstream fallback and encoded targets in %s',
  async (mode) => {
    const f = await fixture(mode);
    try {
      const names =
        mode === 'dev'
          ? [
              'app-alias',
              'app-index',
              'app-html/',
              'app-encoded%3Fleaf.json',
              'public-index',
              'public-index/',
              'public-encoded%3Fleaf.json',
            ]
          : ['preview-index', 'preview-index/', 'preview-encoded%3Fleaf.json'];
      const paths = names.map((name) => '/signals-ai/' + name);
      if (mode === 'dev')
        paths.push(
          `/signals-ai/@fs${f.root}/app/app-index`,
          `/signals-ai/@fs${f.root}/app/app-index/`,
          `/signals-ai/@fs${f.root}/app/app-html/`,
        );
      for (const path of paths) {
        const response = await get(f.port, path);
        console.log(JSON.stringify({ mode, path, ...response }));
        expect.soft(response.status, path).toBe(403);
        expect.soft(response.body, path).not.toContain(marker);
      }
      for (const path of mode === 'dev'
        ? ['app-safe.js', 'public-safe.js', '@vite/client', 'src/main.tsx', 'Library']
        : ['preview-safe.js', 'Library']) {
        const response = await get(f.port, '/signals-ai/' + path);
        expect(response.status, path).toBe(200);
        expect(response.body).not.toContain(marker);
        if (path.includes('safe.js')) expect(response.body).toContain('public-control');
        if (path === 'Library') expect(response.body).toContain('public-shell');
      }
    } finally {
      await close(f);
    }
  },
  20000,
);

it.each([false, true])(
  'denies transformed canonical queries, initially absent=%s',
  async (absent) => {
    const f = await fixture('dev', absent);
    try {
      expect.soft(f.canonicalQueryAllowed).toBe(false);
      for (const path of [
        `/signals-ai${f.query}?import`,
        `/signals-ai/@id/${f.query}?import`,
        `/signals-ai/@fs${f.query}?import`,
      ]) {
        const response = await get(f.port, path);
        console.log(JSON.stringify({ path, ...response }));
        expect.soft([403, 500], path).toContain(response.status);
        expect.soft(response.body, path).not.toContain(marker);
        expect.soft(response.body, path).not.toMatch(/export (?:const secret|default)/);
        expect.soft(response.body, path).toMatch(/Forbidden|denied|allow list|Failed to load/i);
      }
    } finally {
      await close(f);
    }
  },
  20000,
);

it('keeps colon-key owner API dispatch and Host/Origin/CSRF checks', async () => {
  const f = await fixture();
  try {
    const api = '/signals-ai/__signals/api/';
    const session = JSON.parse((await get(f.port, api + 'session')).body) as { token: string };
    const headers = { 'content-type': 'application/json', 'x-signals-token': session.token };
    const scopeResponse = await get(f.port, api + 'request-scope', headers, 'POST', '{}');
    expect(scopeResponse.status).toBe(200);
    const scope = JSON.parse(scopeResponse.body) as { epoch: string; identity: string };
    for (const key of ['a:b', 'a-b']) {
      const response = await get(f.port, api + 'requests/' + key, {
        'x-signals-owner-epoch': scope.epoch,
      });
      console.log(JSON.stringify({ key, ...response }));
      expect.soft(response.status).toBe(404);
      expect.soft(response.type).toContain('application/json');
      if (response.type.includes('application/json'))
        expect.soft(JSON.parse(response.body)).toMatchObject({
          code: 'not_found',
          receipt: null,
          deduplication: { epoch: scope.epoch },
        });
    }
    const hostileHeaders: Record<string, string>[] = [
      { host: 'attacker.example' },
      { origin: 'https://attacker.example' },
    ];
    for (const headers of hostileHeaders)
      expect((await get(f.port, api + 'requests/a:b', headers)).status).toBe(403);
    expect(
      (
        await get(
          f.port,
          api + 'request-scope',
          { 'content-type': 'application/json' },
          'POST',
          '{}',
        )
      ).body,
    ).toContain('csrf_token_required');
    expect(
      (await get(f.port, api + 'requests/a:b', { 'x-signals-owner-epoch': 'wrong' })).body,
    ).toContain('owner_epoch_mismatch');
    expect(
      (
        await get(f.port, api + 'requests/a:b', {
          'x-signals-provider-version': '1.0',
          'x-signals-instance-id': 'wrong',
          'x-signals-owner-epoch': scope.epoch,
        })
      ).body,
    ).toContain('provider_instance_mismatch');
  } finally {
    await close(f);
  }
}, 20000);
