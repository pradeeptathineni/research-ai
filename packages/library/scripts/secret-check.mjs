import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const root = new URL('../', import.meta.url);
const rootPath = fileURLToPath(root);
const excluded = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  'playwright-report',
  'test-results',
  '.signals',
]);
const textExtensions = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.sql',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);
const signatures = [
  /\bsk-(?:proj-|svcacct-|live-)?[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
];

const findings = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
    } else if (textExtensions.has(extname(entry.name)) || entry.name === '.env.example') {
      const content = await readFile(path, 'utf8');
      if (signatures.some((pattern) => pattern.test(content))) {
        findings.push(relative(rootPath, path));
      }
    }
  }
}

await walk(rootPath);
if (findings.length) {
  process.stderr.write(`Potential committed secret material: ${findings.join(', ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('No high-confidence secret signatures found.\n');
}
