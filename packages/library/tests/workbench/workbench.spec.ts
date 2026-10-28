import { test, expect, type Page } from '@playwright/test';
import { expectAccessibleViewport } from './accessibility.js';
import { selectEvidenceResearch } from './research.js';
import { loadEntities } from '../../packages/corpus/src/search-store.js';
import { projectNativeLibrary } from '../../packages/domain/src/library-search.js';

async function destination(page: Page, name: string) {
  await page.getByRole('complementary').getByRole('button', { name, exact: true }).click();
}
async function research(page: Page, question?: string) {
  await destination(page, 'Search');
  if (question !== undefined)
    await page.getByLabel('Find something useful', { exact: true }).fill(question);
  await page.getByRole('button', { name: 'Research online', exact: true }).click();
  await selectEvidenceResearch(page);
}
async function following(page: Page, panel: string) {
  await destination(page, 'Following');
  await page
    .getByRole('navigation', { name: 'Following views' })
    .getByRole('button', { name: panel, exact: true })
    .click();
}

async function replayDuplicateIdentity(page: Page) {
  const [record] = await loadEntities();
  if (!record) throw new Error('public_replay_fixture_missing');
  await page.route('**/__signals/api/library', (route) =>
    route.fulfill({
      json: {
        findings: [projectNativeLibrary(record, 'public'), projectNativeLibrary(record, 'private')],
      },
    }),
  );
  return record;
}

test('source scans and result exposures retain distinct denominators', async ({ page }) => {
  await page.route('**/__signals/api/source-scan', async (route) => {
    await route.fulfill({
      json: {
        sources: [
          {
            uri: 'https://example.com/feed',
            label: 'Followed source',
            state: 'unchanged',
            delta: 'No new links',
            newLinks: [],
            health: { scans: 2, resultExposures: 1, exposures: 1, opportunities: 0 },
          },
        ],
      },
    });
  });
  await page.goto('');
  await following(page, 'Sources');
  await page.getByRole('button', { name: 'Scan followed sources without AI', exact: true }).click();
  await expect(page.getByText(/2 scans; 1 result exposures/)).toBeVisible();
});

test('Search capture carries explicit question constraints to the research boundary', async ({
  page,
}) => {
  let submitted: unknown;
  await page.route('**/__signals/api/capture', async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ status: 400, json: { code: 'capture_payload_fixture_stopped' } });
  });
  await page.goto('');
  await research(page, 'Inspect this learning resource');
  await page.getByText('Project context and constraints', { exact: true }).click();
  await page.getByLabel('Context for this question').fill('Read only; no containers or installs.');
  await page.getByLabel('Capture a public URL').fill('https://example.com/learning');
  await page.getByRole('button', { name: 'Capture URL', exact: true }).click();
  await expect(page.getByText('capture_payload_fixture_stopped', { exact: true })).toBeVisible();
  expect(submitted).toMatchObject({
    query: 'Inspect this learning resource',
    context: 'Read only; no containers or installs.',
    captureUrls: ['https://example.com/learning'],
  });
});

