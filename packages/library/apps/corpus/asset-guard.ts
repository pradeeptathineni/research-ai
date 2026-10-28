import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { isFileLoadingAllowed, normalizePath, type Connect, type ResolvedConfig } from 'vite';

function contains(root: string, file: string): boolean {
  const path = relative(root, file);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

// Resolve existing parents too: missing routes can still cross a directory symlink
async function physicalPath(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    const parent = dirname(file);
    if (parent === file) throw error;
    return resolve(await physicalPath(parent), basename(file));
  }
}

// Vite compiles fs.deny during config resolution, before configureServer runs.
// Include the physical root even when only its symlinked parent exists yet.
export async function privateAssetDenials(roots: string[]): Promise<string[]> {
  const paths = await Promise.all(
    roots.map(async (root) => [
      normalizePath(resolve(root)),
      normalizePath(await physicalPath(root)),
    ]),
  );
  return [...new Set(paths.flat())].flatMap((path) => {
    if (/[[\]{}*?!()|]/.test(path)) throw new Error('Private asset roots must be literal paths.');
    return [path, `${path}/**`];
  });
}

// sirv tries p and p/index even with extensions:[]; HTML fallback also tries
// p.html and p/index.html. resolve() normalizes both trailing-slash spellings.
const fileCandidates = (file: string, mountRoot = false): string[] => [
  file,
  // A mount-root request never names its sibling root.html.
  ...(!mountRoot ? [`${file}.html`] : []),
  resolve(file, 'index'),
  resolve(file, 'index.html'),
];

export async function assetGuard(
  config: ResolvedConfig,
  queryDirectory: string,
  preview = false,
): Promise<Connect.NextHandleFunction> {
  const output = resolve(config.root, config.build.outDir);
  const physicalOutput = preview ? await realpath(output) : '';
  const privateQueries = await physicalPath(queryDirectory);
  const physicalConfig = {
    ...config,
    server: {
      ...config.server,
      fs: {
        ...config.server.fs,
        allow: await Promise.all(config.server.fs.allow.map(physicalPath)),
      },
    },
  };
  async function allowed(file: string): Promise<boolean> {
    const physical = await physicalPath(file);
    if (preview) return contains(output, file) && contains(physicalOutput, physical);
    return (
      isFileLoadingAllowed(config, normalizePath(file)) &&
      isFileLoadingAllowed(physicalConfig, normalizePath(physical)) &&
      !contains(privateQueries, physical)
    );
  }
  return (request, response, next) => {
    void (async () => {
      // Run before Vite's base rewriting, cached transforms, public and static serving
      const raw = request.url?.split(/[?#]/, 1)[0] ?? '';
      let path: string;
      try {
        path = decodeURIComponent(raw);
        // sirv uses decodeURI while transforms/HTML use decodeURIComponent.
        // Ambiguous reserved encodings cannot authorize a different disk name.
        if (decodeURI(raw) !== path) throw new Error('ambiguous_asset_path');
      } catch {
        throw new Error('invalid_asset_path');
      }
      if (!path.startsWith('/') || /[\\\0%]/.test(path)) throw new Error('invalid_asset_path');
      if (path.startsWith(config.base)) path = `/${path.slice(config.base.length)}`;
      // Vite also accepts absolute JSON imports, including /@id//absolute.
      // Refuse locators naming this known private root before SPA fallback;
      // compiled fs.deny separately protects resolved module reads.
      const locator = path.startsWith('/@id/') ? path.slice('/@id/'.length) : path;
      if (!preview && isAbsolute(locator) && contains(privateQueries, resolve(locator)))
        throw new Error('private_asset');
      const targets = preview
        ? [resolve(output, `.${path}`)]
        : path.startsWith('/@fs/')
          ? [resolve(path.slice('/@fs'.length))]
          : [
              resolve(config.root, `.${path}`),
              ...(config.publicDir ? [resolve(config.publicDir, `.${path}`)] : []),
            ];
      const mountRoots = [output, config.root, config.publicDir];
      const files = targets.flatMap((file) => fileCandidates(file, mountRoots.includes(file)));
      files.push(resolve(preview ? output : config.root, 'index.html'));
      for (const file of files) if (!(await allowed(file))) throw new Error('private_asset');
      next();
    })().catch(() => {
      response.writeHead(403, { 'content-type': 'text/plain' });
      response.end('Forbidden');
    });
  };
}
