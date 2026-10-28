import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { budgets, type SearchResult, type Proposal } from '../../domain/src/search-contract.js';
import { digest } from './search-fetch.js';
import { requestStore } from './search-request-store.js';
import { loadRun, retainRun } from './search-store.js';
import { searchApi } from './search-api.js';
import { acceptDiscovery } from './signal-search.js';
import type * as RunnerModule from './search-runner.js';
import {
  extractiveDiscussionRunner,
  type DiscussionCall,
} from '../../../tests/fixtures/frozen-followup-runner.js';

// The native runner must never be reached: readiness is a stub and discovery fails loudly.
vi.mock('./search-runner.js', async (original) => ({
  ...(await original<typeof RunnerModule>()),
  codexRunner: () => ({
    evidenceClass: 'configured-live',
    readiness: async () => ({
      available: false,
      broadSearch: false,
      runner: 'codex',
      reason: 'test stub',
    }),
    discover: async () => {
      throw new Error('native_runner_forbidden');
    },
  }),
}));

type Api = ReturnType<typeof searchApi>;
type Ref = { owner: string; kind: string; id: string; revision: string; digest: string };
/** Only the reply fields these checks read; JSON leaves absent fields undefined. */
type Body = {
  code: string;
  token: string;
  id: string;
  cancelled: boolean;
  content: string;
  receipt: { state: string; reason: string; request_digest: string };
  result_ref: Ref;
  ref: Ref;
  capabilities: { operations: { name: string }[]; contracts: { id: string; versions: string[] }[] };
  records: {
    ref: Ref;
    kind: string;
    summary: string;
    visibility: string;
    open_capability: string;
  }[];
};
/** Drive the real handler in-process; no socket is opened. */
function call(api: Api, method: string, route: string, body?: unknown, headers = {}) {
  const request = Object.assign(
    Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]),
    {
      method,
      url: '/signals-ai/__signals/api/' + route,
      headers: {
        host: '127.0.0.1:5178',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
    },
  );
  return new Promise<{ status: number; body: Body }>((done) => {
    let status = 0;
    const response = {
      writableEnded: false,
      once() {},
      writeHead(code: number) {
        status = code;
        return response;
      },
      end(text?: string) {
        done({ status, body: (text ? JSON.parse(text) : null) as Body });
      },
    };
    void api(request as unknown as IncomingMessage, response as unknown as ServerResponse);
  });
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const tankAnswer =
  '## Rainwater tank options\n\nA 2,000-litre polyethylene tank suits a small roof ([Guide](https://example.org/tanks)). First-flush diverters reduce sediment but need monthly cleaning. Concrete tanks last longer but cost about twice as much. Local permit rules were not checked.';
const cisternNote =
  'Provisional cistern notes: overflow pipes must drain away from foundations ([Code](https://example.org/code)). Sizing was not finished.';
