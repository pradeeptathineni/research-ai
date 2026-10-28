import { createServer } from 'node:http';
import { openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { searchApi } from '../../packages/corpus/src/search-api.js';
import { budgets, parseRequest } from '../../packages/domain/src/search-contract.js';

// Started only by the offline API test. The authored codex executable on its
// restricted PATH handles readiness; generation is this measured callback only.
const root = process.argv[2]!;
const mode = process.argv[3]!;
const api = searchApi(root, async (input) => {
  const query = parseRequest(input);
  // Synchronous at entry: a completed HTTP response cannot race ahead of its
  // measured callback, even when two independent server processes compete.
  const counter = openSync(join(root, 'callbacks.jsonl'), 'a', 0o600);
  try {
    writeSync(counter, JSON.stringify({ pid: process.pid, input }) + '\n');
    fsyncSync(counter);
  } finally {
    closeSync(counter);
  }
  process.send?.({ type: 'callback' });
  if (mode.startsWith('hold')) await new Promise(() => {});
  return {
    schemaVersion: 2,
    runId: randomUUID(),
    query: query.query,
    status: 'completed',
    brief: { format: 'markdown', text: 'Measured offline answer; no provider execution.' },
    items: [],
    sources: [],
    coverage: [],
    gaps: [],
    usage: {
      modelCalls: 0,
      providerUsage: null,
      cost: null,
      searches: 0,
      documents: 0,
      elapsedMs: 0,
    },
    counts: { leads: 0, distinct: 0, duplicates: 0, omitted: 0 },
    limits: budgets.quick,
  };
});
const server = createServer((request, response) => {
  if (mode === 'hold-drop' && request.url?.endsWith('/search')) {
    // Destroy before writing the start reply: the client cannot receive its 202
    // or job identity, while the real API has already persisted dispatch intent.
    response.end = function () {
      response.destroy();
      return response;
    };
  }
  void api(request, response);
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no_port');
  process.send?.({ type: 'ready', port: address.port, pid: process.pid });
});
