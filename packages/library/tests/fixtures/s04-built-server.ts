import { createServer } from 'node:http';
import { appendFile, lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import { searchApi } from '../../packages/corpus/src/search-api.js';
import { signalSearch } from '../../packages/corpus/src/signal-search.js';
import { RunnerFailure } from '../../packages/corpus/src/search-runner.js';

const root = resolve(process.argv[2]!);
const assets = await realpath(resolve('dist/public-site'));
const api = searchApi(root, (request, dependencies) =>
  signalSearch(request, {
    ...dependencies,
    runner: {
      evidenceClass: 'fixture',
      readiness: () =>
        Promise.resolve({
          available: true,
          broadSearch: true,
          runner: 'fixture',
          reason: 'authored offline S04 fixture',
        }),
      discover: async (input, _signal, _progress, _hints, brief) => {
        if (process.env.S04_NO_GENERATION === '1')
          throw new Error('cold_reopen_attempted_generation');
        await appendFile(
          resolve(root, 'callbacks.jsonl'),
          JSON.stringify({ query: input.query }) + '\n',
        );
        if (input.query.includes('incomplete')) {
          const text = 'Provisional aurora field guide Ω. Permission and fit remain unknown.';
          brief?.({ format: 'markdown', text });
          throw new RunnerFailure(
            'cancelled',
            0,
            { cleanup: { complete: false, error: 'authored fixture stop' } },
            { format: 'markdown', text },
          );
        }
        return {
          proposal: { answer: 'Complete constellation synthesis Ω. Still unassessed.' },
          searches: 0,
          usage: null,
        };
      },
    },
  }),
);
const builtFiles = new Set([
  'index.html',
  ...(await readdir(resolve(assets, 'assets'))).map((name) => `assets/${name}`),
]);
const server = createServer((request, response) => {
  void (async () => {
    if (await api(request, response)) return;
    const address = server.address();
    const trusted =
      address &&
      typeof address !== 'string' &&
      request.headers.host === `127.0.0.1:${address.port}` &&
      request.method === 'GET';
    if (!trusted) {
      response.writeHead(403);
      response.end();
      return;
    }
    const pathname = request.url?.split('?')[0];
    const name =
      pathname === '/signals-ai/'
        ? 'index.html'
        : pathname?.startsWith('/signals-ai/')
          ? pathname.slice('/signals-ai/'.length)
          : '';
    if (!name || !builtFiles.has(name)) {
      response.writeHead(404);
      response.end();
      return;
    }
    const file = resolve(assets, name);
    if (
      (await lstat(file)).isSymbolicLink() ||
      relative(assets, await realpath(file)).startsWith('..')
    )
      throw new Error('asset_escape');
    let bytes = await readFile(file);
    if (name === 'index.html')
      bytes = Buffer.from(
        bytes.toString().replace('<head>', '<head><script>window.__SIGNALS_LOCAL__=true;</script>'),
      );
    const kind = extname(file);
    response.writeHead(200, {
      'content-type':
        kind === '.js' ? 'text/javascript' : kind === '.css' ? 'text/css' : 'text/html',
      'x-content-type-options': 'nosniff',
    });
    response.end(bytes);
  })().catch(() => {
    if (!response.headersSent) response.writeHead(404);
    response.end();
  });
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') process.send?.({ type: 'ready', port: address.port });
});
