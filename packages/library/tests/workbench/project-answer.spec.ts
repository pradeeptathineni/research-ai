import { test, expect } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LibraryFinding } from '../../packages/domain/src/library-search.js';
import { openFreshResearch, registerScopedProject } from './research.js';

test('project opportunities reopen complete retained answers without research, including stale and missing findings', async ({
  page,
  request,
}) => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'signals-project-answer-')));
  const question = 'Project answer replay: required offline export remains unknown.';
  const unexpected: string[] = [];
  const popups: string[] = [];
  page.on('popup', (popup) => popups.push(popup.url()));
  try {
    await writeFile(join(folder, 'README.md'), '# Export study\nInspect offline export limits.\n');
    await openFreshResearch(page, question);
    await page.getByRole('button', { name: 'Start online research', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Research brief' })).toContainText(
      'aurora quill constellation',
    );
    const { findings } = (await (await request.get('__signals/api/library')).json()) as {
      findings: LibraryFinding[];
    };
    const answer = findings.find((finding) => finding.title === question && finding.answer)!;
    const original = findings.find((finding) => finding.native)!;
    expect(answer.answer?.limits.length).toBeGreaterThan(0);
    const { token } = (await (await request.get('__signals/api/session')).json()) as {
      token: string;
    };
    const headers = { origin: 'http://127.0.0.1:5189', 'x-signals-token': token };
    const project = await registerScopedProject(request, folder, 'Retained answer project');
    for (const finding of [answer, original]) {
      const attached = await request.post('__signals/api/opportunities/attach', {
        headers,
        data: {
          projectId: project.id,
          findingKey: finding.key,
          need: 'Inspect offline export.',
          reason: 'Retain the original limits for inspection.',
          nextAction: 'explore',
        },
      });
      expect(attached.ok()).toBe(true);
    }
    // History replay is read-only; deny every other POST as a provider-call sentinel.
    await page.route('**/__signals/api/**', async (route) => {
      if (route.request().method() === 'POST' && !route.request().url().endsWith('/history/open')) {
        unexpected.push(route.request().url());
        await route.fulfill({ status: 400, json: { code: 'project_reopen_provider_forbidden' } });
      } else await route.continue();
    });
    await page.reload();
    await page
      .getByRole('complementary')
      .getByRole('button', { name: 'Projects', exact: true })
      .click();
    await page.getByRole('button', { name: 'Open Retained answer project', exact: true }).click();
    const row = page.locator('.desk-project-row').filter({
      has: page.getByRole('heading', { name: question, exact: true }),
    });
    const reopen = row
      .getByRole('button', { name: 'Reopen complete answer', exact: true })
      .or(row.getByRole('link', { name: `Open ${question}`, exact: true }));
    await reopen.click();
    const evidence = page.getByRole('region', { name: 'Evidence panel' });
    await expect(evidence).toContainText('Complete answer · Unassessed · Confidence Unknown');
    await expect(evidence).toContainText('aurora quill constellation');
    await expect(row).toContainText(answer.answer!.limits[0]!);
    await expect(row.locator('a[href="#"]')).toHaveCount(0);
    expect(popups).toEqual([]);
    await page.getByRole('button', { name: 'Close evidence', exact: true }).click();
    await page.reload();
    await expect(row.getByRole('button', { name: 'Reopen complete answer' })).toBeVisible();
    const originalRow = page.locator('.desk-project-row').filter({
      has: page.getByRole('heading', { name: original.title, exact: true }),
    });
    await expect(
      originalRow.getByRole('link', { name: `Open ${original.title}`, exact: true }),
    ).toHaveAttribute('href', original.uri);
    const disconnected = await request.post('__signals/api/projects/disconnect', {
      headers,
      data: { id: project.id },
    });
    expect(disconnected.ok()).toBe(true);
    await page.reload();
    await expect(row).toContainText('The project source changed or disconnected; recheck this fit');
    const button = row.getByRole('button', { name: 'Reopen complete answer', exact: true });
    await button.focus();
    await button.press('Enter');
    await expect(evidence).toContainText('aurora quill constellation');
    await page.getByRole('button', { name: 'Close evidence', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 900 });
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeInViewport();
    expect(
      await button.evaluate((element) => element.getBoundingClientRect().right <= innerWidth),
    ).toBe(true);
    await button.click();
    await expect(evidence).toContainText('aurora quill constellation');
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.screenshot({
      path: test.info().outputPath('project-answer-390.png'),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Close evidence', exact: true }).click();
    await page.route('**/__signals/api/library', async (route) => {
      const response = await route.fetch();
      const library = (await response.json()) as { findings: LibraryFinding[] };
      await route.fulfill({
        json: { findings: library.findings.filter((finding) => finding.key !== answer.key) },
      });
    });
    await page.reload();
    await expect(row).toContainText('The linked finding is unavailable.');
    await expect(row.getByRole('button', { name: 'Reopen complete answer' })).toHaveCount(0);
    await expect(row.locator('a[href="#"]')).toHaveCount(0);
    await expect(row).toContainText('Retain the original limits for inspection.');
    expect(unexpected).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    await rm(folder, { recursive: true, force: true });
  }
});
