import { it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, realpath, rm, mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium, expect as expectUI } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { libraryPreferences } from './library-meaning.js';
import type { LibrarySettings } from './library-settings.js';

it('built Settings shares native CLI values, preserves consent and refuses stale or uncertain saves', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'library-saving-browser-')));
  const output = resolve(process.env.LIBRARY_SETTINGS_EVIDENCE ?? '/tmp/library-settings-browser');
  await mkdir(output, { recursive: true });
  await libraryPreferences(root, { meaningMatching: true });
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('../../../tests/fixtures/s04-built-server.ts', import.meta.url)),
      root,
    ],
    {
      env: {
        ...process.env,
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        S04_NO_GENERATION: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  let stderr = '';
  child.stderr!.on('data', (value: Buffer) => {
    stderr += value.toString();
  });
  const cli = (body?: unknown): LibrarySettings => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/library-settings.ts',
        '--root',
        root,
        body ? 'edit' : 'show',
        ...(body ? [JSON.stringify(body)] : []),
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as LibrarySettings;
  };
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture_start_timeout')), 10000);
      child.on('message', (message: { type: string; port: number }) => {
        if (message.type === 'ready') {
          clearTimeout(timer);
          resolve(message.port);
        }
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error(stderr));
      });
    });
    browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/signals-ai/`);
    await page
      .getByRole('complementary')
      .getByRole('button', { name: 'Settings', exact: true })
      .click();
    const panel = page.getByRole('region', { name: 'Personal Library preferences' });
    const status = panel.getByRole('status');
    await expectUI(status).toContainText('Saved personal preferences loaded');
    await expectUI(panel.getByLabel('Automatic private saving', { exact: true })).not.toBeChecked();
    await expectUI(panel).toContainText('Source: default');
    await panel.getByLabel('Automatic private saving', { exact: true }).check();
    await panel.getByLabel('Minimum Signal', { exact: true }).fill('90');
    await expectUI(
      panel.getByRole('button', { name: 'Save personal preferences', exact: true }),
    ).toBeDisabled();
    const save = async () => {
      await panel.getByRole('button', { name: 'Preview personal preferences' }).click();
      await expectUI(status).toContainText('validated');
      await panel.getByRole('button', { name: 'Save personal preferences', exact: true }).click();
      await expectUI(status).toContainText('Personal preferences saved');
    };
    await save();
    expect(cli().settings.map((row) => row.effective)).toEqual([true, 90, 75]);
    expect((await libraryPreferences(root)).meaningMatching).toBe(true);
    await page.reload();
    await expectUI(status).toContainText('Saved personal preferences loaded');
    await expectUI(panel.getByLabel('Minimum Signal', { exact: true })).toHaveValue('90');
    await panel.getByLabel('Find personal-saving settings').fill('Signal');
    await expectUI(panel.getByLabel('Minimum relevance', { exact: true })).toHaveCount(0);
    await panel.getByLabel('Minimum Signal', { exact: true }).fill('95');
    await panel.getByLabel('Find personal-saving settings').fill('');
    const current = cli();
    cli({
      action: 'save',
      expectedRevision: current.revision,
      updates: { 'automaticSaving.signalThreshold': 80 },
      resets: [],
    });
    await panel.getByRole('button', { name: 'Preview personal preferences' }).click();
    await expectUI(status).toContainText('changed');
    await expectUI(
      panel.getByRole('button', { name: 'Save personal preferences', exact: true }),
    ).toBeDisabled();
    await panel.getByRole('button', { name: 'Reload personal preferences' }).click();
    await expectUI(panel.getByLabel('Minimum Signal', { exact: true })).toHaveValue('80');
    await panel.getByRole('button', { name: 'Use default saving preferences' }).click();
    await save();
    expect(cli().settings.every((row) => row.source === 'default')).toBe(true);
    await panel.getByLabel('Minimum Signal', { exact: true }).fill('101');
    await panel.getByRole('button', { name: 'Preview personal preferences' }).click();
    expect(
      await panel
        .getByLabel('Minimum Signal', { exact: true })
        .evaluate((element) => (element as HTMLInputElement).validity.rangeOverflow),
    ).toBe(true);
    await panel.getByLabel('Minimum Signal', { exact: true }).fill('85');
    await panel.getByRole('button', { name: 'Preview personal preferences' }).click();
    await expectUI(status).toContainText('validated');
    let writes = 0;
    await page.route('**/__signals/api/library-settings', async (route) => {
      if (
        route.request().method() === 'POST' &&
        (route.request().postDataJSON() as { action: string }).action === 'save'
      ) {
        writes++;
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    });
    await panel.getByRole('button', { name: 'Save personal preferences', exact: true }).click();
    await expectUI(status).toContainText('Save was not confirmed');
    await expectUI(
      panel.getByRole('button', { name: 'Save personal preferences', exact: true }),
    ).toBeDisabled();
    expect(cli().settings[1]?.effective).toBe(85);
    await page.unroute('**/__signals/api/library-settings');
    await panel.getByRole('button', { name: 'Reload personal preferences' }).click();
    await expectUI(status).toContainText('Saved personal preferences loaded');
    expect(writes).toBe(1);
    expect((await libraryPreferences(root)).meaningMatching).toBe(true);
    const audit = await new AxeBuilder({ page })
      .include('.desk-personal-preferences')
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(audit.violations).toEqual([]);
    await panel.screenshot({ path: join(output, 'library-saving-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await panel.getByLabel('Find personal-saving settings').focus();
    expect(
      await panel
        .getByLabel('Find personal-saving settings')
        .evaluate((element) => element === document.activeElement),
    ).toBe(true);
    await panel.screenshot({ path: join(output, 'library-saving-mobile.png') });
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'close');
      child.kill('SIGTERM');
      await stopped;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
