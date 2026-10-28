import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Type, type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { atomicJson, readPrivateJson } from './search-store.js';
import { ProviderError } from './provider-capabilities.js';
import {
  freezeTopicFromCollection,
  listTopics,
  readKnowledge,
  searchKnowledge,
  withKnowledgeWriter,
} from './knowledge.js';

const closed = { additionalProperties: false };
const uuid = Type.String({ format: 'uuid' });
const short = Type.String({ minLength: 1, maxLength: 200 });
const digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const owners = ['signals-ai', 'planning-ai', 'principles-ai'] as const;
const kinds = [
  'entity',
  'lead',
  'answer',
  'imported_answer',
  'research_note',
  'decision',
  'review',
  'reflection',
  'principle',
  'study-session',
] as const;
const date = Type.Union([Type.String({ format: 'date-time', maxLength: 40 }), Type.Null()]);
const querySchema = Type.Object(
  {
    text: Type.String({ maxLength: 2000 }),
    owners: Type.Array(Type.Enum([...owners]), { maxItems: 3, uniqueItems: true }),
    kinds: Type.Array(Type.Enum([...kinds]), { maxItems: 10, uniqueItems: true }),
    updated_after: Type.Optional(date),
    updated_before: Type.Optional(date),
    triage: Type.Enum(['all', 'unreviewed', 'keep', 'dismiss']),
    limit: Type.Integer({ minimum: 1, maximum: 100 }),
  },
  closed,
);
const collectionSchema = Type.Object(
  {
    id: uuid,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    revision: Type.Integer({ minimum: 1 }),
    digest,
    created_at: Type.String({ format: 'date-time' }),
    updated_at: Type.String({ format: 'date-time' }),
    query: querySchema,
  },
  closed,
);
const verdictSchema = Type.Object(
  {
    operation_id: uuid,
    state: Type.Enum(['keep', 'dismiss', 'unreviewed']),
    reason: Type.String({ maxLength: 500 }),
    updated_at: Type.String({ format: 'date-time' }),
  },
  closed,
);
const triageSchema = Type.Object(
  {
    identity: Type.String({ minLength: 1, maxLength: 1200 }),
    selection: Type.Object(
      {
        ref: Type.Object(
          {
            owner: short,
            kind: short,
            id: short,
            revision: short,
            digest,
          },
          closed,
        ),
        instance_id: short,
        owner_epoch: Type.Union([short, Type.Null()]),
      },
      closed,
    ),
    history: Type.Array(verdictSchema, { minItems: 1, maxItems: 5 }),
  },
  closed,
);
const operationSchema = Type.Object(
  {
    id: uuid,
    meaning: digest,
    kind: Type.Enum(['create', 'update', 'triage', 'freeze']),
    target_id: uuid,
    topic_id: Type.Optional(uuid),
  },
  closed,
);
const stateSchema = Type.Object(
  {
    version: Type.Literal(1),
    collections: Type.Array(collectionSchema, { maxItems: 100 }),
    triage: Type.Array(triageSchema, { maxItems: 1000 }),
    operations: Type.Array(operationSchema, { maxItems: 500 }),
  },
  closed,
);
const createSchema = Type.Object({ operation_id: uuid, name: short, query: querySchema }, closed);
const updateSchema = Type.Object(
  { operation_id: uuid, revision: Type.Integer({ minimum: 1 }), name: short, query: querySchema },
  closed,
);
const selectionSchema = Type.Object(
  {
    ref: Type.Object({ owner: short, kind: short, id: short, revision: short, digest }, closed),
    instance_id: short,
    owner_epoch: Type.Union([short, Type.Null()]),
  },
  closed,
);
const triageInputSchema = Type.Object(
  {
    operation_id: uuid,
    revision: Type.Integer({ minimum: 1 }),
    digest,
    changes: Type.Array(
      Type.Object(
        {
          selection: selectionSchema,
          state: Type.Enum(['keep', 'dismiss', 'unreviewed']),
          reason: Type.Optional(Type.String({ maxLength: 500 })),
        },
        closed,
      ),
      { minItems: 1, maxItems: 100 },
    ),
  },
  closed,
);
const freezeInputSchema = Type.Object(
  {
    operation_id: uuid,
    revision: Type.Integer({ minimum: 1 }),
    digest,
    name: short,
    selections: Type.Array(selectionSchema, { maxItems: 100, uniqueItems: true }),
    questions: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 100 }),
  },
  closed,
);
type Query = Static<typeof querySchema>;
type Collection = Static<typeof collectionSchema>;
type Selection = Static<typeof selectionSchema>;
type TriageInput = Static<typeof triageInputSchema>;
type State = Static<typeof stateSchema>;

