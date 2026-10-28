import { test, expect } from '@playwright/test';
import { openResearchOptions } from './research.js';
import { expectAccessibleViewport } from './accessibility.js';

test('opt-in offers stay unverified and explicit edited selection uses its own immutable parent', async ({
  page,
}) => {
  const question = 'answer receipt browser fixture; no uploading recordings.';
  await openResearchOptions(page, question);
  await page
    .getByRole('combobox', { name: 'Research method', exact: true })
    .selectOption('answer-first');
  await page
    .getByRole('checkbox', { name: 'Suggest a few decision-critical checks (unverified)' })
    .check();
  await page.getByRole('button', { name: 'Start online research', exact: true }).click();
  const offered = page.getByRole('region', { name: 'Suggested checks', exact: true });
  await expect(offered).toContainText('whole-item Signal unassessed');
  await expect(offered).toContainText('Unknown');
  await expect(page.getByRole('region', { name: 'Research brief', exact: true })).toContainText(
    'aurora quill constellation',
  );
  const claim = 'Edited no-upload export proposition.';
  await offered.getByRole('textbox', { name: 'Suggested proposition 1', exact: true }).fill(claim);
  await expectAccessibleViewport(page, 390);
  let received: Record<string, unknown> | undefined;
  await page.route('**/__signals/api/capture', async (route) => {
    received = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 400, json: { code: 'suggestion_fixture_stopped' } });
  });
  await offered.getByRole('button', { name: 'Check selected suggestion 1', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('suggestion_fixture_stopped', { exact: true })).toBeVisible();
  expect(received).toMatchObject({
    query: question,
    claimText: claim,
    suggestionIndex: 0,
    captureUrls: ['https://example.com/tool#export'],
    method: 'native',
    cache: 'private',
    save: 'never',
  });
  expect(received?.assessmentOf).toMatch(/^[a-f0-9-]{36}$/);
  expect(received?.offeredDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(received).not.toHaveProperty('claimOrigin');
});

test('stale nomination option does not leak into an ordinary form request', async ({ page }) => {
  await openResearchOptions(page, 'answer receipt browser fixture');
  const method = page.getByRole('combobox', { name: 'Research method', exact: true });
  await method.selectOption('answer-first');
  await page
    .getByRole('checkbox', { name: 'Suggest a few decision-critical checks (unverified)' })
    .check();
  await method.selectOption('native');
  let received: Record<string, unknown> | undefined;
  await page.route('**/__signals/api/search', async (route) => {
    received = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 400, json: { code: 'ordinary_fixture_stopped' } });
  });
  await page.getByRole('button', { name: 'Start online research', exact: true }).click();
  await expect(page.getByText('ordinary_fixture_stopped', { exact: true })).toBeVisible();
  expect(received).toMatchObject({ method: 'native' });
  expect(received).not.toHaveProperty('suggestChecks');
  expect(received).not.toHaveProperty('suggestionIndex');
});
