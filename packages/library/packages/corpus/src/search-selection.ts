import { resolve } from 'node:path';
import { loadEntities } from './search-store.js';

/** Bind a saved identity to its selected store; duplicate identities need explicit scope. */
export async function selectSavedEntity(
  id: string,
  root: string,
  destination?: 'public' | 'private',
) {
  if (!/^entity-[a-f0-9]{24}$/.test(id)) throw new Error('invalid_entity_id');
  if (destination !== undefined && !['public', 'private'].includes(destination))
    throw new Error('invalid_entity_destination');
  const stores = destination ? [destination] : (['public', 'private'] as const);
  const candidates = (
    await Promise.all(
      stores.map(async (store) => ({
        destination: store,
        record: (
          await loadEntities(
            resolve(root, store === 'public' ? 'signals/entities' : '.signals/corpus/entities'),
          )
        ).find((record) => record.entity.id === id),
      })),
    )
  ).filter((candidate) => candidate.record !== undefined);
  if (candidates.length > 1) throw new Error('ambiguous_entity_destination');
  const selected = candidates[0];
  if (!selected?.record) throw new Error('unknown_entity');
  return { destination: selected.destination, record: selected.record };
}