function run(runId: string, query: string, text: string, answer: boolean): SearchResult {
  return {
    schemaVersion: 2,
    runId,
    query,
    status: answer ? 'completed' : 'cancelled',
    brief: { format: 'markdown', text },
    ...(answer
      ? {
          answerReceipt: {
            observedAt: '2026-10-20T10:00:00.000Z',
            sha256: digest(text),
            state: 'unassessed' as const,
            confidence: 'unknown' as const,
            provenance: { receipt: runId, requestedModel: null, servedModel: null },
          },
        }
      : {}),
    items: [],
    sources: [],
    coverage: [],
    gaps: [answer ? 'Citations were not assessed.' : 'Research was cancelled.'],
    usage: {
      searches: 0,
      documents: 0,
      elapsedMs: 0,
      modelCalls: 1,
      providerUsage: null,
      cost: null,
    },
    counts: { leads: 0, distinct: 0, duplicates: 0, omitted: 0 },
    limits: budgets.quick,
  };
}

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-followup-')));
  const scope = await requestStore(root).initialize();
  const answerId = randomUUID();
  const noteId = randomUUID();
  await retainRun(
    run(answerId, 'Which rainwater tank suits a small roof?', tankAnswer, true),
    root,
  );
  await retainRun(
    run(noteId, 'How should a cistern overflow be routed?', cisternNote, false),
    root,
  );
  const calls: DiscussionCall[] = [];
  const api = searchApi(
    root,
    undefined,
    undefined,
    undefined,
    undefined,
    extractiveDiscussionRunner((entry) => calls.push(entry)),
  );
  const { token } = (await call(api, 'GET', 'session')).body as { token: string };
  const owner = {
    'x-signals-provider-version': '1.0',
    'x-signals-instance-id': scope.identity,
    'x-signals-owner-epoch': scope.epoch,
  };
  const exact = async (kind: string, id: string) =>
    (
      await call(
        api,
        'GET',
        'provider/records?ref=' +
          encodeURIComponent(
            JSON.stringify({ owner: 'signals-ai', kind, id, revision: null, digest: null }),
          ),
        undefined,
        owner,
      )
    ).body.ref;
  const envelope = (
    parent_ref: Awaited<ReturnType<typeof exact>>,
    question: string,
    key = randomUUID(),
  ) => ({
    schema_version: '1.0',
    request_id: 'followup:' + key,
    idempotency_key: key,
    parent_ref,
    question,
    scope: 'saved-context-only',
    retention: 'private',
    authority_ref: {
      owner: 'signals-ai',
      kind: 'authority',
      id: 'test-user',
      revision: '1',
      digest: null,
    },
  });
  const ask = (target: Api, body: unknown, headers = {}) =>
    call(target, 'POST', 'followups', body, {
      'x-signals-token': token,
      'x-signals-owner-epoch': scope.epoch,
      ...headers,
    });
  const settled = async (target: Api, key: string) => {
    for (let n = 0; n < 200; n++) {
      const found = await call(target, 'GET', 'followups/' + key, undefined, owner);
      // Lock-free ledger reads can land between the writer's head and snapshot publication.
      if (
        found.status === 503 &&
        ['provider_unavailable', 'request_store_unavailable'].includes(found.body.code)
      ) {
        transientReads++;
        await new Promise((done) => setTimeout(done, 10));
        continue;
      }
      if (found.status !== 200) throw new Error('followup_lookup_' + JSON.stringify(found));
      if (!['unknown', 'admitted', 'cancel_requested'].includes(found.body.receipt?.state))
        return found.body;
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error('followup_did_not_settle');
  };
  let transientReads = 0;
  return {
    root,
    scope,
    api,
    token,
    owner,
    calls,
    answerId,
    noteId,
    exact,
    envelope,
    ask,
    settled,
    transient: () => transientReads,
  };
}

