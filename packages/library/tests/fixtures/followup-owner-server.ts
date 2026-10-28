// Real Signals HTTP owner for the Deep "Ask about this" journey. Research and discussion use
// authored offline runners; nothing is fetched and no native model is invoked.
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { searchApi } from '../../packages/corpus/src/search-api.js';
import { signalSearch } from '../../packages/corpus/src/signal-search.js';
import { RunnerFailure } from '../../packages/corpus/src/search-runner.js';
import { extractiveDiscussionRunner } from './frozen-followup-runner.js';

const root = resolve(process.argv[2]!);
const cold = process.env.FOLLOWUP_COLD === '1';
const log = (name: string, value: unknown) =>
  appendFileSync(resolve(root, name), JSON.stringify(value) + '\n');
const tankAnswer =
  '## Rainwater tank options\n\nA 2,000-litre polyethylene tank suits a small roof ([Guide](https://example.org/tanks)). First-flush diverters reduce sediment but need monthly cleaning. Concrete tanks last longer but cost about twice as much. Local permit rules were not checked.';
const discussion = extractiveDiscussionRunner((call) => log('discussion-calls.jsonl', call));
const api = searchApi(
  root,
  (request, dependencies) =>
    signalSearch(request, {
      ...dependencies,
      runner: {
        evidenceClass: 'fixture',
        readiness: () =>
          Promise.resolve({
            available: true,
            broadSearch: true,
            runner: 'fixture',
            reason: 'authored offline follow-up fixture',
          }),
        discover: async (input, _signal, _progress, _hints, brief) => {
          if (cold) throw new Error('cold_owner_attempted_research');
          await appendFile(
            resolve(root, 'research-calls.jsonl'),
            JSON.stringify({ query: input.query }) + '\n',
          );
          if (input.query.includes('incomplete')) {
            const text =
              'Provisional cistern notes: overflow pipes must drain away from foundations ([Code](https://example.org/code)). Sizing was not finished.';
            brief?.({ format: 'markdown', text });
            throw new RunnerFailure(
              'cancelled',
              0,
              { cleanup: { complete: true } },
              { format: 'markdown', text },
            );
          }
          return { proposal: { answer: tankAnswer }, searches: 0, usage: null };
        },
      },
    }),
  undefined,
  undefined,
  undefined,
  (task) => {
    if (cold) throw new Error('cold_owner_attempted_discussion');
    return discussion(task);
  },
);
const server = createServer((request, response) => {
  void (async () => {
    if (request.method === 'POST') log('handler-posts.jsonl', { path: request.url });
    if (await api(request, response)) return;
    response.writeHead(404);
    response.end();
  })().catch(() => {
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});
server.listen(Number(process.env.FOLLOWUP_OWNER_PORT ?? 0), '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') process.send?.({ type: 'ready', port: address.port });
});
