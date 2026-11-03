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

// Same-ref consistency lint only, not access control. Repository permissions
// and the github-pages environment own who may dispatch or deploy. Local
// corpus:build remains available for development, but not on this release path.
const pagesWorkflow = readFileSync(
  new URL('../.github/workflows/pages.yml', import.meta.url),
  'utf8',
);
const triggerBlock = /^on:\r?\n([\s\S]*?)^permissions:/m.exec(pagesWorkflow)?.[1] ?? '';
const triggers = [...triggerBlock.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_-]*):/gm)].map(
  (match) => match[1],
);
const dispatchInput =
  /^ {6}preview_sha256:\r?\n {8}description:.*\r?\n {8}required: true\r?\n {8}type: string$/m.test(
    pagesWorkflow,
  );
const reviewedCommand =
  /^ {10}npm run corpus -- build-reviewed --review-sha256="\$REVIEWED_PREVIEW_SHA256" --reviewer="\$REVIEWER"$/m.exec(
    pagesWorkflow,
  );
const reviewedExport = reviewedCommand?.index ?? -1;
const staticBuild = /^ {6}- run: npx vite build --config apps\/corpus\/vite\.config\.ts$/m.exec(
  pagesWorkflow,
);
const verifyStep =
  /^ {6}- name: Verify Vite copied every public artifact byte from the reviewed preview\r?\n {8}run: npm run corpus -- verify-reviewed-site --preview-sha256="\$REVIEWED_PREVIEW_SHA256"$/m.exec(
    pagesWorkflow,
  );
const uploadStep =
  /^ {6}- uses: actions\/upload-pages-artifact@[^\r\n]+\r?\n {8}with:\r?\n {10}path: dist\/public-site$/m.exec(
    pagesWorkflow,
  );
const byteCheck = verifyStep?.index ?? -1;
const upload = uploadStep?.index ?? -1;
const verifyEnd = byteCheck < 0 ? -1 : byteCheck + verifyStep[0].length;
const releaseTests = [
  pagesWorkflow.indexOf('      - name: Install the pinned private PDF test parser'),
  pagesWorkflow.indexOf('      - run: npm test'),
  pagesWorkflow.indexOf(
    '      - run: node --experimental-strip-types --test scripts/public-site-integrity.test.mjs',
  ),
];
const noBuildBeforeUpload =
  !/npm run (?:corpus:build|build(?:\s|$))|npm run corpus -- build(?:\s|$)/.test(pagesWorkflow);
if (
  triggers.join(',') !== 'workflow_dispatch' ||
  !dispatchInput ||
  !pagesWorkflow.includes('REVIEWER: ${{ github.actor }}') ||
  !pagesWorkflow.includes('--reviewer="$REVIEWER"') ||
  reviewedExport < 0 ||
  !staticBuild ||
  staticBuild.index <= reviewedExport ||
  byteCheck <= staticBuild.index ||
  releaseTests.some((position) => position < 0 || position >= reviewedExport) ||
  !noBuildBeforeUpload ||
  upload <= byteCheck ||
  verifyEnd < 0 ||
  pagesWorkflow.slice(verifyEnd, upload).trim() !== '' ||
  !pagesWorkflow.includes('name: github-pages')
)
  throw new Error('Pages publication must be manually reviewed and byte-verified before upload.');
process.stdout.write(`Pre-1 release guard passed: ${version}\n`);