it('answers a question about one exact saved answer from its frozen text and retains a linked child', async () => {
  const t = await setup();
  try {
    const capabilities = (await call(t.api, 'GET', 'provider/capabilities')).body;
    const operations = capabilities.capabilities.operations.map((row) => row.name);
    expect(operations).toEqual(expect.arrayContaining(['ask_saved_research', 'lookup_followup']));
    expect(t.calls).toHaveLength(0);

    const parentPath = join(t.root, '.signals/runs', `${t.answerId}.json`);
    const before = await readFile(parentPath);
    const parentRef = await t.exact('answer', t.answerId);
    const body = t.envelope(
      parentRef,
      'Which part needs cleaning, and were the permit rules checked?',
    );
    const started = await t.ask(t.api, body);
    expect(started.status).toBe(202);
    expect(started.body.receipt.state).toBe('unknown');
    const done = await t.settled(t.api, body.idempotency_key);
    expect(done.receipt).toMatchObject({
      state: 'complete',
      reason: 'followup_complete_child_retained',
    });
    expect(done.result_ref).toMatchObject({ owner: 'signals-ai', kind: 'answer' });

    const read = await call(
      t.api,
      'GET',
      'provider/records?ref=' + encodeURIComponent(JSON.stringify(done.result_ref)),
      undefined,
      t.owner,
    );
    expect(read.status).toBe(200);
    const child = JSON.parse(read.body.content) as SearchResult;
    // Meaningful extraction from the actual frozen parent text, not a canned reply.
    expect(child.brief!.text).toContain(
      'First-flush diverters reduce sediment but need monthly cleaning.',
    );
    expect(child.brief!.text).toContain('Local permit rules were not checked.');
    expect(child.brief!.text).not.toContain('Concrete tanks');
    expect(child.answerReceipt).toMatchObject({ state: 'unassessed', confidence: 'unknown' });
    expect(child.followupOf).toMatchObject({
      scope: 'saved-context-only',
      parent: parentRef,
      parentStatus: 'completed',
      parentQuery: 'Which rainwater tank suits a small roof?',
      requestDigest: done.receipt.request_digest,
    });
    expect(child.followupOf!.frozen.priorSynthesis).toBe(tankAnswer);
    expect(child.gaps.join(' ')).toContain('unassessed prior synthesis');
    expect(child.gaps.join(' ')).toContain(
      'Discussion only: no search, source access or verification',
    );
    expect(child.usage).toMatchObject({ searches: 0, documents: 0 });
    expect(t.calls).toEqual([expect.objectContaining({ question: body.question, live: false })]);
    // Original research bytes are untouched.
    expect(await readFile(parentPath)).toEqual(before);
    expect(sha(await readFile(parentPath))).toBe(parentRef.digest);

    // Same key and meaning returns the original identity without a second discussion.
    const again = await t.ask(t.api, body);
    expect(again.status).toBe(202);
    expect(again.body.id).toBe(started.body.id);
    expect(again.body.result_ref).toEqual(done.result_ref);
    const changed = await t.ask(t.api, { ...body, question: 'Something else?' });
    expect(changed.body.code).toBe('request_conflict');
    expect(t.calls).toHaveLength(1);

    // The child is an ordinary saved answer for Library search and exact Plan selection.
    const library = await call(
      t.api,
      'GET',
      'provider/library?q=' + encodeURIComponent('permit rules cleaning') + '&kinds=answer',
      undefined,
      t.owner,
    );
    const row = library.body.records.find((item) => item.ref.id === done.result_ref.id);
    expect(row).toMatchObject({
      kind: 'answer',
      visibility: 'private',
      open_capability: 'owner_route',
    });
    expect(row?.summary).toContain('Follow-up about saved research');
    expect(row?.ref.digest).toBe(done.result_ref.digest);

    // A later missing parent never erases or regenerates the child's copied scope.
    await rm(parentPath);
    const reopened = await call(
      t.api,
      'GET',
      'provider/records?ref=' + encodeURIComponent(JSON.stringify(done.result_ref)),
      undefined,
      t.owner,
    );
    expect(reopened.status).toBe(200);
    expect(reopened.body.content).toBe(read.body.content);
    expect((await loadRun(done.result_ref.id, t.root)).followupOf!.frozen.priorSynthesis).toBe(
      tankAnswer,
    );
    expect((await t.settled(t.api, body.idempotency_key)).result_ref).toEqual(done.result_ref);
    const orphan = await t.ask(t.api, t.envelope(parentRef, 'Still there?'));
    expect(orphan).toMatchObject({ status: 404, body: { code: 'provider_record_not_found' } });
    expect(t.calls).toHaveLength(1);
  } finally {
    await rm(t.root, { recursive: true, force: true });
  }
});

it('refuses drifted, missing, malformed or unbound parents before admission or inference', async () => {
  const t = await setup();
  try {
    const parentRef = await t.exact('answer', t.answerId);
    const drift = t.envelope(
      { ...parentRef, digest: '0'.repeat(64), revision: 'sha256:' + '0'.repeat(64) },
      'Was anything checked?',
    );
    expect(await t.ask(t.api, drift)).toMatchObject({
      status: 409,
      body: { code: 'provider_record_changed' },
    });
    const missing = t.envelope({ ...parentRef, id: randomUUID() }, 'Was anything checked?');
    expect((await t.ask(t.api, missing)).body.code).toBe('provider_record_not_found');
    const wrongKind = t.envelope({ ...parentRef, kind: 'research_note' }, 'Was anything checked?');
    expect((await t.ask(t.api, wrongKind)).status).toBe(503);
    for (const bad of [
      { ...t.envelope(parentRef, 'q'), scope: 'web' },
      { ...t.envelope(parentRef, 'q'), retention: 'memory' },
      { ...t.envelope(parentRef, 'q'), parent_ref: { ...parentRef, revision: null } },
      { ...t.envelope(parentRef, 'q'), parent_ref: { ...parentRef, kind: 'entity' } },
      { ...t.envelope(parentRef, 'q'), path: '/etc/passwd' },
      t.envelope(parentRef, '\ud800'),
    ])
      expect((await t.ask(t.api, bad)).status).toBe(400);
    expect(
      (await t.ask(t.api, t.envelope(parentRef, 'q'), { 'x-signals-owner-epoch': randomUUID() }))
        .body.code,
    ).toBe('owner_epoch_mismatch');
    expect(
      (await t.ask(t.api, t.envelope(parentRef, 'q'), { 'x-signals-token': 'wrong' })).body.code,
    ).toBe('csrf_token_required');
    for (const refused of [drift, missing, wrongKind])
      expect(
        (await call(t.api, 'GET', 'followups/' + refused.idempotency_key, undefined, t.owner))
          .status,
      ).toBe(404);
    expect(t.calls).toHaveLength(0);
  } finally {
    await rm(t.root, { recursive: true, force: true });
  }
});

