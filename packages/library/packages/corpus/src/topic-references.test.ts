import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  configureKnowledge,
  createTopic,
  exportTopicReferences,
  listTopicReferences,
  listTopics,
  setTopicReference,
  updateTopic,
} from './knowledge.js';

let root: string;
let exportPath: string;
const asOf = '2026-10-23T01:00:00.000Z';
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((name) => `${JSON.stringify(name)}:${canonical(object[name])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function record(content = '{"choice":"keep exact provenance"}') {
  const digest = sha(content);
  return {
    ref: {
      owner: 'planning-ai',
      kind: 'decision',
      id: 'synthetic-decision',
      revision: `sha256:${digest}`,
      digest,
    },
    title: 'Synthetic decision',
    summary: 'Synthetic fixture only',
    updated_at: asOf,
    qualification: 'user_authored_assertion',
    content,
  };
}
const selection = (row = record()) => ({
  ref: row.ref,
  instance_id: 'synthetic-planning',
  owner_epoch: null,
});
async function writeExport(row = record()) {
  await writeFile(
    exportPath,
    JSON.stringify({
      schema_version: '1.0',
      owner: 'planning-ai',
      instance_id: 'synthetic-planning',
      exported_at: asOf,
      records: [row],
    }),
  );
}
function metadata(year = 2021) {
  return {
    year,
    authors: [{ given: 'Ada', family: 'Lovelace' }],
    title: 'A sample article',
    type: 'article' as const,
    container_title: 'Transactions of Synthetic Computing',
    doi: '10.1234/example.1',
    url: 'https://example.org/synthetic-article',
  };
}
async function runCli(args: string[]) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', join(process.cwd(), 'scripts/knowledge.ts'), '--root', root, ...args],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', resolveExit);
  });
  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  };
}
async function makeTopic() {
  const row = record();
  await writeExport(row);
  await configureKnowledge(root, {
    owners: [{ owner: 'planning-ai', path: exportPath, instance_id: 'synthetic-planning' }],
  });
  const topic = await createTopic(root, { name: 'Reference metadata journey' });
  const saved = await updateTopic(root, topic.id, {
    revision: topic.revision,
    name: topic.name,
    selections: [selection(row)],
    links: [],
    questions: [],
  });
  return { topic: saved, selection: selection(row) };
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'signals-topic-references-')));
  exportPath = join(root, 'planning-export.json');
});
afterEach(async () => rm(root, { recursive: true, force: true }));

it('retains exact metadata versions, CAS, detached history and explicit fresh-process exports', async () => {
  const { topic, selection: selected } = await makeTopic();
  const first = await setTopicReference(root, topic.id, {
    revision: topic.revision,
    selection: selected,
    metadata: metadata(),
  });
  expect(first).toMatchObject({ topic: { revision: 3 }, changed: true });
  expect(first.reference.metadata_revision).toBe(1);
  expect(first.reference.qualification).toBe('User-supplied bibliographic metadata; unverified.');
  expect(first.reference.id).toBe(`ref-${sha(canonical(selected))}`);
  expect(first.reference.metadata_sha256).toBe(sha(canonical(metadata())));

  const reordered = {
    type: 'article' as const,
    title: 'A sample article',
    authors: [{ family: 'Lovelace', given: 'Ada' }],
    year: 2021,
    container_title: 'Transactions of Synthetic Computing',
    doi: '10.1234/example.1',
    url: 'https://example.org/synthetic-article',
  };
  const unchanged = await setTopicReference(root, topic.id, {
    revision: first.topic.revision,
    selection: selected,
    metadata: reordered,
  });
  expect(unchanged.changed).toBe(false);
  expect(unchanged.topic.revision).toBe(first.topic.revision);

  const beforeStale = await listTopics(root);
  await expect(
    setTopicReference(root, topic.id, {
      revision: topic.revision,
      selection: selected,
      metadata: metadata(2022),
    }),
  ).rejects.toMatchObject({ status: 409, code: 'knowledge_topic_changed' });
  expect(await listTopics(root)).toEqual(beforeStale);

  const second = await setTopicReference(root, topic.id, {
    revision: unchanged.topic.revision,
    selection: selected,
    metadata: metadata(2022),
  });
  expect(second).toMatchObject({ topic: { revision: 4 }, changed: true });
  expect(second.reference.metadata_revision).toBe(2);
  expect((await listTopics(root)).topics[0]!.references![0]!.metadata_versions).toEqual([
    expect.objectContaining({
      metadata_revision: 1,
      metadata_sha256: first.reference.metadata_sha256,
    }),
    expect.objectContaining({
      metadata_revision: 2,
      metadata_sha256: second.reference.metadata_sha256,
    }),
  ]);
  const listed = await listTopicReferences(root, topic.id);
  expect(listed.references).toEqual([second.reference]);
  expect(listed.availability).toMatchObject([
    { reference_id: first.reference.id, membership: 'selected', state: 'current' },
  ]);

  const invalid = [
    { ...metadata(), title: '' },
    { ...metadata(), title: 'x'.repeat(501) },
    { ...metadata(), year: 10_000 },
    { ...metadata(), doi: 'https://doi.org/not-a-doi' },
    { ...metadata(), url: 'javascript:alert(1)' },
    { ...metadata(), authors: [{ literal: 'Author', family: 'Also author' }] },
    { ...metadata(), unsupported: 'not allowed' },
  ];
  const beforeInvalid = await listTopics(root);
  for (const metadataInput of invalid)
    await expect(
      setTopicReference(root, topic.id, {
        revision: second.topic.revision,
        selection: selected,
        metadata: metadataInput,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_reference_metadata' });
  expect(await listTopics(root)).toEqual(beforeInvalid);

  await writeExport(record('{"choice":"new owner digest"}'));
  await expect(
    setTopicReference(root, topic.id, {
      revision: second.topic.revision,
      selection: selected,
      metadata: metadata(2023),
    }),
  ).rejects.toMatchObject({ status: 409, code: 'knowledge_record_changed' });
  expect(await listTopics(root)).toEqual(beforeInvalid);

  await expect(
    exportTopicReferences(root, topic.id, {
      revision: second.topic.revision,
      reference_ids: [first.reference.id, first.reference.id],
    }),
  ).rejects.toMatchObject({ status: 400, code: 'invalid_reference_selection' });
  await expect(
    exportTopicReferences(root, topic.id, {
      revision: second.topic.revision - 1,
      reference_ids: [first.reference.id],
    }),
  ).rejects.toMatchObject({ status: 409, code: 'knowledge_topic_changed' });

  const successor = record('{"choice":"new current digest"}');
  await writeExport(successor);
  const replaced = await updateTopic(root, topic.id, {
    revision: second.topic.revision,
    name: topic.name,
    selections: [selection(successor)],
    links: [],
    questions: [],
  });
  expect(replaced.revision).toBe(5);
  let detached = await listTopicReferences(root, topic.id);
  expect(detached.references[0]!.metadata_revision).toBe(2);
  expect(detached.availability).toMatchObject([
    { reference_id: first.reference.id, membership: 'detached', state: 'detached' },
  ]);
  expect(detached.references[0]!.selection).toEqual(selected);
  expect(first.reference.id).not.toBe(`ref-${sha(canonical(selection(successor)))}`);

  const removed = await updateTopic(root, topic.id, {
    revision: replaced.revision,
    name: topic.name,
    selections: [],
    links: [],
    questions: [],
  });
  expect(removed.revision).toBe(6);
  detached = await listTopicReferences(root, topic.id);
  expect(detached.references[0]!.selection).toEqual(selected);
  const exported = await exportTopicReferences(root, topic.id, {
    revision: removed.revision,
    reference_ids: [first.reference.id],
  });
  expect(exported).toEqual({
    schema: 'signals.reference-list.v1',
    topic: { id: topic.id, revision: 6 },
    references: [second.reference],
  });

  const reopened = await runCli(['references', topic.id]);
  expect(reopened.exitCode).toBe(0);
  expect(reopened.stderr).toBe('');
  expect(JSON.parse(reopened.stdout)).toEqual(detached);
  const exportedCli = await runCli([
    'references-export',
    topic.id,
    JSON.stringify({ revision: removed.revision, reference_ids: [first.reference.id] }),
  ]);
  expect(exportedCli.exitCode).toBe(0);
  expect(JSON.parse(exportedCli.stdout)).toEqual(exported);
  expect(exportedCli.stdout).not.toContain('keep exact provenance');
});

it('refuses a 33rd metadata version without truncating retained history', async () => {
  const { topic, selection: selected } = await makeTopic();
  let result = await setTopicReference(root, topic.id, {
    revision: topic.revision,
    selection: selected,
    metadata: metadata(2000),
  });
  for (let version = 2; version <= 32; version++)
    result = await setTopicReference(root, topic.id, {
      revision: result.topic.revision,
      selection: selected,
      metadata: metadata(2000 + version),
    });
  expect(result.reference.metadata_revision).toBe(32);
  const saved = (await listTopics(root)).topics[0]!;
  await expect(
    setTopicReference(root, topic.id, {
      revision: result.topic.revision,
      selection: selected,
      metadata: metadata(2100),
    }),
  ).rejects.toMatchObject({ status: 409, code: 'knowledge_reference_history_full' });
  expect((await listTopics(root)).topics[0]).toEqual(saved);
});
