import { createServer } from 'node:http';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { searchApi } from '../../packages/corpus/src/search-api.js';
import { retainResearchAnswer } from '../../packages/corpus/src/research-answer.js';
import { importedAnswers } from '../../packages/corpus/src/research-receipts.js';
import { requestStore } from '../../packages/corpus/src/search-request-store.js';
import { groundedFixture } from '../../tests/fixtures/grounded-answer.js';

// Explicit isolated fixture only. Reopen mode never regenerates or rewrites the answer.
if (!process.argv[2]) throw new Error('new_demo_directory_required');
const root = resolve(process.argv[2]);
const reopen = process.argv[3] === '--reopen';
await mkdir(root, { recursive: true });
if (!reopen) {
  if ((await readdir(root)).length) throw new Error('demo_directory_must_be_empty');
  const result = groundedFixture();
  await writeFile(
    join(root, 'grounded.json'),
    JSON.stringify({ status: 'complete', ...result }, null, 2),
  );
  await retainResearchAnswer(
    root,
    {
      query: 'Grounded export options',
      ...result,
      observedAt: '2026-10-22T12:00:00Z',
      provenance: {
        receipt: 'synthetic offline demonstration',
        requestedModel: null,
        servedModel: null,
      },
    },
    [],
  );
  await requestStore(root).initialize();
}
const scope = await requestStore(root).scope();
const saved = (await importedAnswers(root))[0]!;
if (!saved?.grounding) throw new Error('grounded_demo_record_required');
const api = searchApi(root, () => Promise.reject(new Error('generation_forbidden_in_demo')));
const server = createServer((request, response) => {
  // Demo cannot acquire a native token or mutate anything through HTTP.
  if (request.method !== 'GET' || request.url?.endsWith('/session')) {
    response.writeHead(403);
    response.end('{}');
    return;
  }
  void api(request, response)
    .then((handled) => {
      if (!handled) {
        response.writeHead(404);
        response.end();
      }
    })
    .catch(() => {
      response.writeHead(500);
      response.end('{}');
    });
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') return;
  const ready = {
    type: 'ready',
    port: address.port,
    scope,
    runId: saved.runId,
    fixture: true,
    modelCalls: 0,
    sourceAcquisitions: 0,
  };
  process.send?.(ready);
  process.stdout.write(JSON.stringify(ready) + '\n');
});
