import { rm } from 'node:fs/promises';
import { URL } from 'node:url';

for (const target of [
  'dist',
  'coverage',
  'playwright-report',
  'test-results',
  '.meta/context/local',
]) {
  await rm(new URL(`../${target}`, import.meta.url), { force: true, recursive: true });
}