test('duplicate Corpus identities send the selected store for check and refresh', async ({
  page,
}) => {
  const record = await replayDuplicateIdentity(page);
  // Frontend boundary fixture; backend scope/storage guards have separate HTTP regressions.
  const selections: unknown[] = [];
  await page.route('**/__signals/api/primary-check', async (route) => {
    selections.push(route.request().postDataJSON());
    await route.fulfill({ json: { status: 'unchanged', reason: 'Scope boundary fixture.' } });
  });
  await page.route('**/__signals/api/refresh', async (route) => {
    selections.push(route.request().postDataJSON());
    await route.fulfill({ status: 400, json: { code: 'scope_boundary_fixture_stopped' } });
  });
  await page.goto('');
  await destination(page, 'Search');
  const privateCard = page
    .locator('.desk-finding')
    .filter({ has: page.getByText(/Private finding/) });
  const publicCard = page
    .locator('.desk-finding')
    .filter({ has: page.getByText(/Public finding/) });
  await expect(privateCard).toHaveCount(1);
  await expect(publicCard).toHaveCount(1);
  await privateCard.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(publicCard.getByRole('button', { name: 'Compare', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await publicCard.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Compare selected findings' }).locator('article'),
  ).toHaveCount(2);
  await privateCard.getByText('Evidence & details', { exact: true }).click();
  await privateCard.getByRole('button', { name: 'Check primary source without AI' }).click();
  await expect(page.getByText(/Scope boundary fixture/)).toBeVisible();
  await privateCard
    .getByRole('button', { name: 'Research changes and independent evidence' })
    .click();
  await expect(page.getByRole('alert')).toContainText('scope_boundary_fixture_stopped');
  await publicCard.getByText('Evidence & details', { exact: true }).click();
  await publicCard.getByRole('button', { name: 'Check primary source without AI' }).click();
  expect(selections).toEqual([
    { id: record.entity.id, destination: 'private' },
    { id: record.entity.id, destination: 'private' },
    { id: record.entity.id, destination: 'public' },
  ]);
  const ids = await page
    .locator('[id]')
    .evaluateAll((elements) => elements.map((element) => element.id));
  expect(new Set(ids).size).toBe(ids.length);
});

test('server-owned replay supports evidence, private notes, manual saves, inbox and reopening', async ({
  page,
  request,
}) => {
  await page.goto('');
  await research(page, 'approved public replay');
  await page.getByRole('button', { name: 'Start online research', exact: true }).click();
  await expect(page.locator('.entity-card')).toHaveCount(2);
  await expect(page.getByRole('region', { name: 'Research brief' })).toContainText(
    'A practical next step',
  );
  expect(
    await page.locator('.research-brief').evaluate((brief) => {
      const card = document.querySelector('.entity-card');
      return (
        card && Boolean(brief.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_PRECEDING)
      );
    }),
  ).toBe(true);
  const first = page.locator('.entity-card').first();
  const annotatedName = await first.getByRole('heading', { level: 2 }).innerText();
  await first.getByText('Score, limits and sources', { exact: true }).click();
  await first.getByText(/^Observation inputs/).click();
  await first
    .getByRole('button', { name: /^Preview evidence for/ })
    .first()
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await first.getByText('Private note and feedback', { exact: true }).click();
  await first.getByRole('textbox', { name: /^Note for/ }).fill('Private browser annotation');
  await first.getByRole('combobox', { name: /^Feedback for/ }).selectOption('useful');
  await first.getByRole('button', { name: 'Save private note' }).click();
  await expect(page.getByText('Private note and feedback saved.')).toBeVisible();
  await first.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Keep selected in inbox' }).click();
  await expect(page.getByText(/^Promising inbox \(/)).toBeVisible();
  await page.getByRole('button', { name: /^Save selected/ }).click();
  await expect(first.getByText(/· Saved/)).toBeVisible();
  await page.reload();
  await expect(page.getByRole('region', { name: 'Research brief' })).toContainText(
    'A practical next step',
  );
  await page.getByText(/^Promising inbox \(/).click();
  await page
    .getByRole('button', { name: /^Reopen/ })
    .first()
    .click();
  await expect(page.locator('.entity-card')).toHaveCount(2);
  // Current Corpus membership can reorder replay; the annotation belongs to an identity.
  const reopened = page
    .locator('.entity-card')
    .filter({ has: page.getByRole('heading', { level: 2, name: annotatedName, exact: true }) });
  await reopened.getByText('Private note and feedback', { exact: true }).click();
  await expect(reopened.getByRole('textbox', { name: /^Note for/ })).toHaveValue(
    'Private browser annotation',
  );
  await destination(page, 'Library');
  await page.getByRole('button', { name: 'Inbox & capture', exact: true }).click();
  await page
    .getByRole('button', { name: /^Remove .* from inbox$/ })
    .first()
    .click();
  await expect(page.getByText('No pending leads.', { exact: false })).toBeVisible();
  await research(page);
  for (const width of [1440, 320]) {
    await expectAccessibleViewport(page, width);
    await page.screenshot({ path: test.info().outputPath(`portal-${width}.png`), fullPage: true });
  }
  const blocked = await request.get('__signals/api/personal', {
    headers: { origin: 'https://evil.example' },
  });
  expect(blocked.status()).toBe(403);
});

test('a readable answer survives metadata gaps and untrusted content is inert', async ({
  page,
}) => {
  await page.goto('');
  await research(page, 'partial metadata fixture');
  await page.getByRole('button', { name: 'Start online research', exact: true }).click();
  const brief = page.getByRole('region', { name: 'Research brief' });
  await expect(brief).toContainText('The original answer is retained despite a record gap.');
  await expect(page.getByRole('region', { name: 'Leads with metadata gaps' })).toContainText(
    'Missing supported defining evidence.',
  );
  await expect(page.locator('.entity-card')).toHaveCount(0);
  await expect(brief.locator('script')).toHaveCount(0);
  await expect(brief.getByRole('link')).toHaveCount(0);
  expect(await page.evaluate(() => '__briefExecuted' in window)).toBe(false);
  await page.getByRole('button', { name: 'Save lead privately', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('saved privately as an unassessed lead');
  await destination(page, 'Library');
  await page.getByLabel('Find something useful', { exact: true }).fill('Incomplete lead');
  const savedLead = page
    .locator('.desk-finding')
    .filter({ has: page.getByRole('heading', { name: 'Incomplete lead', exact: true }) });
  await expect(savedLead).toContainText('unassessed-lead');
  await savedLead.getByText('Evidence & details', { exact: true }).click();
  await expect(page.getByRole('region', { name: 'Evidence panel' })).toContainText(
    'Saved lead · not assessed',
  );
  await page.getByRole('button', { name: 'Close evidence', exact: true }).click();
  await destination(page, 'Activity');
  await expect(page.getByRole('region', { name: 'Recent research' })).toContainText(
    'partial metadata fixture',
  );
  await page.getByRole('button', { name: 'Open result', exact: true }).first().click();
  await expect(brief).toContainText('The original answer is retained despite a record gap.');
});

test('offline Corpus filtering and follow-up preserve selected destination scope', async ({
  page,
}) => {
  const record = await replayDuplicateIdentity(page);
  const requests: unknown[] = [];
  await page.route('**/__signals/api/library-discussion', async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ json: { answer: 'Scope fixture response.', statements: [] } });
  });
  await page.goto('');
  await destination(page, 'Search');
  await page.getByLabel('Find something useful', { exact: true }).fill('unmatched phrase fixture');
  await expect(page.locator('.desk-finding')).toHaveCount(0);
  await page.getByLabel('Find something useful', { exact: true }).fill(record.entity.name);
  await expect(page.locator('.desk-finding')).toHaveCount(2);
  await page
    .locator('.desk-finding')
    .filter({ has: page.getByText(/Private finding/) })
    .getByRole('button', { name: 'Compare', exact: true })
    .click();
  await page.getByText('Ask about these items', { exact: true }).click();
  await page
    .getByLabel('Ask selected retained evidence', { exact: true })
    .fill('What can I learn from this?');
  await page.getByRole('button', { name: 'Explain from retained evidence', exact: true }).click();
  await expect(page.getByText('Scope fixture response.')).toBeVisible();
  expect(requests).toEqual([
    { keys: [`native:private:${record.entity.id}`], question: 'What can I learn from this?' },
  ]);
  let reply = () => {};
  let waiting = false;
  await page.route('**/__signals/api/library-discussion', async (route) => {
    requests.push(route.request().postDataJSON());
    waiting = true;
    await new Promise<void>((resolve) => {
      reply = resolve;
    });
    await route.fulfill({
      json: { answer: 'Stale selected-scope answer must remain hidden.', statements: [] },
    });
  });
  await page
    .locator('.desk-finding')
    .filter({ has: page.getByText(/Public finding/) })
    .getByRole('button', { name: 'Compare', exact: true })
    .click();
  await page
    .getByLabel('Ask selected retained evidence', { exact: true })
    .fill('Inspect both qualified copies');
  await page.getByRole('button', { name: 'Explain from retained evidence', exact: true }).click();
  await expect.poll(() => waiting).toBe(true);
  expect((requests[1] as { keys: string[] }).keys.sort()).toEqual([
    `native:private:${record.entity.id}`,
    `native:public:${record.entity.id}`,
  ]);
  await page.getByRole('button', { name: 'Clear comparison', exact: true }).click();
  reply();
  await page
    .locator('.desk-finding')
    .filter({ has: page.getByText(/Private finding/) })
    .getByRole('button', { name: 'Compare', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Explain from retained evidence', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByText('Stale selected-scope answer must remain hidden.', { exact: true }),
  ).toHaveCount(0);
});

test('interest plans are editable, validated and opt out by interest', async ({ page }) => {
  await page.goto('');
  await following(page, 'Interests');
  await page.getByRole('button', { name: 'Add question', exact: true }).click();
  await page
    .getByRole('checkbox', { name: /^Allow shared source acquisition/ })
    .last()
    .uncheck();
  await page.getByText('Shared acquisition plan', { exact: true }).click();
  await page.getByLabel('Native-proposed acquisition groups (JSON)', { exact: true }).fill('{');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('must be valid JSON');
  await expect(
    page.getByLabel('Native-proposed acquisition groups (JSON)', { exact: true }),
  ).toHaveValue('{');
  await page.getByLabel('Native-proposed acquisition groups (JSON)', { exact: true }).fill('[]');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Settings saved.');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Research route', { exact: true })).toHaveCount(0);
  await expect(
    page.getByLabel('Evidence extraction model reference', { exact: false }),
  ).toHaveCount(0);
});

test('source settings and owned cancellation remain usable', async ({ page }) => {
  await page.goto('');
  await following(page, 'Sources');
  await page.getByText('Configured acquisition and extraction providers', { exact: true }).click();
  await expect(page.getByText('searxng: unconfigured', { exact: true })).toBeVisible();
  await expect(page.getByText('last30days: unconfigured', { exact: true })).toBeVisible();
  await page.getByLabel('Source URL', { exact: true }).fill('https://example.com/feed');
  await page.getByLabel('Source name', { exact: true }).fill('Private followed feed');
  await page.getByRole('button', { name: 'Add followed source', exact: true }).click();
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Settings saved.');
  await page.reload();
  await following(page, 'Sources');
  await expect(page.getByRole('group', { name: 'Private followed feed' })).toBeVisible();
  await research(page, 'cancellation fixture');
  await page.getByRole('button', { name: 'Start online research', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByText(/Research cancelled/)).toBeVisible();
});

test('provisional leads are separate from final savable evidence', async ({ page }) => {
  await page.goto('');
  await research(page, 'cancellation fixture');
  await page.getByRole('button', { name: 'Start online research', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Provisional research leads' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Research brief' })).toContainText(
    'This original answer is ready before source checks finish.',
  );
  await expect(page.getByRole('region', { name: 'Research brief' })).toContainText(
    'Partial output; research and evidence checks are still pending',
  );
  await expect(page.locator('.entity-card')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Provisional research leads' })).not.toBeVisible();
  await expect(page.getByText(/Research cancelled/)).toBeVisible();
});

test('Jobs runs a finite disabled activation without enabling recurrence', async ({ page }) => {
  await page.goto('');
  await destination(page, 'Activity');
  await page.getByRole('button', { name: 'Run due once', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('No due jobs activated.');
  await expect(page.getByLabel('Enable query discovery', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('Enable corpus discovery', { exact: true })).not.toBeChecked();
});
