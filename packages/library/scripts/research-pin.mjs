import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const packageName = '@pradeeptathineni/research-ai';
const identityKeys = [
  'name',
  'version',
  'license',
  'type',
  'engines',
  'bin',
  'types',
  'exports',
  'files',
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const blobHash = (bytes) =>
  createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

function layoutOption(option) {
  if (option !== undefined) return option;
  if (process.env.SIGNALS_RESEARCH_LAYOUT === undefined) return null;
  return {
    mode: process.env.SIGNALS_RESEARCH_LAYOUT,
    root: process.env.SIGNALS_RESEARCH_WORKSPACE_ROOT,
    manifest: process.env.SIGNALS_RESEARCH_WORKSPACE_MANIFEST,
    manifestSha256: process.env.SIGNALS_RESEARCH_WORKSPACE_MANIFEST_SHA256,
    lockSha256: process.env.SIGNALS_RESEARCH_WORKSPACE_LOCK_SHA256,
  };
}

function requireValue(condition, message) {
  if (!condition) throw new Error(`research-ai workspace: ${message}`);
}

async function ordinaryFile(path, limit = 4 * 1024 * 1024) {
  const info = await lstat(path);
  requireValue(
    info.isFile() && !info.isSymbolicLink() && info.size <= limit,
    'ordinary bounded file required',
  );
  requireValue((await realpath(path)) === path, 'file path substitution');
  return readFile(path);
}

/** Explicit workspace policy; never selected by detecting an installed symlink. */
async function workspaceContext(libraryRoot, layout) {
  requireValue(layout?.mode === 'workspace', 'unsupported or incomplete explicit layout');
  requireValue(
    typeof layout.root === 'string' && isAbsolute(layout.root),
    'absolute declared root required',
  );
  const root = await realpath(layout.root);
  requireValue(
    root === layout.root && (await realpath(libraryRoot)) === join(root, 'packages/library'),
    'undeclared Library root',
  );
  requireValue(
    typeof layout.manifest === 'string' && isAbsolute(layout.manifest),
    'absolute manifest required',
  );
  const manifestRelative = relative(root, layout.manifest);
  requireValue(
    manifestRelative && !manifestRelative.startsWith('..') && !isAbsolute(manifestRelative),
    'manifest outside workspace',
  );
  requireValue(
    /^[a-f0-9]{64}$/.test(layout.manifestSha256 ?? '') &&
      /^[a-f0-9]{64}$/.test(layout.lockSha256 ?? ''),
    'declared manifest and lock hashes required',
  );
  const manifestBytes = await ordinaryFile(layout.manifest, 128 * 1024);
  requireValue(sha256(manifestBytes) === layout.manifestSha256, 'manifest digest mismatch');
  const manifest = JSON.parse(manifestBytes);
  requireValue(
    manifest.schema === 'research.component-source-manifest.v1' &&
      manifest.component === 'Methods' &&
      manifest.ownerId === 'research-ai' &&
      manifest.targetPath === 'packages/methods',
    'undeclared component identity',
  );
  const methods = join(root, 'packages/methods');
  requireValue((await realpath(methods)) === methods, 'Methods root substitution');
  const packageBytes = await ordinaryFile(join(methods, 'package.json'));
  const metadata = JSON.parse(packageBytes);
  requireValue(
    metadata.name === packageName && metadata.license === 'MIT',
    'unexpected Methods package identity',
  );
  const projection = Object.fromEntries(identityKeys.map((key) => [key, metadata[key]]));
  const expectedProjection = Object.fromEntries(
    identityKeys.map((key) => [key, manifest.packageIdentity?.[key]]),
  );
  requireValue(
    JSON.stringify(projection) === JSON.stringify(expectedProjection) &&
      sha256(JSON.stringify(projection)) === manifest.packageIdentityProjectionSha256,
    'package identity projection mismatch',
  );
  requireValue(
    Object.keys(metadata.dependencies ?? {}).length === 0,
    'Methods runtime dependency boundary changed',
  );
  const commit = manifest.frozenSource?.integrationCommit;
  requireValue(/^[a-f0-9]{40}$/.test(commit ?? ''), 'frozen source revision required');
  await execute('git', ['-C', root, 'merge-base', '--is-ancestor', commit, 'HEAD']);
  const tree = (
    await execute('git', ['-C', root, 'ls-tree', '-r', '-z', commit], {
      maxBuffer: 8 * 1024 * 1024,
    })
  ).stdout;
  const blobs = new Map(
    tree
      .split('\0')
      .filter(Boolean)
      .map((row) => {
        const tab = row.indexOf('\t');
        const [mode, kind, hash] = row.slice(0, tab).split(' ');
        return [row.slice(tab + 1), { mode, kind, hash }];
      }),
  );
  requireValue(
    blobHash(packageBytes) === blobs.get('package.json')?.hash,
    'package bytes differ from frozen source',
  );
  const files = new Map();
  let totalBytes = 0;
  async function visit(name) {
    requireValue(
      typeof name === 'string' &&
        name &&
        !name.includes('\\') &&
        !isAbsolute(name) &&
        !name.split('/').some((part) => !part || part === '.' || part === '..'),
      'invalid payload path',
    );
    const path = join(methods, name);
    const info = await lstat(path);
    requireValue(
      !info.isSymbolicLink() && (await realpath(path)) === path,
      'payload path substitution',
    );
    if (info.isDirectory()) {
      for (const child of await readdir(path)) await visit(`${name}/${child}`);
    } else {
      requireValue(info.isFile() && info.size <= 16 * 1024 * 1024, 'invalid payload file');
      const bytes = await ordinaryFile(path, 16 * 1024 * 1024);
      const frozen = blobs.get(name);
      requireValue(
        frozen?.kind === 'blob' &&
          ['100644', '100755'].includes(frozen.mode) &&
          blobHash(bytes) === frozen.hash,
        'payload differs from frozen source',
      );
      totalBytes += files.has(name) ? 0 : bytes.length;
      requireValue(totalBytes <= 64 * 1024 * 1024 && files.size < 10000, 'payload bounds exceeded');
      files.set(name, sha256(bytes));
    }
  }
  requireValue(
    Array.isArray(metadata.files) && metadata.files.length <= 256,
    'bounded package file list required',
  );
  for (const name of metadata.files) await visit(name);
  const rows = [...files.keys()].sort().map((path) => ({ path, sha256: files.get(path) }));
  requireValue(
    rows.length === manifest.payloadManifest?.fileCount &&
      sha256(JSON.stringify(rows)) === manifest.payloadManifest?.sha256,
    'payload manifest mismatch',
  );
  const rootPackage = JSON.parse(await ordinaryFile(join(root, 'package.json')));
  requireValue(
    rootPackage.private === true &&
      Array.isArray(rootPackage.workspaces) &&
      rootPackage.workspaces.includes('packages/methods') &&
      rootPackage.workspaces.includes('packages/library'),
    'declared workspace components required',
  );
  const lockBytes = await ordinaryFile(join(root, 'package-lock.json'));
  requireValue(sha256(lockBytes) === layout.lockSha256, 'workspace lock digest mismatch');
  const lock = JSON.parse(lockBytes);
  const link = lock.packages?.[`node_modules/${packageName}`];
  requireValue(
    link?.link === true && link.resolved === 'packages/methods',
    'workspace lock must bind exact Methods target',
  );
  const locked = lock.packages?.['packages/methods'];
  requireValue(
    locked?.name === metadata.name &&
      locked.version === metadata.version &&
      locked.license === metadata.license,
    'workspace lock package identity mismatch',
  );
  const installed = join(root, 'node_modules', packageName);
  requireValue(
    (await lstat(installed)).isSymbolicLink() && (await realpath(installed)) === methods,
    'undeclared installed workspace link',
  );
  return { root, metadata, rootPackage };
}

/** The dependency checker may use only this declared root, never a parent search. */
export async function researchDependencyRoot(root, option) {
  const layout = layoutOption(option);
  return layout
    ? join((await workspaceContext(root, layout)).root, 'node_modules')
    : join(root, 'node_modules');
}

// Exact composed Research archive; version alone does not identify these capabilities.
export const researchArchive = {
  version: '0.4.0-rc.1',
  sourceCommit: '344a5ea30a36efaf3c10ca1fa4b6f3a319f01fa4',
  sha256: '0f7ab726f7267e1a7e85c4f7094d909db5a7e64671a2b319d3083aa39f6ce947',
  integrity:
    'sha512-WwROhHo9AMQHDsapnVDvhdBwTHMMYr5WzdutkbA0rb9x4wboXP8U6Qt48lD+11mQXPi60nteskdUNHuaTM2obA==',
};
export const researchSpec = `file:vendor/research-ai/${researchArchive.sha256}.tgz`;

export async function checkResearchPin(root, declared, locked, installed, option) {
  const layout = layoutOption(option);
  if (layout) {
    try {
      const context = await workspaceContext(root, layout);
      const override = context.rootPackage.overrides?.[packageName];
      const acceptedOverride =
        typeof override === 'string' &&
        override.startsWith('file:') &&
        resolve(context.root, override.slice(5)) === join(context.root, 'packages/methods');
      requireValue(
        declared === 'file:../methods' || (declared === researchSpec && acceptedOverride),
        'undeclared workspace dependency',
      );
      requireValue(
        installed.name === context.metadata.name &&
          installed.version === context.metadata.version &&
          installed.license === context.metadata.license,
        'installed workspace metadata mismatch',
      );
      return [];
    } catch (error) {
      return [
        `research-ai: workspace integrity refused (${error instanceof Error ? error.message : 'unavailable'})`,
      ];
    }
  }
  const errors = [];
  if (declared !== researchSpec || locked?.resolved !== researchSpec)
    errors.push('research-ai: manifest and lock must name the accepted local archive');
  if (locked?.version !== researchArchive.version || installed.version !== researchArchive.version)
    errors.push('research-ai: installed and locked versions must match the accepted source commit');
  if (locked?.integrity !== researchArchive.integrity)
    errors.push('research-ai: lock integrity differs from the accepted archive');
  if (installed.license !== 'MIT' || locked?.license !== 'MIT')
    errors.push('research-ai: installed and locked MIT license required');
  const vendor = join(root, 'vendor');
  const archiveDirectory = join(vendor, 'research-ai');
  const archive = join(archiveDirectory, `${researchArchive.sha256}.tgz`);
  const packageDirectory = join(root, 'node_modules', '@pradeeptathineni', 'research-ai');
  const canonicalRoot = await realpath(root);
  const expected = (path) => join(canonicalRoot, relative(root, path));
  for (const directory of [vendor, archiveDirectory, packageDirectory]) {
    const stat = await lstat(directory).catch(() => null);
    if (
      !stat?.isDirectory() ||
      stat.isSymbolicLink() ||
      (await realpath(directory)) !== expected(directory)
    )
      errors.push(`research-ai: directory or symlink substitution at ${directory}`);
  }
  const stat = await lstat(archive).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || (await realpath(archive)) !== expected(archive))
    errors.push('research-ai: archive must be an ordinary tracked file');
  else {
    const bytes = await readFile(archive);
    if (
      createHash('sha256').update(bytes).digest('hex') !== researchArchive.sha256 ||
      `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== researchArchive.integrity
    )
      errors.push('research-ai: accepted archive bytes changed');
  }
  return errors;
}