it('keeps a stopped note incomplete, and leaves an interrupted follow-up unknown without replay', async () => {
  const t = await setup();
  try {
    const noteRef = await t.exact('research_note', t.noteId);
    const noteBody = t.envelope(noteRef, 'Where must overflow pipes drain?');
    await t.ask(t.api, noteBody);
    const note = await t.settled(t.api, noteBody.idempotency_key);
    const child = await loadRun(note.result_ref.id, t.root);
    expect(child.brief!.text).toContain('overflow pipes must drain away from foundations');
    expect(child.followupOf).toMatchObject({ parentStatus: 'cancelled', parent: noteRef });
    expect(child.gaps.join(' ')).toContain('stopped before completion');
    expect(child.gaps.join(' ')).toContain('does not complete the original research');
    expect((await loadRun(t.noteId, t.root)).status).toBe('cancelled');

    // A discussion that never answers: restart the owner while dispatch may have started.
    let release: () => void = () => {};
    const hanging = searchApi(t.root, undefined, undefined, undefined, undefined, () => ({
      discover: (_request, signal) =>
        new Promise<never>((_, reject) => {
          release = () => reject(new Error('cancelled'));
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        }),
    }));
    const hangingToken = (await call(hanging, 'GET', 'session')).body.token;
    const answerRef = await t.exact('answer', t.answerId);
    const body = t.envelope(answerRef, 'Which tank lasts longer?');
    const started = await t.ask(hanging, body, { 'x-signals-token': hangingToken });
    expect(started.body.receipt.state).toBe('unknown');
    let coldCalls = 0;
    const cold = searchApi(t.root, undefined, undefined, undefined, undefined, () => ({
      discover: async () => {
        coldCalls++;
        throw new Error('cold_owner_must_not_discuss');
      },
    }));
    const coldToken = (await call(cold, 'GET', 'session')).body.token;
    const lookup = await call(cold, 'GET', 'followups/' + body.idempotency_key, undefined, t.owner);
    expect(lookup.body.receipt).toMatchObject({
      state: 'unknown',
      reason: 'dispatch_may_have_started',
    });
    expect(lookup.body.result_ref).toBeNull();
    const repeated = await t.ask(cold, body, { 'x-signals-token': coldToken });
    expect(repeated.status).toBe(202);
    expect(repeated.body.receipt.state).toBe('unknown');
    expect(coldCalls).toBe(0);

    // The live owner's existing cancel route settles the same identity.
    const cancel = await call(
      hanging,
      'POST',
      'cancel/' + started.body.id,
      {},
      {
        'x-signals-token': hangingToken,
      },
    );
    expect(cancel.body).toEqual({ cancelled: true });
    release();
    const final = await t.settled(cold, body.idempotency_key);
    expect(final.receipt.state).toBe('cancelled');
    expect(final.receipt.reason).toContain('followup_cancelled');
    expect(final.result_ref).toBeNull();
    expect(coldCalls).toBe(0);
  } finally {
    await rm(t.root, { recursive: true, force: true });
  }
});

function across(refs: Ref[], question: string, key = randomUUID()) {
  return {
    schema_version: '2.0',
    request_id: `across:${key}`,
    idempotency_key: key,
    parent_refs: refs,
    question,
    scope: 'saved-context-only',
    retention: 'private',
    authority_ref: {
      owner: 'signals-ai',
      kind: 'authority',
      id: 'offline-user',
      revision: '1',
      digest: null,
    },
  };
}

