import { createServer, preview, isFileLoadingAllowed, normalizePath } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Actual project config/API, disposable cwd and authored readiness-only PATH.
const project = fileURLToPath(new URL('../../', import.meta.url));
const root = process.cwd();
const options = {
  configFile: resolve(project, 'apps/corpus/vite.config.ts'),
  root: resolve(root, 'app'),
  publicDir: resolve(root, 'public'),
  cacheDir: resolve(root, 'cache'),
  build: { outDir: resolve(root, 'output') },
  server: { host: '127.0.0.1', port: 0, strictPort: true, fs: { allow: [root, project] } },
  preview: { host: '127.0.0.1', port: 0, strictPort: true },
  logLevel: 'error' as const,
};
const server = process.argv[2] === 'preview' ? await preview(options) : await createServer(options);
if ('listen' in server) await server.listen();
const listener = server.httpServer!;
const address = listener.address();
if (!address || typeof address === 'string') throw new Error('no_port');
process.send?.({
  port: address.port,
  canonicalQueryAllowed: isFileLoadingAllowed(server.config, normalizePath(process.argv[3]!)),
});
process.once('SIGTERM', () => {
  const closed =
    'close' in server ? server.close() : new Promise<void>((done) => listener.close(() => done()));
  void closed.then(() => process.exit(0));
});
