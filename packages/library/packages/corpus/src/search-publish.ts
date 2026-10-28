import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadEntities, withWriter } from './search-store.js';
import { resolve } from 'node:path';

const exec = promisify(execFile);
async function git(root: string, args: string[]) {
  return (await exec('git', args, { cwd: root, timeout: 30000, maxBuffer: 1000000 })).stdout;
}
export async function publicationReadiness(root = process.cwd(), requireClean = false) {
  const remote = (await git(root, ['remote', 'get-url', 'origin'])).trim();
  if (
    !/^(?:https:\/\/github\.com\/|git@github\.com:)pradeeptathineni\/signals-ai(?:\.git)?$/.test(
      remote,
    )
  )
    throw new Error('unknown_publication_remote');
  const branch = (await git(root, ['branch', '--show-current'])).trim();
  if (branch !== 'main') throw new Error('publication_requires_main');
  const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const rows = status.split('\0').filter(Boolean);
  const paths = rows.map((row) => row.slice(3));
  if (
    rows.some((row) => row.startsWith('R') || row.startsWith('C')) ||
    paths.some((path) => !/^signals\/entities\/entity-[a-f0-9]{24}\.json$/.test(path))
  )
    throw new Error('unrelated_dirty_publication_destination');
  if (requireClean && paths.length) throw new Error('publication_destination_not_clean');
  if ((await git(root, ['diff', '--cached', '--name-only'])).trim())
    throw new Error('preexisting_staged_changes');
  const local = (await git(root, ['rev-parse', 'HEAD'])).trim();
  const remoteHead = (await git(root, ['rev-parse', 'origin/main'])).trim();
  if (local !== remoteHead) throw new Error('publication_requires_reviewed_remote_parity');
  return { remote, branch, paths };
}
/** Explicit publication stages only validated native entity paths, and never rewrites remote history. */
export async function publishCorpus(root = process.cwd()) {
  return withWriter(root, async () => {
    const ready = await publicationReadiness(root);
    if (!ready.paths.length) return { published: false, reason: 'no_material_public_change' };
    await loadEntities(resolve(root, 'signals/entities'));
    await git(root, ['fetch', 'origin', 'main']);
    const divergence = (
      await git(root, ['rev-list', '--left-right', '--count', 'HEAD...origin/main'])
    )
      .trim()
      .split(/\s+/)
      .map(Number);
    if (divergence[1] !== 0) throw new Error('remote_changed_review_required');
    await git(root, ['add', '--', ...ready.paths]);
    const staged = (await git(root, ['diff', '--cached', '--name-only'])).trim().split('\n');
    if (staged.some((path) => !ready.paths.includes(path)))
      throw new Error('unexpected_publication_stage');
    await git(root, ['diff', '--cached', '--check']);
    await git(root, ['commit', '-m', 'feat(corpus): update evidence-backed discovery batch']);
    const commit = (await git(root, ['rev-parse', 'HEAD'])).trim();
    await git(root, ['push', 'origin', 'main']);
    return {
      published: true,
      commit,
      workflow:
        'The existing push-triggered CI and Pages build/deploy validate this human/configured-user push. No GITHUB_TOKEN inference workflow is installed.',
    };
  });
}