it('supports two and four parents while keeping selected stopped notes incomplete', async () => {
  const t = await setup();
  try {
    const refs = [await t.exact('answer', t.answerId), await t.exact('research_note', t.noteId)];
    for (const count of [2, 4]) {
      while (refs.length < count) {
        const parent = run(randomUUID(), `Extra authored parent ${refs.length}`, tankAnswer, true);
        await retainRun(parent, t.root);
        refs.push(await t.exact('answer', parent.runId));
      }
      const body = across(refs.slice(0, count), 'Which part needs monthly cleaning?');
      expect((await t.ask(t.api, body)).status).toBe(202);
      const done = await t.settled(t.api, body.idempotency_key);
      expect(done.receipt.state).toBe('complete');
      const child = await loadRun(done.result_ref.id, t.root);
      expect(child.followupOf).toMatchObject({
        version: 2,
        parents: expect.arrayContaining([
          expect.objectContaining({ ref: refs[1], status: 'cancelled' }),
        ]),
      });
      expect(child.gaps.join(' ')).toContain('does not complete it');
      expect((await loadRun(t.noteId, t.root)).status).toBe('cancelled');
    }
    expect(t.calls).toHaveLength(2);
  } finally {
    await rm(t.root, { recursive: true, force: true });
  }
});

it('refuses a second multi-parent admission while a discussion is active', async () => {
  const t = await setup();
  let release: () => void = () => {};
  try {
    const refs = [await t.exact('answer', t.answerId), await t.exact('research_note', t.noteId)];
    const hanging = searchApi(t.root, undefined, undefined, undefined, undefined, () => ({
      discover: (_request, signal) =>
        new Promise<never>((_, reject) => {
          release = () => reject(new Error('cancelled'));
          signal.addEventListener('abort', release, { once: true });
        }),
    }));
    const token = (await call(hanging, 'GET', 'session')).body.token;
    const firstBody = across(refs, 'first question');
    const first = await t.ask(hanging, firstBody, { 'x-signals-token': token });
    expect(first.status).toBe(202);
    const second = across(refs, 'second question');
    expect(await t.ask(hanging, second, { 'x-signals-token': token })).toMatchObject({
      status: 409,
      body: { code: 'runner_busy' },
    });
    expect(
      (await call(hanging, 'GET', 'followups/' + second.idempotency_key, undefined, t.owner))
        .status,
    ).toBe(404);
    await call(hanging, 'POST', 'cancel/' + first.body.id, {}, { 'x-signals-token': token });
    release();
    expect((await t.settled(hanging, firstBody.idempotency_key)).receipt.state).toBe('cancelled');
  } finally {
    release();
    await rm(t.root, { recursive: true, force: true });
  }
});

it('refuses invalid multi-parent selections, drift and missing parents before admission', async () => {
  const t = await setup();
  try {
    const refs = [await t.exact('answer', t.answerId), await t.exact('research_note', t.noteId)];
    const inputs = [
      across(refs.slice(0, 1), 'q'),
      across(
        Array.from({ length: 5 }, () => ({ ...refs[0]!, id: randomUUID() })),
        'q',
      ),
      across([refs[0]!, refs[0]!], 'q'),
      across(refs, '\ud800'),
      across([refs[0]!, { ...refs[1]!, revision: 'sha256:' + '0'.repeat(64) }], 'q'),
      across([refs[0]!, { ...refs[1]!, kind: 'entity' }], 'q'),
    ];
    for (const body of inputs) {
      expect((await t.ask(t.api, body)).status).toBe(400);
      expect(
        (await call(t.api, 'GET', 'followups/' + body.idempotency_key, undefined, t.owner)).status,
      ).toBe(404);
    }
    const changed = across(
      [refs[0]!, { ...refs[1]!, digest: '0'.repeat(64), revision: 'sha256:' + '0'.repeat(64) }],
      'q',
    );
    expect((await t.ask(t.api, changed)).status).toBe(409);
    expect(
      (await call(t.api, 'GET', 'followups/' + changed.idempotency_key, undefined, t.owner)).status,
    ).toBe(404);
    const largeRefs: Ref[] = [];
    for (let index = 0; index < 2; index++) {
      const parent = run(randomUUID(), `Large selected answer ${index}`, 'x'.repeat(60000), true);
      await retainRun(parent, t.root);
      largeRefs.push(await t.exact('answer', parent.runId));
    }
    const large = across(largeRefs, 'q');
    expect((await t.ask(t.api, large)).body.code).toBe('followup_synthesis_budget_exceeded');
    expect(
      (await call(t.api, 'GET', 'followups/' + large.idempotency_key, undefined, t.owner)).status,
    ).toBe(404);
    await rm(join(t.root, '.signals/runs', `${t.noteId}.json`));
    const missing = across(refs, 'q');
    expect((await t.ask(t.api, missing)).status).toBe(404);
    expect(
      (await call(t.api, 'GET', 'followups/' + missing.idempotency_key, undefined, t.owner)).status,
    ).toBe(404);
    expect(t.calls).toHaveLength(0);
  } finally {
    await rm(t.root, { recursive: true, force: true });
  }
});

