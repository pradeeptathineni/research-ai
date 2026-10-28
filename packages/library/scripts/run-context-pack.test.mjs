import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

import {
  findImplicitRepomixIgnoreFiles,
  validateContextPackArguments,
  validateContextPackConfig,
} from './run-context-pack.mjs';

const scriptPath = fileURLToPath(new URL('./run-context-pack.mjs', import.meta.url));
const repositoryConfig = JSON.parse(
  readFileSync(new URL('../.meta/context/pack.json', import.meta.url), 'utf8'),
);
const clone = (value) => JSON.parse(JSON.stringify(value));

test('accepts the reviewed static configuration and no caller arguments', () => {
  assert.deepEqual(validateContextPackArguments([]), []);
  assert.deepEqual(validateContextPackConfig(repositoryConfig), []);
});

for (const args of [
  ['--include', '{{{{{{{{{{hostile}}}}}}}}}}'],
  ['--config', '/tmp/alternate.json'],
  ['unreviewed/path'],
]) {
  test(`rejects appended context-pack arguments: ${args.join(' ')}`, () => {
    assert.notDeepEqual(validateContextPackArguments(args), []);
    const result = spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not accept caller-provided arguments/u);
  });
}

test('rejects brace expansion and excessive pattern length in repository configuration', () => {
  const braceConfig = clone(repositoryConfig);
  braceConfig.include.push('src/{a,b}.ts');
  assert.match(validateContextPackConfig(braceConfig).join('\n'), /prohibited brace expansion/u);

  const longConfig = clone(repositoryConfig);
  longConfig.include.push('a'.repeat(257));
  assert.match(validateContextPackConfig(longConfig).join('\n'), /at most 256/u);
});

test('rejects disabled security, uncompressed output, and an excessive token budget', () => {
  const changed = clone(repositoryConfig);
  changed.security.enableSecurityCheck = false;
  changed.output.compress = false;
  changed.output.tokenBudget = 30_001;
  const errors = validateContextPackConfig(changed).join('\n');
  assert.match(errors, /security scanning/u);
  assert.match(errors, /structurally compressed/u);
  assert.match(errors, /1 through 30000/u);
});

test('rejects implicit Git, dot-ignore, default patterns, and unsafe output paths', () => {
  const changed = clone(repositoryConfig);
  changed.ignore.useGitignore = true;
  changed.ignore.useDotIgnore = true;
  changed.ignore.useDefaultPatterns = true;
  changed.output.filePath = '.meta/context/{alternate,hostile}/pack.xml';
  const errors = validateContextPackConfig(changed).join('\n');
  assert.match(errors, /implicit Git, dot-ignore, and package-default patterns/u);
  assert.match(errors, /prohibited brace expansion/u);
});

test('finds implicit .repomixignore files in every non-Git repository directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'signals-context-ignore-'));
  try {
    const searchedDirectories = [
      ['.codex'],
      ['.meta', 'context', 'local'],
      ['coverage'],
      ['dist'],
      ['node_modules', 'fixture'],
      ['playwright-report'],
      ['test-results'],
      ['apps', 'web'],
    ];
    for (const segments of searchedDirectories) {
      const directory = join(root, ...segments);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, '.repomixignore'), '{{{{hostile}}}}\n');
    }
    mkdirSync(join(root, '.git', 'info'), { recursive: true });
    writeFileSync(join(root, '.git', 'info', '.repomixignore'), 'metadata only\n');

    assert.deepEqual(
      findImplicitRepomixIgnoreFiles(root),
      searchedDirectories.map((segments) => join(root, ...segments, '.repomixignore')).sort(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
