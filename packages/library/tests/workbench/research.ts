import { expect, type Page, type APIRequestContext } from '@playwright/test';
import type { Project } from '../../packages/corpus/src/project-contract.js';

export async function registerScopedProject(
  request: APIRequestContext,
  folder: string,
  name: string,
) {
  const { token } = (await (await request.get('__signals/api/session')).json()) as {
    token: string;
  };
  const headers = { origin: 'http://127.0.0.1:5189', 'x-signals-token': token };
  const preview = await request.post('__signals/api/projects/preview', {
    headers,
    data: { source: { kind: 'local', path: folder } },
  });
  expect(preview.ok()).toBe(true);
  const { id } = (await preview.json()) as { id: string };
  const saved = await request.post('__signals/api/projects/register', {
    headers,
    data: {
      previewId: id,
      name,
      purpose: `The current purpose of ${name}`,
      constraints: ['Read only'],
    },
  });
  expect(saved.ok()).toBe(true);
  return (await saved.json()) as Project;
}

// Fresh typed question with the workbench method left untouched.
export async function openFreshResearch(page: Page, question: string) {
  await page.goto('');
  await page
    .getByRole('complementary')
    .getByRole('button', { name: 'Search', exact: true })
    .click();
  await page.getByLabel('Find something useful', { exact: true }).fill(question);
  await page.getByRole('button', { name: 'Research online', exact: true }).click();
}

// Scored workflows select evidence assessment explicitly; the fresh default is answer-first.
export async function openResearchOptions(page: Page, question: string) {
  await openFreshResearch(page, question);
  await selectEvidenceResearch(page);
}

export async function selectEvidenceResearch(page: Page) {
  const options = page.getByText('Research options', { exact: true });
  const details = options.locator('..');
  if (!(await details.evaluate((node) => (node as HTMLDetailsElement).open))) await options.click();
  await page.getByRole('combobox', { name: 'Research method', exact: true }).selectOption('native');
}
