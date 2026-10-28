import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  configureKnowledge,
  readKnowledge,
  searchKnowledge,
  type KnowledgeSelection,
  type openTopic as OpenTopicFunction,
} from './knowledge.js';
import { saveLibraryLead } from './library-leads.js';
import { requestStore } from './search-request-store.js';
import { searchApi } from './search-api.js';
import {
  createSmartCollection,
  runSmartCollection,
  triageSmartCollection,
} from './smart-collections.js';
import type * as SearchRunnerModule from './search-runner.js';

vi.mock('./search-runner.js', async (original) => ({
  ...(await original<typeof SearchRunnerModule>()),
  codexRunner: () => ({ readiness: async () => ({ available: false, reason: 'offline test' }) }),
}));

const at = '2026-10-22T12:00:00.000Z';
const hash = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');
let root: string;
let exportPath: string;
let nativeSelection: KnowledgeSelection;
let nativeContent: string;

type Run = Awaited<ReturnType<typeof runSmartCollection>>;
type Collection = Awaited<ReturnType<typeof createSmartCollection>>['collection'];
type FrozenTopic = Awaited<ReturnType<typeof OpenTopicFunction>>['topic'];
type TopicStatus = Awaited<ReturnType<typeof OpenTopicFunction>>['statuses'][number];
const json = async <T>(response: Response): Promise<T> => {
  const value: unknown = await response.json();
  return value as T;
};

async function writePlanning(content = nativeContent) {
  const digest = hash(content);
  await writeFile(
    exportPath,
    JSON.stringify({
      schema_version: '1.0',
      owner: 'planning-ai',
      instance_id: 'synthetic-planning',
      exported_at: at,
      records: [
        {
          ref: {
            owner: 'planning-ai',
            kind: 'decision',
            id: nativeSelection.ref.id,
            revision: `sha256:${digest}`,
            digest,
          },
          title: 'Rollout decision with colliding ID',
          summary: 'A synthetic rollout decision.',
          updated_at: at,
          qualification: 'user_authored_assertion',
          content,
        },
      ],
    }),
  );
}

async function seed() {
  await requestStore(root).initialize();
  await saveLibraryLead(
    root,
    {
      uri: 'https://example.org/rollout-native-one',
      name: 'Rollout native one',
      description: 'A retained rollout note.',
      limits: [],
    },
    randomUUID(),
    'rollout',
  );
  await saveLibraryLead(
    root,
    {
      uri: 'https://example.org/rollout-native-two',
      name: 'Rollout native two',
      description: 'Another retained rollout note.',
      limits: [],
    },
    randomUUID(),
    'rollout',
  );
  const native = (await searchKnowledge(root, 'rollout', 100)).records.find(
    (row) => row.selection.ref.owner === 'signals-ai',
  );
  if (!native) throw new Error('synthetic_native_record_missing');
  nativeSelection = native.selection;
  nativeContent = (await readKnowledge(root, native.selection)).content;
  await writePlanning();
  await configureKnowledge(root, {
    owners: [
      { owner: 'planning-ai', path: exportPath, instance_id: 'synthetic-planning' },
      {
        owner: 'principles-ai',
        path: join(root, 'temporarily-unavailable-principles.json'),
        instance_id: 'synthetic-principles',
      },
    ],
  });
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'signals-smart-collections-')));
  exportPath = join(root, 'explicit-planning-export.json');
  await seed();
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const query = {
  text: 'rollout',
  owners: ['signals-ai', 'planning-ai', 'principles-ai'],
  kinds: ['lead', 'decision'],
  updated_after: '2026-10-20T00:00:00Z',
  triage: 'all',
  limit: 100,
};

