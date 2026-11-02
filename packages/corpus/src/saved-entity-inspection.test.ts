import { expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEntities } from './search-store.js';
import { inspectSavedEntity } from './saved-entity-inspection.js';

it('shows a privately saved assessed finding with its exact record and saved-search receipt', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'saved-entity-inspection-')));
  const [source] = await loadEntities(resolve('signals/entities'));
  if (!source) throw new Error('missing_native_fixture');
  const privateDir = join(root, '.signals/corpus/entities');
  await mkdir(privateDir, { recursive: true });
  const lead = structuredClone(source);
  const record = { ...lead, state: 'user-saved' as const };
  const recordPath = join(privateDir, `${record.entity.id}.json`);
  const exactRecordBytes = `${JSON.stringify(record, null, 2)}\n`;
  await writeFile(recordPath, exactRecordBytes);
  await mkdir(join(root, '.signals'), { recursive: true });
  const receipt = {
    id: 'receipt-1',
    at: '2026-11-02T00:00:00.000Z',
    mode: 'manual',
    destination: 'private',
    selected: [record.entity.id],
    changed: [record.entity.id],
    skipped: [],
    runId: '12345678-1234-4234-8234-123456789abc',
    query: 'synthetic lead query',
    kind: 'one-off',
  };
  const mismatchReceipt = { ...receipt, id: 'receipt-2', selected: ['entity-000000000000000000000000'] };
  await writeFile(
    join(root, '.signals/selections.json'),
    JSON.stringify([receipt, mismatchReceipt]),
  );
  try {
    const inspected = await inspectSavedEntity(record.entity.id, root, 'private');
    expect(inspected).toMatchObject({
      schema: 'signals.saved-entity-inspection.v1',
      destination: 'private',
      savedState: 'user-saved',
      assessmentState: 'assessed-finding',
      confidence: 'Unknown',
      receipts: [{ runId: receipt.runId, query: receipt.query, mode: 'manual' }],
      historicalRead: expect.stringContaining('history/open'),
    });
    expect(inspected.record).toEqual(record);
    expect(inspected.record.entity.evidence).toEqual(record.entity.evidence);
    expect(inspected.receipts.map(({ id }) => id)).toEqual([receipt.id]);
    expect(await readFile(recordPath, 'utf8')).toBe(exactRecordBytes);
    expect(await loadEntities(join(root, 'signals/entities'))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

