import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { unlinkSync, symlinkSync } from 'node:fs';
import type * as NodeFs from 'node:fs';
import type { PathLike } from 'node:fs';
import { join } from 'node:path';
import { materialPreviewCli } from '../../../scripts/material-preview.js';

const hooks = vi.hoisted(() => ({ afterLstat: null as ((path: string) => void) | null }));
vi.mock('node:fs', async () => {
  const fs = await vi.importActual<typeof NodeFs>('node:fs');
  return {
    ...fs,
    lstatSync: (path: PathLike) => {
      const result = fs.lstatSync(path);
      hooks.afterLstat?.(String(path));
      return result;
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  hooks.afterLstat = null;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(text: string) {
  const root = await mkdtemp('/tmp/material-preview-cli-');
  roots.push(root);
  const file = join(root, 'explicit-snapshot.json');
  await writeFile(
    file,
    JSON.stringify({
      extractor: 'plain-text',
      title: 'CLI public control',
      links: [],
      author: null,
      publishedAt: null,
      sections: [],
      text,
    }),
  );
  return { root, file };
}

it('provides an actual two-step ordinary source selection with no implicit output or source mutation', async () => {
  const { root, file } = await fixture('Not suitable unless this prerequisite holds.');
  const original = await readFile(file);
  const listed = materialPreviewCli(['list', '--snapshot', file]);
  expect(listed.code).toBe(0);
  const list = JSON.parse(listed.stdout);
  const selected = materialPreviewCli([
    'select',
    '--snapshot',
    file,
    '--sha256',
    list.textSha256,
    '--start',
    '0',
    '--end',
    String(list.textLength),
  ]);
  expect(selected.code).toBe(0);
  expect(JSON.parse(selected.stdout).selection.text).toBe(
    'Not suitable unless this prerequisite holds.',
  );
  expect(await readdir(root)).toEqual(['explicit-snapshot.json']);
  expect(await readFile(file)).toEqual(original);
});

it('provides an actual long source workflow and rejects over-budget selection', async () => {
  const { file } = await fixture('A'.repeat(60000) + 'Late caveat.');
  const list = JSON.parse(
    materialPreviewCli(['list', '--snapshot', file, '--offset', '60000']).stdout,
  );
  const selected = materialPreviewCli([
    'select',
    '--snapshot',
    file,
    '--sha256',
    list.textSha256,
    '--start',
    '60000',
    '--end',
    '60012',
  ]);
  expect(selected.code).toBe(0);
  expect(JSON.parse(selected.stdout).selection.text).toBe('Late caveat.');
  expect(
    materialPreviewCli([
      'select',
      '--snapshot',
      file,
      '--sha256',
      list.textSha256,
      '--start',
      '0',
      '--end',
      '48001',
    ]).code,
  ).toBe(1);
});

it('refuses missing, repeated and unsupported arguments without reading a default snapshot', () => {
  for (const args of [
    [],
    ['list'],
    ['list', '--snapshot', 'absent', '--snapshot', 'other'],
    ['list', '--snapshot', 'absent', '--start', '0'],
    ['select', '--snapshot', 'absent', '--sha256', 'x', '--start', '0.1', '--end', '2'],
  ]) {
    const result = materialPreviewCli(args);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
  }
});

it('refuses a snapshot symlink and a deterministic path-replacement race', async () => {
  const { file, root } = await fixture('Allowed original source.');
  const target = join(root, 'another-public-control.json');
  await writeFile(target, await readFile(file));
  const link = join(root, 'link.json');
  symlinkSync(target, link);
  expect(materialPreviewCli(['list', '--snapshot', link]).code).toBe(1);
  hooks.afterLstat = (path) => {
    if (path === file) {
      hooks.afterLstat = null;
      unlinkSync(file);
      symlinkSync(target, file);
    }
  };
  const raced = materialPreviewCli(['list', '--snapshot', file]);
  expect(raced.code).toBe(1);
  expect(raced.stdout).toBe('');
});
