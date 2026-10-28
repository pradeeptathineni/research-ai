import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  configureKnowledge,
  createTopic,
  listTopics,
  openTopic,
  topicEvidenceGraph,
  updateTopic,
} from './knowledge.js';
import { requestStore } from './search-request-store.js';
import { searchApi } from './search-api.js';

let root: string;
let exportPath: string;
const asOf = '2026-10-23T01:00:00.000Z';
const content = (choice: string) => JSON.stringify({ choice });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function record(id: string, value: string) {
  const bytes = content(value);
  const digest = hash(bytes);
  return {
    ref: { owner: 'planning-ai', kind: 'decision', id, revision: `sha256:${digest}`, digest },
    title: id.toUpperCase(),
    summary: 'Synthetic owner metadata',
    updated_at: asOf,
    qualification: 'user_authored_assertion',
    content: bytes,
  };
}
async function writeExport(rows: ReturnType<typeof record>[]) {
  await writeFile(
    exportPath,
    JSON.stringify({
      schema_version: '1.0',
      owner: 'planning-ai',
      instance_id: 'graph-fixture',
      exported_at: asOf,
      records: rows,
    }),
  );
}
const select = (row: ReturnType<typeof record>) => ({
  ref: row.ref,
  instance_id: 'graph-fixture',
  owner_epoch: null,
});
const memberKey = (selected: ReturnType<typeof select>) =>
  JSON.stringify([
    selected.ref.owner,
    selected.instance_id,
    selected.ref.kind,
    selected.ref.id,
    selected.ref.revision,
    selected.ref.digest,
  ]);
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'signals-topic-graph-')));
  exportPath = join(root, 'planning-export.json');
});
afterEach(async () => rm(root, { recursive: true, force: true }));

it('shows owner-derived changed and unavailable impacts with finite caller-asserted paths', async () => {
  const rows = [
    record('a', 'choice-a'),
    record('b', 'choice-b'),
    record('c', 'choice-c'),
    record('d', 'choice-d'),
  ];
  await writeExport(rows);
  await configureKnowledge(root, {
    owners: [{ owner: 'planning-ai', path: exportPath, instance_id: 'graph-fixture' }],
  });
  const topic = await createTopic(root, { name: 'Synthetic impact journey' });
  const selected = rows.map(select);
  await updateTopic(root, topic.id, {
    revision: topic.revision,
    name: topic.name,
    selections: selected,
    links: [
      {
        from: memberKey(selected[0]!),
        to: memberKey(selected[1]!),
        label: 'A needs B',
        relation: 'depends_on',
      },
      {
        from: memberKey(selected[1]!),
        to: memberKey(selected[2]!),
        label: 'B needs C',
        relation: 'depends_on',
      },
      {
        from: memberKey(selected[3]!),
        to: memberKey(selected[2]!),
        label: 'nearby only',
        relation: 'related',
      },
      {
        from: memberKey(selected[2]!),
        to: memberKey(selected[0]!),
        label: 'cycle stops',
        relation: 'depends_on',
      },
      {
        from: memberKey(selected[0]!),
        to: memberKey(selected[2]!),
        label: 'claimed support',
        relation: 'supports',
      },
      { from: memberKey(selected[3]!), to: memberKey(selected[0]!), label: 'legacy relation' },
    ],
    questions: [],
  });
  await writeExport([
    record('a', 'choice-a'),
    record('b', 'choice-b'),
    record('c', 'choice-c changed'),
    record('d', 'choice-d'),
  ]);
  let graph = await topicEvidenceGraph(root, topic.id);
  const cKey = memberKey(selected[2]!);
  const aKey = memberKey(selected[0]!);
  const bKey = memberKey(selected[1]!);
  const trigger = graph.impacts.find((impact) => impact.trigger === cKey)!;
  expect(trigger.state).toBe('needs_review');
  expect(trigger.paths).toContainEqual({ dependent: bKey, path: [cKey, bKey] });
  expect(trigger.paths).toContainEqual({ dependent: aKey, path: [cKey, bKey, aKey] });
  expect(graph.nodes.find((node) => node.key === cKey)?.state).toBe('changed');
  expect(graph.edges.find((edge) => edge.label === 'legacy relation')?.relation).toBe('related');
  expect(trigger.paths.some(({ dependent }) => dependent === memberKey(selected[3]!))).toBe(false);
  expect(graph.edges.find((edge) => edge.label === 'claimed support')?.basis).toBe('user_asserted');

  await writeExport([rows[0]!, rows[2]!, rows[3]!]);
  graph = await topicEvidenceGraph(root, topic.id);
  const missingKey = memberKey(selected[1]!);
  expect(graph.nodes.find((node) => node.key === missingKey)?.state).toBe('missing');
  expect(graph.impacts.find((impact) => impact.trigger === missingKey)?.paths).toContainEqual({
    dependent: aKey,
    path: [missingKey, aKey],
  });

  await rm(exportPath);
  graph = await topicEvidenceGraph(root, topic.id);
  expect(graph.nodes.every((node) => node.state === 'unavailable')).toBe(true);
  expect(graph.impacts.every((impact) => impact.state === 'indeterminate')).toBe(true);
  expect(graph.nodes.map((node) => node.selection)).toEqual(selected);
  expect((await openTopic(root, topic.id)).topic.revision).toBe(2);
});

