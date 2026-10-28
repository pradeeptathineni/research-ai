import { resolve } from 'node:path';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { atomicJson, withWriter, readPrivateJson } from './search-store.js';
import type { PersonalState } from '../../domain/src/search-priority.js';
import { creditSourceFeedback } from './search-sources.js';
import { loadSettings } from './search-settings.js';
const schema = Type.Record(
  Type.String({ pattern: '^entity-[a-f0-9]{24}$' }),
  Type.Object(
    {
      note: Type.String({ maxLength: 5000 }),
      feedback: Type.Enum(['none', 'skip', 'mute', 'useful']),
      novelty: Type.Enum(['confirmed-new', 'known', 'unknown']),
      seenAt: Type.String({ maxLength: 40 }),
    },
    { additionalProperties: false },
  ),
);
export async function loadPersonal(root: string): Promise<Record<string, PersonalState>> {
  const parsed = await readPrivateJson(root, 'personal.json', {});
  if (!Value.Check(schema, parsed)) throw new Error('invalid_personal_state');
  return parsed;
}
export async function updatePersonal(
  root: string,
  id: string,
  value: PersonalState,
  parent?: string,
) {
  if (!Value.Check(schema, { [id]: value })) throw new Error('invalid_personal_state');
  return withWriter(root, async () => {
    const state = await loadPersonal(root);
    state[id] = value;
    await atomicJson(resolve(root, '.signals/personal.json'), state);
    if (parent) {
      try {
        if (
          (await loadSettings(root)).followedSources?.some(
            (source) => source.enabled && source.uri === parent,
          )
        )
          await creditSourceFeedback(root, parent, id, value.feedback);
      } catch {
        return { ...value, sourceFeedbackError: true };
      }
    }
    return value;
  });
}
