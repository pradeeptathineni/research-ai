import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  configureKnowledge,
  createTopic,
  exportTopic,
  knowledgeOwners,
  listTopics,
  openTopic,
  readKnowledge,
  searchKnowledge,
  updateTopic,
} from './knowledge.js';
import { saveLibraryLead } from './library-leads.js';
import { requestStore } from './search-request-store.js';
import { searchApi } from './search-api.js';
import type * as SearchRunnerModule from './search-runner.js';

vi.mock('./search-runner.js', async (original) => ({
  ...(await original<typeof SearchRunnerModule>()),
  codexRunner: () => ({
    readiness: async () => ({ available: false, reason: 'offline synthetic test' }),
  }),
}));
let root: string;
let exportPath: string;
const time = '2026-10-23T01:00:00.000Z';
const hash = (content: string) => createHash('sha256').update(content).digest('hex');
function record(
  owner = 'planning-ai',
  kind = 'decision',
  content = JSON.stringify({
    choice: 'retain Aurora provenance',
    privateBody: 'never centralise body',
  }),
) {
  const digest = hash(content);
  return {
    ref: { owner, kind, id: 'synthetic-1', revision: `sha256:${digest}`, digest },
    title: 'Aurora retention',
    summary: 'Selected record metadata',
    updated_at: time,
    qualification: 'user_authored_assertion',
    content,
  };
}
async function exported(records = [record()], instance = 'synthetic-planning') {
  await writeFile(
    exportPath,
    JSON.stringify({
      schema_version: '1.0',
      owner: 'planning-ai',
      instance_id: instance,
      exported_at: time,
      records,
    }),
  );
}
const selection = (row = record()) => ({
  ref: row.ref,
  instance_id: 'synthetic-planning',
  owner_epoch: null,
});
const memberKey = (selected = selection()) =>
  JSON.stringify([
    selected.ref.owner,
    selected.instance_id,
    selected.ref.kind,
    selected.ref.id,
    selected.ref.revision,
    selected.ref.digest,
  ]);
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'signals-knowledge-')));
  exportPath = join(root, 'explicit-owner-export.json');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it('searches exact native and configured owner metadata with visible coverage and no byte corpus', async () => {
  await requestStore(root).initialize();
  await saveLibraryLead(
    root,
    {
      uri: 'https://example.org/aurora',
      name: 'Aurora native research',
      description: 'Retained lead',
      limits: ['Unassessed'],
    },
    randomUUID(),
    'Aurora',
  );
  await exported();
  await configureKnowledge(root, {
    owners: [{ owner: 'planning-ai', path: exportPath, instance_id: 'synthetic-planning' }],
  });
  const result = await searchKnowledge(root, 'Auror');
  expect(result.records.map((row) => row.selection.ref.owner)).toEqual([
    'signals-ai',
    'planning-ai',
  ]);
  expect(result.owner_coverage.map((row) => row.state)).toEqual([
    'connected',
    'connected',
    'unconfigured',
  ]);
  expect(result.owner_coverage[1]!.export_as_of).toBe(time);
  expect(result.owner_coverage[1]!.reason).toContain('frozen');
  const foreign = result.records[1]!;
  expect((await readKnowledge(root, foreign.selection)).content).toBe(record().content);
  expect(JSON.stringify(result)).not.toContain('never centralise body');
  expect((await searchKnowledge(root, 'centralise')).records[0]!.selection.ref.owner).toBe(
    'planning-ai',
  );
  expect(JSON.stringify(await knowledgeOwners(root))).not.toContain(exportPath);
  await rm(exportPath);
  const partial = await searchKnowledge(root, 'Aurora');
  expect(partial.records).toHaveLength(1);
  expect(partial.owner_coverage[1]!.state).toBe('unavailable');
});