it('serves the graph through the existing guarded read route and rejects query additions', async () => {
  const scope = await requestStore(root).initialize();
  const row = record('a', 'choice-a');
  await writeExport([row]);
  await configureKnowledge(root, {
    owners: [{ owner: 'planning-ai', path: exportPath, instance_id: 'graph-fixture' }],
  });
  const topic = await createTopic(root, { name: 'HTTP graph' });
  await updateTopic(root, topic.id, {
    revision: 1,
    name: topic.name,
    selections: [select(row)],
    links: [],
    questions: [],
  });
  const api = searchApi(root, async () => {
    throw new Error('Graph reads do not invoke research.');
  });
  const server = createServer((request, response) => void api(request, response));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  const base = `http://127.0.0.1:${address.port}/signals-ai/__signals/api/`;
  const headers = {
    'x-signals-instance-id': scope.identity,
    'x-signals-owner-epoch': scope.epoch,
  };
  try {
    expect((await fetch(base + `topics/${topic.id}/graph`)).status).toBe(428);
    const response = await fetch(base + `topics/${topic.id}/graph`, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      schema_version: '1.0',
      topic: { id: topic.id, revision: 2 },
      nodes: [{ state: 'current' }],
      edges: [],
      impacts: [],
    });
    expect((await fetch(base + `topics/${topic.id}/graph?x=1`, { headers })).status).toBe(400);
    expect((await fetch(base + `topics/${topic.id}/graph?x=1&x=2`, { headers })).status).toBe(400);
    expect(
      (
        await fetch(base + `topics/${topic.id}/graph`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

// Two fresh CLI processes have separate deadlines; output assertions stay exact
it('drains complete large JSON and Markdown CLI output through stdout pipes', async () => {
  const rows = Array.from({ length: 100 }, (_, index) => record(`row-${index}`, `choice-${index}`));
  await writeExport(rows);
  await configureKnowledge(root, {
    owners: [{ owner: 'planning-ai', path: exportPath, instance_id: 'graph-fixture' }],
  });
  const topic = await createTopic(root, { name: 'Large graph pipe' });
  const selections = rows.map(select);
  const pair = (index: number) => ({
    from: memberKey(selections[index]!),
    to: memberKey(selections[99]!),
    label: `Dependency ${index}: ${'x'.repeat(480)}`,
    relation: 'depends_on' as const,
  });
  await updateTopic(root, topic.id, {
    revision: topic.revision,
    name: topic.name,
    selections,
    links: [
      ...Array.from({ length: 99 }, (_, index) => pair(index)),
      ...Array.from({ length: 99 }, (_, index) => pair(index)),
      {
        from: memberKey(selections[0]!),
        to: memberKey(selections[1]!),
        label: `Related: ${'y'.repeat(490)}`,
      },
      {
        from: memberKey(selections[1]!),
        to: memberKey(selections[0]!),
        label: `Supports: ${'z'.repeat(490)}`,
        relation: 'supports',
      },
    ],
    questions: [],
  });
  await writeExport(rows.map((row, index) => (index === 99 ? record('row-99', 'changed') : row)));
  const expected = await topicEvidenceGraph(root, topic.id);
  expect(Buffer.byteLength(JSON.stringify(expected))).toBeLessThanOrEqual(4 * 1024 * 1024);
  const cli = join(process.cwd(), 'scripts/knowledge.ts');

  async function run(format: 'json' | 'markdown') {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', cli, '--root', root, 'graph', topic.id, '--format', format],
      {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 8_000,
        killSignal: 'SIGKILL',
      },
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

  const json = await run('json');
  expect(json.exitCode).toBe(0);
  expect(json.stderr).toBe('');
  expect(json.stdout.length).toBeGreaterThan(65_536);
  expect(json.stdout.endsWith('\n')).toBe(true);
  expect(JSON.parse(json.stdout)).toEqual(expected);

  const markdown = await run('markdown');
  expect(markdown.exitCode).toBe(0);
  expect(markdown.stderr).toBe('');
  expect(markdown.stdout.length).toBeGreaterThan(65_536);
  expect(markdown.stdout.startsWith(`# Evidence impact map: ${topic.id}\n`)).toBe(true);
  expect(markdown.stdout).toContain('Dependency 98:');
  expect(
    markdown.stdout.endsWith(
      '- No source validity, truth, causality, successor, or automatic topic update is inferred.\n\n',
    ),
  ).toBe(true);
}, 20_000);

it('refuses an oversized changing dependency chain without changing the topic', async () => {
  const rows = Array.from({ length: 100 }, (_, index) =>
    record(`record-${String(index).padStart(3, '0')}-${'x'.repeat(160)}`, `choice-${index}`),
  );
  await writeExport(rows);
  await configureKnowledge(root, {
    owners: [{ owner: 'planning-ai', path: exportPath, instance_id: 'graph-fixture' }],
  });
  const topic = await createTopic(root, { name: 'Oversized chain' });
  const selections = rows.map(select);
  await updateTopic(root, topic.id, {
    revision: topic.revision,
    name: topic.name,
    selections,
    links: Array.from({ length: 99 }, (_, index) => ({
      from: memberKey(selections[index]!),
      to: memberKey(selections[index + 1]!),
      label: `Decision ${index} depends on the next exact record`,
      relation: 'depends_on',
    })),
    questions: [],
  });
  const saved = (await listTopics(root)).topics[0]!;
  await writeExport(rows.map((row, index) => record(row.ref.id, `changed-${index}`)));

  await expect(topicEvidenceGraph(root, topic.id)).rejects.toMatchObject({
    status: 409,
    code: 'knowledge_graph_too_large',
    reason: expect.stringContaining('Select a smaller topic'),
  });
  expect((await listTopics(root)).topics[0]).toEqual(saved);
});
