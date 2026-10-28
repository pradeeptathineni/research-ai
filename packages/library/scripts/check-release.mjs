import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import process from 'node:process';

// The withdrawn stable name cannot be reused by the ordinary milestone process.
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
if (!/^0\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/.test(version)) {
  throw new Error(
    'Only 0.x milestones are authorized. A stable release requires a new user decision.',
  );
}
const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : null;
if (tag && tag !== `v${version}`)
  throw new Error('Release tag must match the authorized 0.x version.');
process.stdout.write(`Pre-1 release guard passed: ${version}\n`);
