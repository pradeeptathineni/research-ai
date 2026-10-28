import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import MiniSearch from 'minisearch';
import { Type, type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { atomicJson, readPrivateJson, withWriter } from './search-store.js';
import { exactOwnerRecord, providerLibrary, ProviderError } from './provider-capabilities.js';
import { requestStore } from './search-request-store.js';

const closed = { additionalProperties: false };
const short = Type.String({ minLength: 1, maxLength: 200 });
const sha = Type.String({ pattern: '^[a-f0-9]{64}$' });
const topicGraphByteLimit = 4 * 1024 * 1024;
const refSchema = Type.Object(
  { owner: short, kind: short, id: short, revision: short, digest: sha },
  closed,
);
const selectionSchema = Type.Object(
  { ref: refSchema, instance_id: short, owner_epoch: Type.Union([short, Type.Null()]) },
  closed,
);
const referenceAuthorSchema = Type.Union([
  Type.Object({ literal: short }, closed),
  Type.Object({ family: short, given: Type.Optional(short) }, closed),
]);
const referenceMetadataSchema = Type.Object(
  {
    type: Type.Enum(['article', 'book', 'webpage', 'report']),
    title: Type.String({ minLength: 1, maxLength: 500 }),
    authors: Type.Optional(Type.Array(referenceAuthorSchema, { maxItems: 32 })),
    year: Type.Optional(Type.Integer({ minimum: 1000, maximum: 9999 })),
    container_title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    publisher: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    doi: Type.Optional(
      Type.String({ minLength: 1, maxLength: 200, pattern: '^10\\.[0-9]{4,9}/\\S+$' }),
    ),
    url: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, pattern: '^https?://\\S+$' })),
  },
  closed,
);
const referenceVersionSchema = Type.Object(
  {
    metadata_revision: Type.Integer({ minimum: 1, maximum: 32 }),
    metadata_sha256: sha,
    metadata: referenceMetadataSchema,
  },
  closed,
);
const topicReferenceSchema = Type.Object(
  {
    id: Type.String({ pattern: '^ref-[a-f0-9]{64}$' }),
    selection: selectionSchema,
    current_version: Type.Integer({ minimum: 1, maximum: 32 }),
    metadata_versions: Type.Array(referenceVersionSchema, { minItems: 1, maxItems: 32 }),
  },
  closed,
);
const summarySchema = Type.Object(
  {
    selection: selectionSchema,
    title: Type.String({ minLength: 1, maxLength: 500 }),
    summary: Type.String({ maxLength: 2000 }),
    updated_at: Type.Union([Type.String({ maxLength: 40 }), Type.Null()]),
    qualification: Type.String({ minLength: 1, maxLength: 1000 }),
  },
  closed,
);
const readerSchema = Type.Object(
  {
    owner: Type.Enum(['planning-ai', 'principles-ai']),
    path: Type.String({ minLength: 1, maxLength: 4096 }),
    instance_id: short,
  },
  closed,
);
const configSchema = Type.Object({ owners: Type.Array(readerSchema, { maxItems: 2 }) }, closed);
const exportedRecord = Type.Object(
  {
    ref: refSchema,
    title: summarySchema.properties.title,
    summary: summarySchema.properties.summary,
    updated_at: summarySchema.properties.updated_at,
    qualification: summarySchema.properties.qualification,
    content: Type.String({ maxLength: 2_000_000 }),
  },
  closed,
);
const exportSchema = Type.Object(
  {
    schema_version: Type.Literal('1.0'),
    owner: readerSchema.properties.owner,
    instance_id: short,
    exported_at: Type.Optional(Type.String({ format: 'date-time' })),
    source_revision: Type.Optional(short),
    freshness: Type.Optional(Type.String({ maxLength: 1000 })),
    records: Type.Array(exportedRecord, { maxItems: 5000 }),
  },
  closed,
);
const linkSchema = Type.Object(
  {
    from: Type.String({ maxLength: 1500 }),
    to: Type.String({ maxLength: 1500 }),
    label: Type.String({ minLength: 1, maxLength: 500 }),
    relation: Type.Optional(Type.Enum(['related', 'depends_on', 'supports', 'contradicts'])),
  },
  closed,
);
const editFields = {
  name: Type.String({ minLength: 1, maxLength: 200 }),
  links: Type.Array(linkSchema, { maxItems: 200 }),
  questions: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 100 }),
};
const collectionSnapshotSchema = Type.Object(
  {
    collection_id: Type.String({ format: 'uuid' }),
    collection_revision: Type.Integer({ minimum: 1 }),
    collection_digest: sha,
    partial: Type.Boolean(),
    owner_coverage: Type.Array(
      Type.Object(
        {
          owner: short,
          state: Type.Enum(['connected', 'unconfigured', 'unavailable', 'partial']),
          observed_at: Type.String({ format: 'date-time' }),
          export_as_of: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
          reason: Type.String({ maxLength: 1000 }),
        },
        closed,
      ),
      { maxItems: 3 },
    ),
  },
  closed,
);
const topicSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    revision: Type.Integer({ minimum: 1 }),
    created_at: Type.String(),
    updated_at: Type.String(),
    members: Type.Array(summarySchema, { maxItems: 100 }),
    references: Type.Optional(Type.Array(topicReferenceSchema, { maxItems: 100 })),
    collection_snapshot: Type.Optional(collectionSnapshotSchema),
    ...editFields,
  },
  closed,
);
const stateSchema = Type.Object(
  { version: Type.Literal(1), topics: Type.Array(topicSchema, { maxItems: 100 }) },
  closed,
);
const patchSchema = Type.Object(
  {
    revision: Type.Integer({ minimum: 1 }),
    selections: Type.Array(selectionSchema, { maxItems: 100 }),
    ...editFields,
  },
  closed,
);
const setTopicReferenceSchema = Type.Object(
  {
    revision: Type.Integer({ minimum: 1 }),
    selection: selectionSchema,
    metadata: Type.Unknown(),
  },
  closed,
);
const exportTopicReferencesSchema = Type.Object(
  {
    revision: Type.Integer({ minimum: 1 }),
    reference_ids: Type.Array(Type.String({ pattern: '^ref-[a-f0-9]{64}$' }), {
      minItems: 1,
      maxItems: 100,
    }),
  },
  closed,
);
type Reader = Static<typeof readerSchema>;
type Selection = Static<typeof selectionSchema>;
type Summary = Static<typeof summarySchema>;
type Topic = Static<typeof topicSchema>;
type ExportRecord = Static<typeof exportedRecord>;
type TopicReference = Static<typeof topicReferenceSchema>;
export type KnowledgeSelection = Selection;
export type KnowledgeReferenceMetadata = Static<typeof referenceMetadataSchema>;
export type KnowledgeReferenceRow = {
  id: string;
  selection: Selection;
  metadata_revision: number;
  metadata_sha256: string;
  metadata: KnowledgeReferenceMetadata;
  qualification: 'User-supplied bibliographic metadata; unverified.';
};
const owners = ['signals-ai', 'planning-ai', 'principles-ai'];
const kinds: Record<string, string[]> = {
  'planning-ai': ['decision', 'review', 'reflection'],
  'principles-ai': ['principle', 'study-session'],
};
const digest = (content: string) => createHash('sha256').update(content).digest('hex');
const referenceQualification = 'User-supplied bibliographic metadata; unverified.' as const;
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((name) => `${JSON.stringify(name)}:${canonicalJson(object[name])}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('non_json_value');
  return encoded;
}
const selectionIdentity = (selection: Selection) => canonicalJson(selection);
const topicReferenceId = (selection: Selection) => `ref-${digest(selectionIdentity(selection))}`;
function validateReferenceMetadata(value: unknown): KnowledgeReferenceMetadata {
  if (!Value.Check(referenceMetadataSchema, value))
    fail(
      400,
      'invalid_reference_metadata',
      'Bibliographic metadata is invalid or has unsupported fields.',
    );
  const metadata = value as KnowledgeReferenceMetadata;
  const text = [
    metadata.title,
    metadata.container_title,
    metadata.publisher,
    ...(metadata.authors ?? []).flatMap((author) =>
      'literal' in author ? [author.literal] : [author.family, author.given].filter(Boolean),
    ),
  ];
  if (text.some((value) => value !== undefined && !value.trim()))
    fail(400, 'invalid_reference_metadata', 'Bibliographic text fields cannot be blank.');
  if (metadata.url) {
    try {
      const url = new URL(metadata.url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
    } catch {
      fail(400, 'invalid_reference_metadata', 'Reference URL must be an absolute HTTP(S) URL.');
    }
  }
  return metadata;
}
function currentReferenceRow(reference: TopicReference): KnowledgeReferenceRow {
  const version = reference.metadata_versions[reference.current_version - 1]!;
  return {
    id: reference.id,
    selection: reference.selection,
    metadata_revision: version.metadata_revision,
    metadata_sha256: version.metadata_sha256,
    metadata: version.metadata,
    qualification: referenceQualification,
  };
}
const fail = (status: number, code: string, reason: string): never => {
  throw new ProviderError(status, code, reason);
};
function checked<T>(schema: TSchema, value: unknown): T {
  if (!Value.Check(schema, value))
    fail(400, 'invalid_knowledge_input', 'Input does not match the bounded knowledge contract.');
  return value as T;
}
function checkSelection(selection: Selection) {
  if (
    !owners.includes(selection.ref.owner) ||
    selection.ref.revision !== `sha256:${selection.ref.digest}` ||
    (selection.ref.owner === 'signals-ai'
      ? selection.owner_epoch === null
      : selection.owner_epoch !== null)
  )
    fail(
      400,
      'invalid_knowledge_selection',
      'Select a complete owner-qualified digest reference and its trusted instance.',
    );
}
const key = (selection: Selection) =>
  JSON.stringify([
    selection.ref.owner,
    selection.instance_id,
    selection.ref.kind,
    selection.ref.id,
    selection.ref.revision,
    selection.ref.digest,
  ]);
async function writeKnowledge<T>(root: string, operation: () => Promise<T>) {
  try {
    const directory = resolve(root, '.signals');
    const state = await lstat(directory).catch((failure: NodeJS.ErrnoException) => {
      if (failure.code !== 'ENOENT') throw failure;
      return null;
    });
    if (
      (await realpath(root)) !== resolve(root) ||
      (state &&
        (!state.isDirectory() ||
          state.isSymbolicLink() ||
          (await realpath(directory)) !== directory))
    )
      fail(
        503,
        'knowledge_storage_unavailable',
        'Private storage must use its owned real directory. No alternate location was written.',
      );
    return await withWriter(root, operation);
  } catch (failure) {
    if (failure instanceof ProviderError) throw failure;
    return fail(
      503,
      'knowledge_storage_unavailable',
      'Private state could not be written safely. Reopen to inspect the saved outcome before retrying.',
    );
  }
}
/** Reuses the validated private writer boundary for adjacent owner state. */
export function withKnowledgeWriter<T>(root: string, operation: () => Promise<T>) {
  return writeKnowledge(root, operation);
}
async function config(root: string) {
  try {
    return checked<Static<typeof configSchema>>(
      configSchema,
      await readPrivateJson(root, 'knowledge-owners.json', { owners: [] }),
    );
  } catch {
    return fail(
      503,
      'knowledge_config_unavailable',
      'Reader configuration is unsafe or invalid. Inspect it locally.',
    );
  }
}
export async function knowledgeOwners(root: string) {
  return {
    owners: (await config(root)).owners.map(({ owner, instance_id }) => ({
      owner,
      instance_id,
      configured: true,
    })),
  };
}
export async function configureKnowledge(root: string, input: unknown) {
  const parsed = checked<Static<typeof configSchema>>(configSchema, input);
  if (
    new Set(parsed.owners.map((row) => row.owner)).size !== parsed.owners.length ||
    parsed.owners.some((row) => !isAbsolute(row.path))
  )
    fail(
      400,
      'invalid_knowledge_config',
      'Each owner requires one explicitly configured absolute export file.',
    );
  await writeKnowledge(root, () =>
    atomicJson(resolve(root, '.signals/knowledge-owners.json'), parsed),
  );
  return knowledgeOwners(root);
}
async function readExport(reader: Reader) {
  try {
    if ((await realpath(reader.path)) !== reader.path) throw new Error();
    const file = await open(reader.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let content: string;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 10_000_000) throw new Error();
      const bytes = await file.readFile();
      if (bytes.length > 10_000_000 || !Buffer.from(bytes.toString('utf8')).equals(bytes))
        throw new Error();
      content = bytes.toString('utf8');
    } finally {
      await file.close();
    }
    const result = checked<Static<typeof exportSchema>>(exportSchema, JSON.parse(content));
    if (result.owner !== reader.owner || result.instance_id !== reader.instance_id)
      throw new Error();
    const ids = new Set<string>();
    for (const row of result.records) {
      const id = JSON.stringify([row.ref.kind, row.ref.id]);
      if (
        row.ref.owner !== reader.owner ||
        !kinds[reader.owner]!.includes(row.ref.kind) ||
        ids.has(id) ||
        row.ref.digest !== digest(row.content) ||
        row.ref.revision !== `sha256:${row.ref.digest}` ||
        (row.updated_at !== null && !Number.isFinite(Date.parse(row.updated_at)))
      )
        throw new Error();
      JSON.parse(row.content); // Only deterministic native JSON, never executable content.
      ids.add(id);
    }
    return result;
  } catch {
    return fail(
      503,
      'knowledge_owner_unavailable',
      'Configured owner export is missing, unsafe, mismatched or invalid. Refresh it with its owner; no disk discovery was attempted.',
    );
  }
}
function foreignSummary(reader: Reader, record: ExportRecord): Summary {
  const { ref, title, summary, updated_at, qualification } = record;
  return {
    selection: { ref, instance_id: reader.instance_id, owner_epoch: null },
    title,
    summary,
    updated_at,
    qualification,
  };
}
async function nativeSummaries(root: string, q: string) {
  const scope = await requestStore(root).scope();
  const records: Summary[] = [];
  let cursor: string | null = null;
  let partial = false;
  do {
    const params = new URLSearchParams({ q, limit: '100', ...(cursor ? { cursor } : {}) });
    const page = await providerLibrary(root, `?${params}`, '1.0', scope.identity, scope.epoch);
    partial ||= page.owner_coverage.some((row) => row.reason.includes('Partial coverage:'));
    for (const row of page.records) {
      if (!row.ref.digest || !row.ref.revision) {
        partial = true;
        continue;
      }
      records.push({
        selection: {
          ref: { ...row.ref, digest: row.ref.digest, revision: row.ref.revision },
          instance_id: scope.identity,
          owner_epoch: scope.epoch,
        },
        title: row.title.slice(0, 500),
        summary: row.summary,
        updated_at: row.updated_at ?? null,
        qualification: row.domain_status,
      });
    }
    cursor = page.next_cursor;
    if (records.length >= 5000 && cursor) {
      partial = true;
      break;
    }
  } while (cursor);
  return { records, partial };
}
/** Disposable metadata projection: foreign content is never written into a central corpus. */
export async function searchKnowledge(root: string, query = '', limit = 30) {
  if (query.length > 2000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    fail(400, 'invalid_knowledge_query', 'Query is bounded to 2000 units and limit to 1..100.');
  const readers = (await config(root)).owners;
  const records: Summary[] = [];
  const owner_coverage = await Promise.all(
    owners.map(async (owner) => {
      const observed_at = new Date().toISOString();
      try {
        if (owner === 'signals-ai') {
          const native = await nativeSummaries(root, query);
          records.push(...native.records);
          return {
            owner,
            state: native.partial ? 'partial' : 'connected',
            observed_at,
            export_as_of: null,
            reason:
              'Saved native Library records; historical published bundles without exact readers excluded.',
          };
        }
        const reader = readers.find((item) => item.owner === owner);
        if (!reader)
          return {
            owner,
            state: 'unconfigured',
            observed_at,
            export_as_of: null,
            reason: 'No explicit export reader configured.',
          };
        const exported = await readExport(reader);
        const summaries = exported.records.map((row) => foreignSummary(reader, row));
        if (query.trim()) {
          const index = new MiniSearch<Summary & { id: number; body: string }>({
            fields: ['title', 'summary', 'qualification', 'body'],
            storeFields: ['id'],
          });
          index.addAll(
            summaries.map((row, id) => ({ ...row, id, body: exported.records[id]!.content })),
          );
          records.push(
            ...index
              .search(query, { prefix: true, fuzzy: 0.2, combineWith: 'AND' })
              .map((hit) => summaries[Number(hit.id)]!),
          );
        } else
          records.push(
            ...summaries.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? '')),
          );
        return {
          owner,
          state: 'connected',
          observed_at,
          export_as_of: exported.exported_at ?? null,
          reason:
            'Explicit frozen owner export searched. Regenerate it explicitly for newer records; matching it does not establish live source freshness.',
        };
      } catch {
        return {
          owner,
          state: 'unavailable',
          observed_at,
          export_as_of: null,
          reason: 'Owner records could not be read safely. Other configured owners remain usable.',
        };
      }
    }),
  );
  // Round robin preserves each available owner in a bounded combined result.
  const groups = owners.map((owner) => records.filter((row) => row.selection.ref.owner === owner));
  const ranked: Summary[] = [];
  for (let offset = 0; ranked.length < limit && groups.some((group) => group[offset]); offset++)
    for (const group of groups)
      if (group[offset] && ranked.length < limit) ranked.push(group[offset]!);
  return { schema_version: '1.0', records: ranked, owner_coverage };
}
async function resolveSelection(
  root: string,
  selection: Selection,
  current = false,
  exportsByReader?: Map<string, ReturnType<typeof readExport>>,
) {
  checkSelection(selection);
  if (selection.ref.owner === 'signals-ai') {
    const scope = await requestStore(root).scope();
    if (scope.identity !== selection.instance_id || scope.epoch !== selection.owner_epoch)
      fail(
        503,
        'knowledge_owner_unavailable',
        'The configured Signals store identity changed; explicit reconciliation is required.',
      );
    const exact = await exactOwnerRecord(
      root,
      current ? { ...selection.ref, revision: null, digest: null } : selection.ref,
    );
    return {
      selection: { ...selection, ref: exact.ref },
      content: exact.bytes.toString('utf8'),
      content_type: 'application/json' as const,
      export_as_of: null,
    };
  }
  const reader = (await config(root)).owners.find(
    (row) => row.owner === selection.ref.owner && row.instance_id === selection.instance_id,
  );
  if (!reader)
    return fail(
      503,
      'knowledge_owner_unavailable',
      'The selected owner store is not explicitly configured.',
    );
  const readerKey = JSON.stringify(reader);
  let pending = exportsByReader?.get(readerKey);
  if (!pending) {
    pending = readExport(reader);
    exportsByReader?.set(readerKey, pending);
  }
  const exported = await pending;
  const row = exported.records.find(
    (item) => item.ref.kind === selection.ref.kind && item.ref.id === selection.ref.id,
  );
  if (!row)
    return fail(
      404,
      'knowledge_record_missing',
      'The exact record is absent from the configured current owner export.',
    );
  if (!current && key(selection) !== key(foreignSummary(reader, row).selection))
    fail(
      409,
      'knowledge_record_changed',
      'The selected saved identity differs from the current export. No successor was substituted.',
    );
  return {
    selection: foreignSummary(reader, row).selection,
    content: row.content,
    content_type: 'application/json' as const,
    export_as_of: exported.exported_at ?? null,
  };
}
export async function readKnowledge(root: string, input: unknown) {
  return resolveSelection(root, checked<Selection>(selectionSchema, input));
}
async function topicState(root: string) {
  try {
    const state = checked<Static<typeof stateSchema>>(
      stateSchema,
      await readPrivateJson(root, 'topics.json', { version: 1, topics: [] }),
    );
    if (new Set(state.topics.map((topic) => topic.id)).size !== state.topics.length)
      throw new Error();
    for (const topic of state.topics) {
      const keys = topic.members.map((member) => {
        checkSelection(member.selection);
        return key(member.selection);
      });
      const referenceIds = new Set<string>();
      if (
        new Set(keys).size !== keys.length ||
        topic.links.some((link) => !keys.includes(link.from) || !keys.includes(link.to))
      )
        throw new Error();
      for (const reference of topic.references ?? []) {
        checkSelection(reference.selection);
        if (
          referenceIds.has(reference.id) ||
          reference.id !== topicReferenceId(reference.selection) ||
          reference.current_version !== reference.metadata_versions.length
        )
          throw new Error();
        referenceIds.add(reference.id);
        reference.metadata_versions.forEach((version, index) => {
          const metadata = validateReferenceMetadata(version.metadata);
          if (
            version.metadata_revision !== index + 1 ||
            version.metadata_sha256 !== digest(canonicalJson(metadata))
          )
            throw new Error();
        });
      }
    }
    return state;
  } catch {
    return fail(
      503,
      'knowledge_topics_unavailable',
      'Private topic state is unsafe or invalid. Inspect locally before editing.',
    );
  }
}
export async function listTopics(root: string) {
  return { topics: (await topicState(root)).topics };
}
async function saveTopics(root: string, state: Static<typeof stateSchema>) {
  if (Buffer.byteLength(JSON.stringify(state, null, 2) + '\n') > 2_000_000)
    fail(
      409,
      'knowledge_topics_full',
      'Private topic storage reached its byte limit. Export or remove records before adding more.',
    );
  await atomicJson(resolve(root, '.signals/topics.json'), state);
}
export async function createTopic(root: string, input: unknown) {
  const { name } = checked<{ name: string }>(Type.Object({ name: editFields.name }, closed), input);
  return writeKnowledge(root, async () => {
    const state = await topicState(root);
    if (state.topics.length >= 100)
      fail(409, 'knowledge_topics_full', 'Export or remove a topic before adding another.');
    const now = new Date().toISOString();
    const topic: Topic = {
      id: randomUUID(),
      name,
      revision: 1,
      created_at: now,
      updated_at: now,
      members: [],
      links: [],
      questions: [],
    };
    state.topics.push(topic);
    await saveTopics(root, state);
    return topic;
  });
}
const frozenTopicInputSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    name: editFields.name,
    selections: Type.Array(selectionSchema, { minItems: 1, maxItems: 100 }),
    questions: editFields.questions,
    snapshot: collectionSnapshotSchema,
  },
  closed,
);
/** Called inside the knowledge writer transaction to retain exact selected references. */
export async function freezeTopicFromCollection(root: string, input: unknown) {
  const parsed = checked<Static<typeof frozenTopicInputSchema>>(frozenTopicInputSchema, input);
  parsed.selections.forEach(checkSelection);
  const state = await topicState(root);
  const existing = state.topics.find((topic) => topic.id === parsed.id);
  const meaning = JSON.stringify({
    name: parsed.name,
    selections: parsed.selections,
    questions: parsed.questions,
    snapshot: parsed.snapshot,
  });
  if (existing) {
    const savedMeaning = JSON.stringify({
      name: existing.name,
      selections: existing.members.map((member) => member.selection),
      questions: existing.questions,
      snapshot: existing.collection_snapshot,
    });
    if (meaning !== savedMeaning)
      fail(
        409,
        'knowledge_topic_operation_conflict',
        'The topic ID already records different frozen meaning.',
      );
    return existing;
  }
  if (state.topics.length >= 100)
    fail(409, 'knowledge_topics_full', 'Export or remove a topic before adding another.');
  if (new Set(parsed.selections.map(key)).size !== parsed.selections.length)
    fail(
      400,
      'invalid_knowledge_selection',
      'Frozen selections must have distinct exact identities.',
    );
  const members: Summary[] = [];
  for (const selection of parsed.selections) {
    await resolveSelection(root, selection);
    if (selection.ref.owner === 'signals-ai') {
      const summary = (await nativeSummaries(root, '')).records.find(
        (row) => key(row.selection) === key(selection),
      );
      if (summary) members.push(summary);
    } else {
      const reader = (await config(root)).owners.find(
        (row) => row.owner === selection.ref.owner && row.instance_id === selection.instance_id,
      );
      const record =
        reader &&
        (await readExport(reader)).records.find(
          (row) => key(foreignSummary(reader, row).selection) === key(selection),
        );
      if (reader && record) members.push(foreignSummary(reader, record));
    }
  }
  if (members.length !== parsed.selections.length)
    fail(
      409,
      'knowledge_selection_changed',
      'A selected result is no longer current. Rerun and select it explicitly.',
    );
  const now = new Date().toISOString();
  const topic: Topic = {
    id: parsed.id,
    name: parsed.name,
    revision: 1,
    created_at: now,
    updated_at: now,
    members,
    links: [],
    questions: parsed.questions,
    collection_snapshot: parsed.snapshot,
  };
  state.topics.push(topic);
  await saveTopics(root, state);
  return topic;
}
function findTopic(topics: Topic[], id: string) {
  const topic = topics.find((row) => row.id === id);
  if (!topic)
    return fail(404, 'knowledge_topic_missing', 'This topic is not retained in this workspace.');
  return topic;
}
export async function updateTopic(root: string, id: string, input: unknown) {
  const patch = checked<Static<typeof patchSchema>>(patchSchema, input);
  patch.selections.forEach(checkSelection);
  return writeKnowledge(root, async () => {
    const state = await topicState(root);
    const topic = findTopic(state.topics, id);
    if (patch.revision !== topic.revision)
      fail(
        409,
        'knowledge_topic_changed',
        'Topic changed since it was opened. Reopen before editing.',
      );
    const selectedKeys = patch.selections.map(key);
    if (
      new Set(selectedKeys).size !== selectedKeys.length ||
      patch.links.some(
        (link) => !selectedKeys.includes(link.from) || !selectedKeys.includes(link.to),
      )
    )
      fail(
        400,
        'invalid_knowledge_links',
        'Links must refer to distinct selected member identities in this topic.',
      );
    const members: Summary[] = [];
    const exportsByReader = new Map<string, ReturnType<typeof readExport>>();
    for (const selection of patch.selections) {
      const existing = topic.members.find((row) => key(row.selection) === key(selection));
      if (existing) {
        members.push(existing);
        continue;
      }
      // Resolve before saving. A record already removed from search is not silently re-created.
      await resolveSelection(root, selection, false, exportsByReader);
      let summary: Summary | undefined;
      if (selection.ref.owner === 'signals-ai')
        summary = (await nativeSummaries(root, '')).records.find(
          (row) => key(row.selection) === key(selection),
        );
      else {
        const reader = (await config(root)).owners.find(
          (row) => row.owner === selection.ref.owner && row.instance_id === selection.instance_id,
        )!;
        const exported = await (exportsByReader.get(JSON.stringify(reader)) ?? readExport(reader));
        const row = exported.records.find(
          (item) => key(foreignSummary(reader, item).selection) === key(selection),
        );
        if (row) summary = foreignSummary(reader, row);
      }
      if (!summary)
        return fail(
          409,
          'knowledge_selection_changed',
          'Select the current saved owner record again before adding it.',
        );
      members.push(summary);
    }
    Object.assign(topic, {
      name: patch.name,
      members,
      links: patch.links,
      questions: patch.questions,
      revision: topic.revision + 1,
      updated_at: new Date().toISOString(),
    });
    await saveTopics(root, state);
    return topic;
  });
}
/** Retains caller-supplied bibliographic metadata against one exact current topic member. */
export async function setTopicReference(root: string, topicId: string, input: unknown) {
  const parsed = checked<Static<typeof setTopicReferenceSchema>>(setTopicReferenceSchema, input);
  checkSelection(parsed.selection);
  const metadata = validateReferenceMetadata(parsed.metadata);
  const metadataSha = digest(canonicalJson(metadata));
  return writeKnowledge(root, async () => {
    const state = await topicState(root);
    const topic = findTopic(state.topics, topicId);
    if (parsed.revision !== topic.revision)
      fail(
        409,
        'knowledge_topic_changed',
        'Topic changed since it was opened. Reopen before editing.',
      );
    if (
      !topic.members.some(
        (member) => selectionIdentity(member.selection) === selectionIdentity(parsed.selection),
      )
    )
      fail(
        409,
        'knowledge_reference_selection_missing',
        'Bibliographic metadata can attach only to an exact selected topic member.',
      );
    await resolveSelection(root, parsed.selection);

    const id = topicReferenceId(parsed.selection);
    let reference = topic.references?.find((row) => row.id === id);
    if (reference && selectionIdentity(reference.selection) !== selectionIdentity(parsed.selection))
      fail(409, 'knowledge_reference_identity_conflict', 'Reference identity must be reopened.');
    if (reference) {
      const current = currentReferenceRow(reference);
      if (current.metadata_sha256 === metadataSha)
        return {
          topic: { id: topic.id, revision: topic.revision },
          reference: current,
          changed: false,
        };
      if (reference.metadata_versions.length >= 32)
        fail(
          409,
          'knowledge_reference_history_full',
          'This reference has 32 retained metadata versions. Export its history before replacing it.',
        );
      const version = {
        metadata_revision: reference.metadata_versions.length + 1,
        metadata_sha256: metadataSha,
        metadata,
      };
      reference.metadata_versions.push(version);
      reference.current_version = version.metadata_revision;
    } else {
      if ((topic.references?.length ?? 0) >= 100)
        fail(
          409,
          'knowledge_references_full',
          'This topic already retains 100 references. Export or remove metadata before adding another.',
        );
      const version = { metadata_revision: 1, metadata_sha256: metadataSha, metadata };
      reference = {
        id,
        selection: parsed.selection,
        current_version: 1,
        metadata_versions: [version],
      };
      (topic.references ??= []).push(reference);
    }
    topic.revision++;
    topic.updated_at = new Date().toISOString();
    await saveTopics(root, state);
    return {
      topic: { id: topic.id, revision: topic.revision },
      reference: currentReferenceRow(reference),
      changed: true,
    };
  });
}

/** Lists current descriptions and reports whether each exact selection remains in the topic. */
export async function listTopicReferences(root: string, topicId: string) {
  return withKnowledgeWriter(root, async () => {
    const { topic, statuses } = await openTopic(root, topicId);
    const statusBySelection = new Map(
      statuses.map((status) => [selectionIdentity(status.selection), status]),
    );
    const references = (topic.references ?? []).map(currentReferenceRow);
    const availability = (topic.references ?? []).map((reference) => {
      const status = statusBySelection.get(selectionIdentity(reference.selection));
      return status
        ? {
            reference_id: reference.id,
            membership: 'selected' as const,
            state: status.state,
            reason: status.reason,
            current_ref: status.current_ref,
          }
        : {
            reference_id: reference.id,
            membership: 'detached' as const,
            state: 'detached' as const,
            reason:
              'The exact saved selection was removed from this topic; its metadata history remains available.',
            current_ref: null,
          };
    });
    return { topic: { id: topic.id, revision: topic.revision }, references, availability };
  });
}

/** Exports only caller-selected metadata rows, including detached historical selections. */
export async function exportTopicReferences(root: string, topicId: string, input: unknown) {
  const parsed = checked<Static<typeof exportTopicReferencesSchema>>(
    exportTopicReferencesSchema,
    input,
  );
  if (new Set(parsed.reference_ids).size !== parsed.reference_ids.length)
    fail(400, 'invalid_reference_selection', 'Select each reference ID once.');
  return withKnowledgeWriter(root, async () => {
    const topic = findTopic((await topicState(root)).topics, topicId);
    if (parsed.revision !== topic.revision)
      fail(409, 'knowledge_topic_changed', 'Topic changed since selection. Reopen its references.');
    const byId = new Map((topic.references ?? []).map((reference) => [reference.id, reference]));
    const references = parsed.reference_ids.map((id) => {
      const reference = byId.get(id);
      if (!reference)
        return fail(
          404,
          'knowledge_reference_missing',
          'A selected reference is not retained by this topic.',
        );
      return currentReferenceRow(reference);
    });
    return {
      schema: 'signals.reference-list.v1',
      topic: { id: topic.id, revision: topic.revision },
      references,
    };
  });
}

export async function openTopic(root: string, id: string) {
  const topic = findTopic((await topicState(root)).topics, id);
  // One frozen export per reader for this view; later views always read fresh bytes
  const exportsByReader = new Map<string, ReturnType<typeof readExport>>();
  const statuses = await Promise.all(
    topic.members.map(async ({ selection }) => {
      try {
        const current = await resolveSelection(root, selection, true, exportsByReader);
        const state = key(current.selection) === key(selection) ? 'current' : 'changed';
        return {
          selection,
          state,
          export_as_of: current.export_as_of,
          reason:
            state === 'current'
              ? 'Saved identity matches the configured owner snapshot. Foreign exports are frozen; underlying source freshness is not established.'
              : 'Configured owner snapshot identity differs; saved reference preserved. Select a successor explicitly.',
          current_ref: current.selection.ref,
        };
      } catch (failure) {
        return {
          selection,
          state:
            failure instanceof ProviderError && failure.status === 404 ? 'missing' : 'unavailable',
          export_as_of: null,
          reason:
            'Configured owner record cannot be resolved; saved reference and annotations preserved.',
          current_ref: null,
        };
      }
    }),
  );
  return { topic, statuses };
}

/** Projects exact saved references and caller-authored dependency claims into bounded review paths. */
export async function topicEvidenceGraph(root: string, id: string) {
  const { topic, statuses } = await openTopic(root, id);
  const qualifications = [
    'Relationships are user-authored claims; they are not verified evidence or support.',
    'Only depends_on propagates possible review, from dependency to declared dependents.',
    'Changed and missing references may need review; unavailable status is indeterminate.',
    'Configured foreign exports are frozen snapshots and do not establish underlying source freshness.',
    'No source validity, truth, causality, successor, or automatic topic update is inferred.',
  ];
  const topicRef = { id: topic.id, revision: topic.revision };
  // Count the final compact JSON envelope, charging each array item as it is added.
  let outputBytes = Buffer.byteLength(
    JSON.stringify({
      schema_version: '1.0',
      topic: topicRef,
      nodes: [],
      edges: [],
      impacts: [],
      qualifications,
    }),
  );
  const reserve = (bytes: number) => {
    if (outputBytes + bytes > topicGraphByteLimit)
      fail(
        409,
        'knowledge_graph_too_large',
        'Evidence impact map exceeds the 4 MiB JSON limit. Select a smaller topic to inspect its paths.',
      );
    outputBytes += bytes;
  };
  const nodes = [];
  for (const [index, member] of topic.members.entries()) {
    const node = {
      key: key(member.selection),
      selection: member.selection,
      title: member.title,
      state: statuses[index]!.state,
      reason: statuses[index]!.reason,
      current_ref: statuses[index]!.current_ref,
      export_as_of: statuses[index]!.export_as_of,
    };
    reserve(Buffer.byteLength(JSON.stringify(node)) + (nodes.length ? 1 : 0));
    nodes.push(node);
  }
  const nodeKeys = new Set(nodes.map((node) => node.key));
  const edges = [];
  for (const link of topic.links) {
    if (!nodeKeys.has(link.from) || !nodeKeys.has(link.to))
      fail(503, 'knowledge_topics_unavailable', 'A saved relationship is malformed.');
    const edge = {
      from: link.from,
      to: link.to,
      label: link.label,
      relation: link.relation ?? 'related',
      basis: 'user_asserted' as const,
    };
    reserve(Buffer.byteLength(JSON.stringify(edge)) + (edges.length ? 1 : 0));
    edges.push(edge);
  }
  const dependents = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.relation !== 'depends_on') continue;
    const rows = dependents.get(edge.to) ?? [];
    rows.push(edge.from);
    dependents.set(edge.to, rows);
  }
  for (const rows of dependents.values()) rows.sort();

  const impacts = [];
  for (const trigger of nodes) {
    if (trigger.state === 'current') continue;
    const paths: { dependent: string; path: string[] }[] = [];
    const impact = {
      trigger: trigger.key,
      trigger_state: trigger.state,
      state: trigger.state === 'unavailable' ? 'indeterminate' : 'needs_review',
      reason: trigger.reason,
      paths,
      path_policy: 'one shortest deterministic path per dependent',
    };
    reserve(Buffer.byteLength(JSON.stringify({ ...impact, paths: [] })) + (impacts.length ? 1 : 0));
    impacts.push(impact);
    const visited = new Set([trigger.key]);
    let frontier = [[trigger.key]];
    while (frontier.length) {
      const next: string[][] = [];
      for (const path of frontier) {
        const tail = path[path.length - 1]!;
        for (const dependent of dependents.get(tail) ?? []) {
          if (visited.has(dependent)) continue;
          visited.add(dependent);
          const witness = [...path, dependent];
          const resultPath = { dependent, path: witness };
          reserve(Buffer.byteLength(JSON.stringify(resultPath)) + (paths.length ? 1 : 0));
          paths.push(resultPath);
          next.push(witness);
        }
      }
      frontier = next;
    }
  }
  return {
    schema_version: '1.0',
    topic: topicRef,
    nodes,
    edges,
    impacts,
    qualifications,
  };
}
export async function exportTopic(root: string, id: string) {
  const { topic, statuses } = await openTopic(root, id);
  const content = [
    `# ${topic.name}`,
    '',
    `Saved topic ${topic.id}; revision ${topic.revision}.`,
    'References and user annotations only; record content remains with its owner.',
    ...(topic.collection_snapshot
      ? [
          `Frozen query: ${topic.collection_snapshot.collection_id}; revision ${topic.collection_snapshot.collection_revision}; digest ${topic.collection_snapshot.collection_digest}.`,
          `Owner coverage at freeze: ${JSON.stringify(topic.collection_snapshot.owner_coverage)}.`,
          '',
        ]
      : []),
    '',
    ...topic.members.flatMap((member, index) => [
      `## ${member.title}`,
      member.summary,
      `Owner: ${member.selection.ref.owner}; qualification: ${member.qualification}`,
      `Saved: ${JSON.stringify(member.selection)}`,
      `Current status: ${statuses[index]!.state}`,
      '',
    ]),
    '## Relationships',
    ...topic.links.map(
      (link) => `${link.from} → ${link.to} (${link.relation ?? 'related'}): ${link.label}`,
    ),
    '',
    '## Open questions',
    ...topic.questions.map((question) => `- ${question}`),
    '',
  ].join('\n');
  return { content_type: 'text/markdown', content };
}

