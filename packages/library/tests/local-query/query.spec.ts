import { expect, test } from '@playwright/test';
import { readFile, unlink, writeFile, mkdir, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';

for (const suffix of ['', '?raw', '?import', '?vite-wasm-instance', '?vite-wasm-instance&import']) {
  test(`private assets and their symlinks stay denied with ${suffix || 'no query'}`, async ({
    request,
  }) => {
    const file = resolve('.signals/test-private/privacy-probe.wasm');
    const link = resolve('apps/corpus/privacy-probe.wasm');
    await mkdir('.signals/test-private', { recursive: true });
    const canary = Buffer.from('private-asset-canary');
    // Valid WASM with an inert custom section: parsing must not create a Vite
    // error overlay that would mask later ordinary browser interactions.
    await writeFile(
      file,
      Buffer.concat([Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 0, canary.length + 1, 0]), canary]),
    );
    await symlink(file, link);
    try {
      for (const url of [`/signals-ai/@fs${file}`, '/signals-ai/privacy-probe.wasm']) {
        const response = await request.get(url + suffix);
        const body = await response.text();
        console.log(
          JSON.stringify({
            url: url + suffix,
            status: response.status(),
            canary: body.includes('private-asset-canary'),
            transform: body.includes('export '),
          }),
        );
        expect.soft(response.status(), url + suffix).toBe(403);
        expect.soft(body).not.toContain('private-asset-canary');
        expect.soft(body).toBe('Forbidden');
      }
    } finally {
      await unlink(link);
      await unlink(file);
    }
  });
}

test('canonical query/env exclusions, decoded paths and safe links preserve dev modules', async ({
  request,
}) => {
  await mkdir('private-query-probe', { recursive: true });
  const privateFiles = [
    resolve('private-query-probe/asset-guard.json'),
    resolve('apps/corpus/.env.asset-guard'),
  ];
  const safe = resolve('apps/corpus/asset-guard-safe.js');
  const safeLink = resolve('apps/corpus/asset-guard-link.js');
  const publicLink = resolve('dist/public-data/asset-guard-public.js');
  const privateLink = resolve('apps/corpus/asset-guard-private.json');
  await writeFile(safe, 'export const safe = "public-module-control";\n', { flag: 'wx' });
  await symlink(safe, safeLink);
  await symlink(safe, publicLink);
  try {
    for (const file of privateFiles) {
      await writeFile(file, '{"private":"canonical-private-canary"}', { flag: 'wx' });
      await symlink(file, privateLink);
      try {
        for (const url of [`/signals-ai/@fs${file}`, '/signals-ai/asset-guard-private.json']) {
          const blocked = await request.get(`${url}?raw`);
          const body = await blocked.text();
          console.log(
            JSON.stringify({
              url,
              status: blocked.status(),
              canary: body.includes('canonical-private-canary'),
            }),
          );
          expect.soft(blocked.status()).toBe(403);
          expect.soft(body).toBe('Forbidden');
        }
      } finally {
        await unlink(privateLink);
        await unlink(file);
      }
    }
    for (const path of ['%ZZ', '%2eenv.asset-guard']) {
      const malformed = await request.get(`/signals-ai/${path}`);
      expect(malformed.status()).toBe(403);
      expect(await malformed.text()).toBe('Forbidden');
    }
    // Vite registers new public files asynchronously through its watcher.
    // Wait only for this authored positive; private refusals above stay immediate.
    const publicUrl = '/signals-ai/asset-guard-public.js';
    await expect
      .poll(
        async () => {
          const response = await request.get(publicUrl);
          const body = await response.text();
          const contentType = response.headers()['content-type'] ?? '';
          const observation = {
            url: publicUrl,
            status: response.status(),
            contentType,
            javascript: /^(?:text|application)\/javascript(?:;|$)/.test(contentType),
            marker: body.includes('public-module-control'),
            html: /<!doctype html|<html/i.test(body),
          };
          console.log(JSON.stringify({ publicFixtureReadiness: observation }));
          return observation;
        },
        { timeout: 3000, intervals: [25, 50, 100, 250] },
      )
      .toMatchObject({ status: 200, javascript: true, marker: true, html: false });
    for (const path of [
      'asset-guard-link.js?import',
      'asset-guard-public.js',
      '@vite/client',
      'src/main.tsx',
    ]) {
      const permitted = await request.get(`/signals-ai/${path}`);
      expect(permitted.status(), path).toBe(200);
      if (path.startsWith('asset-guard-'))
        expect(await permitted.text()).toContain('public-module-control');
    }
  } finally {
    await unlink(publicLink);
    await unlink(safeLink);
    await unlink(safe);
  }
});

test('a local user saves an ordinary question without writing evidence artifacts', async ({
  page,
  request,
}) => {
  await page.goto('./?view=Search');
  await page.getByLabel('Find something useful', { exact: true }).fill('toilet dye');
  await page.getByText('Search options', { exact: true }).click();
  await page.getByText('Save this question', { exact: true }).click();
  const reply = page.waitForResponse(
    (r) => r.url().endsWith('/__signals/api/question') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Save question locally' }).click();
  await expect(page.getByText(/^Question saved privately/)).toBeVisible();
  const body = (await (await reply).json()) as { id: string };
  expect(body.id).toMatch(/^[a-f0-9-]+\.json$/);
  const file = `private-query-probe/${body.id}`;
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as {
      result: { question: string };
    };
    expect(value.result).toEqual({ question: 'toilet dye' });
  } finally {
    await unlink(file);
  }
  const denied = await request.post('__signals/api/question', {
    headers: { origin: 'https://example.com', 'content-type': 'application/json' },
    data: { question: 'Cross-origin write' },
  });
  expect(denied.status()).toBe(403);
  const customFile = resolve('private-query-probe/probe.json');
  await writeFile(customFile, '{"private":"custom query content"}');
  try {
    const blocked = await request.get(`/signals-ai/@fs${customFile}`);
    expect(blocked.status()).toBe(403);
    expect(await blocked.text()).not.toContain('custom query content');
  } finally {
    await unlink(customFile);
  }
  await mkdir('.signals/test-private', { recursive: true });
  const privateFile = resolve('.signals/test-private/query.json');
  await writeFile(privateFile, '{"private":"must never be served"}');
  try {
    const blocked = await request.get(`/signals-ai/@fs${privateFile}`);
    expect(blocked.status()).toBe(403);
    expect(await blocked.text()).not.toContain('must never be served');
  } finally {
    await unlink(privateFile);
  }
  await mkdir('.meta/context/local', { recursive: true });
  const contextFile = resolve('.meta/context/local/privacy-probe.json');
  await writeFile(contextFile, '{"private":"local authoring context"}');
  try {
    const blocked = await request.get(`/signals-ai/@fs${contextFile}`);
    expect(blocked.status()).toBe(403);
    expect(await blocked.text()).not.toContain('local authoring context');
  } finally {
    await unlink(contextFile);
  }
});
