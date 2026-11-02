import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

export interface PublicSiteArtifact {
  path: string;
  bytes: string;
  sha256: string;
  byteLength: number;
}

const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

const viteShellFile = (path: string) =>
  path === 'index.html' ||
  /^assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,32}\.(?:js|css)$/.test(path);

/** Checks the whole Vite tree; only reviewed data files and the app's hashed shell are allowed. */
export async function verifyPublicSiteArtifactBytes(
  artifacts: PublicSiteArtifact[],
  directory: string,
) {
  if (!Array.isArray(artifacts)) throw new Error('Invalid reviewed public site manifest.');
  const root = resolve(directory);
  const rootInfo = await lstat(root).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error('Reviewed public site must be an existing real directory.');
  const expected = new Set<string>();
  for (const artifact of artifacts) {
    if (
      !artifact ||
      typeof artifact.path !== 'string' ||
      !artifact.path ||
      artifact.path.includes('\\') ||
      artifact.path.split('/').some((segment) => !segment || segment === '.' || segment === '..') ||
      typeof artifact.bytes !== 'string' ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      hash(artifact.bytes) !== artifact.sha256 ||
      Buffer.byteLength(artifact.bytes, 'utf8') !== artifact.byteLength ||
      expected.has(artifact.path)
    )
      throw new Error('Invalid or duplicate public artifact in reviewed manifest.');
    expected.add(artifact.path);
  }
  const actual = new Set<string>();
  const appShell = new Set<string>();
  const inspect = async (relative: string, absolute: string): Promise<void> => {
    const info = await lstat(absolute);
    if (info.isSymbolicLink())
      throw new Error(`Reviewed public site contains a symlink: ${relative}`);
    if (info.isDirectory()) {
      if (relative !== 'assets' && relative !== 'bundles')
        throw new Error(`Static site contains an unreviewed directory: ${relative}`);
      for (const entry of await readdir(absolute))
        await inspect(`${relative}/${entry}`, join(absolute, entry));
      return;
    }
    if (!info.isFile())
      throw new Error(`Reviewed public site contains a non-file artifact: ${relative}`);
    if (expected.has(relative)) {
      actual.add(relative);
      return;
    }
    if (viteShellFile(relative)) {
      appShell.add(relative);
      return;
    }
    throw new Error(`Static site contains an unreviewed file: ${relative}`);
  };
  for (const entry of await readdir(root)) await inspect(entry, join(root, entry));
  if (!appShell.has('index.html') || ![...appShell].some((path) => path.endsWith('.js')))
    throw new Error('Static site is missing the Vite HTML or JavaScript app shell.');
  if (actual.size !== expected.size || [...expected].some((path) => !actual.has(path)))
    throw new Error('Static site public-data paths differ from the reviewed preview.');
  for (const artifact of artifacts) {
    const path = resolve(root, ...artifact.path.split('/'));
    if (!path.startsWith(`${root}${sep}`))
      throw new Error('Public artifact path escaped the reviewed site directory.');
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink())
      throw new Error(`Reviewed public site is missing a regular file: ${artifact.path}`);
    const bytes = await readFile(path);
    if (
      !bytes.equals(Buffer.from(artifact.bytes, 'utf8')) ||
      hash(bytes.toString('utf8')) !== artifact.sha256
    )
      throw new Error(`Static site bytes differ from the reviewed preview: ${artifact.path}`);
  }
  return {
    verified: true as const,
    artifacts: artifacts.map(({ path, sha256, byteLength }) => ({
      path,
      sha256,
      byteLength,
    })),
  };
}
