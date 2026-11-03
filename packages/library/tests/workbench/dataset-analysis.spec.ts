import { expect, test } from '@playwright/test';

test('imports, analyzes and cold-reopens an exact synthetic CSV version', async ({ page }) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let analysisRuns = 0;
  const runBodies: Record<string, unknown>[] = [];
  let revisionBody: Record<string, unknown> | null = null;
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/analyses\/analysis-[^/]+\/run$/u.test(request.url())) {
      analysisRuns++;
      runBodies.push(request.postDataJSON() as Record<string, unknown>);
    }
    if (
      request.method() === 'POST' &&
      /\/analyses\/analysis-[^/]+\/revisions$/u.test(request.url())
    )
      revisionBody = request.postDataJSON() as Record<string, unknown>;
  });

  await page.goto('');
  const navigation = page.getByRole('complementary');
  await navigation.getByRole('button', { name: 'Data', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Datasets', exact: true })).toBeVisible();

  const file = page.getByLabel('CSV file (up to 1 MB)');
  await file.setInputFiles({
    name: 'rs07-synthetic.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('category,value\nalpha,10\nbeta,20\nalpha,30\n', 'utf8'),
  });
  await page
    .getByLabel('Source description (your assertion)')
    .fill('Synthetic RS07 browser fixture');
  await page.getByLabel('Source URI (optional)').fill('https://example.test/rs07-synthetic.csv');
  await page.getByLabel('License status (your assertion)').selectOption('known');
  await page.getByLabel('License name').fill('Synthetic test license');
  await page.getByLabel('License URI (optional)').fill('https://example.test/license');
  await page.getByLabel(/I confirm I am authorized to retain these bytes/u).check();
  await page.getByRole('button', { name: 'Save dataset version', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Saved version 1');

  const reopenDataset = page.getByRole('button', { name: 'Reopen exact version', exact: true });
  await reopenDataset.focus();
  await page.keyboard.press('Enter');
  const coldDataset = page.getByRole('region', { name: 'Cold reopen result', exact: true });
  await expect(coldDataset).toContainText('The exact bytes passed the SHA-256 check');
  await expect(coldDataset).toContainText('Synthetic RS07 browser fixture');
  await expect(coldDataset).toContainText('known · Synthetic test license');

  const parserReady = page.getByText('CSV parser: configured, pending Methods verification', {
    exact: true,
  });
  await expect(parserReady).toBeVisible();
  const parse = page.getByRole('button', {
    name: 'Parse and inspect this exact version',
    exact: true,
  });
  await expect(parse).toBeEnabled();
  await parse.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Parsed table', exact: true })).toBeVisible();
  await expect(page.getByRole('table')).toContainText('alpha');
  await expect(page.getByText('values remain text.', { exact: false })).toBeVisible();
  await expect(page.getByText(/parser csv-parse 7\.0\.3/u)).toBeVisible();

  await page.getByLabel('Analysis title').fill('Synthetic category counts');
  await page
    .getByLabel('Bar chart category (counts rows per category)')
    .selectOption({ label: 'category' });
  await page
    .getByRole('button', { name: 'Save analysis and chart definition', exact: true })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Saved analysis revision 1.' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Preview compiled SQL', exact: true }).click();
  const review = page.getByRole('region', { name: 'Compiled query review', exact: true });
  await expect(review).toContainText('SELECT * FROM sample');
  await expect(review.locator('pre').nth(1)).toContainText(/count\s*\(/iu);
  await expect(review).toContainText('Query digest');
  await review
    .getByLabel('I reviewed both compiled queries and their exact input digests.')
    .check();

  await expect(
    page.getByRole('button', { name: 'Run and save result', exact: true }),
  ).toBeEnabled();
  await page.route(/\/analyses\/analysis-[^/]+\/run$/u, async (route) => {
    await route.fetch();
    await route.fulfill({
      status: 502,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'fixture_lost_response' }),
    });
  });
  await page.getByRole('button', { name: 'Run and save result', exact: true }).click();
  await expect(page.getByRole('button', { name: /Reopen recovered run/u })).toBeVisible();
  await page.getByRole('button', { name: /Reopen recovered run/u }).click();
  await page.unroute(/\/analyses\/analysis-[^/]+\/run$/u);
  expect(runBodies.at(-1)?.reviewedQueryDigests).toMatchObject({
    steps: [{ step: 's1', queryDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) }],
    chart: expect.stringMatching(/^[a-f0-9]{64}$/u),
  });
  const savedResult = page.getByRole('region', { name: 'Saved analysis result', exact: true });
  await expect(savedResult).toBeVisible();
  await expect(savedResult).toContainText('Run state: complete');
  await expect(savedResult).toContainText('alpha');
  await expect(page.getByRole('region', { name: 'Saved chart data', exact: true })).toContainText(
    'alpha',
  );
  const savedRunDigest = await savedResult.locator('code').first().innerText();
  await expect(savedRunDigest).toMatch(/^[a-f0-9]{64}$/u);
  expect(analysisRuns).toBe(1);

  await page.getByLabel('Analysis title').fill('Synthetic category counts revision two');
  await page.getByLabel('SQL table name').fill('sample_v2');
  const saveRevision = page.getByRole('button', {
    name: 'Save a new analysis revision',
    exact: true,
  });
  await expect(saveRevision).toBeEnabled();
  await saveRevision.click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Saved analysis revision 2.' }),
  ).toBeVisible();
  expect(Object.keys(revisionBody ?? {}).sort()).toEqual([
    'chart',
    'expectedHead',
    'steps',
    'tableName',
    'title',
  ]);
  await page.getByRole('button', { name: 'Preview compiled SQL', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Compiled query review', exact: true }),
  ).toContainText('SELECT * FROM sample_v2');

  await page.reload();
  await navigation.getByRole('button', { name: 'Data', exact: true }).click();
  await page.getByRole('button', { name: 'Reopen exact version', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Cold reopen result', exact: true })).toContainText(
    'Synthetic RS07 browser fixture',
  );

  const analysisPicker = page.getByLabel('Reopen saved analysis revision for this source version');
  await expect(analysisPicker.locator('option')).toHaveCount(3);
  const revisionOne = analysisPicker.locator('option').filter({ hasText: 'Revision 1 ·' });
  await analysisPicker.selectOption((await revisionOne.getAttribute('value'))!);
  await expect(page.getByText('Reopened analysis revision 1.', { exact: true })).toBeVisible();
  const runPicker = page.getByLabel('Reopen saved result');
  await expect(runPicker.locator('option')).toHaveCount(2);
  await runPicker.selectOption({ index: 1 });
  await expect(page.getByText(/Reopened saved run .*; no query was rerun\./u)).toBeVisible();
  const reopenedResult = page.getByRole('region', { name: 'Saved analysis result', exact: true });
  await expect(reopenedResult.locator('code').first()).toHaveText(savedRunDigest);
  await expect(reopenedResult).toContainText('alpha');
  expect(analysisRuns).toBe(1);

  await page.setViewportSize({ width: 1440, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 360, height: 800 });
  const narrowLayout = await page.evaluate(() => ({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    offenders: [...document.querySelectorAll('body *')]
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .slice(0, 8)
      .map((element) => ({
        tag: element.tagName,
        className: element.className,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        overflowX: getComputedStyle(element).overflowX,
      })),
  }));
  expect(narrowLayout, JSON.stringify(narrowLayout)).toMatchObject({
    width: 360,
    scrollWidth: 360,
  });
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
    true,
  );
  expect(
    await page
      .locator('.dataset-workbench button')
      .first()
      .evaluate((element) => getComputedStyle(element).transitionDuration),
  ).toBe('0s');
});