it('saves a query, triages exact identities, observes changed exports, then freezes explicit refs over guarded HTTP', async () => {
  const scope = await requestStore(root).scope();
  const headers = {
    'x-signals-instance-id': scope.identity,
    'x-signals-owner-epoch': scope.epoch,
  };
  async function launch() {
    const api = searchApi(root, async () => {
      throw new Error('Model call is forbidden in this synthetic test');
    });
    const server = createServer((req, res) => void api(req, res));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('synthetic_server_unavailable');
    return { server, base: `http://127.0.0.1:${address.port}/signals-ai/__signals/api/` };
  }
  const first = await launch();
  const close = async (server: ReturnType<typeof createServer>) => {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  };
  let collectionId: string;
  let topicId: string;
  try {
    const session = await json<{ token: string }>(await fetch(first.base + 'session'));
    const auth = {
      ...headers,
      'content-type': 'application/json',
      'x-signals-token': session.token,
    };
    const create = await fetch(first.base + 'smart-collections', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ operation_id: randomUUID(), name: 'Rollout decisions', query }),
    });
    expect(create.status).toBe(200);
    const created = await json<{ collection: Collection }>(create);
    collectionId = created.collection.id;
    const reopened = await json<{ collection: Collection }>(
      await fetch(first.base + `smart-collections/${collectionId}`, { headers }),
    );
    expect(reopened.collection).toEqual(created.collection);

    const run = await json<Run>(
      await fetch(first.base + `smart-collections/${collectionId}/run`, { headers }),
    );
    expect(run.records).toHaveLength(3);
    expect(run.owner_coverage.find((row) => row.owner === 'principles-ai')?.state).toBe(
      'unavailable',
    );
    expect(run.records.filter((row) => row.selection.ref.owner === 'signals-ai')).toHaveLength(2);
    const native = run.records.find(
      (row) =>
        row.selection.ref.owner === 'signals-ai' && row.selection.ref.id === nativeSelection.ref.id,
    );
    const foreign = run.records.find((row) => row.selection.ref.owner === 'planning-ai');
    if (!native || !foreign) throw new Error('synthetic_owner_matches_missing');
    expect(native.selection.ref.id).toBe(foreign.selection.ref.id);
    expect(native.selection.ref.digest).toBe(foreign.selection.ref.digest);
    expect(native.selection.ref.owner).not.toBe(foreign.selection.ref.owner);
    expect(native.date_status).toBe('unknown');
    expect(run.records.every((row) => row.triage === 'unreviewed')).toBe(true);

    const triaged = await fetch(first.base + `smart-collections/${collectionId}/triage`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        operation_id: randomUUID(),
        revision: run.collection.revision,
        digest: run.collection.digest,
        changes: [
          { selection: native.selection, state: 'dismiss', reason: 'Not the selected decision.' },
          { selection: foreign.selection, state: 'keep', reason: 'Review this decision.' },
        ],
      }),
    });
    expect(triaged.status).toBe(200);
    const afterTriage = await json<Run>(
      await fetch(first.base + `smart-collections/${collectionId}/run`, { headers }),
    );
    expect(
      afterTriage.records.find((row) => row.selection.ref.owner === 'signals-ai')?.triage,
    ).toBe('dismiss');
    expect(
      afterTriage.records.find((row) => row.selection.ref.owner === 'planning-ai')?.triage,
    ).toBe('keep');

    const beforeStale = await readFile(join(root, '.signals/smart-collections.json'), 'utf8');
    const stale = await fetch(first.base + `smart-collections/${collectionId}/triage`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        operation_id: randomUUID(),
        revision: run.collection.revision + 1,
        digest: run.collection.digest,
        changes: [{ selection: native.selection, state: 'keep' }],
      }),
    });
    expect(stale.status).toBe(409);
    expect(await readFile(join(root, '.signals/smart-collections.json'), 'utf8')).toBe(beforeStale);

    // A foreign owner with the same ID/hash is still a different selection identity.
    const wrongOwner = {
      ...foreign.selection,
      ref: { ...foreign.selection.ref, owner: 'principles-ai' },
      instance_id: 'synthetic-principles',
    };
    const deniedAlias = await fetch(first.base + `smart-collections/${collectionId}/triage`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        operation_id: randomUUID(),
        revision: run.collection.revision,
        digest: run.collection.digest,
        changes: [
          { selection: native.selection, state: 'keep' },
          { selection: wrongOwner, state: 'keep' },
        ],
      }),
    });
    expect(deniedAlias.status).toBe(409);
    expect(await readFile(join(root, '.signals/smart-collections.json'), 'utf8')).toBe(beforeStale);

    const nextContent = JSON.stringify({ decision: 'rollout retained with changed condition' });
    await writePlanning(nextContent);
    const refreshed = await json<Run>(
      await fetch(first.base + `smart-collections/${collectionId}/run`, { headers }),
    );
    const changed = refreshed.records.find((row) => row.selection.ref.owner === 'planning-ai');
    if (!changed) throw new Error('synthetic_changed_record_missing');
    expect(changed.selection.ref.digest).not.toBe(foreign.selection.ref.digest);
    expect(changed.triage).toBe('unreviewed');
    expect(refreshed.records.find((row) => row.selection.ref.owner === 'signals-ai')?.triage).toBe(
      'dismiss',
    );
    const beforeChangedIdentityAttempt = await readFile(
      join(root, '.signals/smart-collections.json'),
      'utf8',
    );
    const staleIdentity = await fetch(first.base + `smart-collections/${collectionId}/triage`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        operation_id: randomUUID(),
        revision: refreshed.collection.revision,
        digest: refreshed.collection.digest,
        changes: [{ selection: foreign.selection, state: 'keep' }],
      }),
    });
    expect(staleIdentity.status).toBe(409);
    expect(await readFile(join(root, '.signals/smart-collections.json'), 'utf8')).toBe(
      beforeChangedIdentityAttempt,
    );

    const freezeRequest = {
      operation_id: randomUUID(),
      revision: refreshed.collection.revision,
      digest: refreshed.collection.digest,
      name: 'Reviewed rollout choices',
      selections: [native.selection, changed.selection],
      questions: ['What changed in the Planning export?'],
    };
    const frozen = await fetch(first.base + `smart-collections/${collectionId}/freeze`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(freezeRequest),
    });
    expect(frozen.status).toBe(200);
    const frozenResult = await json<{ topic: FrozenTopic; operation_replayed: boolean }>(frozen);
    topicId = frozenResult.topic.id;
    expect(frozenResult.topic.members.map((row) => row.selection)).toEqual([
      native.selection,
      changed.selection,
    ]);
    expect(frozenResult.topic.collection_snapshot).toMatchObject({
      collection_id: collectionId,
      collection_revision: refreshed.collection.revision,
      collection_digest: refreshed.collection.digest,
      partial: true,
    });
    expect(frozenResult.topic.collection_snapshot?.owner_coverage).toMatchObject(
      refreshed.owner_coverage.map((row) => ({
        owner: row.owner,
        state: row.state,
        export_as_of: row.export_as_of,
        reason: row.reason,
      })),
    );
    expect(frozenResult.topic.questions).toEqual(['What changed in the Planning export?']);
    const replayedFreeze = await fetch(first.base + `smart-collections/${collectionId}/freeze`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(freezeRequest),
    });
    expect(
      await json<{ topic: FrozenTopic; operation_replayed: boolean }>(replayedFreeze),
    ).toMatchObject({
      topic: { id: topicId },
      operation_replayed: true,
    });
    const statePath = join(root, '.signals/smart-collections.json');
    const beforeChangedFreezeReplay = await readFile(statePath, 'utf8');
    const changedMeaningReplay = await fetch(
      first.base + `smart-collections/${collectionId}/freeze`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ ...freezeRequest, name: 'Different meaning' }),
      },
    );
    expect(changedMeaningReplay.status).toBe(409);
    expect(await readFile(statePath, 'utf8')).toBe(beforeChangedFreezeReplay);
    const stateAfterFreeze = JSON.parse(await readFile(statePath, 'utf8')) as {
      operations: { id: string }[];
    };
    stateAfterFreeze.operations = stateAfterFreeze.operations.filter(
      (row: { id: string }) => row.id !== freezeRequest.operation_id,
    );
    await writeFile(statePath, JSON.stringify(stateAfterFreeze));
    await writePlanning(JSON.stringify({ decision: 'changed after interrupted freeze' }));
    const changedQuery = { ...query, text: 'query changed after interrupted freeze' };
    const updateQuery = await fetch(first.base + `smart-collections/${collectionId}`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        operation_id: randomUUID(),
        revision: refreshed.collection.revision,
        name: 'Changed after interrupted freeze',
        query: changedQuery,
      }),
    });
    expect(updateQuery.status).toBe(200);
    const beforeChangedRecovery = await readFile(statePath, 'utf8');
    const changedMeaningWithoutReceipt = await fetch(
      first.base + `smart-collections/${collectionId}/freeze`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ ...freezeRequest, name: 'Different meaning' }),
      },
    );
    expect(changedMeaningWithoutReceipt.status).toBe(409);
    expect(await readFile(statePath, 'utf8')).toBe(beforeChangedRecovery);
    const recoveredFreeze = await fetch(first.base + `smart-collections/${collectionId}/freeze`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(freezeRequest),
    });
    const recovered = await json<{ topic: FrozenTopic; operation_replayed: boolean }>(
      recoveredFreeze,
    );
    expect(recovered).toMatchObject({
      topic: { id: topicId },
      operation_replayed: true,
    });
    expect(recovered.topic.members.map((row) => row.selection)).toEqual(freezeRequest.selections);
    expect(recovered.topic.collection_snapshot).toMatchObject({
      collection_id: collectionId,
      collection_revision: refreshed.collection.revision,
      collection_digest: refreshed.collection.digest,
    });
  } finally {
    await close(first.server);
  }

  const second = await launch();
  try {
    const reopened = await json<{ topic: FrozenTopic; statuses: TopicStatus[] }>(
      await fetch(second.base + `topics/${topicId}`, { headers }),
    );
    expect(reopened.topic.collection_snapshot?.collection_id).toBe(collectionId);
    expect(reopened.topic.members.map((row) => row.selection)).toHaveLength(2);
    expect(reopened.statuses.map((row) => row.state)).toEqual(['current', 'changed']);
    const frozenReferences = reopened.topic.members.map((row) => row.selection);
    await writePlanning(JSON.stringify({ decision: 'changed after the topic was frozen' }));
    const changedAfterFreeze = await json<{ topic: FrozenTopic; statuses: TopicStatus[] }>(
      await fetch(second.base + `topics/${topicId}`, { headers }),
    );
    expect(changedAfterFreeze.topic.members.map((row) => row.selection)).toEqual(frozenReferences);
    expect(changedAfterFreeze.statuses.map((row) => row.state)).toEqual(['current', 'changed']);
  } finally {
    await close(second.server);
  }
});

