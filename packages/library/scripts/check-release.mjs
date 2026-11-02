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

// A Pages release must be explicitly dispatched against the exact reviewed
// preview. Local corpus:build remains available for development, but must not
// be the artifact producer on the release path.
const pagesWorkflow = readFileSync(
  new URL('../.github/workflows/pages.yml', import.meta.url),
  'utf8',
);
const reviewedExport = pagesWorkflow.indexOf(
  'build-reviewed --review-sha256="$REVIEWED_PREVIEW_SHA256"',
);
const staticBuild = pagesWorkflow.indexOf('npx vite build --config apps/corpus/vite.config.ts');
const byteCheck = pagesWorkflow.indexOf(
  'verify-reviewed-site --preview-sha256="$REVIEWED_PREVIEW_SHA256"',
);
const upload = pagesWorkflow.indexOf('path: dist/public-site');
if (
  /^  push:/m.test(pagesWorkflow) ||
  !/workflow_dispatch:\s+inputs:\s+preview_sha256:[\s\S]*?required: true/.test(pagesWorkflow) ||
  !pagesWorkflow.includes('REVIEWER: ${{ github.actor }}') ||
  !pagesWorkflow.includes('--reviewer="$REVIEWER"') ||
  reviewedExport < 0 ||
  staticBuild <= reviewedExport ||
  byteCheck <= staticBuild ||
  upload <= byteCheck ||
  pagesWorkflow.includes('npm run corpus:build') || /npm run corpus -- build(?:\s|$)/.test(pagesWorkflow)
)
  throw new Error('Pages publication must be manually reviewed and byte-verified before upload.');
process.stdout.write(`Pre-1 release guard passed: ${version}\n`);