const emptyState: State = { version: 1, collections: [], triage: [], operations: [] };
function canonical(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  throw new Error('invalid_smart_collection_json');
}
const sha = (value: unknown) => createHash('sha256').update(canonical(value), 'utf8').digest('hex');
const identity = (selection: Selection) =>
  JSON.stringify([
    selection.ref.owner,
    selection.instance_id,
    selection.owner_epoch,
    selection.ref.kind,
    selection.ref.id,
    selection.ref.revision,
    selection.ref.digest,
  ]);
const fail = (status: number, code: string, reason: string): never => {
  throw new ProviderError(status, code, reason);
};
function checked<T>(schema: TSchema, input: unknown): T {
  if (!Value.Check(schema, input))
    fail(400, 'invalid_smart_collection', 'Input does not match the bounded collection contract.');
  return input as T;
}
function normalizeQuery(input: Query): Query {
  const query: Query = {
    text: input.text,
    owners: [...input.owners].sort(),
    kinds: [...input.kinds].sort(),
    triage: input.triage,
    limit: input.limit,
    ...(input.updated_after === undefined ? {} : { updated_after: input.updated_after }),
    ...(input.updated_before === undefined ? {} : { updated_before: input.updated_before }),
  };
  const after = query.updated_after;
  const before = query.updated_before;
  const validDate = (value: string | null | undefined) =>
    value === null ||
    value === undefined ||
    (/(?:Z|[+-]\d{2}:\d{2})$/u.test(value) && Number.isFinite(Date.parse(value)));
  if (!validDate(after) || !validDate(before))
    fail(
      400,
      'invalid_smart_collection_dates',
      'Date bounds must be timezone-qualified ISO timestamps.',
    );
  if (after && before && Date.parse(after) > Date.parse(before))
    fail(
      400,
      'invalid_smart_collection_dates',
      'The inclusive start must not follow the inclusive end.',
    );
  return query;
}
async function readState(root: string): Promise<State> {
  try {
    const state = checked<State>(
      stateSchema,
      await readPrivateJson(root, 'smart-collections.json', structuredClone(emptyState)),
    );
    if (
      new Set(state.collections.map((row) => row.id)).size !== state.collections.length ||
      new Set(state.operations.map((row) => row.id)).size !== state.operations.length ||
      new Set(state.triage.map((row) => row.identity)).size !== state.triage.length ||
      state.collections.some((row) => sha(normalizeQuery(row.query)) !== row.digest) ||
      state.triage.some(
        (row) =>
          !owners.includes(row.selection.ref.owner as (typeof owners)[number]) ||
          row.selection.ref.revision !== `sha256:${row.selection.ref.digest}` ||
          identity(row.selection) !== row.identity ||
          (row.selection.ref.owner === 'signals-ai'
            ? row.selection.owner_epoch === null
            : row.selection.owner_epoch !== null),
      )
    )
      throw new Error();
    return state;
  } catch {
    return fail(
      503,
      'smart_collection_state_unavailable',
      'Private collection state is unsafe or invalid. Inspect it locally.',
    );
  }
}
async function writeState(root: string, state: State) {
  assertStateCapacity(state);
  await atomicJson(resolve(root, '.signals/smart-collections.json'), state);
}
function assertStateCapacity(state: State) {
  if (Buffer.byteLength(JSON.stringify(state, null, 2) + '\n', 'utf8') > 2_000_000)
    fail(
      409,
      'smart_collection_capacity',
      'Private collection storage is full; earlier state was preserved.',
    );
}
async function mutate<T>(root: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await withKnowledgeWriter(root, operation);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    return fail(
      503,
      'smart_collection_storage_unavailable',
      'Private collection state could not be safely updated. Reopen the original operation before retrying.',
    );
  }
}
const active = new Map<string, { meaning: string; promise: Promise<unknown> }>();
function admitted<T>(root: string, operationId: string, meaning: string, run: () => Promise<T>) {
  const key = `${resolve(root)}\u0000${operationId}`;
  const existing = active.get(key);
  if (existing) {
    if (existing.meaning !== meaning)
      return Promise.reject(
        new ProviderError(
          409,
          'smart_collection_operation_conflict',
          'Operation ID was already admitted for different meaning.',
        ),
      );
    return existing.promise as Promise<T>;
  }
  // Reserve synchronously so two requests cannot both pass admission before the first I/O.
  const promise = Promise.resolve().then(run);
  active.set(key, { meaning, promise });
  void promise
    .finally(() => {
      if (active.get(key)?.promise === promise) active.delete(key);
    })
    .catch(() => undefined);
  return promise;
}
function replay(
  state: State,
  operationId: string,
  meaning: string,
  kind: Static<typeof operationSchema.properties.kind>,
) {
  const saved = state.operations.find((row) => row.id === operationId);
  if (!saved) return null;
  if (saved.meaning !== meaning || saved.kind !== kind)
    return fail(
      409,
      'smart_collection_operation_conflict',
      'Operation ID was already used for different meaning.',
    );
  return saved;
}
function capacity(state: State, kind: Static<typeof operationSchema.properties.kind>) {
  if (state.operations.length >= 500)
    fail(
      409,
      'smart_collection_capacity',
      'Operation history is full; export the private workspace state before continuing.',
    );
  if (kind === 'create' && state.collections.length >= 100)
    fail(
      409,
      'smart_collection_capacity',
      'Saved collection limit reached; earlier state was preserved.',
    );
}
function recordOperation(state: State, operation: Static<typeof operationSchema>) {
  state.operations.push(operation);
}
function findCollection(state: State, id: string) {
  const row = state.collections.find((item) => item.id === id);
  if (!row)
    return fail(
      404,
      'smart_collection_missing',
      'Saved collection is not present in this workspace.',
    );
  return row;
}
export async function listSmartCollections(root: string) {
  return { collections: (await readState(root)).collections };
}
export async function openSmartCollection(root: string, id: string) {
  return { collection: findCollection(await readState(root), id) };
}
export async function createSmartCollection(root: string, input: unknown) {
  const parsed = checked<Static<typeof createSchema>>(createSchema, input);
  if (!parsed.name.trim())
    fail(400, 'invalid_smart_collection_name', 'Give the saved query a readable name.');
  const query = normalizeQuery(parsed.query);
  const meaning = sha({ kind: 'create', name: parsed.name, query });
  return admitted(root, parsed.operation_id, meaning, () =>
    mutate(root, async () => {
      const state = await readState(root);
      const prior = replay(state, parsed.operation_id, meaning, 'create');
      if (prior)
        return { collection: findCollection(state, prior.target_id), operation_replayed: true };
      capacity(state, 'create');
      const now = new Date().toISOString();
      const collection: Collection = {
        id: randomUUID(),
        name: parsed.name,
        query,
        revision: 1,
        digest: sha(query),
        created_at: now,
        updated_at: now,
      };
      state.collections.push(collection);
      recordOperation(state, {
        id: parsed.operation_id,
        meaning,
        kind: 'create',
        target_id: collection.id,
      });
      await writeState(root, state);
      return { collection, operation_replayed: false };
    }),
  );
}
export async function updateSmartCollection(root: string, id: string, input: unknown) {
  const parsed = checked<Static<typeof updateSchema>>(updateSchema, input);
  if (!parsed.name.trim())
    fail(400, 'invalid_smart_collection_name', 'Give the saved query a readable name.');
  const query = normalizeQuery(parsed.query);
  const meaning = sha({ kind: 'update', id, revision: parsed.revision, name: parsed.name, query });
  return admitted(root, parsed.operation_id, meaning, () =>
    mutate(root, async () => {
      const state = await readState(root);
      const prior = replay(state, parsed.operation_id, meaning, 'update');
      if (prior)
        return { collection: findCollection(state, prior.target_id), operation_replayed: true };
      capacity(state, 'update');
      const collection = findCollection(state, id);
      if (collection.revision !== parsed.revision)
        fail(
          409,
          'smart_collection_changed',
          'Saved query changed since it was opened. Reopen before editing.',
        );
      Object.assign(collection, {
        name: parsed.name,
        query,
        revision: collection.revision + 1,
        digest: sha(query),
        updated_at: new Date().toISOString(),
      });
      recordOperation(state, { id: parsed.operation_id, meaning, kind: 'update', target_id: id });
      await writeState(root, state);
      return { collection, operation_replayed: false };
    }),
  );
}
function currentVerdict(state: State, selection: Selection) {
  return state.triage.find((row) => row.identity === identity(selection))?.history.at(-1);
}
export async function runSmartCollection(root: string, id: string) {
  const collection = findCollection(await readState(root), id);
  const query = collection.query;
  const searched = await searchKnowledge(root, query.text, 100);
  const selectedOwners: Set<string> = query.owners.length ? new Set(query.owners) : new Set(owners);
  const selectedKinds: Set<string> = new Set(query.kinds);
  const start = query.updated_after ? Date.parse(query.updated_after) : null;
  const end = query.updated_before ? Date.parse(query.updated_before) : null;
  const state = await readState(root);
  const currentCollection = findCollection(state, collection.id);
  if (
    currentCollection.revision !== collection.revision ||
    currentCollection.digest !== collection.digest
  )
    fail(
      409,
      'smart_collection_changed',
      'Saved query changed while results were being retrieved. Reopen and run it again.',
    );
  const filtered = searched.records.flatMap((row) => {
    const selection = row.selection;
    if (!selectedOwners.has(selection.ref.owner)) return [];
    if (selectedKinds.size && !selectedKinds.has(selection.ref.kind)) return [];
    const timestamp = row.updated_at ? Date.parse(row.updated_at) : Number.NaN;
    const date_status = !Number.isFinite(timestamp)
      ? 'unknown'
      : (start !== null && timestamp < start) || (end !== null && timestamp > end)
        ? 'out-of-range'
        : 'in-range';
    // Null and malformed legacy dates remain visible rather than being classified by guess.
    if (date_status === 'out-of-range') return [];
    const verdict = currentVerdict(state, selection);
    const triage = verdict?.state ?? 'unreviewed';
    if (query.triage !== 'all' && query.triage !== triage) return [];
    return [{ ...row, date_status, triage, triage_reason: verdict?.reason ?? '' }];
  });
  const selectedCoverageIncomplete = searched.owner_coverage.some(
    (row) =>
      selectedOwners.has(row.owner) &&
      ['unconfigured', 'unavailable', 'partial'].includes(row.state),
  );
  const partial =
    searched.records.length >= 100 || filtered.length > query.limit || selectedCoverageIncomplete;
  return {
    collection: { id: collection.id, revision: collection.revision, digest: collection.digest },
    records: filtered.slice(0, query.limit),
    owner_coverage: searched.owner_coverage,
    partial,
    partial_reason: partial
      ? [
          searched.records.length >= 100 || filtered.length > query.limit
            ? 'The existing owner search cap or saved query limit may omit matches; narrow the query or inspect owner coverage.'
            : null,
          selectedCoverageIncomplete
            ? 'At least one selected owner is unconfigured, unavailable or partial; inspect owner coverage before treating this result set as complete.'
            : null,
        ]
          .filter(Boolean)
          .join(' ')
      : null,
    date_window: {
      updated_after: query.updated_after ?? null,
      updated_before: query.updated_before ?? null,
      timezone: 'UTC offsets are required; boundaries are inclusive.',
    },
    retrieval_note:
      'Order reflects existing lexical retrieval only, not evidence quality or usefulness.',
  };
}
export async function triageSmartCollection(root: string, id: string, input: unknown) {
  const parsed = checked<TriageInput>(triageInputSchema, input);
  const meaning = sha({ kind: 'triage', id, ...parsed });
  return admitted(root, parsed.operation_id, meaning, () =>
    mutate(root, async () => {
      const state = await readState(root);
      const prior = replay(state, parsed.operation_id, meaning, 'triage');
      if (prior)
        return { collection: findCollection(state, prior.target_id), operation_replayed: true };
      capacity(state, 'triage');
      const collection = findCollection(state, id);
      if (collection.revision !== parsed.revision || collection.digest !== parsed.digest)
        fail(
          409,
          'smart_collection_changed',
          'Saved query changed since these results were returned. Rerun before triage.',
        );
      if (
        new Set(parsed.changes.map((row) => identity(row.selection))).size !== parsed.changes.length
      )
        fail(
          400,
          'invalid_smart_collection_triage',
          'A result identity may appear only once per triage operation.',
        );
      const results = await runSmartCollection(root, id);
      const available = new Set(results.records.map((row) => identity(row.selection)));
      // Resolve every exact result before changing any verdict.
      for (const change of parsed.changes) {
        if (!available.has(identity(change.selection)))
          fail(
            409,
            'smart_collection_result_changed',
            'A selected result is no longer in this exact query result. Rerun and select it explicitly.',
          );
        await readKnowledge(root, change.selection);
      }
      for (const change of parsed.changes) {
        const key = identity(change.selection);
        let row = state.triage.find((item) => item.identity === key);
        if (!row) {
          if (state.triage.length >= 1000)
            fail(
              409,
              'smart_collection_capacity',
              'Triage identity limit reached; earlier state was preserved.',
            );
          row = { identity: key, selection: change.selection, history: [] };
          state.triage.push(row);
        }
        row.history.push({
          operation_id: parsed.operation_id,
          state: change.state,
          reason: change.reason ?? '',
          updated_at: new Date().toISOString(),
        });
        row.history = row.history.slice(-5);
      }
      recordOperation(state, { id: parsed.operation_id, meaning, kind: 'triage', target_id: id });
      await writeState(root, state);
      return { collection, operation_replayed: false };
    }),
  );
}
export async function freezeSmartCollection(root: string, id: string, input: unknown) {
  const parsed = checked<Static<typeof freezeInputSchema>>(freezeInputSchema, input);
  const meaning = sha({ kind: 'freeze', id, ...parsed });
  return admitted(root, parsed.operation_id, meaning, () =>
    mutate(root, async () => {
      const state = await readState(root);
      const prior = replay(state, parsed.operation_id, meaning, 'freeze');
      if (prior?.topic_id) {
        const topic = (await listTopics(root)).topics.find((row) => row.id === prior.topic_id);
        if (!topic)
          return fail(
            503,
            'smart_collection_freeze_unavailable',
            'The original freeze is unresolved; inspect the topic state before retrying.',
          );
        return { topic, operation_replayed: true };
      }
      if (prior)
        return fail(
          503,
          'smart_collection_freeze_unavailable',
          'The original freeze receipt is incomplete; inspect the topic state before retrying.',
        );
      // A topic named by the operation UUID proves the owner write completed even if
      // the following receipt write was interrupted. Recover its immutable snapshot
      // before checking whether today's query or sources still match that old freeze.
      const existingTopic = (await listTopics(root)).topics.find(
        (topic) => topic.id === parsed.operation_id,
      );
      if (existingTopic) {
        const snapshot = existingTopic.collection_snapshot;
        const sameMeaning =
          existingTopic.name === parsed.name &&
          JSON.stringify(existingTopic.members.map((member) => member.selection)) ===
            JSON.stringify(parsed.selections) &&
          JSON.stringify(existingTopic.questions) === JSON.stringify(parsed.questions) &&
          snapshot?.collection_id === id &&
          snapshot.collection_revision === parsed.revision &&
          snapshot.collection_digest === parsed.digest;
        if (!sameMeaning)
          fail(
            409,
            'smart_collection_operation_conflict',
            'Operation ID already produced a topic with different meaning.',
          );
        capacity(state, 'freeze');
        recordOperation(state, {
          id: parsed.operation_id,
          meaning,
          kind: 'freeze',
          target_id: id,
          topic_id: existingTopic.id,
        });
        await writeState(root, state);
        return { topic: existingTopic, operation_replayed: true };
      }
      capacity(state, 'freeze');
      const collection = findCollection(state, id);
      if (collection.revision !== parsed.revision || collection.digest !== parsed.digest)
        fail(
          409,
          'smart_collection_changed',
          'Saved query changed since these results were returned. Rerun before freezing.',
        );
      const results = await runSmartCollection(root, id);
      const current = new Set(results.records.map((row) => identity(row.selection)));
      if (new Set(parsed.selections.map(identity)).size !== parsed.selections.length)
        fail(
          400,
          'invalid_smart_collection_freeze',
          'Selected results must have distinct exact identities.',
        );
      for (const selection of parsed.selections) {
        if (!current.has(identity(selection)))
          fail(
            409,
            'smart_collection_result_changed',
            'A selected result is no longer current in this query result. Rerun and select it explicitly.',
          );
        await readKnowledge(root, selection);
      }
      const idempotentTopicId = parsed.operation_id;
      const snapshot = {
        collection_id: collection.id,
        collection_revision: collection.revision,
        collection_digest: collection.digest,
        owner_coverage: results.owner_coverage,
        partial: results.partial,
      };
      const plannedState = structuredClone(state);
      recordOperation(plannedState, {
        id: parsed.operation_id,
        meaning,
        kind: 'freeze',
        target_id: id,
        topic_id: idempotentTopicId,
      });
      assertStateCapacity(plannedState);
      const topic = await freezeTopicFromCollection(root, {
        id: idempotentTopicId,
        name: parsed.name,
        selections: parsed.selections,
        questions: parsed.questions,
        snapshot,
      });
      recordOperation(state, {
        id: parsed.operation_id,
        meaning,
        kind: 'freeze',
        target_id: id,
        topic_id: topic.id,
      });
      await writeState(root, state);
      return { topic, operation_replayed: false };
    }),
  );
}
export async function smartCollectionsRoute(
  root: string,
  route: string,
  mutation: boolean,
  url: string,
  body: unknown,
) {
  const params = new URL(url, 'http://127.0.0.1').searchParams;
  if (route === 'smart-collections' && !mutation) {
    if (params.size)
      fail(400, 'invalid_smart_collection', 'Collection listing takes no query fields.');
    return listSmartCollections(root);
  }
  if (route === 'smart-collections' && mutation) {
    if (params.size)
      fail(400, 'invalid_smart_collection', 'Collection creation takes no query fields.');
    return createSmartCollection(root, body);
  }
  const match =
    /^smart-collections\/([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})(?:\/(run|triage|freeze))?$/.exec(
      route,
    );
  if (!match) return fail(404, 'smart_collection_missing', 'Saved collection route was not found.');
  const [, id, action] = match;
  if (action === 'run' && !mutation) {
    if (params.size)
      fail(400, 'invalid_smart_collection', 'Query run takes no extra query fields.');
    return runSmartCollection(root, id!);
  }
  if (action === 'triage' && mutation) {
    if (params.size) fail(400, 'invalid_smart_collection', 'Triage takes no query fields.');
    return triageSmartCollection(root, id!, body);
  }
  if (action === 'freeze' && mutation) {
    if (params.size) fail(400, 'invalid_smart_collection', 'Freeze takes no query fields.');
    return freezeSmartCollection(root, id!, body);
  }
  if (!action && !params.size && !mutation) return openSmartCollection(root, id!);
  if (!action && !params.size && mutation) return updateSmartCollection(root, id!, body);
  return fail(
    404,
    'smart_collection_operation_unknown',
    'This collection operation is not supported.',
  );
}
