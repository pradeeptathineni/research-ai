import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import {
  buildAnalysisRun,
  prepareAnalysisQuery,
  runAnalysisTarget,
} from '@pradeeptathineni/research-ai';
import {
  appendDatasetVersion,
  appendDatasetAnalysisRevision,
  createDatasetAnalysis,
  datasetStoreLimits,
  importDatasetTable,
  importDataset,
  listDatasets,
  readDatasetAnalysis,
  listDatasetAnalysisRuns,
  readDataset,
  readDatasetAnalysisRun,
  readDatasetTable,
  runDatasetAnalysis,
  type DatasetMetadata,
  type DatasetVersionRef,
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
const parserRoot = process.env.SIGNALS_CSV_PARSER_ROOT;
const engineRoot = process.env.SIGNALS_TABLE_ENGINE_ROOT;

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

it('returns stable corruption and invalid-reference errors for malformed retained input', async () => {
  const root = await temp();
  const ref = await importDataset(
    Buffer.from('region,value\nwest,10\n'),
    { name: 'Malformed metadata.csv', metadata },
    root,
  );
  await writeFile(join(root, ref.datasetId, '01.json'), '{malformed');
  await expect(listDatasets(root)).rejects.toMatchObject({ code: 'dataset_corrupt' });
  await expect(readDataset(null as unknown as DatasetVersionRef, root)).rejects.toMatchObject({
    code: 'invalid_dataset',
  });
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

it('keeps caller-supplied source bytes reopenable when the optional parser is unavailable', async () => {
  const root = await temp();
  const bytes = Buffer.from('region,value\nwest,10\n');
  const ref = await importDataset(bytes, { name: 'Unparsed.csv', metadata }, root);
  await expect(importDatasetTable(ref, undefined, root)).rejects.toMatchObject({
    code: 'csv_parser_unavailable',
  });
  const reopened = await readDataset(ref, root);
  expect(Buffer.from(reopened.bytes)).toEqual(bytes);
  expect(reopened.ref).toEqual(ref);
  await expect(readDatasetTable(ref, root)).rejects.toMatchObject({
    code: 'dataset_table_not_parsed',
  });
});

it.skipIf(!parserRoot || !engineRoot)(
  'uses immutable revision CAS after stale-lock recovery and validates cold run identity',
  async () => {
    const root = await temp();
    const configuredParserRoot = parserRoot!;
    const configuredEngineRoot = engineRoot!;
    const sourceBytes = Buffer.from('region,amount\neast,10\neast,20\nwest,7\n');
    const datasetRef = await importDataset(
      sourceBytes,
      { name: 'Synthetic analysis.csv', metadata },
      root,
    );
    const parsed = await importDatasetTable(datasetRef, configuredParserRoot, root);
    const steps = [
      {
        name: 's1' as const,
        sql: 'SELECT c0 AS region, CAST(c1 AS DOUBLE) AS amount FROM sample',
      },
    ];
    const chart = {
      mark: 'bar' as const,
      step: 's1' as const,
      x: 'q0',
      y: 'q1',
      aggregate: 'sum' as const,
      series: null,
      order: 'x' as const,
    };
    const initial = await createDatasetAnalysis(
      {
        datasetRef,
        tableSha256: parsed.table.sha256,
        tableName: 'sample',
        title: 'Synthetic table analysis',
        steps,
        chart,
      },
      root,
    );
    const analysisFolder = join(root, datasetRef.datasetId, 'analyses', initial.ref.analysisId);
    await mkdir(join(analysisFolder, '.revision-lock'));
    const revisions = await Promise.allSettled(
      Array.from({ length: 2 }, (_, index) =>
        appendDatasetAnalysisRevision(
          initial.ref,
          { tableName: 'sample', title: `Concurrent revision ${index}`, steps, chart },
          root,
        ),
      ),
    );
    expect(revisions.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(revisions.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(revisions.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'analysis_head_changed' },
    });
    const savedRef = revisions.find((result) => result.status === 'fulfilled')!.value.ref;
    const opened = await readDatasetAnalysis(savedRef, root);
    const tables = [{ name: opened.analysis.tables[0]!.name, table: opened.dataset.table }];
    const stepPreview = prepareAnalysisQuery(opened.analysis, tables, {
      kind: 'step',
      step: 's1',
      mode: 'rows',
    });
    const stepResult = await runAnalysisTarget(
      opened.analysis,
      tables,
      { kind: 'step', step: 's1' as const, mode: 'rows' },
      { engineRoot: configuredEngineRoot },
    );
    expect(stepResult.status).toBe('complete');
    if (stepResult.status !== 'complete') throw new Error('Synthetic step query did not complete.');
    const chartPreview = prepareAnalysisQuery(opened.analysis, tables, {
      kind: 'chart',
      columns: stepResult.columns,
    });
    const reviewedQueryDigests = {
      steps: [{ step: 's1', queryDigest: stepPreview.query_digest }],
      chart: chartPreview.query_digest,
    };
    await expect(
      runDatasetAnalysis(
        savedRef,
        configuredEngineRoot,
        { ...reviewedQueryDigests, steps: [{ step: 's1', queryDigest: '0'.repeat(64) }] },
        root,
      ),
    ).rejects.toMatchObject({ code: 'analysis_review_changed' });
    await expect(
      runDatasetAnalysis(
        savedRef,
        configuredEngineRoot,
        { ...reviewedQueryDigests, chart: '0'.repeat(64) },
        root,
      ),
    ).rejects.toMatchObject({ code: 'analysis_review_changed' });
    expect(await listDatasetAnalysisRuns(savedRef, root)).toEqual([]);
    const savedRun = await runDatasetAnalysis(
      savedRef,
      configuredEngineRoot,
      reviewedQueryDigests,
      root,
    );
    expect(savedRun.run.state).toBe('complete');
    const runFolder = join(analysisFolder, 'runs');
    await writeFile(join(runFolder, '.pending-5c02ac79-970e-4db4-b23e-dba784426f68'), '{partial');
    expect(await listDatasetAnalysisRuns(savedRef, root)).toEqual([savedRun.runRef]);
    await expect(
      readDatasetAnalysisRun({ ...savedRun.runRef, runDigest: '0'.repeat(64) }, root),
    ).rejects.toMatchObject({ code: 'analysis_head_changed' });
    const savedRunPath = join(runFolder, `${savedRun.run.id}.json`);
    const runRecord = JSON.parse(await readFile(savedRunPath, 'utf8')) as {
      run: typeof savedRun.run;
      runRef: typeof savedRun.runRef;
    };
    runRecord.run = buildAnalysisRun(
      opened.analysis,
      savedRun.run.entries.map((entry) => ({ target: entry.target, result: entry.artifact! })),
      { id: '00000000-0000-4000-8000-000000000001' },
    );
    await writeFile(savedRunPath, JSON.stringify(runRecord));
    await expect(readDatasetAnalysisRun(savedRun.runRef, root)).rejects.toMatchObject({
      code: 'analysis_head_changed',
    });
    await writeFile(join(runFolder, '00000000-0000-4000-8000-000000000000.json'), '{malformed');
    await expect(listDatasetAnalysisRuns(savedRef, root)).rejects.toMatchObject({
      code: 'analysis_corrupt',
    });
  },
);