it('persists selected identities, links and questions, reopens after restart and never substitutes changed material', async () => {
  await exported();
  await configureKnowledge(root, {
    owners: [{ owner: 'planning-ai', path: exportPath, instance_id: 'synthetic-planning' }],
  });
  const topic = await createTopic(root, { name: 'Aurora choices' });
  const selected = selection();
  const saved = await updateTopic(root, topic.id, {
    revision: 1,
    name: topic.name,
    selections: [selected],
    links: [{ from: memberKey(), to: memberKey(), label: 'revisit before renewal' }],
    questions: ['Did this help?'],
  });
  expect(saved.revision).toBe(2);
  expect((await openTopic(root, topic.id)).statuses[0]!.state).toBe('current');
  expect((await openTopic(root, topic.id)).statuses[0]!.reason).toContain('frozen');
  expect((await listTopics(root)).topics[0]!.questions).toEqual(['Did this help?']);
  const privateBytes = await readFile(join(root, '.signals/topics.json'), 'utf8');
  expect(privateBytes).not.toContain('never centralise body');
  expect((await stat(join(root, '.signals/topics.json'))).mode & 0o777).toBe(0o600);
  await exported([record('planning-ai', 'decision', '{"choice":"changed"}')]);
  const changed = await openTopic(root, topic.id);
  expect(changed.statuses[0]!.state).toBe('changed');
  expect(changed.topic.members[0]!.selection).toEqual(selected);
  await expect(readKnowledge(root, selected)).rejects.toMatchObject({ status: 409 });
  const revised = await updateTopic(root, topic.id, {
    revision: 2,
    name: topic.name,
    selections: [selected],
    links: [],
    questions: ['Keep the frozen choice?'],
  });
  expect(revised.members[0]!.selection).toEqual(selected);
  await exported([]);
  expect((await openTopic(root, topic.id)).statuses[0]!.state).toBe('missing');
  await rm(exportPath);
  expect((await openTopic(root, topic.id)).statuses[0]!.state).toBe('unavailable');
  const readable = await exportTopic(root, topic.id);
  expect(readable.content).toContain(selected.ref.digest);
  expect(readable.content).toContain('Keep the frozen choice?');
  expect(readable.content).toContain('unavailable');
  expect(readable.content).not.toContain('never centralise body');
  await expect(
    updateTopic(root, topic.id, {
      revision: 1,
      name: 'stale',
      selections: [],
      links: [],
      questions: [],
    }),
  ).rejects.toMatchObject({ status: 409 });
});