/** Authored source passages enter through the real evidence decoder; no user Corpus is read. */
async function savedFixture(index: number, count: number): Promise<SearchResult> {
  const passages = Array.from({ length: count }, (_, ordinal) =>
    index === 0 && ordinal >= 45 && ordinal <= 50
      ? `Battery export requirement ${ordinal}: retain signed portable bundles.`
      : index === 0
        ? `Gardening filler ${ordinal}: inspect soil texture.`
        : `Battery export constraint ${index}-${ordinal}: ${index === 1 ? 'permissions remain unknown' : 'archive costs remain unknown'}.`,
  );
  const source = `https://example.org/fixture-${index}`;
  const proposal: Proposal = {
    sources: [
      {
        uri: source,
        title: `Authored source ${index}`,
        publisher: 'Offline fixture',
        family: 'primary',
        origin: 'maintainer',
        publishedAt: '2026-10-20T00:00:00Z',
      },
    ],
    candidates: [
      {
        uri: source,
        name: `Authored option ${index}`,
        kind: 'software',
        identity: 'resolved',
        aliases: [],
        description: 'Synthetic source-selection fixture.',
        facets: {
          domains: [],
          capabilities: [],
          interfaces: [],
          deliveryForms: [],
          platforms: [],
          licenses: [],
          tags: [],
        },
        observations: passages.map((text) => ({
          source: 0,
          feature: 'defining',
          indicator: 'defines',
          statement: text,
          quote: text,
          independent: false,
          origin: 'maintainer',
          status: 'supported',
        })),
        match: { level: 'direct', reason: 'Authored test scope only.', sources: [0] },
        limits: ['Synthetic; no research quality claim.'],
      },
    ],
    coverage: [],
    gaps: [],
  };
  const acquired = await acceptDiscovery(
    proposal,
    { query: `Authored saved option ${index}` },
    {
      asOf: '2026-10-21T00:00:00Z',
      evidenceClass: 'fixture',
      fetch: async (uri) => ({
        uri,
        text: passages.join('\n'),
        digest: digest(passages.join('\n')),
      }),
    },
  );
  const narrative =
    index === 0
      ? 'Battery export uses signed portable bundles.'
      : index === 1
        ? 'Battery export permissions remain unknown.'
        : 'Battery export archive costs remain unknown.';
  return {
    ...run(randomUUID(), `Saved battery option ${index}`, narrative, true),
    ...acquired,
    status: 'completed' as const,
    usage: {
      searches: 0,
      documents: 1,
      elapsedMs: 0,
      modelCalls: 0,
      providerUsage: { fixture: 'authored-source' },
      cost: null,
    },
    brief: { format: 'markdown' as const, text: narrative },
    answerReceipt: {
      observedAt: '2026-10-21T00:00:00Z',
      sha256: digest(narrative),
      state: 'unassessed' as const,
      confidence: 'unknown' as const,
      provenance: { receipt: 'authored offline fixture', requestedModel: null, servedModel: null },
    },
  };
}

