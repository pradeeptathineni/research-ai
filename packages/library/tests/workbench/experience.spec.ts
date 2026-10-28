import { test, expect, type Page } from '@playwright/test';
import { selectEvidenceResearch, registerScopedProject } from './research.js';
import { mkdtemp, writeFile, rm, realpath, mkdir } from 'node:fs/promises';
import { AxeBuilder } from '@axe-core/playwright';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadEntities } from '../../packages/corpus/src/search-store.js';
import { loadPublicCorpus } from '../../packages/corpus/src/public-corpus.js';
import {
  projectNativeLibrary,
  projectLegacyLibrary,
} from '../../packages/domain/src/library-search.js';

async function navigate(page: Page, name: string) {
  await page.getByRole('complementary').getByRole('button', { name, exact: true }).click();
}
test('interactive checkpoint preserves result place, comparison, scopes and submitted meaning consent', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  const artifact = resolve('../signals-ai-planning/reconciliation-20261010/ui-checkpoint');
  await mkdir(artifact, { recursive: true });
  const { token } = (await (await request.get('__signals/api/session')).json()) as {
    token: string;
  };
  const headers = { origin: 'http://127.0.0.1:5189', 'x-signals-token': token };
  const originalSettings = (await (await request.get('__signals/api/settings')).json()) as {
    queries: { id: string; query: string }[];
  };
  const settings = {
    ...originalSettings,
    queries: [
      ...originalSettings.queries,
      {
        id: 'checkpoint-interest',
        query: 'checkpoint retained evidence',
        enabled: true,
        everyDays: 7,
        offsetMinutes: 0,
        concepts: [],
      },
    ],
  };
  expect((await request.post('__signals/api/settings', { headers, data: settings })).ok()).toBe(
    true,
  );
  const labelFixture = async (floating = false) =>
    page.evaluate((floating) => {
      document.querySelector('[data-checkpoint-label]')?.remove();
      const label = document.createElement('p');
      label.dataset.checkpointLabel = 'true';
      label.textContent = 'UI fixture replay · approved public records · no new discovery';
      label.style.cssText =
        'font-size:12px;color:#6b4226;background:#f7ecdc;padding:8px 12px;border-radius:6px' +
        (floating ? ';position:fixed;top:8px;left:12px;right:12px;z-index:30;margin:0' : '');
      document.querySelector('.desk-main')?.prepend(label);
    }, floating);
  try {
    await page.goto('');
    await expect(
      page.getByRole('heading', { name: 'Worth knowing. Worth keeping.' }),
    ).toBeVisible();
    await navigate(page, 'Search');
    await page
      .getByLabel('Find something useful', { exact: true })
      .fill('checkpoint retained evidence');
    await page.getByRole('button', { name: 'Research online', exact: true }).click();
    await selectEvidenceResearch(page);
    await page.getByRole('button', { name: 'Start online research', exact: true }).click();
    await expect(page.locator('.entity-card')).toHaveCount(2);
    await page.locator('.entity-card input[type=checkbox]').first().check();
    await page.getByRole('button', { name: /^Save selected/ }).click();
    await navigate(page, 'Home');
    await page.reload();
    const discoveries = page.getByRole('region', { name: 'Followed interest discoveries' });
    await expect(discoveries).toContainText('Retained from “checkpoint retained evidence”');
    await expect(discoveries).toContainText('Source observed');
    await labelFixture();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: join(artifact, 'desktop-home.png'), fullPage: true });
    await navigate(page, 'Search');
    await page.getByLabel('Find something useful', { exact: true }).fill('');
    const rows = page.locator('.desk-results .desk-finding');
    await rows.nth(0).getByRole('button', { name: 'Compare', exact: true }).click();
    await rows.nth(1).getByRole('button', { name: 'Compare', exact: true }).click();
    await expect(
      page.getByRole('region', { name: 'Compare selected findings' }).locator('article'),
    ).toHaveCount(2);
    const opener = rows.nth(0).getByText('Evidence & details', { exact: true });
    await opener.click();
    const panel = page.getByRole('region', { name: 'Evidence panel' });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { level: 2 })).toBeFocused();
    await labelFixture(true);
    await page.screenshot({
      path: join(artifact, 'desktop-evidence-comparison.png'),
      fullPage: false,
    });
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(opener).toBeFocused();
    await page.setViewportSize({ width: 834, height: 1112 });
    await opener.click();
    await page.screenshot({
      path: join(artifact, 'tablet-evidence-comparison.png'),
      fullPage: false,
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.getByRole('button', { name: 'Close evidence', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await opener.click();
    await page.screenshot({
      path: join(artifact, 'narrow-evidence-comparison.png'),
      fullPage: false,
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const accessibility = await new AxeBuilder({ page }).include('.desk-shell').analyze();
    expect(
      accessibility.violations.filter((violation) =>
        ['critical', 'serious'].includes(violation.impact ?? ''),
      ),
    ).toEqual([]);
    await page.getByRole('button', { name: 'Close evidence', exact: true }).click();
    await page.getByRole('button', { name: 'Combined', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Finding results' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Start online research', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Search scope' })
      .getByRole('button', { name: 'Library', exact: true })
      .click();
    let meaningCalls = 0;
    await page.route('**/__signals/api/library-search', async (route) => {
      meaningCalls++;
      await route.fulfill({
        json: {
          hits: [],
          state: 'disabled',
          reason: 'Meaning matching is disabled; literal results retained.',
          omitted: 0,
          usage: null,
        },
      });
    });
    await page
      .getByLabel('Find something useful', { exact: true })
      .fill('a remembered purpose with unfamiliar wording');
    expect(meaningCalls).toBe(0);
    await page.getByRole('button', { name: 'Search Library', exact: true }).click();
    await expect.poll(() => meaningCalls).toBe(1);
    await expect(page.getByRole('status')).toContainText('Meaning matching is disabled');
    await writeFile(
      join(artifact, 'interaction-proof.json'),
      JSON.stringify(
        {
          evidenceClass: 'isolated-public-replay-fixture',
          liveDiscovery: false,
          humanApproval: 'pending',
          screenshots: [
            'desktop-home.png',
            'desktop-evidence-comparison.png',
            'narrow-evidence-comparison.png',
            'tablet-evidence-comparison.png',
          ],
          interactions: [
            'followed provenance',
            'two-record comparison',
            'side evidence',
            'keyboard focus and Escape restoration',
            'narrow overflow',
            'combined retained and explicit research',
            'no meaning matching on keystroke',
            'one submitted meaning operation',
          ],
          seriousAxeViolations: 0,
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    await request.post('__signals/api/settings', { headers, data: originalSettings });
  }
});

test('cold browsing, scoped save, notes and URL restoration require no research or readiness', async ({
  page,
}) => {
  const paidCalls: string[] = [];
  page.on('request', (request) => {
    if (/\/(search|capture|refresh|followup|provider-health)$/.test(request.url()))
      paidCalls.push(request.url());
  });
  await page.goto('?view=Search');
  await expect(page.locator('.desk-finding').first()).toBeVisible();
  await expect(
    page.getByText('Search saved knowledge.', {
      exact: true,
    }),
  ).toBeVisible();
  const first = page.locator('.desk-finding[data-finding-key^="native:"]').first();
  const key = await first.getAttribute('data-finding-key');
  const title = await first.getByRole('heading', { level: 3 }).innerText();
  await first.getByRole('button', { name: 'Unsave', exact: true }).click();
  await expect(first.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await navigate(page, 'Library');
  await expect(page.locator(`[data-finding-key="${key}"]`)).toHaveCount(0);
  await navigate(page, 'Search');
  await page.getByLabel('Find something useful', { exact: true }).fill(title);
  const finding = page.locator(`[data-finding-key="${key}"]`);
  await finding.getByRole('button', { name: 'Save', exact: true }).click();
  await finding.getByText('Evidence & details', { exact: true }).click();
  await expect(page).toHaveURL(/detail=native/);
  await finding.getByText('Private note and feedback', { exact: true }).click();
  await finding
    .getByLabel(`Note for ${title}`, { exact: true })
    .fill('A useful retained reference');
  await finding.getByRole('button', { name: 'Save private annotation', exact: true }).click();
  await page.reload();
  await expect(finding.locator('details').first()).toHaveAttribute('open', '');
  await expect(page.getByLabel('Find something useful', { exact: true })).toHaveValue(title);
  await finding.getByText('Private note and feedback', { exact: true }).click();
  await expect(finding.getByLabel(`Note for ${title}`, { exact: true })).toHaveValue(
    'A useful retained reference',
  );
  await navigate(page, 'Library');
  await expect(finding).toBeVisible();
  await page.goBack();
  await expect(finding.locator('details').first()).toHaveAttribute('open', '');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Find something useful.' }),
  ).toBeVisible();
  expect(paidCalls).toEqual([]);
});

test('withdrawn project previews cannot cross scope, question, navigation or history; association drafts stay scoped', async ({
  page,
  request,
}) => {
  // Real loopback API with disposable project documents; no production state or model calls.
  const folders = await Promise.all(
    ['A', 'B'].map(async (name) => {
      const folder = await realpath(await mkdtemp(join(tmpdir(), `signals-scope-${name}-`)));
      await writeFile(
        join(folder, 'README.md'),
        `# Project ${name}\n${name}_ONLY_BOUND_PROJECT_EXCERPT`,
      );
      return folder;
    }),
  );
  const calls: { query: string; context?: string }[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/search'))
      calls.push(request.postDataJSON() as { query: string; context?: string });
  });
  try {
    const projectA = await registerScopedProject(request, folders[0]!, 'Scope project A');
    const projectB = await registerScopedProject(request, folders[1]!, 'Scope project B');
    await page.goto('');
    const context = page.getByLabel('Context for this question', { exact: true });
    const approveA = async () => {
      await navigate(page, 'Projects');
      const all = page.getByRole('button', { name: 'All projects', exact: true });
      if (await all.isVisible()) await all.click();
      await page.getByRole('button', { name: 'Open Scope project A', exact: true }).click();
      await page.getByText('Research one project gap', { exact: true }).click();
      await page
        .getByLabel('Question for this project', { exact: true })
        .fill('Review the scoped project A question');
      await page.getByRole('button', { name: 'Preview research context', exact: true }).click();
      await page
        .getByRole('region', { name: 'Project research egress' })
        .getByRole('button', { name: 'Use this context in online research', exact: true })
        .click();
      const detail = page
        .locator('details')
        .filter({ has: page.getByText('Project context and constraints', { exact: true }) });
      if (!(await detail.evaluate((node) => (node as HTMLDetailsElement).open)))
        await detail.getByText('Project context and constraints', { exact: true }).click();
      expect(await context.inputValue()).toContain('A_ONLY_BOUND_PROJECT_EXCERPT');
    };
    const sendGeneral = async (query: string, expectedContext = '') => {
      await page.getByLabel('Find something useful', { exact: true }).fill(query);
      await expect(context).toHaveValue(expectedContext);
      const count = calls.length;
      await page.getByRole('button', { name: 'Start online research', exact: true }).click();
      await expect.poll(() => calls.length).toBe(count + 1);
      expect(calls[count]!.context ?? '').toBe(expectedContext);
      expect(JSON.stringify(calls[count])).not.toContain('A_ONLY_BOUND_PROJECT_EXCERPT');
      await expect(
        page.getByRole('button', { name: 'Start online research', exact: true }),
      ).toBeEnabled();
    };
    await approveA();
    await page.getByLabel('Project scope', { exact: true }).selectOption('');
    await expect(context).toHaveValue('');
    await page.goBack();
    await expect(context).toHaveValue('');
    await sendGeneral('Unrelated general research after Everything');
    await approveA();
    await page.getByLabel('Project scope', { exact: true }).selectOption(projectB.id);
    await expect(context).toHaveValue('');
    await sendGeneral('Unrelated project B research');
    await approveA();
    await sendGeneral('Unrelated same-project question');
    await approveA();
    await navigate(page, 'Following');
    await navigate(page, 'Search');
    await page.getByRole('button', { name: 'Research online', exact: true }).click();
    await expect(context).toHaveValue('');
    await sendGeneral('Unrelated research after navigation');
    await approveA();
    const editedProjectContext = `${await context.inputValue()}x`;
    await context.fill(editedProjectContext);
    await page.getByLabel('Project scope', { exact: true }).selectOption('');
    await expect(context).toHaveValue('');
    const held = page.getByRole('region', { name: 'Held project drafts' });
    await held
      .getByText(/^Held project draft:/)
      .last()
      .click();
    await expect(held.locator('pre').last()).toHaveText(editedProjectContext);
    await sendGeneral('General research after a one-character project edit');
    await approveA();
    await context.fill(`${await context.inputValue()}y`);
    await page.getByLabel('Project scope', { exact: true }).selectOption(projectB.id);
    await sendGeneral('Project B after a one-character project edit');
    await approveA();
    await context.fill(`${await context.inputValue()}z`);
    await sendGeneral('Changed query after a one-character project edit');
    await approveA();
    await context.fill('My deliberate manual draft');
    await page.getByLabel('Project scope', { exact: true }).selectOption('');
    await expect(context).toHaveValue('');
    await sendGeneral('Project edits are held even when every character was replaced');
    await context.fill('My deliberate manual draft');
    await sendGeneral('General research with my deliberate draft', 'My deliberate manual draft');
    await navigate(page, 'Search');
    await page.getByLabel('Find something useful', { exact: true }).fill('');
    await page.getByText('Search options', { exact: true }).click();
    await page.getByLabel('Project scope', { exact: true }).selectOption(projectA.id);
    const finding = page.locator('.desk-finding').first();
    await finding.getByText('Connect to selected project', { exact: true }).click();
    await expect(finding.getByLabel('Project need', { exact: true })).toHaveValue(projectA.purpose);
    await finding
      .getByLabel('Project need', { exact: true })
      .fill('A deliberately edited project A need');
    await page.getByLabel('Project scope', { exact: true }).selectOption(projectB.id);
    await expect(finding.getByLabel('Project need', { exact: true })).toHaveValue(projectB.purpose);
  } finally {
    await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
  }
});

test('native and legacy numeric scores stay labeled and grouped by their original policy', async ({
  page,
}) => {
  const [record] = (await loadEntities()).sort(
    (a, b) => (b.entity.assessment.score ?? -1) - (a.entity.assessment.score ?? -1),
  );
  const { options } = await loadPublicCorpus();
  const native = projectNativeLibrary(record!, 'public');
  const legacy = projectLegacyLibrary(
    options.find(
      (option) =>
        typeof option.quality?.score === 'number' &&
        option.quality.score < (native.intrinsicStrength.score ?? -1),
    )!,
  );
  expect(native.intrinsicStrength.score).toBeGreaterThan(legacy.intrinsicStrength.score!);
  await page.route('**/__signals/api/library', (route) =>
    route.fulfill({ json: { findings: [native, legacy] } }),
  );
  await page.goto('?view=Search');
  await page.getByLabel('Sort', { exact: true }).selectOption('strength');
  const rows = page.locator('.desk-finding');
  expect(
    await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-finding-key'))),
  ).toEqual(
    [legacy, native]
      .sort((a, b) => a.intrinsicStrength.policy.localeCompare(b.intrinsicStrength.policy))
      .map((finding) => finding.key),
  );
  await expect(page.locator(`[data-finding-key="${native.key}"]`)).toContainText(
    native.intrinsicStrength.policy,
  );
  await expect(page.locator(`[data-finding-key="${legacy.key}"]`)).toContainText(
    legacy.intrinsicStrength.policy,
  );
  await rows.nth(0).getByRole('button', { name: 'Compare', exact: true }).click();
  await rows.nth(1).getByRole('button', { name: 'Compare', exact: true }).click();
  const comparison = page.getByRole('region', { name: 'Compare selected findings' });
  await expect(comparison).toContainText('not directly comparable');
  await expect(comparison).toContainText(native.intrinsicStrength.policy);
  await expect(comparison).toContainText(legacy.intrinsicStrength.policy);
});

test('a non-Git project previews explicit documents, edits intent, retains associations and exact research egress', async ({
  page,
}) => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'signals-ui-project-')));
  await writeFile(
    join(folder, 'README.md'),
    '# HTTP problem details\nBuild reliable API error contracts and problem type definitions.',
  );
  await writeFile(join(folder, '.env'), 'PRIVATE_FIXTURE=never-share-this');
  const researchCalls: unknown[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/search')) researchCalls.push(request.postDataJSON());
  });
  try {
    await page.goto('');
    await navigate(page, 'Projects');
    const add = page
      .locator('details')
      .filter({ has: page.getByText('Add a project', { exact: true }) });
    if (!(await add.evaluate((node) => (node as HTMLDetailsElement).open)))
      await add.getByText('Add a project', { exact: true }).click();
    await page.getByLabel('Explicit local folder path', { exact: true }).fill(folder);
    await page.getByRole('button', { name: 'Preview read-only summary', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Inspect the selected summary' })).toBeVisible();
    await expect(page.locator('.desk-projects')).not.toContainText('never-share-this');
    await page.getByLabel('Project name', { exact: true }).fill('API reference project');
    await page
      .getByLabel('Purpose to use for this project', { exact: true })
      .fill('Understand HTTP error contracts');
    await page
      .getByLabel('Constraints (one per line)', { exact: true })
      .fill('Read only\nNo installation');
    await page.getByRole('button', { name: 'Register project', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'API reference project', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Project views' })
      .getByRole('button', { name: 'Activity', exact: true })
      .click();
    await page.getByText('Edit purpose and constraints', { exact: true }).click();
    await page
      .getByLabel('Project purpose', { exact: true })
      .fill('Compare HTTP problem detail standards');
    await page.getByRole('button', { name: 'Save project intent', exact: true }).click();
    await expect(page.getByText('Project intent updated.', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Opportunities', exact: true }).click();
    await page
      .getByRole('button', { name: 'Find retained leads without a model', exact: true })
      .click();
    await expect(
      page.getByText('Lexical matches are opportunities to inspect', { exact: false }),
    ).toBeVisible();
    expect(researchCalls).toEqual([]);
    const leadTitle = await page
      .getByRole('region', { name: 'Corpus leads for project' })
      .locator('article')
      .first()
      .getByRole('heading', { level: 3 })
      .innerText();
    await page
      .getByRole('region', { name: 'Corpus leads for project' })
      .getByRole('button', { name: /^Retain .* for this project$/ })
      .first()
      .click();
    await expect(
      page.getByText('Lead attached with its lexical match limitation.', { exact: true }),
    ).toBeVisible();
    await navigate(page, 'Search');
    await page.getByLabel('Find something useful', { exact: true }).fill(leadTitle);
    await expect(page.getByRole('region', { name: 'Retained project fit' })).toContainText(
      'next action: explore',
    );
    await expect(page.getByRole('region', { name: 'Retained project fit' })).toContainText(
      'Project need:',
    );
    await navigate(page, 'Projects');
    const retainedOpportunity = page
      .locator('.desk-project-row')
      .filter({ has: page.getByRole('heading', { level: 3, name: leadTitle, exact: true }) });
    await retainedOpportunity.getByText('AI engineering setup (Context)', { exact: true }).click();
    await expect(
      retainedOpportunity.getByRole('button', { name: 'Prepare AI setup request for Context' }),
    ).toBeDisabled();
    await retainedOpportunity
      .getByLabel(`AI engineering need for ${leadTitle}`, { exact: true })
      .fill('AI-assisted browser interaction review');
    await retainedOpportunity
      .getByLabel(`Context profile ID for ${leadTitle}`, { exact: true })
      .fill('engineering-development-core');
    await retainedOpportunity
      .getByRole('button', { name: 'Prepare AI setup request for Context' })
      .click();
    await expect(page.getByRole('region', { name: 'Context setup request' })).toContainText(
      'AI-assisted browser interaction review',
    );
    const requestURL = await page
      .getByRole('link', { name: 'Download Context request' })
      .getAttribute('href');
    const portable = JSON.parse(decodeURIComponent(requestURL!.split(',')[1]!)) as {
      method: string;
      profile_id: string;
      findings: { outcome: string }[];
    };
    expect(portable.method).toBe('plan');
    expect(portable.profile_id).toBe('engineering-development-core');
    expect(portable.findings[0]!.outcome).toBe('AI-assisted browser interaction review');
    await expect(retainedOpportunity).toContainText('Next action: explore');
    expect(researchCalls).toEqual([]);
    await page.getByText('Research one project gap', { exact: true }).click();
    await page
      .getByLabel('Question for this project', { exact: true })
      .fill('Compare supported error contract examples');
    await page.getByRole('button', { name: 'Preview research context', exact: true }).click();
    const egress = page.getByRole('region', { name: 'Project research egress' });
    const actualContext = await egress.locator('pre').innerText();
    expect(actualContext).toContain('Compare HTTP problem detail standards');
    expect(actualContext).not.toContain(folder);
    expect(actualContext).not.toContain('never-share-this');
    expect(researchCalls).toEqual([]);
    await egress
      .getByRole('button', { name: 'Use this context in online research', exact: true })
      .click();
    await expect(page.getByText('quick budget:', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Start online research', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Research brief' })).toBeVisible();
    expect(researchCalls).toEqual([
      expect.objectContaining({
        query: 'Compare supported error contract examples',
        context: actualContext,
        profile: 'quick',
        save: 'never',
      }),
    ]);
    await page.screenshot({
      path: test.info().outputPath('project-preview-registered.png'),
      fullPage: true,
    });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