it('refuses wrong stores, tampered digests, malformed JSON, duplicates, unknown kinds and symlink exports with bounded redacted failures', async () => {
  await configureKnowledge(root, {
    owners: [{ owner: 'planning-ai', path: exportPath, instance_id: 'synthetic-planning' }],
  });
  const malformed = [
    { ...record(), content: '{"changed":true}' },
    { ...record(), ref: { ...record().ref, kind: 'filesystem' } },
    record('principles-ai'),
    record('planning-ai', 'decision', 'not JSON'),
  ];
  for (const invalid of malformed) {
    await exported([invalid]);
    await expect(readKnowledge(root, selection())).rejects.toMatchObject({
      status: 503,
      reason: expect.not.stringContaining(root),
    });
  }
  await exported([record()], 'other-store');
  expect((await searchKnowledge(root)).owner_coverage[1]!.state).toBe('unavailable');
  await exported([record(), record()]);
  expect((await searchKnowledge(root)).owner_coverage[1]!.state).toBe('unavailable');
  await exported();
  const pointer = join(root, 'symlink.json');
  await symlink(exportPath, pointer);
  await configureKnowledge(root, {
    owners: [{ owner: 'planning-ai', path: pointer, instance_id: 'synthetic-planning' }],
  });
  expect((await searchKnowledge(root)).owner_coverage[1]!.state).toBe('unavailable');
  await expect(
    configureKnowledge(root, {
      owners: [{ owner: 'planning-ai', path: 'relative.json', instance_id: 'x' }],
    }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(readKnowledge(root, { ...selection(), path: exportPath })).rejects.toMatchObject({
    status: 400,
  });
});

it('preserves old state on invalid selection, dangling links and corrupt or symlink private storage', async () => {
  const topic = await createTopic(root, { name: 'Private' });
  const patch = {
    revision: 1,
    name: 'Private',
    selections: [selection()],
    links: [],
    questions: [],
  };
  await expect(updateTopic(root, topic.id, patch)).rejects.toMatchObject({ status: 503 });
  expect((await listTopics(root)).topics[0]!.revision).toBe(1);
  await expect(
    updateTopic(root, topic.id, {
      ...patch,
      selections: [],
      links: [{ from: 'absent', to: 'absent', label: 'bad' }],
    }),
  ).rejects.toMatchObject({ status: 400 });
  await writeFile(join(root, '.signals/topics.json'), '{}');
  await expect(listTopics(root)).rejects.toMatchObject({ status: 503 });
  await rm(join(root, '.signals/topics.json'));
  await writeFile(join(root, 'outside.json'), '{}');
  await symlink(join(root, 'outside.json'), join(root, '.signals/topics.json'));
  await expect(createTopic(root, { name: 'Must refuse' })).rejects.toMatchObject({ status: 503 });
  expect(await readFile(join(root, 'outside.json'), 'utf8')).toBe('{}');
});

it('refuses a symlink private directory before creating writer or topic state', async () => {
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'signals-knowledge-outside-')));
  try {
    await symlink(outside, join(root, '.signals'));
    await expect(createTopic(root, { name: 'Must not escape' })).rejects.toMatchObject({
      status: 503,
    });
    await expect(stat(join(outside, 'locks'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(outside, 'topics.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

it('serves guarded HTTP journeys, retains topics across owner restart and rejects browser configuration paths', async () => {
  const scope = await requestStore(root).initialize();
  await exported();
  await configureKnowledge(root, {
    owners: [{ owner: 'planning-ai', path: exportPath, instance_id: 'synthetic-planning' }],
  });
  const headers = { 'x-signals-instance-id': scope.identity, 'x-signals-owner-epoch': scope.epoch };
  async function launch() {
    const api = searchApi(root, async () => {
      throw new Error('No model invocation allowed');
    });
    const server = createServer((request, response) => {
      void api(request, response);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    return { server, base: `http://127.0.0.1:${address.port}/signals-ai/__signals/api/` };
  }
  const first = await launch();
  let id: string;
  try {
    expect((await fetch(first.base + 'provider/knowledge')).status).toBe(428);
    expect(
      (
        await fetch(first.base + 'provider/knowledge', {
          headers: { ...headers, origin: 'https://foreign.example' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(first.base + 'topics', {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: '{"name":"Denied"}',
        })
      ).status,
    ).toBe(403);
    const session = (await (await fetch(first.base + 'session')).json()) as { token: string };
    const auth = {
      ...headers,
      'content-type': 'application/json',
      'x-signals-token': session.token,
    };
    expect(
      (
        await fetch(first.base + 'knowledge/owners', {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ owners: [{ path: exportPath }] }),
        })
      ).status,
    ).toBe(404);
    const search = (await (
      await fetch(first.base + 'provider/knowledge?q=Aurora', { headers })
    ).json()) as Awaited<ReturnType<typeof searchKnowledge>>;
    expect(search.records).toHaveLength(1);
    const created = (await (
      await fetch(first.base + 'topics', {
        method: 'POST',
        headers: auth,
        body: '{"name":"HTTP synthetic"}',
      })
    ).json()) as Awaited<ReturnType<typeof createTopic>>;
    id = created.id;
    const saved = await fetch(first.base + `topics/${id}`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        revision: 1,
        name: created.name,
        selections: [search.records[0]!.selection],
        links: [],
        questions: ['Resume this?'],
      }),
    });
    expect(saved.status).toBe(200);
    const referenceInput = {
      revision: 2,
      selection: search.records[0]!.selection,
      metadata: { type: 'report', title: 'Synthetic retained reference', year: 2026 },
    };
    expect(
      (
        await fetch(first.base + `topics/${id}/references`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify(referenceInput),
        })
      ).status,
    ).toBe(403);
    const attached = await fetch(first.base + `topics/${id}/references`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(referenceInput),
    });
    expect(attached.status).toBe(200);
    const reference = (await attached.json()) as { reference: { id: string } };
    const listed = await fetch(first.base + `topics/${id}/references`, { headers });
    expect(listed.status).toBe(200);
    const refs = (await listed.json()) as { references: { id: string }[] };
    expect(refs.references.map((row) => row.id)).toEqual([reference.reference.id]);
    expect(
      (
        await fetch(first.base + `topics/${id}/references`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify(referenceInput),
        })
      ).status,
    ).toBe(409);
    const exportedReferences = await fetch(first.base + `topics/${id}/references/export`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ revision: 3, reference_ids: [reference.reference.id] }),
    });
    expect(exportedReferences.status).toBe(200);
    const referenceList = (await exportedReferences.json()) as {
      schema: string;
      references: { qualification: string }[];
    };
    expect(referenceList.schema).toBe('signals.reference-list.v1');
    expect(referenceList.references[0]!.qualification).toBe(
      'User-supplied bibliographic metadata; unverified.',
    );
    expect((await fetch(first.base + 'provider/knowledge?path=/tmp', { headers })).status).toBe(
      400,
    );
  } finally {
    first.server.closeAllConnections();
    await new Promise<void>((done) => first.server.close(() => done()));
  }
  const second = await launch();
  try {
    const reopened = (await (
      await fetch(second.base + `topics/${id!}`, { headers })
    ).json()) as Awaited<ReturnType<typeof openTopic>>;
    expect(reopened.topic.questions).toEqual(['Resume this?']);
    expect(reopened.statuses[0]!.state).toBe('current');
    expect((await fetch(second.base + `topics/${id!}/export`, { headers })).status).toBe(200);
    const references = (await (
      await fetch(second.base + `topics/${id!}/references`, { headers })
    ).json()) as { references: { metadata: { title: string } }[] };
    expect(references.references[0]!.metadata.title).toBe('Synthetic retained reference');
  } finally {
    second.server.closeAllConnections();
    await new Promise<void>((done) => second.server.close(() => done()));
  }
});
