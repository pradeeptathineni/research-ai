import { expect, test } from '@playwright/test';

test('reviews and appends one independent lens over a retained capture, then cold reopens it', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  let appendRequests = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/perspective-workflows\/[0-9a-f-]+\/perspectives$/u.test(request.url())
    )
      appendRequests++;
  });

  await page.goto('');
  await page
    .getByRole('complementary')
    .getByRole('button', { name: 'Search', exact: true })
    .click();
  await page.getByRole('button', { name: 'Research online', exact: true }).click();
  const openPerspectives = page.getByRole('button', {
    name: 'Independent perspectives from retained captures',
    exact: true,
  });
  await expect(openPerspectives).toBeVisible();
  await openPerspectives.click();

  const capturePicker = page.getByLabel('Retained source captures (select 1–8)');
  const captureOption = capturePicker.locator('option').filter({
    hasText: 'https://example.test/rs04-retained-source',
  });
  await expect(captureOption).toHaveCount(1);
  const captureValue = await captureOption.getAttribute('value');
  expect(captureValue).not.toBeNull();
  await capturePicker.selectOption(captureValue ?? '');
  await page
    .getByLabel('Research topic')
    .fill('What does this retained study say, and what limitations does it state?');
  await page.getByRole('button', { name: 'Save frozen workflow', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('No provider request has run');

  await page.getByRole('button', { name: 'Run Basic Facts', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Basic facts · complete', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Perspective span contributions', exact: true }),
  ).toContainText('short-term reduction');

  await page.getByLabel('Perspective label').fill('Limitations lens');
  await page
    .getByLabel('Perspective focus')
    .fill('Identify explicitly stated limits on follow-up and interpretation.');
  await page.getByRole('button', { name: 'Preview independent lens', exact: true }).click();
  const preview = page.getByRole('region', { name: 'Perspective addition preview', exact: true });
  await expect(preview).toContainText('Limitations lens');
  await expect(preview).toContainText('No comparison or outline history will be marked stale.');
  await expect(preview).toContainText('Comparisons marked stale: none');
  await preview
    .getByLabel('I reviewed this lens and the historical comparison qualification.')
    .check();
  const append = page.getByRole('button', { name: 'Request this lens once', exact: true });
  await append.focus();
  await page.keyboard.press('Enter');

  const contributions = page.getByRole('region', {
    name: 'Perspective span contributions',
    exact: true,
  });
  await expect(contributions).toContainText('short-term reduction');
  await expect(contributions).toContainText('Follow-up lasted six months.');
  await expect(
    contributions.getByRole('region', { name: 'Shared cited spans' }).last(),
  ).toContainText('short-term reduction');
  await expect(
    contributions.getByRole('region', { name: 'Cited in recorded conflicts' }).last(),
  ).toContainText('No exact cited spans in this category.');
  expect(appendRequests).toBe(1);

  await page.reload();
  await page
    .getByRole('complementary')
    .getByRole('button', { name: 'Search', exact: true })
    .click();
  await page.getByRole('button', { name: 'Research online', exact: true }).click();
  await page
    .getByRole('button', {
      name: 'Independent perspectives from retained captures',
      exact: true,
    })
    .click();
  const workflowCard = page
    .getByRole('list', { name: 'Saved perspective workflows' })
    .getByRole('listitem');
  await expect(workflowCard).toContainText('Revision 2 · complete');
  const reopen = workflowCard.getByRole('button', { name: 'Reopen exact workflow', exact: true });
  await reopen.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByText('Reopened workflow revision 2 from its exact saved reference.'),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Perspective span contributions' })).toContainText(
    'Follow-up lasted six months.',
  );
  expect(appendRequests).toBe(1);

  await page.setViewportSize({ width: 1440, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('rs04-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('rs04-phone.png'), fullPage: true });
});
