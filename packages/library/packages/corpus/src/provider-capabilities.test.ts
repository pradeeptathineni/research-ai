import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { retainRun } from './search-store.js';
import { retainIncompleteNarrative } from './library.js';
import { saveLibraryLead } from './library-leads.js';
import { retainResearchAnswer } from './research-answer.js';
import { requestStore } from './search-request-store.js';
import { providerLibrary, providerRecord } from './provider-capabilities.js';
import { previewProject } from './project-preview.js';
import { attachOpportunity, registerProject } from './projects.js';
import { budgets, type SearchResult } from '../../domain/src/search-contract.js';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const stop = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGKILL');
  await closed;
};
const serverFixture = fileURLToPath(
  new URL('../../../tests/fixtures/search-request-server.ts', import.meta.url),
);
const launch = async (root: string) => {
  await mkdir(join(root, 'bin'), { recursive: true });
  await writeFile(
    join(root, 'bin/codex'),
    `#!/bin/sh\necho "$*" >> '${root}/probes'\ncase "$*" in\n--version) echo 'codex offline fixture' ;;\n'login status') echo 'Logged in fixture' ;;\n*) exit 91 ;;\nesac\n`,
    { mode: 0o700 },
  );
  const child = spawn(process.execPath, ['--import', 'tsx', serverFixture, root, 'complete'], {
    env: {
      PATH:
        join(root, 'bin') +
        ':' +
        process.execPath.slice(0, process.execPath.lastIndexOf('/')) +
        ':/usr/bin:/bin',
      HOME: root,
      TMPDIR: root,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let errors = '';
  child.stderr!.on('data', (bytes: Buffer) => {
    errors += bytes.toString();
  });
  const port = await new Promise<number>((done, reject) => {
    child.on('message', (message: { type: string; port: number }) => {
      if (message.type === 'ready') done(message.port);
    });
    child.once('exit', (code) => reject(new Error('fixture_exit_' + code + errors)));
    child.once('error', reject);
  });
  return { child, base: `http://127.0.0.1:${port}/signals-ai/__signals/api/` };
};

it('negotiates a portable owner boundary and reads exact partial answer bytes without readiness or generation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-provider-')));
  const consumer = await realpath(await mkdtemp(join(tmpdir(), 'signals-standalone-consumer-')));
  const children: ChildProcess[] = [];
  try {
    const first = await launch(root);
    children.push(first.child);
    const version = { 'x-signals-provider-version': '1.0' };
    expect((await fetch(first.base + 'provider/capabilities', { headers: version })).status).toBe(
      503,
    );
    await expect(lstat(join(root, '.signals'))).rejects.toMatchObject({ code: 'ENOENT' });
    const { token } = (await (await fetch(first.base + 'session')).json()) as { token: string };
    const auth = { 'content-type': 'application/json', 'x-signals-token': token };
    const scope = (await (
      await fetch(first.base + 'request-scope', { method: 'POST', headers: auth, body: '{}' })
    ).json()) as { identity: string; epoch: string };
    const capsResponse = await fetch(first.base + 'provider/capabilities', { headers: version });
    expect(capsResponse.status).toBe(200);
    const metadata = (await capsResponse.json()) as {
      capabilities: {
        instance_id: string;
        process_observation: boolean;
        contracts: { id: string; versions: string[] }[];
        operations: {
          name: string;
          target_kinds: string[];
          mutating: boolean;
          authority_required: boolean;
        }[];
      };
    };
    expect(metadata.capabilities.instance_id).toBe(scope.identity);
    expect(metadata.capabilities.process_observation).toBe(true);
    expect(metadata.capabilities.contracts).toContainEqual({ id: 'K13', versions: ['1.0'] });
    expect(metadata.capabilities.contracts).toContainEqual({ id: 'K14', versions: ['1.0'] });
    expect(metadata.capabilities.contracts).toContainEqual({
      id: 'smart-collections',
      versions: ['1.0'],
    });
    expect(metadata.capabilities.operations).toContainEqual({
      name: 'triage_smart_collection',
      target_kinds: ['exact_result_identity'],
      mutating: true,
      authority_required: true,
    });
    const narrative = 'Original partial answer Ω\r\nQualification remains unknown.';
    const run: SearchResult = {
      schemaVersion: 2,
      runId: randomUUID(),
      query: 'offline retained fixture',
      status: 'partial',
      brief: { format: 'markdown', text: narrative },
      answerReceipt: {
        observedAt: '2026-10-21T05:00:00Z',
        sha256: hash(narrative),
        state: 'unassessed',
        confidence: 'unknown',
        provenance: {
          receipt: 'authored offline fixture',
          requestedModel: null,
          servedModel: null,
        },
      },
      items: [],
      sources: [],
      coverage: [],
      gaps: ['Still partial; not a quality claim.'],
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
    await retainRun(run, root);
    const bytes = await readFile(join(root, '.signals/runs', run.runId + '.json'));
    const reference = {
      owner: 'signals-ai',
      kind: 'answer',
      id: run.runId,
      revision: null,
      digest: null,
    };
    const owned = {
      ...version,
      'x-signals-instance-id': scope.identity,
      'x-signals-owner-epoch': scope.epoch,
    };
    const open = (ref: unknown, extra: Record<string, string> = {}) =>
      fetch(first.base + 'provider/records?ref=' + encodeURIComponent(JSON.stringify(ref)), {
        headers: { ...owned, ...extra },
      });
    const probes = await readFile(join(root, 'probes'));
    const ledger = await readFile(join(root, '.signals/requests/ledger.json'));
    const opened = await open(reference);
    expect(opened.status).toBe(200);
    const exact = (await opened.json()) as { ref: typeof reference; content: string };
    const libraryResponse = await fetch(first.base + 'provider/library?q=offline&limit=1', {
      headers: owned,
    });
    expect(libraryResponse.status).toBe(200);
    const libraryPage = (await libraryResponse.json()) as {
      records: { ref: typeof reference; open_capability: string }[];
      owner_coverage: unknown[];
    };
    expect(libraryPage.records).toContainEqual(
      expect.objectContaining({
        ref: expect.objectContaining({ kind: 'answer', id: run.runId, digest: hash(bytes) }),
        open_capability: 'owner_route',
      }),
    );
    expect(libraryPage.owner_coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ owner: 'signals-ai', state: 'connected' }),
      ]),
    );
    const note: SearchResult = {
      ...run,
      runId: randomUUID(),
      query: 'offline note evidence',
      status: 'failed',
      answerReceipt: undefined,
      gaps: ['Fixture stopped before evidence assessment.'],
    };
    await retainIncompleteNarrative(root, note);
    const page = (query: string) =>
      fetch(first.base + 'provider/library?' + query, { headers: owned });
    const notePageResponse = await page('q=offline&kinds=research_note&limit=1');
    expect(notePageResponse.status).toBe(200);
    const notePage = (await notePageResponse.json()) as {
      records: { ref: typeof reference; domain_status: string }[];
      next_cursor: string | null;
    };
    expect(notePage.records[0]).toMatchObject({
      ref: { kind: 'research_note', id: note.runId },
      domain_status: 'incomplete:failed',
    });
    for (const q of ['"offline note"', 'offlin', 'offlne']) {
      const found = (await (
        await page('q=' + encodeURIComponent(q) + '&kinds=research_note')
      ).json()) as { records: { ref: typeof reference }[] };
      expect(
        found.records.map((row) => row.ref.id),
        q,
      ).toContain(note.runId);
    }
    expect((await open(notePage.records[0]!.ref)).status).toBe(200);
    const firstPage = (await (await page('q=offline&limit=1')).json()) as {
      records: unknown[];
      next_cursor: string | null;
    };
    expect(firstPage.records).toHaveLength(1);
    expect(firstPage.next_cursor).toEqual(expect.any(String));
    expect(
      (
        (await (
          await page('q=offline&limit=1&cursor=' + encodeURIComponent(firstPage.next_cursor!))
        ).json()) as { records: unknown[] }
      ).records,
    ).toHaveLength(1);
    expect((await page('q=offline&kinds=unsupported')).status).toBe(400);
    expect((await page('q=offline&project_ref=unsupported')).status).toBe(400);
    expect((await page('q=offline&cursor=invalid')).status).toBe(409);
    const publicEntityName = (await readdir('signals/entities')).find((name) =>
      name.endsWith('.json'),
    )!;
    const entityOriginal = await readFile(join('signals/entities', publicEntityName));
    await mkdir(join(root, 'signals/entities'), { recursive: true });
    await mkdir(join(root, '.signals/corpus/entities'), { recursive: true });
    await writeFile(join(root, 'signals/entities', publicEntityName), entityOriginal);
    await writeFile(join(root, '.signals/corpus/entities', publicEntityName), entityOriginal);
    const entities = (await (await page('kinds=entity')).json()) as {
      records: { ref: typeof reference; visibility: string }[];
    };
    expect(entities.records).toHaveLength(2);
    expect(entities.records.map((row) => row.ref.id).sort()).toEqual([
      `private:${publicEntityName.slice(0, -5)}`,
      `public:${publicEntityName.slice(0, -5)}`,
    ]);
    for (const entity of entities.records) {
      const original = await open(entity.ref);
      expect(original.status).toBe(200);
      expect(((await original.json()) as { content: string }).content).toBe(
        entityOriginal.toString(),
      );
    }
    const selected = join(root, 'selected');
    await mkdir(selected);
    await writeFile(
      join(selected, 'README.md'),
      '# Offline owner project\n\nInspect the selected entity.\n',
    );
    const project = (await previewProject({ kind: 'local', path: selected }, '/example')).project;
    await registerProject(root, project);
    await attachOpportunity(root, {
      projectId: project.id,
      findingKey: `native:public:${publicEntityName.slice(0, -5)}`,
      need: 'Inspect evidence',
      reason: 'Explicit offline fixture association',
      nextAction: 'explore',
    });
    const projectRef = {
      owner: 'signals-ai',
      kind: 'project',
      id: project.id,
      revision: null,
      digest: null,
    };
    const linked = (await (
      await page('kinds=entity&project_ref=' + encodeURIComponent(JSON.stringify(projectRef)))
    ).json()) as { records: { ref: typeof reference; project_refs: (typeof reference)[] }[] };
    expect(linked.records).toHaveLength(1);
    expect(linked.records[0]?.ref.id).toBe(`public:${publicEntityName.slice(0, -5)}`);
    expect(linked.records[0]?.project_refs[0]).toMatchObject({
      id: project.id,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect((await open(linked.records[0]!.project_refs[0]!)).status).toBe(200);
    expect(
      (
        await page(
          'kinds=entity&project_ref=' +
            encodeURIComponent(JSON.stringify({ ...projectRef, digest: 'f'.repeat(64) })),
        )
      ).status,
    ).toBe(409);
    const savedLead = await saveLibraryLead(
      root,
      {
        uri: 'https://example.org/s04-lead',
        name: 'S04 candidate lead',
        description: 'Source not assessed',
        limits: ['Requires independent primary check.'],
      },
      run.runId,
      run.query,
    );
    const leadPage = (await (await page('q=candidate&kinds=lead')).json()) as {
      records: { ref: typeof reference }[];
    };
    expect(leadPage.records).toHaveLength(1);
    expect(leadPage.records[0]?.ref.id).toBe(savedLead.id);
    expect((await open(leadPage.records[0]!.ref)).status).toBe(200);
    const imported = await retainResearchAnswer(
      root,
      {
        query: 'older imported constellation',
        answer: 'Original older Ω synthesis; no new generation.',
        observedAt: '2026-10-19T10:00:00Z',
        provenance: {
          receipt: 'authored offline import fixture',
          requestedModel: null,
          servedModel: null,
        },
      },
      [],
    );
    const importedBytes = await readFile(imported.answerPath);
    const importedPage = (await (await page('q=constellation&kinds=imported_answer')).json()) as {
      records: { ref: typeof reference }[];
    };
    expect(importedPage.records).toHaveLength(1);
    expect(importedPage.records[0]?.ref.id).toBe(imported.runId);
    expect(
      ((await (await open(importedPage.records[0]!.ref)).json()) as { content: string }).content,
    ).toBe(importedBytes.toString());
    expect(await readFile(imported.answerPath)).toEqual(importedBytes);
    expect(exact.content).toBe(bytes.toString());
    expect(exact.ref.digest).toBe(hash(bytes));
    expect(exact.ref.revision).toBe('sha256:' + hash(bytes));
    expect((await open({ ...reference, kind: 'research_run' })).status).toBe(200);
    expect((await open({ ...reference, kind: 'signal' })).status).toBe(400);
    expect((await open(reference, { 'x-signals-owner-epoch': randomUUID() })).status).toBe(409);
    expect(
      (
        await fetch(
          first.base + 'provider/records?ref=' + encodeURIComponent(JSON.stringify(reference)),
          { headers: version },
        )
      ).status,
    ).toBe(428);
    expect(
      (
        await fetch(
          first.base +
            'provider/records?ref=' +
            encodeURIComponent(JSON.stringify(reference)) +
            '&command=open',
          { headers: owned },
        )
      ).status,
    ).toBe(400);
    expect(JSON.parse(exact.content) as SearchResult).toMatchObject({
      status: 'partial',
      brief: { text: narrative },
    });
    expect((await open({ ...exact.ref, digest: 'f'.repeat(64) })).status).toBe(409);
    expect((await open(reference, { 'x-signals-instance-id': randomUUID() })).status).toBe(409);
    expect((await open({ ...reference, owner: 'another-owner' })).status).toBe(409);
    expect((await open(reference, { 'x-signals-provider-version': '2.0' })).status).toBe(426);
    expect((await open({ ...reference, id: '../../unowned', command: 'open path' })).status).toBe(
      400,
    );
    expect((await open({ ...reference, id: randomUUID() })).status).toBe(404);
    const escapedId = randomUUID();
    await symlink(join(root, 'probes'), join(root, '.signals/runs', escapedId + '.json'));
    expect((await open({ ...reference, id: escapedId })).status).toBe(503);
    await rm(join(root, '.signals/runs', escapedId + '.json'));
    const forbidden = await fetch(first.base + 'search', {
      method: 'POST',
      headers: { ...auth, origin: 'https://untrusted.example' },
      body: '{malformed',
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ code: 'untrusted_origin' });
    const request = {
      schema_version: '1.0',
      request_id: 'negotiation-test',
      idempotency_key: 'must-not-dispatch',
      query: 'Negotiation must precede action',
      method: 'answer-first',
      profile: 'quick',
      cache: 'memory',
      save: 'never',
      project_ref: null,
      authority_ref: {
        owner: 'signals-ai',
        kind: 'authority',
        id: 'local-fixture',
        revision: '1',
        digest: null,
      },
    };
    const incompatible = await fetch(first.base + 'search', {
      method: 'POST',
      headers: { ...auth, ...owned, 'x-signals-provider-version': '2.0' },
      body: JSON.stringify(request),
    });
    expect(incompatible.status).toBe(426);
    const wrongOwner = await fetch(first.base + 'search', {
      method: 'POST',
      headers: { ...auth, ...owned, 'x-signals-instance-id': randomUUID() },
      body: JSON.stringify(request),
    });
    expect(wrongOwner.status).toBe(409);
    await copyFile(
      fileURLToPath(new URL('../../../scripts/examples/provider-consumer.mjs', import.meta.url)),
      join(consumer, 'consumer.mjs'),
    );
    const consume = async (base: string) => {
      const child = spawn(
        process.execPath,
        ['consumer.mjs', base, scope.identity, scope.epoch, JSON.stringify(exact.ref)],
        {
          cwd: consumer,
          env: {
            PATH: process.execPath.slice(0, process.execPath.lastIndexOf('/')) + ':/usr/bin:/bin',
            HOME: consumer,
            TMPDIR: consumer,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      const [exit] = await once(child, 'close');
      return { exit, stdout, stderr };
    };
    const standalone = await consume(first.base);
    expect(standalone.exit).toBe(0);
    expect((JSON.parse(standalone.stdout) as { content: string }).content).toBe(bytes.toString());
    await copyFile(
      fileURLToPath(new URL('../../../scripts/examples/library-consumer.mjs', import.meta.url)),
      join(consumer, 'library-consumer.mjs'),
    );
    const consumeLibrary = async (base: string) => {
      const child = spawn(
        process.execPath,
        ['library-consumer.mjs', base, scope.identity, scope.epoch, 'offline'],
        {
          cwd: consumer,
          env: {
            PATH: process.execPath.slice(0, process.execPath.lastIndexOf('/')) + ':/usr/bin:/bin',
            HOME: consumer,
            TMPDIR: consumer,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      const [exit] = await once(child, 'close');
      return { exit, stdout, stderr };
    };
    const libraryBefore = await consumeLibrary(first.base);
    expect(libraryBefore.exit, libraryBefore.stderr).toBe(0);
    expect((JSON.parse(libraryBefore.stdout) as { records: unknown[] }).records).toHaveLength(2);
    await stop(first.child);
    const restarted = await launch(root);
    children.push(restarted.child);
    const reopened = await consume(restarted.base);
    expect(reopened.exit).toBe(0);
    expect(reopened.stdout).toBe(standalone.stdout);
    const libraryAfter = await consumeLibrary(restarted.base);
    expect(libraryAfter.exit, libraryAfter.stderr).toBe(0);
    expect((JSON.parse(libraryAfter.stdout) as { records: unknown[] }).records).toHaveLength(2);
    expect(await readFile(join(root, 'probes'))).toEqual(probes);
    expect(await readFile(join(root, '.signals/requests/ledger.json'))).toEqual(ledger);
    expect(await readFile(join(root, '.signals/runs', run.runId + '.json'))).toEqual(bytes);
    const callbackRows = (await readFile(join(root, 'callbacks.jsonl'), 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean);
    expect(callbackRows).toHaveLength(0);
    await stop(restarted.child);
    const unavailable = await consume(restarted.base);
    expect(unavailable.exit).toBe(1);
    expect(unavailable.stderr).toContain('provider unavailable');
    if (process.env.S03_PROVIDER_EVIDENCE) {
      await writeFile(
        process.env.S03_PROVIDER_EVIDENCE,
        JSON.stringify(
          {
            scope,
            metadata,
            ref: exact.ref,
            content: exact.content,
            original_sha256: hash(bytes),
            standalone,
            restarted: reopened,
            unavailable,
            first_pid: first.child.pid,
            restarted_pid: restarted.child.pid,
            callback_rows: callbackRows,
            readiness_before: probes.toString(),
            readiness_after: (await readFile(join(root, 'probes'))).toString(),
            ledger_unchanged: (await readFile(join(root, '.signals/requests/ledger.json'))).equals(
              ledger,
            ),
          },
          null,
          2,
        ) + '\n',
      );
    }
  } finally {
    await Promise.all(children.map((child) => stop(child)));
    await rm(root, { recursive: true, force: true });
    await rm(consumer, { recursive: true, force: true });
  }
}, 30000);

it('keeps retained answer and run reads terminal while valid siblings remain searchable', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-provider-status-')));
  try {
    const scope = await requestStore(root).initialize();
    const narrative = 'Authored status qualification Ω';
    const original: SearchResult = {
      schemaVersion: 2,
      runId: randomUUID(),
      query: 'status qualification original',
      status: 'completed',
      brief: { format: 'markdown', text: narrative },
      answerReceipt: {
        observedAt: '2026-10-21T05:00:00Z',
        sha256: hash(narrative),
        state: 'unassessed',
        confidence: 'unknown',
        provenance: { receipt: 'offline fixture', requestedModel: null, servedModel: null },
      },
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
    const sibling = { ...original, runId: randomUUID(), query: 'status qualification sibling' };
    await retainRun(original, root);
    await retainRun(sibling, root);
    const file = join(root, '.signals/runs', original.runId + '.json');
    const headers = ['1.0', scope.identity, scope.epoch] as const;
    for (const status of [
      'completed',
      'partial',
      'failed',
      'cancelled',
      'not_configured',
      'running',
      null,
    ] as const) {
      const value: Record<string, unknown> = { ...original };
      if (status === null) delete value.status;
      else value.status = status;
      const bytes = JSON.stringify(value);
      await writeFile(file, bytes);
      for (const kind of ['answer', 'research_run']) {
        const ref = { owner: 'signals-ai', kind, id: original.runId, revision: null, digest: null };
        const read = providerRecord(
          root,
          '/provider/records?ref=' + encodeURIComponent(JSON.stringify(ref)),
          ...headers,
        );
        if (status === 'running' || status === null)
          await expect(read).rejects.toMatchObject({
            status: 503,
            code: 'provider_record_unavailable',
          });
        else expect((await read).content).toBe(bytes);
      }
      if (status === 'running' || status === null) {
        const page = await providerLibrary(root, '/provider/library?q=status', ...headers);
        expect(page.records.find((row) => row.ref.id === original.runId)?.open_capability).not.toBe(
          'owner_route',
        );
        expect(page.records.find((row) => row.ref.id === sibling.runId)?.open_capability).toBe(
          'owner_route',
        );
        expect(page.owner_coverage[0]?.reason).toContain('Partial coverage');
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
