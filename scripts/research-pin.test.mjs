import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import {
  checkResearchPin,
  researchArchive,
  researchSpec,
  researchDependencyRoot,
} from './research-pin.mjs';

const source = fileURLToPath(
  new URL(`../vendor/research-ai/${researchArchive.sha256}.tgz`, import.meta.url),
);
const locked = {
  version: researchArchive.version,
  resolved: researchSpec,
  integrity: researchArchive.integrity,
  license: 'MIT',
};
const installed = { version: researchArchive.version, license: 'MIT' };

test('accepts only the exact tracked package archive, lock and extracted installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'signals-research-pin-'));
  const archiveDirectory = join(root, 'vendor/research-ai');
  const archive = join(archiveDirectory, `${researchArchive.sha256}.tgz`);
  const packageDirectory = join(root, 'node_modules/@pradeeptathineni/research-ai');
  try {
    await mkdir(archiveDirectory, { recursive: true });
    await mkdir(packageDirectory, { recursive: true });
    await copyFile(source, archive);
    const check = (spec = researchSpec, lock = locked, metadata = installed) =>
      checkResearchPin(root, spec, lock, metadata);
    assert.deepEqual(await check(), []);
    assert.match((await check('file:vendor/research-ai/other.tgz')).join(' '), /manifest and lock/);
    assert.match(
      (await check(researchSpec, { ...locked, integrity: 'sha512-wrong' })).join(' '),
      /integrity/,
    );
    assert.match(
      (await check(researchSpec, { ...locked, version: '0.1.0' })).join(' '),
      /versions/,
    );
    assert.match(
      (await check(researchSpec, locked, { ...installed, version: '0.1.0' })).join(' '),
      /versions/,
    );
    const bytes = await readFile(archive);
    await writeFile(archive, Buffer.concat([bytes, Buffer.from('changed')]));
    assert.match((await check()).join(' '), /bytes changed/);
    await rm(archive);
    await symlink(source, archive);
    assert.match((await check()).join(' '), /ordinary tracked file/);
    await rm(archive);
    await mkdir(archive);
    assert.match((await check()).join(' '), /ordinary tracked file/);
    await rm(packageDirectory, { recursive: true });
    await symlink(archiveDirectory, packageDirectory);
    assert.match((await check()).join(' '), /directory or symlink substitution/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('one explicit workspace workflow binds source, component, lock and installed link without weakening standalone mode', async () => {
  const exec = promisify(execFile);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-research-workspace-')));
  const library = join(root, 'packages/library');
  const methods = join(root, 'packages/methods');
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const metadata = {
    name: '@pradeeptathineni/research-ai',
    version: researchArchive.version,
    license: 'MIT',
    type: 'module',
    engines: { node: '>=24.19.0 <25' },
    bin: { 'research-ai': 'src/index.mjs' },
    types: './src/index.d.ts',
    exports: { '.': { types: './src/index.d.ts', default: './src/index.mjs' } },
    files: ['src', 'LICENSE'],
  };
  const contents = new Map([
    ['LICENSE', 'MIT fixture license\n'],
    ['src/index.d.ts', 'export declare const fixture: true;\n'],
    ['src/index.mjs', 'export const fixture = true;\n'],
  ]);
  try {
    await exec('git', ['init', '-q', root]);
    await mkdir(join(root, 'src'));
    for (const [name, content] of contents) await writeFile(join(root, name), content);
    await writeFile(join(root, 'package.json'), JSON.stringify(metadata));
    await exec('git', ['-C', root, 'add', 'package.json', 'LICENSE', 'src']);
    await exec('git', [
      '-C',
      root,
      '-c',
      'user.name=Compatibility fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'Frozen Methods fixture',
    ]);
    const commit = (await exec('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
    await mkdir(methods, { recursive: true });
    for (const name of ['package.json', 'LICENSE', 'src'])
      await rename(join(root, name), join(methods, name));
    await mkdir(library, { recursive: true });
    const wrapper = {
      private: true,
      workspaces: ['packages/methods', 'packages/library'],
      overrides: { [metadata.name]: 'file:./packages/methods' },
    };
    await writeFile(join(root, 'package.json'), JSON.stringify(wrapper));
    await writeFile(
      join(library, 'package.json'),
      JSON.stringify({ private: true, dependencies: { [metadata.name]: researchSpec } }),
    );
    await writeFile(
      join(library, 'package-lock.json'),
      JSON.stringify({ packages: { [`node_modules/${metadata.name}`]: locked } }),
    );
    const workspaceLock = {
      lockfileVersion: 3,
      packages: {
        'packages/methods': { name: metadata.name, version: metadata.version, license: 'MIT' },
        [`node_modules/${metadata.name}`]: { resolved: 'packages/methods', link: true },
      },
    };
    const lockBytes = JSON.stringify(workspaceLock);
    await writeFile(join(root, 'package-lock.json'), lockBytes);
    await mkdir(join(root, 'node_modules/@pradeeptathineni'), { recursive: true });
    const installedLink = join(root, 'node_modules', metadata.name);
    await symlink(methods, installedLink);
    const rows = [...contents]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, content]) => ({ path, sha256: digest(content) }));
    const manifest = {
      schema: 'research.component-source-manifest.v1',
      component: 'Methods',
      ownerId: 'research-ai',
      targetPath: 'packages/methods',
      packageIdentity: metadata,
      packageIdentityProjectionSha256: digest(JSON.stringify(metadata)),
      frozenSource: { integrationCommit: commit },
      payloadManifest: { fileCount: rows.length, sha256: digest(JSON.stringify(rows)) },
    };
    const manifestPath = join(root, 'methods-manifest.json');
    const manifestBytes = JSON.stringify(manifest);
    await writeFile(manifestPath, manifestBytes);
    const layout = {
      mode: 'workspace',
      root,
      manifest: manifestPath,
      manifestSha256: digest(manifestBytes),
      lockSha256: digest(lockBytes),
    };
    const check = (option = layout) =>
      checkResearchPin(library, researchSpec, locked, metadata, option);
    assert.deepEqual(await check(), []);
    assert.equal(await researchDependencyRoot(library, layout), join(root, 'node_modules'));
    assert.match((await check(null)).join(' '), /directory or symlink substitution/);
    // Private mutable data is not used as a substitute for engine-content verification.
    await mkdir(join(root, '.signals'));
    await writeFile(join(root, '.signals/private-fixture.json'), '{"fixture":true}');
    assert.deepEqual(await check(), []);
    await mkdir(join(library, 'scripts'));
    for (const name of ['research-pin.mjs', 'dependency-check.mjs'])
      await copyFile(fileURLToPath(new URL(name, import.meta.url)), join(library, 'scripts', name));
    const run = await exec(process.execPath, [join(library, 'scripts/dependency-check.mjs')], {
      env: {
        ...process.env,
        SIGNALS_RESEARCH_LAYOUT: 'workspace',
        SIGNALS_RESEARCH_WORKSPACE_ROOT: root,
        SIGNALS_RESEARCH_WORKSPACE_MANIFEST: manifestPath,
        SIGNALS_RESEARCH_WORKSPACE_MANIFEST_SHA256: layout.manifestSha256,
        SIGNALS_RESEARCH_WORKSPACE_LOCK_SHA256: layout.lockSha256,
      },
    });
    assert.match(run.stdout, /Verified 1 exact direct versions/);
    await writeFile(join(methods, 'src/index.mjs'), 'export const fixture = false;\n');
    assert.match((await check()).join(' '), /payload differs from frozen source/);
    await writeFile(join(methods, 'src/index.mjs'), contents.get('src/index.mjs'));
    await rm(installedLink);
    await symlink(root, installedLink);
    assert.match((await check()).join(' '), /undeclared installed workspace link/);
    await rm(installedLink);
    await symlink(methods, installedLink);
    await writeFile(
      join(root, 'package-lock.json'),
      JSON.stringify({ ...workspaceLock, changed: true }),
    );
    assert.match((await check()).join(' '), /lock digest mismatch/);
    await writeFile(join(root, 'package-lock.json'), lockBytes);
    const badManifest = JSON.stringify({ ...manifest, component: 'Undeclared' });
    await writeFile(manifestPath, badManifest);
    assert.match(
      (await check({ ...layout, manifestSha256: digest(badManifest) })).join(' '),
      /undeclared component identity/,
    );
    await writeFile(manifestPath, manifestBytes);
    assert.deepEqual(await check(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
