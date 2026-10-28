import { createServer } from 'node:http';
import { openSync, writeSync, fsyncSync, closeSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { searchApi } from '../../packages/corpus/src/search-api.js';
import { budgets, parseRequest } from '../../packages/domain/src/search-contract.js';

// Real Signals HTTP handler and built index, with an authored offline search
// callback. The callback never invokes a native model or a network provider.
const root = process.argv[2]!;
const mode = process.argv[3]!;
const api = searchApi(root, async (input, options) => {
  const query = parseRequest(input);
  const counter = openSync(join(root, 'callbacks.jsonl'), 'a', 0o600);
  try {
    writeSync(counter, JSON.stringify({ pid: process.pid, query: query.query, mode }) + '\n');
    fsyncSync(counter);
  } finally {
    closeSync(counter);
  }
  options?.progress?.('Fixture worker inspected one source');
  process.send?.({ type: 'callback' });
  if (mode === 'fatal') throw new Error('fixture_worker_failed');
  if (mode === 'hold') {
    await new Promise<void>((done) => {
      if (options?.signal?.aborted) return done();
      options?.signal?.addEventListener('abort', () => setTimeout(done, 150), { once: true });
    });
  }
  return {
    schemaVersion: 2,
    runId: randomUUID(),
    query: query.query,
    status: mode === 'hold' ? 'cancelled' : 'partial',
    brief: { format: 'markdown', text: 'Offline fixture answer; no provider execution.' },
    items: [],
    sources: [],
    coverage: [],
    gaps: ['fixture partial evidence'],
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
});
const server = createServer((request, response) => {
  void (async () => {
    if (await api(request, response)) return;
    if (request.method === 'GET' && request.url === '/signals-ai/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(readFileSync('dist/public-site/index.html'));
      return;
    }
    response.writeHead(404);
    response.end();
  })();
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no_port');
  process.send?.({ type: 'ready', port: address.port, pid: process.pid });
});
