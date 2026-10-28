import { test, expect, type Page } from '@playwright/test';
import { expectAccessibleViewport } from './accessibility.js';
import { openResearchOptions } from './research.js';
import { selectedExampleQuery } from '../../scripts/examples/selected-primary.js';

test('offline page selection and registered synthetic host survive cold Activity/Open without another check', async ({
  page,
  request,
}) => {
  const setup = await request.post('__fixture/selected-primary');
  expect(setup.ok()).toBe(true);
  expect(await setup.json()).toEqual({ scripted: true, actualNativeCalls: 0 });
  let checkRequests = 0;
  await page.route('**/__signals/api/capture', async (route) => {
    checkRequests++;
    await route.abort();
  });
  const openSaved = async () => {
    await page
      .getByRole('complementary')
      .getByRole('button', { name: 'Activity', exact: true })
      .click();
    const row = page
      .getByRole('region', { name: 'Recent research', exact: true })
      .locator('article')
      .filter({ hasText: selectedExampleQuery });
    const open = row.getByRole('button', { name: 'Open result', exact: true });
    await open.focus();
    await open.press('Enter');
  };
  await page.goto('/signals-ai/');
  await openSaved();
  const receipt = page.getByRole('region', { name: 'Selected proposition check', exact: true });
  await expect(receipt).toContainText('selected PDF text-layer windows');
  await expect(receipt).toContainText('Authored scripted fixture');
  await expect(receipt).toContainText('Confidence Unknown');
  await expect(receipt).toContainText('No numeric Signal');
  await expect(receipt).toContainText('separate full normalized extraction copy');
  await expect(receipt).toContainText('Selected pages: 1, 2. Unread pages: 3, 4');
  await expect(receipt).toContainText('Original UTF16/page bindings: 0–31, pages 1–1');
  await expect(
    receipt.getByRole('link', { name: 'Selected source 1', exact: true }),
  ).toHaveAttribute('href', 'https://example.org/manual.pdf');
  await expectAccessibleViewport(page, 390);
  await page.reload();
  await openSaved();
  await expect(receipt).toContainText('Only water cooling is approved.');
  expect(checkRequests).toBe(0);
});

async function primaryCheck(page: Page, question: string) {
  await openResearchOptions(page, question);
  await page
    .getByRole('combobox', { name: 'Research method', exact: true })
    .selectOption('primary-check');
}

test('primary check sends ordered selected URLs and explicit request authority without an answer parent', async ({
  page,
}) => {
  let submitted: unknown;
  await page.route('**/__signals/api/capture', async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ status: 400, json: { code: 'primary_payload_fixture_stopped' } });
  });
  const question = 'Does the policy cover transfer, rather than only display?';
  await primaryCheck(page, question);
  const start = page.getByRole('button', { name: 'Check primary sources', exact: true });
  await expect(start).toBeDisabled();
  await page
    .getByRole('textbox', { name: 'Proposition to check against primary sources', exact: true })
    .fill('The policy permits transfer.');
  await page
    .getByRole('textbox', { name: 'Primary source URLs', exact: true })
    .fill('https://example.org/policy\nhttps://example.com/limitations');
  await page.getByText('Project context and constraints', { exact: true }).click();
  await page
    .getByLabel('Context for this question')
    .fill('No private records or account operations.');
  await start.click();
  await expect(page.getByText('primary_payload_fixture_stopped', { exact: true })).toBeVisible();
  expect(submitted).toEqual({
    query: question,
    context: 'No private records or account operations.',
    method: 'native',
    claimOrigin: 'request',
    claimText: 'The policy permits transfer.',
    captureUrls: ['https://example.org/policy', 'https://example.com/limitations'],
    profile: 'quick',
    review: false,
    cache: 'private',
    save: 'never',
  });
  await page
    .getByRole('textbox', { name: 'Primary source URLs', exact: true })
    .fill('https://example.org/a\nhttps://example.org/b\nhttps://example.org/c');
  await expect(start).toBeDisabled();
  await page.getByRole('combobox', { name: 'Research method', exact: true }).selectOption('native');
  await expect(
    page.getByRole('button', { name: 'Start online research', exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole('textbox', { name: 'Primary source URLs', exact: true })).toHaveCount(
    0,
  );
});

