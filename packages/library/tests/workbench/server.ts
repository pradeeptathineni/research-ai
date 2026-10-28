import { createServer } from 'vite';
import { mkdir, mkdtemp, realpath, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { searchApi } from '../../packages/corpus/src/search-api.js';
import { digest } from '../../packages/corpus/src/search-fetch.js';
import { signalSearch } from '../../packages/corpus/src/signal-search.js';
import { RunnerFailure } from '../../packages/corpus/src/search-runner.js';
import { loadEntities } from '../../packages/corpus/src/search-store.js';
import { contextualize } from '../../packages/domain/src/search-priority.js';
import { saveDecision } from '../../packages/domain/src/search-score.js';
import { materialPreviewCli } from '../../scripts/material-preview.js';
import {
  prepareSelectedExample,
  reviewSelectedExample,
} from '../../scripts/examples/selected-primary.js';
import {
  budgets,
  parseRequest,
  type SearchResult,
} from '../../packages/domain/src/search-contract.js';

// Replay approved public evidence through the real API/storage. No private planning records,
// browser route interception, discovery or model execution is part of this UI fixture.
const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), 'signals-workbench-')));
await prepareSelectedExample(fixtureRoot);
const [inputSha, sourceSha, textSha] = (await readFile(join(fixtureRoot, 'digests'), 'utf8'))
  .trim()
  .split(' ');
const preview = materialPreviewCli([
  'pages',
  '--snapshot',
  join(fixtureRoot, 'extraction.json'),
  '--input-sha256',
  inputSha!,
  '--source-sha256',
  sourceSha!,
  '--text-sha256',
  textSha!,
  '--source-uri',
  'https://example.org/manual.pdf',
  '--claim',
  'Water cooling is approved.',
  '--anchors',
  '["Only water c"]',
]);
if (preview.code !== 0) throw new Error(preview.stderr);
await writeFile(join(fixtureRoot, 'packet.json'), preview.stdout, { flag: 'wx' });
const example = await reviewSelectedExample(fixtureRoot, 'private');
if (example.proof.scriptedReviews !== 1 || example.proof.actualNativeCalls !== 0)
  throw new Error('selected_example_fixture_failed');
const root = join(fixtureRoot, 'history');
const approved = (await loadEntities(resolve('signals/entities'))).slice(0, 2);
if (approved.length !== 2) throw new Error('public_replay_fixture_missing');
await mkdir(join(root, 'signals/entities'), { recursive: true });
for (const record of approved)
  await writeFile(
    join(root, 'signals/entities', `${record.entity.id}.json`),
    JSON.stringify(record),
  );
