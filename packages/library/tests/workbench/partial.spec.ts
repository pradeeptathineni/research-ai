import { test, expect } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import type { SearchResult } from '../../packages/domain/src/search-contract.js';
import { openResearchOptions } from './research.js';
import type { Page } from '@playwright/test';

async function openSaved(page: Page, question: string) {
  await page
    .getByRole('complementary')
    .getByRole('button', { name: 'Activity', exact: true })
    .click();
  await page
    .getByRole('region', { name: 'Recent research' })
    .getByRole('article')
    .filter({ hasText: question })
    .first()
    .getByRole('button', { name: 'Open result', exact: true })
    .click();
  await expect(page.getByLabel('Find something useful', { exact: true })).toHaveValue(question);
}

test('a useful unassessed note stays visible through cancellation and history reopening', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openResearchOptions(page, 'partial timeout fixture');
  await page.getByRole('button', { name: 'Start online research', exact: true }).click();
  const narrative = page.getByRole('region', { name: 'Research brief', exact: true });
  await expect(narrative).toContainText('Current support is unresolved');
  await expect(narrative).toContainText(
    'Partial output; research and evidence checks are still pending',
  );
  await expect(narrative).toContainText('Confidence: Unknown');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByText(/Research cancelled/)).toBeVisible();
  await expect(narrative).toContainText('Research stopped before completion');
  await expect(page.getByLabel('Continue from retained work', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Discuss retained work', exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Assess this citation', exact: true })).toHaveCount(
    0,
  );
  const result = await page.evaluate(async () => {
    const response = await fetch('/signals-ai/__signals/api/history');
    return (await response.json()) as { runs: { query: string; runId: string }[] };
  });
  const retained = result.runs.find(
    (row: { query: string }) => row.query === 'partial timeout fixture',
  );
  if (!retained) throw new Error('partial fixture run missing');
  const runId = retained.runId;
  await page.reload();
  await page.evaluate(async (runId) => {
    const { token } = (await (await fetch('/signals-ai/__signals/api/session')).json()) as {
      token: string;
    };
    await fetch('/signals-ai/__signals/api/history/open', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signals-token': token,
      },
      body: JSON.stringify({ runId }),
    });
  }, runId);
  // The real retained run remains independently reopenable after page state is gone.
  const reopened = await page.evaluate(async (runId) => {
    const { token } = (await (await fetch('/signals-ai/__signals/api/session')).json()) as {
      token: string;
    };
    const opened = (await (
      await fetch('/signals-ai/__signals/api/history/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-signals-token': token },
        body: JSON.stringify({ runId }),
      })
    ).json()) as { id: string };
    return (await (await fetch('/signals-ai/__signals/api/runs/' + opened.id)).json()) as {
      result: SearchResult;
    };
  }, runId);
  expect(reopened.result.status).toBe('cancelled');
  expect(reopened.result.brief?.text).toContain('Current support is unresolved');
  expect(reopened.result.answerReceipt).toBeUndefined();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

async function savedParents(page: Page) {
  await openResearchOptions(page, 'partial timeout fixture');
  await page.getByRole('button', { name: 'Start online research', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Research brief' })).toContainText(
    'Current support is unresolved',
  );
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByText(/Research cancelled/)).toBeVisible();
  await openResearchOptions(page, 'unrelated saved parent fixture');
  await page.getByRole('button', { name: 'Start online research', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Research brief' })).toContainText(
    'A practical next step',
  );
  await openSaved(page, 'partial timeout fixture');
  await expect(page.getByRole('region', { name: 'Research brief' })).toContainText(
    'Current support is unresolved',
  );
}

const reply = {
  mode: 'frozen-evidence-replay',
  answer: 'Discussion belongs only to interrupted parent A.',
  statements: [],
  gaps: ['Frozen only.'],
  usage: null,
};

test('completed discussion cannot migrate to a different retained parent', async ({ page }) => {
  await savedParents(page);
  await page.route('**/__signals/api/followup', (route) => route.fulfill({ json: reply }));
  await page
    .getByLabel('Continue from retained work', { exact: true })
    .fill('What remains unresolved?');
  await page.getByRole('button', { name: 'Discuss retained work', exact: true }).click();
  await expect(page.getByText(reply.answer, { exact: true })).toBeVisible();
  await openSaved(page, 'unrelated saved parent fixture');
  await expect(page.getByRole('region', { name: 'Research brief' })).toContainText(
    'A practical next step',
  );
  await expect(page.getByText(reply.answer, { exact: true })).toHaveCount(0);
});

test('a delayed discussion reply cannot repopulate after switching its retained parent', async ({
  page,
}) => {
  await savedParents(page);
  await page
    .getByLabel('Continue from retained work', { exact: true })
    .fill('Discuss this parent only.');
  let release!: () => void, entered!: () => void;
  const paused = new Promise<void>((done) => {
    release = done;
  });
  const arrived = new Promise<void>((done) => {
    entered = done;
  });
  await page.route('**/__signals/api/followup', async (route) => {
    entered();
    await paused;
    await route.fulfill({ json: reply });
  });
  await page.getByRole('button', { name: 'Discuss retained work', exact: true }).click();
  await arrived;
  await openSaved(page, 'unrelated saved parent fixture');
  await expect(page.getByRole('region', { name: 'Research brief' })).toContainText(
    'A practical next step',
  );
  const delivered = page.waitForResponse('**/__signals/api/followup');
  release();
  await delivered;
  await page.waitForTimeout(50);
  await expect(page.getByText(reply.answer, { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Discuss retained work', exact: true }),
  ).toBeEnabled();
});