test('primary acquisition denial remains unreviewed and can be reopened from private Activity', async ({
  page,
}) => {
  const question = 'Primary browser denial fixture: does the policy establish an outcome?';
  await primaryCheck(page, question);
  await page
    .getByRole('textbox', { name: 'Proposition to check against primary sources', exact: true })
    .fill('The policy establishes an outcome.');
  await page
    .getByRole('textbox', { name: 'Primary source URLs', exact: true })
    .fill('https://example.org/policy');
  await expectAccessibleViewport(page, 390);
  await page.getByRole('button', { name: 'Check primary sources', exact: true }).click();
  const receipt = page.getByRole('region', { name: 'Selected proposition check', exact: true });
  await expect(receipt).toContainText('without an original research answer');
  await expect(receipt).toContainText('not-reviewed');
  await expect(receipt).toContainText('Not available');
  await expect(receipt).toContainText('Confidence Unknown');
  await expect(receipt).toContainText('No numeric Signal');
  await expect(receipt).toContainText('source_denied_403');
  await expect(receipt).toContainText('Saved privately with the original request');
  await page
    .getByRole('complementary')
    .getByRole('button', { name: 'Activity', exact: true })
    .click();
  const retained = page
    .getByRole('region', { name: 'Recent research', exact: true })
    .locator('article')
    .filter({ hasText: question });
  await retained.getByRole('button', { name: 'Open result', exact: true }).click();
  await expect(receipt).toContainText('The policy establishes an outcome.');
  await expect(receipt).toContainText('source_denied_403');
  await expectAccessibleViewport(page, 390);
});

test('unsupported primary sources show an honest handoff and reopen without another check', async ({
  page,
}) => {
  let checkRequests = 0;
  await page.route('**/__signals/api/capture', async (route) => {
    checkRequests++;
    await route.continue();
  });
  const cases = [
    {
      question: 'Primary unsupported PDF-like fixture: does the manual establish an outcome?',
      proposition: 'The manual establishes an outcome.',
      uri: 'https://example.org/unsupported-fixture.pdf',
      pdf: true,
    },
    {
      question: 'Primary unsupported shape fixture: does the download establish an outcome?',
      proposition: 'The download establishes an outcome.',
      uri: 'https://example.org/unsupported-fixture.bin',
      pdf: false,
    },
  ];
  for (const fixture of cases) {
    await page.goto('/signals-ai/');
    await primaryCheck(page, fixture.question);
    await page
      .getByRole('textbox', { name: 'Proposition to check against primary sources', exact: true })
      .fill(fixture.proposition);
    await page.getByRole('textbox', { name: 'Primary source URLs', exact: true }).fill(fixture.uri);
    await page.getByRole('button', { name: 'Check primary sources', exact: true }).click();
    const receipt = page.getByRole('region', { name: 'Selected proposition check', exact: true });
    const blocked = receipt.getByRole('region', { name: 'Blocked source check', exact: true });
    const verify = async () => {
      await expect(receipt).toContainText('not-reviewed');
      await expect(receipt).toContainText('Not available');
      await expect(blocked).toContainText(fixture.proposition);
      await expect(blocked).toContainText(fixture.uri);
      await expect(blocked).toContainText('unsupported_content');
      await expect(blocked).toContainText('does not fetch, resume a session');
      if (fixture.pdf) await expect(blocked).toContainText('does not prove PDF identity');
      await expect(blocked).toContainText('Other shapes have no converter');
      await expect(blocked.getByRole('link', { name: 'source recovery steps' })).toHaveAttribute(
        'href',
        'https://github.com/pradeeptathineni/signals-ai#when-a-selected-source-is-refused',
      );
      await expect(blocked).not.toContainText('Denied access');
    };
    await verify();
    const submitted = checkRequests;
    await page.reload();
    await page
      .getByRole('complementary')
      .getByRole('button', { name: 'Activity', exact: true })
      .click();
    await page
      .getByRole('region', { name: 'Recent research', exact: true })
      .locator('article')
      .filter({ hasText: fixture.question })
      .getByRole('button', { name: 'Open result', exact: true })
      .click();
    await verify();
    expect(checkRequests).toBe(submitted);
    await expectAccessibleViewport(page, 390);
  }
});

test('saved-question research cannot inherit unrelated primary drafts or lose its source scopes', async ({
  page,
}) => {
  await primaryCheck(page, 'An unrelated primary-source question.');
  await page
    .getByRole('textbox', { name: 'Proposition to check against primary sources', exact: true })
    .fill('An unrelated accessory permits reuse.');
  await page
    .getByRole('textbox', { name: 'Primary source URLs', exact: true })
    .fill('https://example.org/unrelated-accessory');
  await page
    .getByRole('complementary')
    .getByRole('button', { name: 'Following', exact: true })
    .click();
  await page.getByRole('button', { name: 'Add question', exact: true }).click();
  const question = 'Find public ecology learning resources.';
  await page.getByRole('textbox', { name: 'Question', exact: true }).fill(question);
  const sources = page.getByRole('textbox', { name: /Supplemental paths for query-/ });
  await sources.fill('https://example.org/ecology/');
  await sources.blur();
  let submitted: unknown;
  await page.route('**/__signals/api/search', async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ status: 400, json: { code: 'saved_question_fixture_stopped' } });
  });
  await page.getByRole('button', { name: /^Search query-.* now$/ }).click();
  await expect(page.getByText('saved_question_fixture_stopped', { exact: true })).toBeVisible();
  expect(submitted).toMatchObject({
    query: question,
    method: 'native',
    supplementalSites: ['https://example.org/ecology/'],
  });
  for (const field of ['claimOrigin', 'claimText', 'captureUrls', 'assessmentOf'])
    expect(submitted).not.toHaveProperty(field);
});
