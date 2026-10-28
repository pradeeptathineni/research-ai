import { resolve } from 'node:path';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { channels, parseRequest } from '../../domain/src/search-contract.js';
import { atomicJson, readPrivateJson } from './search-store.js';

const closed = { additionalProperties: false };
const settingsSchema = Type.Object(
  {
    version: Type.Literal(1),
    runner: Type.Literal('codex'),
    model: Type.String({ maxLength: 100 }),
    effort: Type.String({ maxLength: 30 }),
    extractionModel: Type.Optional(Type.String({ maxLength: 100 })),
    extractionEffort: Type.Optional(Type.String({ maxLength: 30 })),
    profile: Type.Enum(['quick', 'wide']),
    route: Type.Optional(Type.Enum(['native', 'assessed'])),
    groundedReview: Type.Optional(Type.Boolean()),
    threshold: Type.Integer({ minimum: 0, maximum: 100 }),
    retentionDays: Type.Integer({ minimum: 1, maximum: 90 }),
    destination: Type.Enum(['public', 'private']),
    publication: Type.Enum(['local-only', 'reviewed-push', 'unattended']),
    sources: Type.Array(Type.Enum(channels), { minItems: 1, maxItems: 12, uniqueItems: true }),
    followedSources: Type.Optional(
      Type.Array(
        Type.Object(
          {
            uri: Type.String({ maxLength: 2048 }),
            label: Type.String({ minLength: 1, maxLength: 200 }),
            enabled: Type.Boolean(),
            interests: Type.Array(Type.String({ maxLength: 80 }), {
              maxItems: 30,
              uniqueItems: true,
            }),
          },
          closed,
        ),
        { maxItems: 50 },
      ),
    ),
    supplementalSites: Type.Optional(
      Type.Array(Type.String({ maxLength: 2048 }), { maxItems: 20, uniqueItems: true }),
    ),
    queryDiscovery: Type.Boolean(),
    promisingInbox: Type.Optional(
      Type.Object(
        { enabled: Type.Boolean(), minimumPriority: Type.Integer({ minimum: 0, maximum: 100 }) },
        closed,
      ),
    ),
    corpusDiscovery: Type.Boolean(),
    timezone: Type.Literal('UTC'),
    corpusEveryDays: Type.Integer({ minimum: 1, maximum: 3650 }),
    batchSize: Type.Integer({ minimum: 1, maximum: 10 }),
    acquisitionGroups: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: Type.String({ pattern: '^[a-z0-9-]{1,80}$' }),
            members: Type.Array(Type.String({ pattern: '^[a-z0-9-]{1,80}$' }), {
              minItems: 2,
              maxItems: 30,
              uniqueItems: true,
            }),
            query: Type.String({ minLength: 1, maxLength: 120 }),
            reason: Type.String({ minLength: 1, maxLength: 1000 }),
            proposedBy: Type.Literal('native'),
          },
          closed,
        ),
        { maxItems: 32 },
      ),
    ),
    queries: Type.Array(
      Type.Object(
        {
          id: Type.String({ pattern: '^[a-z0-9-]{1,80}$' }),
          query: Type.String({ minLength: 1, maxLength: 2000 }),
          context: Type.Optional(Type.String({ maxLength: 5000 })),
          shareAcquisition: Type.Optional(Type.Boolean()),
          enabled: Type.Boolean(),
          everyDays: Type.Integer({ minimum: 1, maximum: 3650 }),
          offsetMinutes: Type.Integer({ minimum: 0, maximum: 1440 }),
          concepts: Type.Array(Type.String(), { maxItems: 10 }),
          supplementalSites: Type.Optional(
            Type.Array(Type.String({ maxLength: 2048 }), { maxItems: 20, uniqueItems: true }),
          ),
        },
        closed,
      ),
      { maxItems: 512 },
    ),
  },
  closed,
);
export type SearchSettings = Static<typeof settingsSchema>;
export const defaultSettings: SearchSettings = {
  version: 1,
  runner: 'codex',
  model: 'gpt-6.1-sol',
  effort: 'low',
  extractionModel: '',
  extractionEffort: '',
  profile: 'wide',
  route: 'native',
  threshold: 75,
  retentionDays: 7,
  destination: 'private',
  publication: 'local-only',
  sources: [...channels],
  supplementalSites: [
    'https://www.reddit.com',
    'https://news.ycombinator.com',
    'https://stackoverflow.com',
    'https://github.com',
    'https://www.youtube.com',
  ],
  queryDiscovery: false,
  corpusDiscovery: false,
  timezone: 'UTC',
  corpusEveryDays: 14,
  batchSize: 3,
  queries: [],
};
function validateSettings(input: unknown) {
  if (!Value.Check(settingsSchema, input)) throw new Error('invalid_settings');
  const settings = structuredClone(input);
  for (const source of settings.followedSources ?? []) {
    source.uri = parseRequest({
      query: 'Validate followed source',
      captureUrls: [source.uri],
    }).captureUrls![0]!;
    if (
      [...new URL(source.uri).searchParams.keys()].some((key) =>
        /^(?:api[-_]?key|access[-_]?token|token|auth|authorization|password|secret|signature)$/i.test(
          key,
        ),
      )
    )
      throw new Error('credential_followed_source');
  }
  if (
    new Set((settings.followedSources ?? []).map((source) => source.uri)).size !==
    (settings.followedSources ?? []).length
  )
    throw new Error('duplicate_followed_source');
  settings.supplementalSites = parseRequest({
    query: 'Validate search scopes',
    supplementalSites: settings.supplementalSites,
  }).supplementalSites;
  settings.queries.forEach((query) => {
    query.supplementalSites = parseRequest({
      query: query.query,
      supplementalSites: query.supplementalSites,
    }).supplementalSites;
    parseRequest({
      query: query.query,
      supplementalSites: [
        ...new Set([...(settings.supplementalSites ?? []), ...(query.supplementalSites ?? [])]),
      ],
    });
  });
  if (new Set(settings.queries.map((query) => query.id)).size !== settings.queries.length)
    throw new Error('duplicate_query');
  const grouped = new Set<string>();
  const ids = new Set<string>();
  for (const group of settings.acquisitionGroups ?? []) {
    if (ids.has(group.id)) throw new Error('duplicate_acquisition_group');
    ids.add(group.id);
    parseRequest({ query: group.query });
    for (const id of group.members) {
      if (!settings.queries.some((query) => query.id === id))
        throw new Error('unknown_acquisition_interest');
      if (grouped.has(id)) throw new Error('overlapping_acquisition_groups');
      grouped.add(id);
    }
  }
  return settings;
}
export async function loadSettings(root = process.cwd()) {
  const raw = await readPrivateJson(root, 'settings.json', {});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid_settings');
  return validateSettings({ ...structuredClone(defaultSettings), ...raw });
}
export async function saveSettings(settings: unknown, root = process.cwd()) {
  const validated = validateSettings(settings);
  await atomicJson(resolve(root, '.signals/settings.json'), validated);
  return validated;
}
