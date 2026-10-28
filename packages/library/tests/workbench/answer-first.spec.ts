import { test, expect, type Page } from '@playwright/test';
import { openFreshResearch, openResearchOptions } from './research.js';
import { expectAccessibleViewport } from './accessibility.js';

async function researchAnswer(page: Page, question: string) {
  await openResearchOptions(page, question);
  await page
    .getByRole('combobox', { name: 'Research method', exact: true })
    .selectOption('answer-first');
  await page.getByRole('button', { name: 'Start online research', exact: true }).click();
}

async function recordSearches(page: Page, stop?: string) {
  const searches: Record<string, unknown>[] = [];
  await page.route('**/__signals/api/search', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    searches.push(route.request().postDataJSON() as Record<string, unknown>);
    if (stop) await route.fulfill({ status: 400, json: { code: stop } });
    else await route.continue();
  });
  return searches;
}

test('untouched fresh question submits answer-first, stays unassessed and keeps that choice after a native citation check', async ({
  page,
}) => {
  const question = 'answer receipt browser fixture; untouched default entry.';
  await openFreshResearch(page, question);
  await expect(
    page.getByText(
      'Answer first: the answer is unassessed and confidence stays Unknown. Its citations can be checked afterwards. Evidence assessment and primary-source checks remain under Research options.',
      { exact: true },
    ),
  ).toBeVisible();
  await expectAccessibleViewport(page, 390);
  await page.screenshot({
    path: test.info().outputPath('answer-first-entry-390.png'),
    fullPage: true,
  });
  const searches = await recordSearches(page);
  const start = page.getByRole('button', { name: 'Start online research', exact: true });
  await start.focus();
  await start.press('Enter');
  const brief = page.getByRole('region', { name: 'Research brief', exact: true });
  await expect(brief).toContainText('Unassessed answer · Confidence: Unknown');
  await expect(brief).toContainText('aurora quill constellation');
  await expectAccessibleViewport(page, 1440);
  await page.screenshot({
    path: test.info().outputPath('answer-first-result-1440.png'),
    fullPage: true,
  });
  expect(searches).toEqual([
    expect.objectContaining({
      query: question,
      method: 'answer-first',
      cache: 'private',
      save: 'never',
    }),
  ]);
  for (const field of ['assessmentOf', 'claimText', 'captureUrls', 'claimOrigin'])
    expect(searches[0]).not.toHaveProperty(field);
  let selection: unknown;
  await page.route('**/__signals/api/capture', async (route) => {
    selection = route.request().postDataJSON();
    await route.fulfill({ status: 400, json: { code: 'default_assessment_fixture_stopped' } });
  });
  await page.getByRole('button', { name: 'Assess this citation', exact: true }).click();
  await expect(page.getByText('default_assessment_fixture_stopped', { exact: true })).toBeVisible();
  expect(selection).toMatchObject({
    query: question,
    method: 'native',
    captureUrls: ['https://example.com/tool#export'],
  });
  await page.unroute('**/__signals/api/capture');
  await page.getByRole('button', { name: 'Assess this citation', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Linked citation assessment' })).toContainText(
    'https://example.com/tool#export',
  );
  await page.getByText('Research options', { exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Research method', exact: true })).toHaveValue(
    'answer-first',
  );
  await page.unroute('**/__signals/api/search');
  const further = await recordSearches(page, 'default_further_fixture_stopped');
  await page.getByRole('button', { name: 'Search further', exact: true }).click();
  await expect(page.getByText('default_further_fixture_stopped', { exact: true })).toBeVisible();
  expect(further).toEqual([expect.objectContaining({ method: 'answer-first' })]);
});

test('explicit evidence assessment remains selectable and is submitted for later typed questions', async ({
  page,
}) => {
  await openFreshResearch(page, 'Explicit native selection fixture question.');
  await page.getByText('Research options', { exact: true }).click();
  const method = page.getByRole('combobox', { name: 'Research method', exact: true });
  await expect(method).toHaveValue('answer-first');
  await method.selectOption('native');
  await expect(
    page.getByText(
      'Research with evidence assessment is selected. Change the method under Research options.',
      { exact: true },
    ),
  ).toBeVisible();
  const searches = await recordSearches(page, 'explicit_native_fixture_stopped');
  const stopped = page.getByText('explicit_native_fixture_stopped', { exact: true });
  await page.getByRole('button', { name: 'Start online research', exact: true }).click();
  await expect(stopped).toBeVisible();
  await page
    .getByLabel('Find something useful', { exact: true })
    .fill('A second explicit native fixture question.');
  await expect(method).toHaveValue('native');
  await page.getByRole('button', { name: 'Start online research', exact: true }).click();
  await expect.poll(() => searches.length).toBe(2);
  expect(searches).toEqual([
    expect.objectContaining({
      query: 'Explicit native selection fixture question.',
      method: 'native',
    }),
    expect.objectContaining({
      query: 'A second explicit native fixture question.',
      method: 'native',
    }),
  ]);
});

test('primary-source check from the fresh default is submitted natively, never answer-first', async ({
  page,
}) => {
  let submitted: unknown;
  await page.route('**/__signals/api/capture', async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ status: 400, json: { code: 'default_primary_fixture_stopped' } });
  });
  const searches = await recordSearches(page, 'default_primary_search_unexpected');
  const question = 'Does the default-entry policy cover transfer?';
  await openFreshResearch(page, question);
  await page.getByText('Research options', { exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Research method', exact: true })
    .selectOption('primary-check');
  await page
    .getByRole('textbox', { name: 'Proposition to check against primary sources', exact: true })
    .fill('The policy permits transfer.');
  await page
    .getByRole('textbox', { name: 'Primary source URLs', exact: true })
    .fill('https://example.org/policy');
  await page.getByRole('button', { name: 'Check primary sources', exact: true }).click();
  await expect(page.getByText('default_primary_fixture_stopped', { exact: true })).toBeVisible();
  expect(submitted).toMatchObject({
    query: question,
    method: 'native',
    claimOrigin: 'request',
    claimText: 'The policy permits transfer.',
    captureUrls: ['https://example.org/policy'],
    profile: 'quick',
  });
  expect(searches).toEqual([]);
});

test('focused proposition sends exact claim, original question and selected citation', async ({
  page,
}) => {
  const question = 'answer receipt browser fixture; required offline CSV export and no upload.';
  await researchAnswer(page, question);
  const claim = 'Offline CSV export must be explicit; unknown remains unknown.';
  await page.getByLabel('Proposition to check', { exact: true }).fill(claim);
  let selection: unknown;
  await page.route('**/__signals/api/capture', async (route) => {
    selection = route.request().postDataJSON();
    await route.fulfill({ status: 400, json: { code: 'focused_proposition_fixture_stopped' } });
  });
  await page
    .getByRole('button', { name: 'Check proposition against this citation', exact: true })
    .click();
  await expect(
    page.getByText('focused_proposition_fixture_stopped', { exact: true }),
  ).toBeVisible();
  expect(selection).toMatchObject({
    query: question,
    claimText: claim,
    profile: 'quick',
    method: 'native',
    cache: 'private',
    save: 'never',
    captureUrls: ['https://example.com/tool#export'],
  });
  expect((selection as { assessmentOf: string }).assessmentOf).toMatch(/^[a-f0-9-]{36}$/);
});

test('plain answer is visibly unassessed, whole narrative can be found/reopened and citations assessed explicitly', async ({
  page,
}) => {
  const question =
    'answer receipt browser fixture ' +
    'background '.repeat(155) +
    'Required: never upload recordings and export CSV with explicit end times.';
  await researchAnswer(page, question);
  const brief = page.getByRole('region', { name: 'Research brief', exact: true });
  await expect(brief).toContainText('Unassessed answer · Confidence: Unknown');
  await expect(brief).toContainText('aurora quill constellation');
  await expect(
    page.getByRole('button', { name: 'Assess this citation', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('complementary')
    .getByRole('button', { name: 'Library', exact: true })
    .click();
  await page
    .getByLabel('Find something useful', { exact: true })
    .fill('"aurora quill constellation"');
  const finding = page.locator('.desk-finding').filter({ hasText: question.slice(0, 80) });
  await expect(finding).toHaveCount(1);
  await finding.getByRole('button', { name: 'Reopen complete answer', exact: true }).click();
  const evidence = page.getByRole('region', { name: 'Evidence panel' });
  await expect(evidence).toContainText('Complete answer · Unassessed · Confidence Unknown');
  await expect(evidence).toContainText('aurora quill constellation');
  await page.getByRole('button', { name: 'Close evidence', exact: true }).click();
  await finding.getByRole('button', { name: 'Review citations', exact: true }).click();
  await expect(brief).toContainText('aurora quill constellation');
  let selection: unknown;
  await page.route('**/__signals/api/capture', async (route) => {
    selection = route.request().postDataJSON();
    await route.fulfill({ status: 400, json: { code: 'selected_assessment_fixture_stopped' } });
  });
  await page.getByRole('button', { name: 'Assess this citation', exact: true }).click();
  await expect(
    page.getByText('selected_assessment_fixture_stopped', { exact: true }),
  ).toBeVisible();
  expect(selection).toMatchObject({
    query: question,
    method: 'native',
    captureUrls: ['https://example.com/tool#export'],
  });
  expect((selection as { assessmentOf: string }).assessmentOf).toMatch(/^[a-f0-9-]{36}$/);
  await page.unroute('**/__signals/api/capture');
  await page.getByRole('button', { name: 'Assess this citation', exact: true }).click();
  const check = page.getByRole('region', { name: 'Linked citation assessment' });
  await expect(check).toContainText('https://example.com/tool#export');
  await page.getByText('Source coverage and gaps', { exact: true }).click();
  await expect(
    page.getByText('No decisive export evidence; abstain.', { exact: true }),
  ).toBeVisible();
  await check.getByRole('button', { name: 'Reopen original answer', exact: true }).click();
  await expect(brief).toContainText('aurora quill constellation');
});