it('asks across three actual HTTP records, selects late relevant sources, and cold-reopens a Plan-readable child', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-ask-across-http-')));
  const children: ChildProcess[] = [];
  const stop = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, 'close');
    child.kill('SIGTERM');
    await closed;
  };
  try {
    const scope = await requestStore(root).initialize();
    const parents = await Promise.all([
      savedFixture(0, 60),
      savedFixture(1, 3),
      savedFixture(2, 4),
    ]);
    for (const parent of parents) await retainRun(parent, root);
    const parentBytes = await Promise.all(
      parents.map((parent) => readFile(join(root, '.signals/runs', `${parent.runId}.json`))),
    );
    await mkdir(join(root, 'bin'));
    await writeFile(
      join(root, 'bin/codex'),
      '#!/bin/sh\ncase "$*" in\n--version) echo "codex offline fixture";;\n"login status") echo "Logged in fixture";;\n*) exit 91;;\nesac\n',
      { mode: 0o700 },
    );
    const launch = async (cold: boolean) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(
            new URL('../../../tests/fixtures/followup-owner-server.ts', import.meta.url),
          ),
          root,
        ],
        {
          env: {
            PATH: `${join(root, 'bin')}:${process.execPath.slice(0, process.execPath.lastIndexOf('/'))}:/usr/bin:/bin`,
            HOME: root,
            TMPDIR: root,
            FOLLOWUP_COLD: cold ? '1' : '0',
          },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
      children.push(child);
      let stderr = '';
      child.stderr!.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      const port = await new Promise<number>((resolve, reject) => {
        child.on('message', (message: { type: string; port: number }) => {
          if (message.type === 'ready') resolve(message.port);
        });
        child.once('exit', (code) => reject(new Error(`fixture_exit_${code}: ${stderr}`)));
        child.once('error', reject);
      });
      return `http://127.0.0.1:${port}/signals-ai/__signals/api/`;
    };
    const owner = {
      'x-signals-provider-version': '1.0',
      'x-signals-instance-id': scope.identity,
      'x-signals-owner-epoch': scope.epoch,
    };
    const request = async (base: string, route: string, body?: unknown, token?: string) => {
      const reply = await fetch(base + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...owner,
          ...(body === undefined
            ? {}
            : { 'content-type': 'application/json', 'x-signals-token': token! }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: reply.status, body: (await reply.json()) as Body };
    };
    const first = await launch(false);
    const capabilities = (await request(first, 'provider/capabilities')).body.capabilities;
    expect(capabilities.contracts).toContainEqual({
      id: 'frozen-followup-request',
      versions: ['1.0', '2.0'],
    });
    expect(capabilities.operations).toContainEqual({
      name: 'ask_across_saved_research',
      target_kinds: ['answer', 'research_note'],
      mutating: true,
      authority_required: true,
    });
    const token = (await request(first, 'session')).body.token;
    const refs: Ref[] = [];
    for (const parent of parents)
      refs.push(
        (
          await request(
            first,
            'provider/records?ref=' +
              encodeURIComponent(
                JSON.stringify({
                  owner: 'signals-ai',
                  kind: 'answer',
                  id: parent.runId,
                  revision: null,
                  digest: null,
                }),
              ),
          )
        ).body.ref,
      );
    const body = across(
      refs,
      'Which battery export requirements, permissions and archive costs remain?',
    );
    const admitted = await request(first, 'followups', body, token);
    expect(admitted.status).toBe(202);
    let done: Body | undefined;
    for (let attempt = 0; attempt < 150; attempt++) {
      const read = await request(first, 'followups/' + body.idempotency_key);
      if (read.status === 200 && read.body.receipt.state === 'complete') {
        done = read.body;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(done?.result_ref.kind).toBe('answer');
    const original = await request(
      first,
      'provider/records?ref=' + encodeURIComponent(JSON.stringify(done!.result_ref)),
    );
    expect(original.status).toBe(200);
    const child = JSON.parse(original.body.content) as SearchResult;
    if (child.followupOf?.version !== 2) throw new Error('missing_v2_closure');
    const closure = child.followupOf;
    expect(closure.parents.map((parent) => parent.ref)).toEqual(refs);
    // Qualified source IDs consume the byte budget before all 40 slots fit.
    expect(closure.selection).toMatchObject({
      method: 'bm25-v1',
      question_sha256: digest(body.question),
      per_parent: [
        { total: 60, kept: 24 },
        { total: 3, kept: 3 },
        { total: 4, kept: 4 },
      ],
    });
    for (let ordinal = 45; ordinal <= 50; ordinal++)
      expect(closure.frozen.material.map((row) => row.statement)).toContain(
        `Battery export requirement ${ordinal}: retain signed portable bundles.`,
      );
    expect(closure.cited.length).toBeGreaterThan(0);
    expect(
      closure.cited.every((id) => closure.frozen.material.some((row) => row.observationId === id)),
    ).toBe(true);
    expect(child.brief!.text).toContain('permissions remain unknown');
    expect(child.gaps.join(' ')).toContain('24/60 retained statements');
    expect(Buffer.byteLength(JSON.stringify(closure.frozen.material))).toBeLessThanOrEqual(18000);
    for (const row of closure.frozen.material) {
      const parent = parents.find((entry) =>
        row.entityId.startsWith(`native:private:${entry.runId}_`),
      )!;
      const observation = parent.items
        .flatMap((item) => item.entity.observations)
        .find((entry) => row.observationId.endsWith(':' + entry.id))!;
      expect(row.statement).toBe(observation.statement);
      expect(row.quote).toBe(observation.quote);
      expect(row.evidenceId.endsWith(':' + observation.evidenceId)).toBe(true);
    }
    for (let index = 0; index < parents.length; index++)
      expect(await readFile(join(root, '.signals/runs', `${parents[index]!.runId}.json`))).toEqual(
        parentBytes[index],
      );
    const calls = () =>
      readFile(join(root, 'discussion-calls.jsonl'), 'utf8').then((text) =>
        text.trim().split('\n').filter(Boolean),
      );
    const callsBefore = (await calls()).length;
    expect(callsBefore).toBe(1);
    await stop(children[0]!);
    const cold = await launch(true);
    const coldToken = (await request(cold, 'session')).body.token;
    for (const parent of parents) await rm(join(root, '.signals/runs', `${parent.runId}.json`));
    const restored = await request(cold, 'followups/' + body.idempotency_key);
    expect(restored.body.result_ref).toEqual(done!.result_ref);
    const read = await request(
      cold,
      'provider/records?ref=' + encodeURIComponent(JSON.stringify(done!.result_ref)),
    );
    expect(read.body.content).toBe(original.body.content);
    const library = await request(cold, 'provider/library?q=battery&kinds=answer');
    expect(library.body.records.find((row) => row.ref.id === child.runId)?.open_capability).toBe(
      'owner_route',
    );
    const repeated = await request(
      cold,
      'followups',
      { ...body, request_id: 'retry-after-lost-reply' },
      coldToken,
    );
    expect(repeated.body.id).toBe(admitted.body.id);
    expect(repeated.body.result_ref).toEqual(done!.result_ref);
    expect(
      (await request(cold, 'followups', { ...body, question: 'different meaning' }, coldToken)).body
        .code,
    ).toBe('request_conflict');
    const missing = across(refs, 'new request after parent deletion');
    expect((await request(cold, 'followups', missing, coldToken)).status).toBe(404);
    expect((await request(cold, 'followups/' + missing.idempotency_key)).status).toBe(404);
    expect(await calls()).toHaveLength(1);
    const ledger = JSON.parse(
      await readFile(join(root, '.signals/requests/ledger.json'), 'utf8'),
    ) as { records: { key: string }[] };
    expect(ledger.records.filter((record) => record.key === body.idempotency_key)).toHaveLength(1);
    if (process.env.P3_EVIDENCE) {
      await writeFile(join(process.env.P3_EVIDENCE, 'child.json'), original.body.content);
      await writeFile(
        join(process.env.P3_EVIDENCE, 'demo.json'),
        JSON.stringify(
          {
            request: body,
            result_ref: done!.result_ref,
            parents: refs,
            selection: closure.selection,
            cited: closure.cited,
            first_pid: children[0]!.pid,
            restarted_pid: children[1]!.pid,
            discussion_calls_before_restart: callsBefore,
            discussion_calls_after_restart: (await calls()).length,
            admitted_records_for_original_key: ledger.records.filter(
              (record) => record.key === body.idempotency_key,
            ).length,
            native_model_calls: 0,
            child_sha256: digest(original.body.content),
            restored_result_ref: restored.body.result_ref,
            existing_child_readable_after_parent_deletion:
              read.body.content === original.body.content,
          },
          null,
          2,
        ) + '\n',
      );
    }
  } finally {
    for (const child of children) await stop(child);
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
