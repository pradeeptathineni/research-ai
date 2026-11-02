import { createHash } from 'node:crypto';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import {
  changeLibraryPreferences,
  libraryPreferences,
  personalSavingDefaults,
  personalSavingSchema,
  libraryPreferencesSchema,
} from './library-meaning.js';

const fields = [
  {
    key: 'enabled',
    label: 'Automatic private saving',
    description: 'Privately retain qualifying results when workbench research completes.',
    constraints: personalSavingSchema.properties.enabled,
  },
  {
    key: 'signalThreshold',
    label: 'Minimum Signal',
    description:
      'Minimum Signal for automatic private saving. Other eligibility checks still apply.',
    constraints: personalSavingSchema.properties.signalThreshold,
  },
  {
    key: 'relevanceThreshold',
    label: 'Minimum relevance',
    description:
      'Required topic relevance. 75 is a direct match. 100 means the inspected constraints are met.',
    constraints: personalSavingSchema.properties.relevanceThreshold,
  },
] as const;
const ids = fields.map((field) => `automaticSaving.${field.key}`);
type Preferences = Awaited<ReturnType<typeof libraryPreferences>>;
const revision = (preferences: Preferences) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        meaningMatching: preferences.meaningMatching,
        automaticSaving: preferences.automaticSaving
          ? {
              enabled: preferences.automaticSaving.enabled,
              signalThreshold: preferences.automaticSaving.signalThreshold,
              relevanceThreshold: preferences.automaticSaving.relevanceThreshold,
            }
          : null,
      }),
    )
    .digest('hex');

function projection(preferences: Preferences) {
  const effective = preferences.automaticSaving ?? personalSavingDefaults;
  return {
    schema: 'owner.settings.v1' as const,
    owner: 'research-ai',
    component: 'library',
    scope: 'private-library',
    revision: revision(preferences),
    storage: '.signals/library-preferences.json',
    settings: fields.map((field) => ({
      id: `automaticSaving.${field.key}`,
      label: field.label,
      category: 'Personal saving',
      description: field.description,
      constraints: field.constraints,
      default: personalSavingDefaults[field.key],
      effective: effective[field.key],
      source: preferences.automaticSaving ? 'private preferences' : 'default',
      scope: 'private-library',
      editable: true,
      risk: 'preference',
      restartRequired: false,
      takesEffect: 'next automatic-saving decision',
      resetGroup: 'automaticSaving',
    })),
    limitations: [
      'Only private automatic-saving preferences are editable here.',
      'Saving still requires completed assessment, resolved identity and no decisive unresolved contradiction. Thresholds are policy judgments, not probabilities.',
      'Changing these defaults starts no research and saves no existing result.',
      'The workbench reads this policy at completion. A running operation can observe a saved change.',
      'Memory-only requests, claim checks and refresh do not use automatic personal saving.',
      'Manual saving, public admission, recurrence and meaning-matching consent remain separate.',
      'Reset restores the complete personal-saving group. Individual override removal is unsupported.',
      'Revision binds the validated preference values, including unexposed consent, rather than file formatting.',
    ],
  };
}
export type LibrarySettings = ReturnType<typeof projection>;
export async function readLibrarySettings(root: string) {
  return projection(await libraryPreferences(root));
}

const requestSchema = Type.Object(
  {
    action: Type.Enum(['preview', 'save']),
    expectedRevision: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    updates: Type.Record(Type.String(), Type.Unknown()),
    resets: Type.Array(Type.String(), { uniqueItems: true, maxItems: 3 }),
  },
  { additionalProperties: false },
);

/** Edit only the existing private-saving group, never consent or execution settings. */
export async function editLibrarySettings(root: string, input: unknown) {
  if (!Value.Check(requestSchema, input)) throw new Error('invalid_library_settings');
  const reset = input.resets.length > 0;
  const keys = Object.keys(input.updates);
  if (
    reset
      ? keys.length ||
        ids.some((id) => !input.resets.includes(id)) ||
        input.resets.length !== ids.length
      : !keys.length || keys.some((key) => !ids.includes(key))
  )
    throw new Error('invalid_library_settings');
  for (const field of fields) {
    const id = `automaticSaving.${field.key}`;
    if (id in input.updates && !Value.Check(field.constraints, input.updates[id]))
      throw new Error('invalid_library_settings');
  }
  const prepare = (current: Preferences) => {
    if (revision(current) !== input.expectedRevision) throw new Error('settings_changed');
    const next = { ...current };
    if (reset) delete next.automaticSaving;
    else {
      const values = { ...(current.automaticSaving ?? personalSavingDefaults) };
      for (const field of fields) {
        const id = `automaticSaving.${field.key}`;
        if (id in input.updates) Object.assign(values, { [field.key]: input.updates[id] });
      }
      next.automaticSaving = values;
    }
    if (!Value.Check(libraryPreferencesSchema, next)) throw new Error('invalid_library_settings');
    return next;
  };
  const preferences =
    input.action === 'save'
      ? await changeLibraryPreferences(root, prepare)
      : prepare(await libraryPreferences(root));
  return {
    ...projection(preferences),
    baseRevision: input.expectedRevision,
    saved: input.action === 'save',
  };
}