/** Existing HTTP owner wrapper validates instance/epoch, origin and mutation session first. */
export async function knowledgeRoute(
  root: string,
  route: string,
  mutation: boolean,
  url: string,
  body: unknown,
) {
  const params = new URL(url, 'http://127.0.0.1').searchParams;
  if (route === 'provider/knowledge' && !mutation) {
    if (
      [...params.keys()].some(
        (name) => !['q', 'limit'].includes(name) || params.getAll(name).length !== 1,
      )
    )
      fail(400, 'invalid_knowledge_query', 'Unknown or repeated query fields.');
    return searchKnowledge(
      root,
      params.get('q') ?? '',
      params.has('limit') ? Number(params.get('limit')) : 30,
    );
  }
  if (params.size) fail(400, 'invalid_knowledge_query', 'This operation takes no query fields.');
  if (route === 'knowledge/owners' && !mutation) return knowledgeOwners(root);
  if (route === 'knowledge/record' && mutation) {
    const input = checked<{ selection: Selection }>(
      Type.Object({ selection: selectionSchema }, closed),
      body,
    );
    return readKnowledge(root, input.selection);
  }
  if (route === 'topics') return mutation ? createTopic(root, body) : listTopics(root);
  const references =
    /^topics\/([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})\/references(\/export)?$/.exec(route);
  if (references && !references[2])
    return mutation
      ? setTopicReference(root, references[1]!, body)
      : listTopicReferences(root, references[1]!);
  if (references?.[2] === '/export' && mutation)
    return exportTopicReferences(root, references[1]!, body);
  const match = /^topics\/([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})(\/export|\/graph)?$/.exec(
    route,
  );
  if (match && !match[2])
    return mutation ? updateTopic(root, match[1]!, body) : openTopic(root, match[1]!);
  if (match?.[2] === '/export' && !mutation) return exportTopic(root, match[1]!);
  if (match?.[2] === '/graph' && !mutation) return topicEvidenceGraph(root, match[1]!);
  return fail(
    404,
    'unknown_knowledge_operation',
    'This knowledge operation is not supported. Reader configuration is operator CLI only.',
  );
}
