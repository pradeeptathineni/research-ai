import { mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

test('preview refuses a planted output escape while public assets and SPA routes remain usable', async ({
  request,
}) => {
  const privateFile = resolve('.signals/test-private/preview-asset-guard.json');
  const link = resolve('dist/public-site/assets/preview-asset-guard.json');
  const directoryLink = resolve('dist/public-site/preview-asset-guard');
  await mkdir('.signals/test-private', { recursive: true });
  await writeFile(privateFile, '{"private":"preview-private-canary"}', { flag: 'wx' });
  await symlink(privateFile, link);
  await symlink(resolve('.signals/test-private'), directoryLink);
  try {
    for (const suffix of [
      '',
      '?raw',
      '?import',
      '?vite-wasm-instance',
      '?vite-wasm-instance&import',
    ]) {
      const response = await request.get(`assets/preview-asset-guard.json${suffix}`);
      const body = await response.text();
      console.log(
        JSON.stringify({
          suffix,
          status: response.status(),
          canary: body.includes('preview-private-canary'),
        }),
      );
      expect.soft(response.status()).toBe(403);
      expect.soft(body).toBe('Forbidden');
    }
    expect((await request.get('preview-asset-guard/preview-asset-guard.json')).status()).toBe(403);
    const library = await request.get('library.json');
    expect(library.status()).toBe(200);
    expect(await library.json()).toEqual(
      JSON.parse(await readFile('dist/public-site/library.json', 'utf8')),
    );
    const index = await request.get('');
    const html = await index.text();
    expect(index.status()).toBe(200);
    const module = html.match(/src="([^"]+\/assets\/[^"]+\.js)"/)?.[1];
    expect(module).toBeDefined();
    expect((await request.get(module!)).status()).toBe(200);
    const route = await request.get('ordinary-library-route');
    expect(route.status()).toBe(200);
    expect(await route.text()).toBe(html);
    // Missing private-looking routes can be SPA HTML; that alone is not disclosure
    const missing = await request.get('/signals-ai/.signals/not-an-asset.json');
    expect(await missing.text()).not.toContain('preview-private-canary');
  } finally {
    await unlink(directoryLink);
    await unlink(link);
    await unlink(privateFile);
  }
});
