import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import {
  createLibraryIndex,
  type LibraryFinding,
} from '../../packages/domain/src/library-search.js';

const findings = JSON.parse(
  await readFile('dist/public-data/library.json', 'utf8'),
) as LibraryFinding[];

test('public browsing searches the entire approved library without local or model calls', async ({
  page,
}) => {
  const localCalls: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('__signals')) localCalls.push(request.url());
  });
  await page.goto('');
  await expect(page.locator('.desk-finding').first()).toBeVisible();
  const query = 'water meter';
  await page.getByLabel('Find something useful', { exact: true }).fill(query);
  const expected = createLibraryIndex(findings)
    .search(query)
    .map((hit) => hit.finding.key);
  expect(
    await page
      .locator('.desk-finding')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-finding-key'))),
  ).toEqual(expected.slice(0, 40));
  await page.getByLabel('Access & license').selectOption('open-source');
  const filtered = createLibraryIndex(findings)
    .search(query, { acquisition: 'open-source' })
    .map((hit) => hit.finding.key);
  expect(
    await page
      .locator('.desk-finding')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-finding-key'))),
  ).toEqual(filtered.slice(0, 40));
  await expect(page.getByRole('button', { name: 'Research online', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Projects', exact: true })).toHaveCount(0);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Export public Library', exact: true }).click();
  const stream = await (await downloadEvent).createReadStream();
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(Buffer.from(part as Uint8Array));
  expect(JSON.parse(Buffer.concat(parts).toString())).toEqual(findings);
  expect(
    findings.every(
      (finding) => finding.origin.destination === 'public' && finding.notes === undefined,
    ),
  ).toBe(true);
  expect(localCalls).toEqual([]);
});

test('supported evidence and comparison reflow with keyboard access and reduced motion', async ({
  page,
}) => {
  await page.goto('');
  await expect(page.locator('.desk-finding').first()).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: /Skip to/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#desk-content')).toBeFocused();
  await page
    .locator('.desk-finding')
    .nth(0)
    .getByRole('button', { name: 'Compare', exact: true })
    .click();
  await page
    .locator('.desk-finding')
    .nth(1)
    .getByRole('button', { name: 'Compare', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Compare selected findings' }).locator('article'),
  ).toHaveCount(2);
  await page
    .locator('.desk-finding')
    .first()
    .getByText('Evidence & details', { exact: true })
    .click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    if (process.env.SIGNALS_SCREENSHOT_DIR) {
      await mkdir(process.env.SIGNALS_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({
        path: join(process.env.SIGNALS_SCREENSHOT_DIR, `public-corpus-${width}.png`),
        fullPage: true,
      });
    }
  }
  await page.evaluate(() => {
    document.documentElement.style.zoom = '2';
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('public transport failures and malformed records retain the shell and allow retry', async ({
  page,
}) => {
  await page.route('**/library.json', (route) =>
    route.fulfill({ status: 503, body: 'unavailable' }),
  );
  await page.goto('');
  await expect(page.getByRole('alert')).toContainText('could not be loaded');
  await page.unroute('**/library.json');
  await page.getByRole('button', { name: 'Reload library' }).click();
  await expect(page.locator('.desk-finding').first()).toBeVisible();
  await page.route('**/library.json', (route) => route.fulfill({ json: [{}] }));
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('incomplete');
  await page.unroute('**/library.json');
  await page.getByRole('button', { name: 'Reload library' }).click();
  await expect(page.locator('.desk-finding').first()).toBeVisible();
});
