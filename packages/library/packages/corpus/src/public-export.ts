import { lstat, mkdir, mkdtemp, rename, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { loadPublicCorpus } from './public-corpus.js';
import { parsePublicIndex } from '../../domain/src/public-index.js';
import type { StoredEntity } from './search-store.js';
import { projectLegacyLibrary, projectNativeLibrary } from '../../domain/src/library-search.js';

/** Complete immutable derived bytes before atomically switching the public-data pointer. */
export async function publishPublicData(
  corpus: Awaited<ReturnType<typeof loadPublicCorpus>>,
  directory = 'dist',
  entities: StoredEntity[] = [],
) {
  parsePublicIndex(corpus.options);
  if (corpus.bundles.some(({ bundle }) => !/^[a-zA-Z0-9-]+$/.test(bundle.bundle_id)))
    throw new Error('Unsafe public download name.');
  await mkdir(directory, { recursive: true });
  const pointer = join(resolve(directory), 'public-data');
  const prior = await lstat(pointer).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (prior && !prior.isSymbolicLink())
    throw new Error('Existing public-data directory must be preserved or moved before building.');
  const staging = await mkdtemp(join(resolve(directory), 'public-snapshot-'));
  await writeFile(join(staging, 'corpus.json'), `${JSON.stringify(corpus.options, null, 2)}\n`);
  await writeFile(join(staging, 'entities.json'), `${JSON.stringify(entities, null, 2)}\n`);
  // Derive only from the approved public inputs. Local annotations and projects never enter this view.
  const library = [
    ...entities.map((record) => projectNativeLibrary(record, 'public')),
    ...corpus.options.map(projectLegacyLibrary),
  ];
  await writeFile(join(staging, 'library.json'), `${JSON.stringify(library, null, 2)}\n`);
  await mkdir(join(staging, 'bundles'));
  for (const { bundle, admission, bytes } of corpus.bundles) {
    await writeFile(join(staging, 'bundles', `${bundle.bundle_id}.json`), bytes);
    await writeFile(
      join(staging, 'bundles', `${bundle.bundle_id}.json.sha256`),
      `${admission.digest}\n`,
    );
  }
  const next = `${staging}.pointer`;
  await symlink(staging, next, 'dir');
  await rename(next, pointer);
}