const api = searchApi(root, async (input, dependencies) => {
  const request = parseRequest(input);
  if (request.claimOrigin === 'retained-partial') {
    const supported = request.claimText === 'The selected guide states the needed prerequisite.';
    const checked = await signalSearch(request, {
      ...dependencies,
      root,
      fetch: (uri) => {
        if (!supported) return Promise.reject(new Error('source_denied_403'));
        return Promise.resolve({
          uri,
          text: 'The guide requires an explicit prerequisite. No permission or effectiveness is established.',
          normalizer: 'text-v2',
          digest: digest(
            'The guide requires an explicit prerequisite. No permission or effectiveness is established.',
          ),
        });
      },
      claimRunner: () => ({
        readiness: () =>
          Promise.resolve({
            available: true,
            broadSearch: false,
            runner: 'fixture',
            reason: 'Scripted review; no native model.',
          }),
        discover: () =>
          Promise.resolve({
            searches: 0,
            usage: null,
            proposal: {
              verdict: 'supported',
              reason: 'Scripted prerequisite declaration only.',
              nextCheck: 'Permission and effectiveness remain unassessed.',
              findings: [
                {
                  sourceIndex: 0,
                  quote: 'The guide requires an explicit prerequisite.',
                  status: 'supported',
                  decisive: true,
                  reason: 'Fixture wording only.',
                },
              ],
              gaps: [],
            },
          }),
      }),
    });
    // Offline expiry fixture: remove only its own synthetic parent after the child is saved.
    if (request.query === 'partial note fixture expired')
      await rm(join(root, '.signals/runs', request.assessmentOf! + '.json'));
    return checked;
  }
  if (
    request.query === 'partial timeout fixture' ||
    request.query.startsWith('partial note fixture ')
  )
    return signalSearch(request, {
      ...dependencies,
      root,
      runner: {
        readiness: () =>
          Promise.resolve({
            available: true,
            broadSearch: true,
            runner: 'fixture',
            reason: 'No model; controlled cancellation.',
          }),
        discover: async (_request, signal, _progress, _hints, brief) => {
          const note = {
            format: 'markdown' as const,
            text: 'A source pointer is available: [guide](https://example.com/guide). Current support is unresolved.',
          };
          brief?.(note);
          await new Promise<void>((done) => {
            if (signal.aborted) done();
            else signal.addEventListener('abort', () => done(), { once: true });
          });
          throw new RunnerFailure('cancelled', 0, null, note);
        },
      },
    });
  if (request.claimOrigin === 'request')
    return signalSearch(request, {
      ...dependencies,
      root,
      // Synthetic refusals only: no fetch, parser or converter exists behind these fixture URLs.
      fetch: (uri) =>
        Promise.reject(
          new Error(
            /\/unsupported-fixture\.(pdf|bin)$/.test(uri)
              ? 'unsupported_content'
              : 'source_denied_403',
          ),
        ),
    });
  if (request.method === 'answer-first')
    return signalSearch(request, {
      ...dependencies,
      root,
      runner: {
        evidenceClass: 'fixture',
        readiness: () =>
          Promise.resolve({
            available: true,
            broadSearch: true,
            runner: 'fixture',
            reason: 'Synthetic public answer; no model calls.',
          }),
        discover: () =>
          Promise.resolve({
            searches: 0,
            usage: null,
            proposal: {
              ...(request.suggestChecks
                ? {
                    suggestions: [
                      {
                        claim: 'Offline export is available without uploading recordings.',
                        basis: 'The original answer leaves export unknown.',
                        why: 'A no-upload requirement could exclude this candidate.',
                        urls: ['https://example.com/tool#export'],
                      },
                    ],
                  }
                : {}),
              answer:
                '## A partial possibility\r\n\r\nRequired offline export is unknown; do not assume full fit.\r\n\r\n' +
                'Background note. '.repeat(1300) +
                '\r\n\r\nRemembered Ω aurora quill constellation.\r\n\r\n[Primary citation](https://example.com/tool#export)',
            },
          }),
      },
    });
  if (request.assessmentOf)
    return signalSearch(request, {
      ...dependencies,
      root,
      runner: {
        evidenceClass: 'fixture',
        readiness: () =>
          Promise.resolve({
            available: true,
            broadSearch: true,
            runner: 'fixture',
            reason: 'Synthetic negative citation check; no model.',
          }),
        discover: () =>
          Promise.resolve({
            searches: 0,
            usage: null,
            proposal: {
              sources: [],
              candidates: [],
              coverage: [],
              gaps: ['No decisive export evidence; abstain.'],
            },
          }),
      },
    });
  dependencies?.progress?.('Replaying approved public evidence for UI verification.');
  if (request.query === 'cancellation fixture') {
    dependencies?.brief?.({
      format: 'markdown',
      text: 'This original answer is ready before source checks finish.',
    });
    dependencies?.provisional?.(
      approved.map(({ entity }) => ({
        uri: entity.uri,
        name: entity.name,
        description: entity.description,
        limits: entity.limits,
      })),
    );
    await new Promise<void>((done) =>
      dependencies?.signal?.addEventListener('abort', () => done(), { once: true }),
    );
  }
  const items = approved.map(({ entity }) => {
    const match = {
      level: 'direct' as const,
      reason: 'Developer UI replay; relevance is not evaluated.',
      sources: [0],
    };
    const decision = saveDecision(entity, match);
    return {
      entity: structuredClone(entity),
      match,
      ...decision,
      priority: {
        policy: 'contextual-priority-v1' as const,
        score: null,
        novelty: 'unknown' as const,
        personalNovelty: 'unknown' as const,
        feedback: 'none' as const,
        applicability: 'direct' as const,
        value: 'medium' as const,
        action: 'study' as const,
        reason: 'Inspect this approved evidence.',
        constraints: [],
        sources: [0],
        evidenceIds: entity.evidence.map((source) => source.id),
        relations: [
          {
            uri: approved[1]!.entity.uri,
            kind: 'alternative' as const,
            reason: 'Another approved record.',
          },
        ],
      },
    };
  });
  const result: SearchResult = {
    schemaVersion: 2,
    runId: randomUUID(),
    query: request.query,
    brief: {
      format: 'markdown',
      text: '## A practical next step\n\nInspect the retained public examples and compare their uses before choosing what to study.\n\n- [Inspect a public source](https://example.com/reference)\n- No new discovery was performed in this browser replay.',
    },
    status: dependencies?.signal?.aborted ? 'cancelled' : 'partial',
    items: contextualize(items, new Set()),
    sources: approved.flatMap(({ entity }) => entity.evidence),
    coverage: [],
    gaps: ['Developer replay: no new discovery performed.'],
    usage: {
      searches: 0,
      documents: 0,
      modelCalls: 0,
      elapsedMs: 0,
      providerUsage: null,
      cost: null,
    },
    counts: { leads: 2, distinct: 2, duplicates: 0, omitted: 0 },
    limits: budgets.quick,
  };
  if (request.query === 'partial metadata fixture') {
    result.items = [];
    result.brief = {
      format: 'markdown',
      text: 'The original answer is retained despite a record gap.\n\n<script>window.__briefExecuted = true</script>\n\n[Unsafe action](javascript:alert(1))',
    };
    result.provisionalLeads = [
      {
        name: 'Incomplete lead',
        uri: 'https://example.com/lead',
        description: 'A learning possibility awaiting source metadata.',
        limits: ['Missing supported defining evidence.'],
      },
    ];
  }
  return result;
});
const server = await createServer({
  configFile: resolve('apps/corpus/vite.config.ts'),
  server: { port: 5189, strictPort: true },
  plugins: [
    {
      name: 'server-owned-replay',
      enforce: 'pre',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          // Keep the unchanged authored record in Activity's 30-row window for its test.
          if (
            request.method === 'POST' &&
            request.url === '/signals-ai/__fixture/selected-primary'
          ) {
            const now = new Date();
            void utimes(join(root, '.signals/runs', `${example.result.runId}.json`), now, now)
              .then(() => {
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ scripted: true, actualNativeCalls: 0 }));
              })
              .catch(next);
            return;
          }
          void api(request, response)
            .then((handled) => {
              if (!handled) next();
            })
            .catch(next);
        });
      },
    },
  ],
});
await server.listen();
process.once('SIGTERM', () => {
  void server.close().then(() => rm(fixtureRoot, { recursive: true, force: true }));
});
