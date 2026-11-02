import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEntities, loadRun, retainRun, saveEntities } from './search-store.js';
import { inspectSavedEntity, projectAssessmentState } from './saved-entity-inspection.js';
import { budgets, type SearchResult } from '../../domain/src/search-contract.js';

it('shows a privately saved assessed finding with its exact record and saved-search receipt', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'saved-entity-inspection-')));
  const [source] = await loadEntities(resolve('signals/entities'));
  if (!source) throw new Error('missing_native_fixture');
  const privateDir = join(root, '.signals/corpus/entities');
  await mkdir(privateDir, { recursive: true });
  const entity = structuredClone(source.entity);
  await mkdir(join(root, '.signals'), { recursive: true });
  const run: SearchResult = {
    schemaVersion: 2,
    runId: randomUUID(),
    query: 'synthetic lead query',
    status: 'completed',
    items: [
      {
        entity,
        match: { level: 'direct', reason: 'Synthetic exact receipt.', sources: [] },
        eligible: false,
        reasons: ['manual_only'],
      },
    ],
    sources: [],
    coverage: [],
    gaps: [],
    usage: {
      searches: 0,
      documents: 0,
      elapsedMs: 0,
      modelCalls: 0,
      providerUsage: null,
      cost: null,
    },
    counts: { leads: 1, distinct: 1, duplicates: 0, omitted: 0 },
    limits: budgets.quick,
  };
  await retainRun(run, root);
  await saveEntities(run.items, 'manual', root, 'private', 75, false, {
    runId: run.runId,
    query: run.query,
    kind: 'one-off',
  });
  const [record] = await loadEntities(privateDir);
  if (!record) throw new Error('manual_save_missing_private_entity');
  const recordPath = join(privateDir, `${record.entity.id}.json`);
  const exactRecordBytes = await readFile(recordPath, 'utf8');
  const [receipt] = JSON.parse(await readFile(join(root, '.signals/selections.json'), 'utf8'));
  const selectionHistory = JSON.parse(
    await readFile(join(root, '.signals/selections.json'), 'utf8'),
  );
  const mismatchReceipt = {
    ...selectionHistory[0],
    id: 'receipt-2',
    selected: ['entity-000000000000000000000000'],
  };
  const malformedQueryIdReceipt = { ...selectionHistory[0], queryId: 42 };
  const laterSkippedSelection = {
    ...selectionHistory[0],
    id: 'receipt-repeat',
    changed: [],
    skipped: [record.entity.id],
  };
  await writeFile(
    join(root, '.signals/selections.json'),
    JSON.stringify([malformedQueryIdReceipt, laterSkippedSelection, mismatchReceipt]),
  );
  try {
    const inspected = await inspectSavedEntity(record.entity.id, root, 'private');
    expect(inspected).toMatchObject({
      schema: 'signals.saved-entity-inspection.v1',
      destination: 'private',
      savedState: 'user-saved',
      assessmentState: 'assessed-finding',
      confidence: 'Unknown',
      receipts: [
        {
          runId: run.runId,
          query: run.query,
          mode: 'manual',
          destination: 'private',
          selectionEffect: 'changed',
          reopenStatus: 'available',
        },
        {
          destination: 'private',
          selectionEffect: 'skipped',
          reopenStatus: 'available',
        },
      ],
      historicalRead: expect.stringContaining('history/open'),
    });
    expect(inspected.record).toEqual(record);
    expect(inspected.record.entity.evidence).toEqual(record.entity.evidence);
    expect(inspected.receipts.map(({ id }) => id)).toEqual([receipt.id, 'receipt-repeat']);
    expect(inspected.receipts[0]).not.toHaveProperty('queryId');
    expect((await loadRun(run.runId, root)).items[0]?.entity.id).toBe(record.entity.id);
    expect(await readFile(recordPath, 'utf8')).toBe(exactRecordBytes);
    expect(await loadEntities(join(root, 'signals/entities'))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps a saved record inspectable when its recorded frozen run is missing', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'saved-entity-stale-run-')));
  const [source] = await loadEntities(resolve('signals/entities'));
  if (!source) throw new Error('missing_native_fixture');
  const record = { ...structuredClone(source), state: 'user-saved' as const };
  const id = record.entity.id;
  await mkdir(join(root, '.signals/corpus/entities'), { recursive: true });
  await mkdir(join(root, '.signals'), { recursive: true });
  await writeFile(join(root, '.signals/corpus/entities', `${id}.json`), JSON.stringify(record));
  await writeFile(
    join(root, '.signals/selections.json'),
    JSON.stringify([
      {
        id: 'stale-selection',
        at: '2026-11-02T00:00:00Z',
        mode: 'manual',
        destination: 'private',
        selected: [id],
        changed: [id],
        skipped: [],
        runId: randomUUID(),
        query: 'expired research',
        kind: 'one-off',
      },
    ]),
  );
  try {
    const inspected = await inspectSavedEntity(id, root, 'private');
    expect(inspected.record).toEqual(record);
    expect(inspected.receipts).toMatchObject([
      {
        reopenStatus: 'unavailable',
        reopenReason: 'The frozen selection run is no longer retained.',
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('fails closed on unsupported assessment states and the loader rejects malformed saved assessments', async () => {
  expect(() => projectAssessmentState('future-state')).toThrow('unsupported_assessment_state');
  expect(() => projectAssessmentState(undefined)).toThrow('unsupported_assessment_state');

  const root = await realpath(await mkdtemp(join(tmpdir(), 'saved-entity-invalid-assessment-')));
  const [source] = await loadEntities(resolve('signals/entities'));
  if (!source) throw new Error('missing_native_fixture');
  const id = source.entity.id;
  await mkdir(join(root, '.signals/corpus/entities'), { recursive: true });
  try {
    for (const state of ['future-state', undefined] as const) {
      const entity = structuredClone(source.entity) as unknown as Record<string, unknown>;
      const assessment = { ...(entity.assessment as Record<string, unknown>) };
      if (state === undefined) delete assessment.state;
      else assessment.state = state;
      entity.assessment = assessment;
      await writeFile(
        join(root, '.signals/corpus/entities', `${id}.json`),
        JSON.stringify({ recordVersion: 2, entity, state: 'user-saved' }),
      );
      await expect(inspectSavedEntity(id, root, 'private')).rejects.toThrow(
        'invalid_entity_schema',
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('marks a malformed noncanonical run ID as a conflict without dropping its receipt', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'saved-entity-malformed-run-')));
  const [source] = await loadEntities(resolve('signals/entities'));
  if (!source) throw new Error('missing_native_fixture');
  const record = { ...structuredClone(source), state: 'user-saved' as const };
  const id = record.entity.id;
  await mkdir(join(root, '.signals/corpus/entities'), { recursive: true });
  await mkdir(join(root, '.signals'), { recursive: true });
  await writeFile(join(root, '.signals/corpus/entities', `${id}.json`), JSON.stringify(record));
  await writeFile(
    join(root, '.signals/selections.json'),
    JSON.stringify([
      {
        id: 'malformed-run-selection',
        at: '2026-11-02T00:00:00Z',
        mode: 'manual',
        destination: 'private',
        selected: [id],
        changed: [id],
        skipped: [],
        runId: '------------------------------------',
        query: 'old research',
        kind: 'one-off',
      },
    ]),
  );
  try {
    const inspected = await inspectSavedEntity(id, root, 'private');
    expect(inspected.record).toEqual(record);
    expect(inspected.receipts).toMatchObject([
      {
        runId: '------------------------------------',
        reopenStatus: 'conflict',
        reopenReason: 'The recorded selection run ID is invalid.',
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('marks a receipt conflict when the frozen run does not contain its saved entity', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'saved-entity-conflicting-run-')));
  const [source] = await loadEntities(resolve('signals/entities'));
  if (!source) throw new Error('missing_native_fixture');
  const record = { ...structuredClone(source), state: 'user-saved' as const };
  const id = record.entity.id;
  const run: SearchResult = {
    schemaVersion: 2,
    runId: randomUUID(),
    query: 'same query, wrong entity',
    status: 'completed',
    items: [],
    sources: [],
    coverage: [],
    gaps: [],
    usage: {
      searches: 0,
      documents: 0,
      elapsedMs: 0,
      modelCalls: 0,
      providerUsage: null,
      cost: null,
    },
    counts: { leads: 0, distinct: 0, duplicates: 0, omitted: 0 },
    limits: budgets.quick,
  };
  await mkdir(join(root, '.signals/corpus/entities'), { recursive: true });
  await mkdir(join(root, '.signals'), { recursive: true });
  await writeFile(join(root, '.signals/corpus/entities', `${id}.json`), JSON.stringify(record));
  await retainRun(run, root);
  await writeFile(
    join(root, '.signals/selections.json'),
    JSON.stringify([
      {
        id: 'conflicting-selection',
        at: '2026-11-02T00:00:00Z',
        mode: 'manual',
        destination: 'private',
        selected: [id],
        changed: [id],
        skipped: [],
        runId: run.runId,
        query: run.query,
        kind: 'one-off',
      },
    ]),
  );
  try {
    const inspected = await inspectSavedEntity(id, root, 'private');
    expect(inspected.record).toEqual(record);
    expect(inspected.receipts).toMatchObject([
      {
        reopenStatus: 'conflict',
        reopenReason: 'The frozen run does not match this receipt and saved entity.',
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('requires a destination for duplicate identities and returns receipts only from that store', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'saved-entity-store-scope-')));
  const [source] = await loadEntities(resolve('signals/entities'));
  if (!source) throw new Error('missing_native_fixture');
  const publicRecord = structuredClone(source);
  const privateRecord = structuredClone(source);
  privateRecord.entity.name = 'Private scoped copy';
  const id = publicRecord.entity.id;
  const result = (query: string, entity: typeof publicRecord.entity): SearchResult => ({
    schemaVersion: 2,
    runId: randomUUID(),
    query,
    status: 'completed',
    items: [
      {
        entity,
        match: { level: 'direct', reason: 'Scoped fixture.', sources: [] },
        eligible: false,
        reasons: ['manual_only'],
      },
    ],
    sources: [],
    coverage: [],
    gaps: [],
    usage: {
      searches: 0,
      documents: 0,
      elapsedMs: 0,
      modelCalls: 0,
      providerUsage: null,
      cost: null,
    },
    counts: { leads: 1, distinct: 1, duplicates: 0, omitted: 0 },
    limits: budgets.quick,
  });
  const publicRun = result('public scope', publicRecord.entity);
  const privateRun = result('private scope', privateRecord.entity);
  await mkdir(join(root, 'signals/entities'), { recursive: true });
  await mkdir(join(root, '.signals/corpus/entities'), { recursive: true });
  await mkdir(join(root, '.signals'), { recursive: true });
  await writeFile(join(root, 'signals/entities', `${id}.json`), JSON.stringify(publicRecord));
  await writeFile(
    join(root, '.signals/corpus/entities', `${id}.json`),
    JSON.stringify({ ...privateRecord, state: 'user-saved' }),
  );
  await retainRun(publicRun, root);
  await retainRun(privateRun, root);
  await writeFile(
    join(root, '.signals/selections.json'),
    JSON.stringify(
      [
        { run: publicRun, destination: 'public', id: 'public-receipt' },
        { run: privateRun, destination: 'private', id: 'private-receipt' },
      ].map(({ run, destination, id: receiptId }) => ({
        id: receiptId,
        at: '2026-11-02T00:00:00Z',
        mode: 'manual',
        destination,
        selected: [id],
        changed: [id],
        skipped: [],
        runId: run.runId,
        query: run.query,
        kind: 'one-off',
      })),
    ),
  );
  try {
    await expect(inspectSavedEntity(id, root)).rejects.toThrow('ambiguous_entity_destination');
    const privateInspection = await inspectSavedEntity(id, root, 'private');
    const publicInspection = await inspectSavedEntity(id, root, 'public');
    expect(privateInspection.record.entity.name).toBe('Private scoped copy');
    expect(privateInspection.receipts.map((receipt) => receipt.id)).toEqual(['private-receipt']);
    expect(publicInspection.record.entity.name).toBe(publicRecord.entity.name);
    expect(publicInspection.receipts.map((receipt) => receipt.id)).toEqual(['public-receipt']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
