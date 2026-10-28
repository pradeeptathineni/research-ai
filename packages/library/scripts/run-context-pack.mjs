import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import process from 'node:process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const configUrl = new URL('../.meta/context/pack.json', import.meta.url);
const repomixBin = fileURLToPath(
  new URL('../node_modules/repomix/bin/repomix.cjs', import.meta.url),
);
export function findImplicitRepomixIgnoreFiles(rootPath) {
  const found = [];
  const pending = [rootPath];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        // Git metadata is outside the repository content Repomix can pack. Every
        // other directory is inspected, including ignored/generated trees, because
        // Repomix independently discovers nested .repomixignore files before it
        // applies the reviewed include and exclusion patterns.
        if (entry.name !== '.git') pending.push(path);
      } else if (entry.isFile() && entry.name === '.repomixignore') {
        found.push(path);
      }
    }
  }
  return found.sort();
}

export function validateContextPackConfig(config) {
  const errors = [];
  const patterns = [
    config?.output?.filePath,
    ...(Array.isArray(config?.include) ? config.include : []),
    ...(Array.isArray(config?.ignore?.customPatterns) ? config.ignore.customPatterns : []),
    ...(Array.isArray(config?.output?.patterns)
      ? config.output.patterns.map((entry) => entry?.pattern)
      : []),
  ];

  if (!Array.isArray(config?.include) || !Array.isArray(config?.ignore?.customPatterns)) {
    errors.push('context pack include and ignore patterns must be explicit arrays');
  }
  if (!Array.isArray(config?.output?.patterns)) {
    errors.push('context pack priority patterns must be an explicit array');
  }
  if (
    config?.ignore?.useGitignore !== false ||
    config?.ignore?.useDotIgnore !== false ||
    config?.ignore?.useDefaultPatterns !== false
  ) {
    errors.push(
      'context pack implicit Git, dot-ignore, and package-default patterns must be disabled',
    );
  }
  if (config?.output?.compress !== true) {
    errors.push('context pack output must remain structurally compressed');
  }
  if (
    !Number.isInteger(config?.output?.tokenBudget) ||
    config.output.tokenBudget <= 0 ||
    config.output.tokenBudget > 30_000
  ) {
    errors.push('context pack token budget must be an integer from 1 through 30000');
  }
  if (config?.security?.enableSecurityCheck !== true) {
    errors.push('context pack security scanning must remain enabled');
  }
  if (patterns.length > 160) {
    errors.push('context pack configuration contains too many patterns');
  }

  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > 256) {
      errors.push('context pack patterns must be non-empty strings of at most 256 characters');
      continue;
    }
    if (/[{}]/u.test(pattern)) {
      errors.push(`context pack pattern uses prohibited brace expansion: ${pattern}`);
    }
  }

  return errors;
}

export function validateContextPackArguments(args) {
  return args.length === 0 ? [] : ['context:pack does not accept caller-provided arguments'];
}

function run() {
  const errors = validateContextPackArguments(process.argv.slice(2));
  let config;
  try {
    config = JSON.parse(readFileSync(configUrl, 'utf8'));
  } catch (error) {
    errors.push(`could not read the reviewed context-pack configuration: ${String(error)}`);
  }
  if (config) errors.push(...validateContextPackConfig(config));
  try {
    const implicitIgnoreFiles = findImplicitRepomixIgnoreFiles(repositoryRoot);
    if (implicitIgnoreFiles.length > 0) {
      errors.push(
        `context pack refuses implicit .repomixignore files: ${implicitIgnoreFiles.join(', ')}`,
      );
    }
  } catch (error) {
    errors.push(`could not verify implicit context-pack inputs: ${String(error)}`);
  }

  if (errors.length > 0) {
    process.stderr.write(`Context pack refused:\n${errors.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }

  const result = spawnSync(process.execPath, [repomixBin, '--config', fileURLToPath(configUrl)], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error) {
    process.stderr.write(`Could not start Repomix: ${String(result.error)}\n`);
    process.exitCode = 1;
    return;
  }
  if (/Packed output exceeds the token budget:/u.test(`${result.stdout}${result.stderr}`)) {
    process.stderr.write('Context pack exceeded its reviewed token budget.\n');
    process.exitCode = 1;
    return;
  }
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