it('replays identical create/freeze operations and refuses stale, changed, and over-capacity mutations without partial writes', async () => {
  const operationId = randomUUID();
  const created = await createSmartCollection(root, {
    operation_id: operationId,
    name: 'Rollout',
    query,
  });
  expect(
    await createSmartCollection(root, { operation_id: operationId, name: 'Rollout', query }),
  ).toMatchObject({ collection: created.collection, operation_replayed: true });
  await expect(
    createSmartCollection(root, { operation_id: operationId, name: 'Different', query }),
  ).rejects.toMatchObject({ status: 409 });
  const results = await runSmartCollection(root, created.collection.id);
  const selected = results.records.find(
    (row) => row.selection.ref.owner === 'signals-ai',
  )?.selection;
  if (!selected) throw new Error('synthetic_native_record_missing');
  const before = await readFile(join(root, '.signals/smart-collections.json'), 'utf8');
  await expect(
    triageSmartCollection(root, created.collection.id, {
      operation_id: randomUUID(),
      revision: 99,
      digest: created.collection.digest,
      changes: [{ selection: selected, state: 'dismiss' }],
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(await readFile(join(root, '.signals/smart-collections.json'), 'utf8')).toBe(before);

  const current = JSON.parse(before) as { triage: unknown[]; operations: { id: string }[] };
  current.triage = Array.from({ length: 1000 }, (_, index) => {
    const selection = {
      ref: {
        owner: 'signals-ai',
        kind: 'lead',
        id: `lead-${String(index).padStart(24, '0')}`,
        revision: `sha256:${'a'.repeat(64)}`,
        digest: 'a'.repeat(64),
      },
      instance_id: 'synthetic-capacity',
      owner_epoch: randomUUID(),
    };
    return {
      identity: JSON.stringify([
        selection.ref.owner,
        selection.instance_id,
        selection.owner_epoch,
        selection.ref.kind,
        selection.ref.id,
        selection.ref.revision,
        selection.ref.digest,
      ]),
      selection,
      history: [
        {
          operation_id: randomUUID(),
          state: 'dismiss' as const,
          reason: 'synthetic',
          updated_at: at,
        },
      ],
    };
  });
  await writeFile(join(root, '.signals/smart-collections.json'), JSON.stringify(current));
  const fullBefore = await readFile(join(root, '.signals/smart-collections.json'), 'utf8');
  await expect(
    triageSmartCollection(root, created.collection.id, {
      operation_id: randomUUID(),
      revision: created.collection.revision,
      digest: created.collection.digest,
      changes: [{ selection: selected, state: 'dismiss' }],
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(await readFile(join(root, '.signals/smart-collections.json'), 'utf8')).toBe(fullBefore);
});
