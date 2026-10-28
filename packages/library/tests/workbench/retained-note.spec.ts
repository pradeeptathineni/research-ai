import { test, expect, type Page } from '@playwright/test';
import { openResearchOptions } from './research.js';

async function activityOpen(page: Page, query: string, status: string) {
  await page
    .getByRole('complementary')
    .getByRole('button', { name: 'Activity', exact: true })
    .click();
  await page
    .getByRole('region', { name: 'Recent research', exact: true })
    .getByRole('article')
    .filter({ hasText: query })
    .filter({ hasText: `${status} ·` })
    .getByRole('button', { name: 'Open result', exact: true })
    .click();
}
async function savedNote(page: Page, query: string) {
  await openResearchOptions(page, query);
  await page.getByRole('button', { name: 'Start online research', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Research brief', exact: true })).toContainText(
    'Current support is unresolved',
  );
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByText(/Research cancelled/)).toBeVisible();
  await activityOpen(page, query, 'cancelled');
  const form = page.getByRole('region', { name: 'Check retained notes', exact: true });
  await expect(form).toBeVisible();
  await expect(form).toContainText('after original-run expiry or deletion');
  return form;
}

for (const supported of [false, true]) {
  test(`saved-note Activity/Open performs an explicit ${supported ? 'supported fixture' : 'denied'} check and reopens both scopes`, async ({
    page,
  }) => {
    const query = `partial note fixture ${supported ? 'supported' : 'denied'}`;
    const form = await savedNote(page, query);
    const proposition = supported
      ? 'The selected guide states the needed prerequisite.'
      : 'Check an inaccessible source declaration.';
    await page.getByLabel('Proposition from retained notes', { exact: true }).fill(proposition);
    const submitted = page.waitForRequest(
      (r) => r.url().endsWith('/__signals/api/capture') && r.method() === 'POST',
    );
    await form.getByRole('button', { name: 'Check this original citation', exact: true }).click();
    const body = (await submitted).postDataJSON() as {
      assessmentOf: string;
      claimText: string;
      captureUrls: string[];
      parentSnapshotDigest: string;
      claimCitations: { groupIndex: number; occurrenceIndex: number }[];
      claimOrigin: string;
    };
    expect(body.claimText).toBe(proposition);
    expect(body.captureUrls).toEqual(['https://example.com/guide']);
    expect(body.claimOrigin).toBe('retained-partial');
    expect(body.parentSnapshotDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(body.claimCitations).toEqual([{ groupIndex: 0, occurrenceIndex: 0 }]);
    const check = page.getByRole('region', { name: 'Selected proposition check', exact: true });
    await expect(check).toContainText('retained incomplete notes');
    await expect(check).toContainText(supported ? 'Verdict: supported' : 'Not available');
    await expect(check).toContainText('Confidence Unknown');
    if (!supported) await expect(check).toContainText('denied');
    await activityOpen(page, query, 'partial');
    await expect(check).toContainText(proposition);
    await check.getByText('Copied incomplete notes', { exact: true }).click();
    await expect(check).toContainText('Current support is unresolved');
    await page.getByRole('button', { name: 'Reopen original notes', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Research brief', exact: true })).toContainText(
      'Current support is unresolved',
    );
    await expect(page.getByLabel('Proposition from retained notes', { exact: true })).toHaveValue(
      '',
    );
  });
}

test('an expired original is not restored and its saved child remains visibly self-contained', async ({
  page,
}) => {
  const query = 'partial note fixture expired';
  const form = await savedNote(page, query);
  await page
    .getByLabel('Proposition from retained notes', { exact: true })
    .fill('The selected guide states the needed prerequisite.');
  await form.getByRole('button', { name: 'Check this original citation', exact: true }).click();
  const check = page.getByRole('region', { name: 'Selected proposition check', exact: true });
  await expect(check).toContainText('Verdict: supported');
  await expect(
    page.getByRole('button', { name: 'Reopen original notes', exact: true }),
  ).toBeDisabled();
  await expect(page.getByText(/Original run no longer retained/)).toBeVisible();
  await activityOpen(page, query, 'partial');
  await expect(check).toContainText('Verdict: supported');
  await check.getByText('Copied incomplete notes', { exact: true }).click();
  await expect(check).toContainText('Current support is unresolved');
});
