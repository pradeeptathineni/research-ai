import { expect, test } from '@playwright/test';

test('reviews, imports, cold reopens and exports one public feed without fetching it', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  const feed = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.atom';
  const opml = `<?xml version="1.0"?><opml version="2.0"><body><outline text="USGS earthquakes" type="atom" xmlUrl="${feed}"/></body></opml>`;
  const acquired: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith('https://earthquake.usgs.gov/')) acquired.push(request.url());
  });
  await page.goto('');
  await page.getByRole('complementary').getByRole('button', { name: 'Following' }).click();
  await page.getByRole('button', { name: 'Sources', exact: true }).click();
  await page.getByText('Import or export OPML sources').click();
  await page.getByLabel('OPML file (up to 1 MB)').setInputFiles({
    name: 'usgs-feed.opml',
    mimeType: 'text/xml',
    buffer: Buffer.from(opml),
  });
  await page.getByRole('button', { name: 'Preview OPML import' }).click();
  const review = page.getByRole('region', { name: 'OPML import preview' });
  await expect(review).toContainText('1 entries · 0 current · 1 after import');
  await expect(review).toContainText(`add: USGS earthquakes · ${feed}`);
  await page.screenshot({ path: testInfo.outputPath('opml-import-preview.png'), fullPage: true });
  await review.getByLabel('I reviewed these source changes.').check();
  let lostReply = false;
  await page.route('**/briefing/opml/import', async (route) => {
    if (lostReply) return route.continue();
    lostReply = true;
    await route.fetch();
    await route.abort('failed');
  });
  await review.getByRole('button', { name: 'Import reviewed sources' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Import saved.' })).toBeVisible();
  expect(lostReply).toBe(true);
  await expect(page.getByRole('group', { name: 'USGS earthquakes' })).toContainText(feed);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('opml-following-phone.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(acquired).toEqual([]);

  await page.reload();
  await page.getByRole('complementary').getByRole('button', { name: 'Following' }).click();
  await page.getByRole('button', { name: 'Sources', exact: true }).click();
  await expect(page.getByRole('group', { name: 'USGS earthquakes' })).toContainText(feed);
  await page.getByText('Import or export OPML sources').click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export saved sources' }).click();
  const saved = await download;
  const stream = await saved.createReadStream();
  let exported = '';
  for await (const chunk of stream as AsyncIterable<Uint8Array | string>)
    exported += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  expect(exported).toContain(feed);
  expect(exported).toContain('USGS earthquakes');
  expect(saved.suggestedFilename()).toBe('research-following.opml');
  expect(acquired).toEqual([]);

  await page.getByLabel('Source URL', { exact: true }).fill('https://example.test/unsaved.xml');
  await page.getByLabel('Source name', { exact: true }).fill('Unsaved source');
  await page.getByRole('button', { name: 'Add followed source' }).click();
  await page.getByLabel('OPML file (up to 1 MB)').setInputFiles({
    name: 'usgs-feed.opml',
    mimeType: 'text/xml',
    buffer: Buffer.from(opml),
  });
  await page.getByRole('button', { name: 'Preview OPML import' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Save or discard your other settings edits' }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('complementary').getByRole('button', { name: 'Following' }).click();
  await page.getByRole('button', { name: 'Sources', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Unsaved source' })).toHaveCount(0);
});
