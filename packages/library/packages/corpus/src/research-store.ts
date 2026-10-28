import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, writeFile, link, unlink } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { readPublicRecord } from './public-record.js';
import { loadPublicCorpus } from './public-corpus.js';

async function directory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if ((await lstat(path)).isSymbolicLink() || (await realpath(path)) !== resolve(path))
    throw new Error('Storage directory must not follow symlinks.');
}
async function appendFile(directoryPath: string, name: string, bytes: string) {
  await directory(directoryPath);
  const temporary = join(directoryPath, `.pending-${randomUUID()}`);
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try {
    await link(temporary, join(directoryPath, name));
  } finally {
    await unlink(temporary);
  }
  return join(directoryPath, name);
}
/** Queries are private by default; saving a question never publishes it as knowledge. */
export async function saveQuery(result: unknown, root = resolve('.signals/queries')) {
  const bytes =
    JSON.stringify({ recordVersion: 1, savedAt: new Date().toISOString(), result }, null, 2) + '\n';
  if (Buffer.byteLength(bytes) > 512_000) throw new Error('Saved query exceeds byte budget.');
  return appendFile(root, `${randomUUID()}.json`, bytes);
}
/** Atomic, non-overwriting publication follows the same complete admission boundary as a rebuild. */
export async function admitRecord(raw: string, type: string, root = resolve('signals')) {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(type)) throw new Error('Invalid signal type.');
  await directory(root);
  const locks = join(dirname(root), '.signals', 'locks');
  await directory(locks);
  const lock = join(locks, `admission-${createHash('sha256').update(resolve(root)).digest('hex')}`);
  await mkdir(lock, { mode: 0o700 });
  try {
    const record = await readPublicRecord(raw, `${type}/draft.json`);
    const existing = await loadPublicCorpus(root);
    const identities = new Set(
      existing.bundles.flatMap((item) => [
        item.bundle.bundle_id,
        ...item.bundle.candidates.map((candidate) => candidate.id),
      ]),
    );
    if (
      [record.bundle.bundle_id, ...record.bundle.candidates.map((candidate) => candidate.id)].some(
        (id) => identities.has(id),
      )
    )
      throw new Error('Published evidence identities are immutable; create a successor.');
    // Validate in a complete disposable collection before adding any public bytes.
    const { mkdtemp, rm, cp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const trial = await mkdtemp(join(tmpdir(), 'signals-admission-'));
    try {
      await cp(root, trial, { recursive: true });
      await mkdir(join(trial, type), { recursive: true });
      await writeFile(join(trial, type, `${randomUUID()}.json`), raw, { flag: 'wx' });
      const checked = await loadPublicCorpus(trial);
      const additions = checked.options.filter((option) =>
        record.bundle.candidates.some((candidate) => candidate.id === option.id),
      );
      if (!additions.length) throw new Error('Held/withdrawn drafts are not automatic admissions.');
      if (additions.some((option) => option.claims.some((claim) => claim.freshness !== 'current')))
        throw new Error('Unresolved claim freshness prevents automatic high-signal admission.');
    } finally {
      await rm(trial, { recursive: true, force: true });
    }
    const folder = join(root, type);
    await directory(folder);
    const stage = join(dirname(root), '.signals', 'pending');
    await directory(stage);
    const pending = await appendFile(stage, `${randomUUID()}.json`, raw);
    const destination = join(folder, `${record.bundle.bundle_id}.json`);
    try {
      await link(pending, destination);
    } finally {
      await unlink(pending);
    }
    return destination;
  } finally {
    const { rmdir } = await import('node:fs/promises');
    await rmdir(lock);
  }
}
