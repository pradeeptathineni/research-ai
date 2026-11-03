import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { searchApi } from '../../packages/corpus/src/search-api.js';
import { requestStore } from '../../packages/corpus/src/search-request-store.js';
import { createSourceCapture } from '../../packages/corpus/src/source-captures.js';
import { fakeCodex, message } from '../../../methods/test/fake-codex.mjs';

const sourceText =
  'A small study reported a short-term reduction. Follow-up lasted six months.';
const sharedQuote = 'short-term reduction';
const uniqueQuote = 'Follow-up lasted six months.';
const citation = (quote) => {
  const start = sourceText.indexOf(quote);
  return { source: 0, start, end: start + quote.length };
};
const reply = (quotes, answer) => ({
  questions: [
    {
      question: 'What does the retained source report?',
      status: 'answered',
      answer,
      citations: quotes.map(citation),
    },
  ],
  omissions: [],
});
const fake = await fakeCodex({
  sessions: [
    {
      events: [
        message(JSON.stringify(reply([sharedQuote], 'The study reports a short-term reduction.'))),
        { type: 'turn.completed' },
      ],
    },
    {
      events: [
        message(
          JSON.stringify(
            reply(
              [sharedQuote, uniqueQuote],
              'The report gives a short-term result and notes six months of follow-up.',
            ),
          ),
        ),
        { type: 'turn.completed' },
      ],
    },
  ],
});

const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), 'perspective-workbench-')));
const root = join(fixtureRoot, 'history');
await mkdir(root, { recursive: true });
const sourceBytes = Buffer.from(
  JSON.stringify({ entity: { uri: 'https://example.test/rs04-retained-source' } }),
  'utf8',
);
const sourceDigest = createHash('sha256').update(sourceBytes).digest('hex');
const sourceRef = {
  owner: 'signals-ai',
  kind: 'entity',
  id: 'rs04-synthetic-source',
  revision: `sha256:${sourceDigest}`,
  digest: sourceDigest,
};
await createSourceCapture(
  root,
  {
    source_ref: sourceRef,
    mode: 'paste',
    text: sourceText,
    observed_at: '2026-11-03T12:00:00.000Z',
  },
  async (ref) => ({ ref, bytes: sourceBytes }),
);
await requestStore(root).initialize();

const api = searchApi(root);
const server = await createServer({
  configFile: resolve('apps/corpus/vite.config.ts'),
  server: { host: '127.0.0.1', port: 5191, strictPort: true },
  plugins: [
    {
      name: 'perspective-workbench-fixture-api',
      enforce: 'pre',
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
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
const cleanup = async () => {
  await server.close();
  await fake.cleanup();
  await rm(fixtureRoot, { recursive: true, force: true });
};
process.once('SIGTERM', () => void cleanup());
process.once('SIGINT', () => void cleanup());
