import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const appRoot = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(appRoot, '../..');
const app = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'));
const library = JSON.parse(await readFile(join(workspaceRoot, 'packages/library/package.json'), 'utf8'));
assert.equal(app.name, 'research-workbench');
assert.equal(app.dependencies['signals-ai'], 'file:../../packages/library');
assert.equal(app.dependencies['@pradeeptathineni/research-ai'], 'file:../../packages/methods');
assert.equal(app.scripts.start, 'npm run start --workspace signals-ai');
assert.equal(app.scripts.dev, 'npm run dev --workspace signals-ai');
assert.equal(library.name, 'signals-ai');
for (const name of ['start', 'dev', 'test:workbench', 'build'])
  assert.equal(typeof library.scripts[name], 'string', `Library workbench script ${name} must remain present`);
await readFile(join(workspaceRoot, 'packages/library/scripts/workbench.ts'));
console.log('Resolved the workspace workbench forwarder to the existing signals-ai scripts/workbench.ts; no app source was copied or launched.');
