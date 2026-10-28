import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, fetchEvidence } from './search-fetch.js';
import type { Project, ProjectSource } from './project-contract.js';

const projectFiles = [
  'README.md',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'docs/README.md',
  'docs/architecture.md',
  'ARCHITECTURE.md',
] as const;
const sensitive =
  /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH)|(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*["']?[^\s"']{8,}|(?:ghp_|github_pat_|sk-proj-)[a-zA-Z0-9_-]{12,}/i;
export interface ProjectPreview {
  id: string;
  expiresAt: string;
  project: Project;
  egress: {
    automatic: false;
    localPathIncluded: false;
    purpose: string;
    constraints: string[];
    files: Project['snapshot']['files'];
    warning: string;
  };
}
const ancestor = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

interface LocalReadBoundary {
  rootStat: Stats;
  beforeOpen?: (path: string) => Promise<void>;
}
async function safeRead(
  root: string,
  name: string,
  boundary: LocalReadBoundary,
  cap = 16384,
): Promise<string | null> {
  const path = resolve(root, name);
  if (!ancestor(root, path) || path === root) throw new Error('outside_project_root');
  const captured = new Map<string, Stats>();
  for (let current = path; ; current = dirname(current)) {
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return null;
    if (stat.isSymbolicLink()) throw new Error('symlink_withheld');
    if (current !== path && !stat.isDirectory()) throw new Error('symlink_withheld');
    captured.set(current, stat);
    if (current === root) {
      if (stat.dev !== boundary.rootStat.dev || stat.ino !== boundary.rootStat.ino)
        throw new Error('source_changed_during_preview');
      break;
    }
  }
  if ((await realpath(path)) !== path) throw new Error('symlink_withheld');
  await boundary.beforeOpen?.(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > cap) throw new Error('oversize_or_nonregular_withheld');
    const approved = captured.get(path)!;
    if (stat.dev !== approved.dev || stat.ino !== approved.ino)
      throw new Error('source_changed_during_preview');
    const verifyBinding = async () => {
      for (const [entry, prior] of captured) {
        const current = await lstat(entry);
        if (
          current.isSymbolicLink() ||
          current.dev !== prior.dev ||
          current.ino !== prior.ino ||
          (entry !== path && !current.isDirectory())
        )
          throw new Error('source_changed_during_preview');
      }
      if ((await realpath(path)) !== path) throw new Error('symlink_withheld');
    };
    await verifyBinding();
    const buffer = Buffer.alloc(cap + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    const after = await file.stat();
    if (
      bytes.length > cap ||
      after.size !== stat.size ||
      bytes.length !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ino !== stat.ino
    )
      throw new Error('source_changed_during_preview');
    await verifyBinding();
    if (bytes.includes(0)) throw new Error('binary_withheld');
    return bytes.toString('utf8');
  } finally {
    await file.close();
  }
}

// Only the documented fixed candidates are matched. Unsupported syntax fails closed.
export function ignoredProjectFile(
  name: string,
  input: string,
): 'ignored' | 'allowed' | 'unsupported' {
  let ignored = false;
  for (const raw of input.split(/\r?\n/)) {
    if (!raw || raw.startsWith('#')) continue;
    if (/[\\{}]|\s$/.test(raw)) return 'unsupported';
    const negated = raw.startsWith('!');
    let pattern = negated ? raw.slice(1) : raw;
    if (!pattern || pattern.includes('***')) return 'unsupported';
    const anchored = pattern.startsWith('/');
    const directory = pattern.endsWith('/');
    pattern = pattern.replace(/^\//, '').replace(/\/$/, '');
    let expression = '';
    for (let index = 0; index < pattern.length; index++) {
      const char = pattern[index]!;
      if (char === '*' && pattern[index + 1] === '*') {
        index++;
        if (pattern[index + 1] === '/') {
          expression += '(?:.*/)?';
          index++;
        } else expression += '.*';
      } else if (char === '[') {
        const end = pattern.indexOf(']', index + 1);
        if (end === -1) return 'unsupported';
        const body = pattern.slice(index + 1, end);
        const inverted = body.startsWith('!');
        const members = inverted ? body.slice(1) : body;
        if (!members || members.length > 64 || !/^[A-Za-z0-9_.-]+$/.test(members))
          return 'unsupported';
        // Ascending ASCII ranges and literal letters/digits are safe; POSIX classes and escaping remain unsupported.
        for (let member = 0; member < members.length; member++) {
          if (
            members[member] === '-' &&
            member > 0 &&
            member < members.length - 1 &&
            members.charCodeAt(member - 1) > members.charCodeAt(member + 1)
          )
            return 'unsupported';
        }
        expression += `[${inverted ? '^/' : ''}${members}]`;
        index = end;
      } else if (char === ']') return 'unsupported';
      else if (char === '*') expression += '[^/]*';
      else if (char === '?') expression += '[^/]';
      else expression += char.replace(/[.+^$()|]/g, '\\$&');
    }
    const prefix = anchored || pattern.includes('/') ? '^' : '(?:^|/)';
    const matcher = new RegExp(prefix + expression + (directory ? '/' : '(?:$|/)'));
    if (matcher.test(name)) {
      // A child cannot be re-included through an excluded parent directory.
      if (negated && ignored && name.includes('/') && !matcher.test(name.split('/')[0]! + '/'))
        return 'unsupported';
      ignored = !negated;
    }
  }
  return ignored ? 'ignored' : 'allowed';
}

export async function previewProject(
  source: ProjectSource,
  serverRoot: string,
  fetcher = fetchEvidence,
  localHooks: { beforeOpen?: (path: string) => Promise<void> } = {},
): Promise<ProjectPreview> {
  const files: Project['snapshot']['files'] = [];
  const gaps: string[] = [];
  let revision: string | null = null;
  let name: string;
  let read: (path: string) => Promise<string | null>;
  const ignores: { prefix: string; text: string }[] = [];
  if (source.kind === 'local') {
    if (!isAbsolute(source.path) || resolve(source.path) !== source.path)
      throw new Error('explicit_absolute_folder_required');
    const path = source.path;
    if (
      ancestor(path, homedir()) ||
      (path !== resolve(serverRoot) && ancestor(path, resolve(serverRoot))) ||
      [
        '/tmp',
        '/private/tmp',
        '/var',
        '/private/var',
        '/Volumes',
        '/Users',
        '/Applications',
        '/Library',
        '/System',
      ].includes(path)
    )
      throw new Error('broad_or_ancestor_folder_denied');
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== path)
      throw new Error('symlink_or_nonfolder_denied');
    name = basename(path);
    read = (entry) => safeRead(path, entry, { rootStat: stat, beforeOpen: localHooks.beforeOpen });
    for (const entry of ['.gitignore', '.git/info/exclude', 'docs/.gitignore']) {
      try {
        const text = await read(entry);
        if (text !== null) ignores.push({ prefix: entry.startsWith('docs/') ? 'docs/' : '', text });
      } catch {
        ignores.push({
          prefix: entry.startsWith('docs/') ? 'docs/' : '',
          text: '[[:unsupported:]]',
        });
        gaps.push(`${entry}: ignore boundary unreadable; affected summaries withheld`);
      }
    }
  } else {
    const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/.exec(
      source.uri,
    );
    if (!match || match[1] === '.' || match[2] === '.' || match[1] === '..' || match[2] === '..')
      throw new Error('github_repository_url_required');
    source = { kind: 'github', uri: `https://github.com/${match[1]}/${match[2]}` };
    const base = `https://api.github.com/repos/${match[1]}/${match[2]}`;
    const json = async (uri: string) => {
      const response = await fetcher(uri, AbortSignal.timeout(15000));
      return JSON.parse(response.text) as Record<string, unknown>;
    };
    const metadata = await json(base);
    if (
      typeof metadata.full_name !== 'string' ||
      metadata.full_name.toLowerCase() !== `${match[1]}/${match[2]}`.toLowerCase() ||
      typeof metadata.default_branch !== 'string'
    )
      throw new Error('github_identity_unresolved');
    const commit = await json(`${base}/commits/${encodeURIComponent(metadata.default_branch)}`);
    if (typeof commit.sha !== 'string' || !/^[a-f0-9]{40,64}$/.test(commit.sha))
      throw new Error('github_revision_unresolved');
    revision = commit.sha;
    name = match[2]!;
    read = async (entry) => {
      try {
        const result = await json(`${base}/contents/${entry}?ref=${revision}`);
        if (
          result.type !== 'file' ||
          result.path !== entry ||
          result.encoding !== 'base64' ||
          typeof result.content !== 'string' ||
          typeof result.size !== 'number' ||
          result.size > 16384
        )
          throw new Error('oversize_or_nonregular_withheld');
        const bytes = Buffer.from(result.content, 'base64');
        if (bytes.length > 16384 || bytes.length !== result.size || bytes.includes(0))
          throw new Error('invalid_document_withheld');
        return bytes.toString('utf8');
      } catch (error) {
        if (error instanceof Error && error.message === 'source_http_404') return null;
        throw error;
      }
    };
    for (const entry of ['.gitignore', 'docs/.gitignore']) {
      try {
        const text = await read(entry);
        if (text !== null) ignores.push({ prefix: entry.startsWith('docs/') ? 'docs/' : '', text });
      } catch {
        ignores.push({ prefix: '', text: '[[:unsupported:]]' });
        gaps.push(`${entry}: ignore boundary unreadable; summaries withheld`);
      }
    }
  }
  let total = 0;
  for (const path of projectFiles) {
    const ignored = ignores.some(
      (rule) =>
        path.startsWith(rule.prefix) &&
        ignoredProjectFile(path.slice(rule.prefix.length), rule.text) !== 'allowed',
    );
    if (ignored) {
      gaps.push(`${path}: ignored or unsupported ignore syntax; withheld`);
      continue;
    }
    try {
      const text = await read(path);
      if (text === null) continue;
      const bytes = Buffer.byteLength(text);
      if (sensitive.test(text)) {
        gaps.push(`${path}: sensitive content withheld`);
        continue;
      }
      if (total + bytes > 65536) {
        gaps.push(`${path}: total byte limit reached`);
        continue;
      }
      total += bytes;
      files.push({ path, bytes, digest: digest(text), excerpt: text.slice(0, 1500) });
    } catch (error) {
      gaps.push(
        `${path}: ${error instanceof Error && ['symlink_withheld', 'oversize_or_nonregular_withheld', 'source_changed_during_preview', 'binary_withheld'].includes(error.message) ? error.message : 'read unavailable'}`,
      );
    }
  }
  let purpose =
    files
      .find((file) => file.path === 'README.md')
      ?.excerpt.replace(/^#+\s.*$/gm, '')
      .trim()
      .split(/\n\s*\n/)[0]
      ?.slice(0, 3000) || 'Describe this project or learning brief.';
  const manifest = files.find((file) => file.path === 'package.json');
  if (manifest) {
    try {
      const parsed = JSON.parse(manifest.excerpt) as { description?: unknown };
      if (typeof parsed.description === 'string' && parsed.description.trim())
        purpose = parsed.description.slice(0, 3000);
    } catch {
      /* Editable document summary remains available. */
    }
  }
  const project: Project = {
    id: `project-${digest(JSON.stringify(source)).slice(0, 24)}`,
    name,
    purpose,
    constraints: [],
    source,
    connected: true,
    snapshot: {
      digest: digest(
        JSON.stringify({
          revision,
          files: files.map(({ path, digest: hash }) => ({ path, digest: hash })),
          gaps,
        }),
      ),
      observedAt: new Date().toISOString(),
      basis: source.kind === 'local' ? 'local-documents' : 'github-commit',
      revision,
      dirty: 'unknown',
      files,
      gaps,
    },
  };
  return {
    id: randomUUID(),
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    project,
    egress: {
      automatic: false,
      localPathIncluded: false,
      purpose,
      constraints: [],
      files,
      warning:
        'Documents are untrusted data. Nothing is sent to an AI service until you confirm a research request.',
    },
  };
}
