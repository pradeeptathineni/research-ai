import { createServer } from 'node:http';
import { readFile, realpath, lstat } from 'node:fs/promises';
import { resolve, relative, extname } from 'node:path';
import { searchApi } from '../packages/corpus/src/search-api.js';
const api = searchApi(resolve(process.env.SIGNALS_WORKSPACE ?? process.cwd()));
const assets = await realpath(resolve('dist/public-site'));
const port = Number(process.env.SIGNALS_PORT ?? 5178);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port.');
const types: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.sha256': 'text/plain',
};
const server = createServer((request, response) => {
  void (async () => {
    if (await api(request, response)) return;
    if (
      request.headers.host !== `127.0.0.1:${port}` ||
      (request.headers.origin && request.headers.origin !== `http://127.0.0.1:${port}`) ||
      request.method !== 'GET'
    ) {
      response.writeHead(403);
      response.end();
      return;
    }
    const raw = request.url?.split('?')[0] ?? '';
    if (/%|\\|\.\.|\/\./.test(raw) || !raw.startsWith('/signals-ai/')) {
      response.writeHead(404);
      response.end();
      return;
    }
    const path = raw.slice('/signals-ai/'.length) || 'index.html';
    if (
      !/^(?:index\.html|corpus\.json|entities\.json|library\.json|assets\/[a-zA-Z0-9._-]+|bundles\/[a-zA-Z0-9._-]+)$/.test(
        path,
      )
    ) {
      response.writeHead(404);
      response.end();
      return;
    }
    const file = resolve(assets, path);
    if (
      (await lstat(file)).isSymbolicLink() ||
      relative(assets, await realpath(file)).startsWith('..')
    )
      throw new Error('asset_escape');
    let bytes = await readFile(file);
    if (path === 'index.html')
      bytes = Buffer.from(
        bytes.toString().replace('<head>', '<head><script>window.__SIGNALS_LOCAL__=true;</script>'),
      );
    response.writeHead(200, {
      'content-type': types[extname(file)] ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    response.end(bytes);
  })().catch(() => {
    if (!response.headersSent) response.writeHead(404);
    response.end();
  });
});
server.listen(port, '127.0.0.1', () =>
  process.stderr.write(`Signals workbench: http://127.0.0.1:${port}/signals-ai/\n`),
);
