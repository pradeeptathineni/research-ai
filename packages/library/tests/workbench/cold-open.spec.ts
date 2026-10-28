import { test, expect, type Page } from '@playwright/test';
import { openResearchOptions } from './research.js';

async function retainedRun(page: Page, query: string) {
  await openResearchOptions(page, query);
  await page.getByRole('button', { name: 'Start online research', exact: true }).click();
  await expect(page.getByText('Research partial; 2 candidates.', { exact: true })).toBeVisible();
  return page.evaluate(async (query) => {
    const history = (await (await fetch('/signals-ai/__signals/api/history')).json()) as {
      runs: { query: string; runId: string }[];
    };
    const retained = history.runs.find((row) => row.query === query);
    if (!retained) throw new Error('retained_fixture_missing');
    return retained.runId;
  }, query);
}

async function delayedColdOpen(page: Page, runId: string, query: string) {
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let delayed = false;
  await page.route('**/__signals/api/history/open', async (route) => {
    if (delayed) {
      await route.continue();
      return;
    }
    delayed = true;
    const response = await route.fetch();
    started();
    await gate;
    await route.fulfill({ response });
  });
  const params = new URLSearchParams({ view: 'Search', mode: 'research', q: query, run: runId });
  await page.goto('?' + params.toString());
  await pending;
  return release;
}

for (const destination of ['Activity', 'Library'] as const) {
  test(`a delayed cold reopen cannot pull navigation back from ${destination}`, async ({
    page,
  }) => {
    const query = `cold reopen navigation ${destination}`;
    const runId = await retainedRun(page, query);
    const release = await delayedColdOpen(page, runId, query);
    const destinationButton = page
      .getByRole('complementary')
      .getByRole('button', { name: destination, exact: true });
    await destinationButton.click();
    await expect(destinationButton).toHaveAttribute('aria-current', 'page');
    const completed = page.waitForResponse((response) => response.url().endsWith('/history/open'));
    release();
    await completed;
    await page.waitForTimeout(500);
    await expect(destinationButton).toHaveAttribute('aria-current', 'page');
    expect(new URL(page.url()).searchParams.get('view')).toBe(destination);
  });
}

test('an unsuperseded cold reopen restores its selected result and remains reopenable', async ({
  page,
}) => {
  const query = 'cold reopen positive control';
  const runId = await retainedRun(page, query);
  const params = new URLSearchParams({ view: 'Search', mode: 'research', q: query, run: runId });
  await page.goto('?' + params.toString());
  await expect(page.getByRole('region', { name: 'Research brief', exact: true })).toContainText(
    'A practical next step',
  );
  await page
    .getByRole('complementary')
    .getByRole('button', { name: 'Activity', exact: true })
    .click();
  await page
    .getByRole('region', { name: 'Recent research' })
    .getByRole('article')
    .filter({ hasText: query })
    .getByRole('button', { name: 'Open result', exact: true })
    .click();
  await expect(page.getByLabel('Find something useful', { exact: true })).toHaveValue(query);
  await expect(page.getByRole('region', { name: 'Research brief', exact: true })).toContainText(
    'A practical next step',
  );
});

for (const destination of ['Activity', 'Library'] as const) {
  test(`reloading ${destination} with a remembered run respects the requested location`, async ({
    page,
  }) => {
    const query = `remembered run in ${destination}`;
    const runId = await retainedRun(page, query);
    let opens = 0;
    await page.route('**/__signals/api/history/open', async (route) => {
      opens++;
      const response = await route.fetch();
      await page.waitForTimeout(250);
      await route.fulfill({ response });
    });
    const params = new URLSearchParams({
      view: destination,
      mode: 'research',
      q: query,
      run: runId,
    });
    await page.goto('?' + params.toString());
    await page.waitForTimeout(500);
    await expect(
      page.getByRole('complementary').getByRole('button', { name: destination, exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    expect(opens).toBe(0);
  });
}

test('history navigation to Activity does not reopen a remembered run; explicit Open still works', async ({
  page,
}) => {
  const query = 'remembered run during browser back';
  await retainedRun(page, query);
  const sidebar = page.getByRole('complementary');
  await sidebar.getByRole('button', { name: 'Activity', exact: true }).click();
  await sidebar.getByRole('button', { name: 'Search', exact: true }).click();
  let opens = 0;
  await page.route('**/__signals/api/history/open', async (route) => {
    opens++;
    const response = await route.fetch();
    await page.waitForTimeout(250);
    await route.fulfill({ response });
  });
  await page.goBack();
  await page.waitForTimeout(500);
  await expect(sidebar.getByRole('button', { name: 'Activity', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  expect(opens).toBe(0);
  await page
    .getByRole('region', { name: 'Recent research' })
    .getByRole('article')
    .filter({ hasText: query })
    .getByRole('button', { name: 'Open result', exact: true })
    .click();
  await expect(page.getByRole('region', { name: 'Research brief', exact: true })).toContainText(
    'A practical next step',
  );
  expect(opens).toBe(1);
});
