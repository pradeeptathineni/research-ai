import { mkdtemp, readFile, realpath, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import {
  appendDatasetVersion,
  datasetStoreLimits,
  importDataset,
  listDatasets,
  readDataset,
  type DatasetMetadata,
} from './dataset-store.js';

const roots: string[] = [];
async function temp() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-datasets-')));
  roots.push(root);
  return join(root, 'datasets');
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const metadata: DatasetMetadata = {
  assertions: 'caller-provided',
  source: { label: 'Synthetic fixture uploaded by the test' },
  license: { status: 'unknown' },
  authorization: { status: 'user-confirmed', recordedAt: '2026-11-03T12:00:00.000Z' },
};

it('preserves exact source bytes and cold-opens the same digest from an immutable reference', async () => {
  const root = await temp();
  const bytes = Buffer.from('\ufeffregion,value\r\nwest,"2,000"\r\n', 'utf8');
  const ref = await importDataset(bytes, { name: 'Synthetic intake.csv', metadata }, root);
  expect(ref.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(await listDatasets(root)).toEqual([ref]);
  const reopened = await readDataset(ref, root);
  expect(Buffer.from(reopened.bytes)).toEqual(bytes);
  expect(reopened.metadata).toEqual(metadata);
  expect(Buffer.from(await readFile(join(root, ref.datasetId, '01.csv')))).toEqual(bytes);
});

it('preserves old versions and rejects a stale or concurrent expected head', async () => {
  const root = await temp();
  const original = Buffer.from('region,value\nwest,10\n');
  const first = await importDataset(original, { name: 'Sales.csv', metadata }, root);
  const replacement = Buffer.from('region,value\neast,20\n');
  const second = await appendDatasetVersion(
    first,
    replacement,
    { name: 'Sales.csv', metadata },
    root,
  );
  expect(second).toMatchObject({ datasetId: first.datasetId, version: 2 });
  expect((await readDataset(first, root)).bytes).toEqual(original);
  expect((await readDataset(second, root)).bytes).toEqual(replacement);
  await expect(
    appendDatasetVersion(
      first,
      Buffer.from('region,value\nnorth,30\n'),
      { name: 'Sales.csv', metadata },
      root,
    ),
  ).rejects.toMatchObject({ code: 'dataset_head_changed' });
  expect(await listDatasets(root)).toEqual([first, second]);
});

it('refuses unbounded, malformed, and unauthorized dataset imports', async () => {
  const root = await temp();
  await expect(
    importDataset(Buffer.from(''), { name: 'bad.csv', metadata }, root),
  ).rejects.toMatchObject({
    code: 'invalid_dataset_bytes',
  });
  await expect(
    importDataset(Buffer.from('a,b\n'), { name: '../private.csv', metadata }, root),
  ).rejects.toMatchObject({ code: 'invalid_dataset' });
  await expect(
    importDataset(Buffer.from([0x61, 0xff]), { name: 'bad.csv', metadata }, root),
  ).rejects.toMatchObject({ code: 'invalid_dataset_bytes' });
  await expect(
    importDataset(
      Buffer.from('a\n'),
      {
        name: 'bad.csv',
        metadata: {
          ...metadata,
          authorization: { status: 'user-confirmed', recordedAt: 'invalid' },
        },
      },
      root,
    ),
  ).rejects.toMatchObject({ code: 'invalid_dataset' });
  await expect(
    importDataset(
      new Uint8Array(datasetStoreLimits.bytes + 1),
      { name: 'large.csv', metadata },
      root,
    ),
  ).rejects.toMatchObject({ code: 'invalid_dataset_bytes' });
  expect(await listDatasets(root)).toEqual([]);
});

it('detects and preserves an orphaned source-byte file after an interrupted version commit', async () => {
  const root = await temp();
  const bytes = Buffer.from('region,value\nwest,10\n');
  const ref = await importDataset(bytes, { name: 'Interrupted.csv', metadata }, root);
  await unlink(join(root, ref.datasetId, '01.json'));
  await expect(listDatasets(root)).rejects.toMatchObject({ code: 'dataset_corrupt' });
  expect(await readFile(join(root, ref.datasetId, '01.csv'))).toEqual(bytes);
});

it('refuses a symlinked storage root on a cold read', async () => {
  const root = await temp();
  const ref = await importDataset(
    Buffer.from('a,b\n1,2\n'),
    { name: 'Fixture.csv', metadata },
    root,
  );
  const link = join(root, '..', 'linked-datasets');
  await symlink(root, link);
  await expect(readDataset(ref, link)).rejects.toMatchObject({ code: 'dataset_corrupt' });
});
