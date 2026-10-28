import { test, expect } from '@playwright/test';
import { openResearchOptions, selectEvidenceResearch } from './research.js';

test('research controls recover after an initial session failure and a successful settings save', async ({
  page,
}) => {
  let sessionRequests = 0;
  await page.route('**/__signals/api/session', async (route) => {
    sessionRequests += 1;
    if (sessionRequests === 1) {
      await route.fulfill({ status: 503, json: { code: 'temporary_session_unavailable' } });
    } else {
      await route.continue();
    }
  });
  await openResearchOptions(page, 'session recovery fixture');
  await expect(page.getByText('Local bridge unavailable.', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Start online research', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('complementary')
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Settings saved.');
  await page
    .getByRole('complementary')
    .getByRole('button', { name: 'Search', exact: true })
    .click();
  await page.getByLabel('Find something useful', { exact: true }).fill('session recovery fixture');
  await page.getByRole('button', { name: 'Research online', exact: true }).click();
  await selectEvidenceResearch(page);
  await expect(
    page.getByRole('button', { name: 'Start online research', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Find sources without AI', exact: true }),
  ).toBeEnabled();
  expect(sessionRequests).toBe(2);
});
