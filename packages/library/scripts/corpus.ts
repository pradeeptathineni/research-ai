import {
  exportReviewedPublicData,
  previewPublicData,
  publishPublicData,
  reviewPublicDataPreview,
  verifyPublicSiteArtifacts,
} from '../packages/corpus/src/public-export.js';
import { loadPublicCorpus } from '../packages/corpus/src/public-corpus.js';
import { filterPublicOptions, type PublicFilters } from '../packages/domain/src/public-corpus.js';
import { constants } from 'node:fs';
import { open, readFile, writeFile } from 'node:fs/promises';
import { encodePublicEvidence } from '../packages/corpus/src/public-record.js';
import { loadEntities } from '../packages/corpus/src/search-store.js';
import {
  exportOpml,
  parseOpml,
  refreshBriefing,
  refreshDue,
} from '../packages/corpus/src/briefing/ingest.js';
import { createBriefingApi, readBriefingRefresh } from '../packages/corpus/src/briefing/store.js';
import { briefingRoute } from '../packages/corpus/src/briefing/http.js';
import { loadSettings, saveSettings } from '../packages/corpus/src/search-settings.js';
import {
  evidenceDigest,
  parseEvidenceBundle,
  requireUniqueJsonKeys,
} from '../packages/domain/src/evidence-exchange.js';

const [operation, ...args] = process.argv.slice(2);
if (operation === 'digest') {
  if (args.length !== 1) throw new Error('Usage: corpus digest FILE.json');
  const raw = await readFile(args[0]!, 'utf8');
  requireUniqueJsonKeys(raw);
  const record = JSON.parse(raw) as { evidence: unknown; encoding: string };
  const bytes = await encodePublicEvidence(record.evidence, record.encoding);
  const digest = evidenceDigest(bytes);
  parseEvidenceBundle(bytes, digest);
  process.stdout.write(`${digest}\n`);
  process.exit(0);
}
if (operation === 'briefing') {
  const [action, ...briefingArgs] = args;
  if (action === 'snapshot' && briefingArgs.length === 1) {
    const response = await briefingRoute(process.cwd(), 'briefing/workbench', false, undefined, 0);
    const snapshot = response?.body;
    if (
      response?.status !== 200 ||
      !snapshot ||
      typeof snapshot !== 'object' ||
      (snapshot as { schema?: unknown }).schema !== 'signals.briefing-workbench.v1'
    )
      throw new Error('Briefing owner did not return a signals.briefing-workbench.v1 snapshot.');
    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
    const bytes = Buffer.byteLength(serialized, 'utf8');
    const snapshotLimit = 8 * 1024 * 1024;
    if (bytes > snapshotLimit)
      throw new Error(
        `Briefing snapshot exceeds the Research seed limit of ${snapshotLimit} bytes.`,
      );
    const output = briefingArgs[0]!;
    const handle = await open(
      output,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    process.stdout.write(
      `${JSON.stringify({ exported: true, schema: 'signals.briefing-workbench.v1', bytes, readAt: (snapshot as { readAt: string }).readAt })}\n`,
    );
    process.exit(0);
  }
  if (action === 'refresh' && briefingArgs.length === 1 && briefingArgs[0] === '--once') {
    process.stdout.write(`${JSON.stringify(await refreshBriefing(process.cwd()), null, 2)}\n`);
    process.exit(0);
  }
  if (
    action === 'refresh' &&
    briefingArgs.length === 2 &&
    briefingArgs[0] === '--once' &&
    briefingArgs[1]!.startsWith('--request-id=')
  ) {
    const requestId = briefingArgs[1]!.slice('--request-id='.length);
    process.stdout.write(
      `${JSON.stringify(await refreshDue(process.cwd(), { once: true, requestId }), null, 2)}\n`,
    );
    process.exit(0);
  }
  if (
    action === 'refresh-status' &&
    briefingArgs.length === 1 &&
    briefingArgs[0]!.startsWith('--request-id=')
  ) {
    const requestId = briefingArgs[0]!.slice('--request-id='.length);
    process.stdout.write(
      `${JSON.stringify(await readBriefingRefresh(process.cwd(), requestId), null, 2)}\n`,
    );
    process.exit(0);
  }
  if (action === 'opml-export' && briefingArgs.length === 1) {
    const sources = (await createBriefingApi(process.cwd()).listSources()).map(
      ({ record }) => record,
    );
    await writeFile(briefingArgs[0]!, exportOpml(sources), { flag: 'wx', mode: 0o600 });
    process.exit(0);
  }
  if (action === 'opml-import' && briefingArgs.length === 1) {
    const parsed = parseOpml(await readFile(briefingArgs[0]!, 'utf8'));
    if (
      parsed.some(
        (source) =>
          (source.type === 'ics' && !/\.ics(?:$|\?)/i.test(source.url)) ||
          (source.type === 'jsonfeed' && !/\.json(?:$|\?)/i.test(source.url)),
      )
    )
      throw new Error('Source type must be inferable from an .ics or .json URL.');
    const settings = await loadSettings(process.cwd());
    const byUrl = new Map((settings.followedSources ?? []).map((source) => [source.uri, source]));
    for (const source of parsed)
      byUrl.set(source.url, { uri: source.url, label: source.label, enabled: true, interests: [] });
    if (byUrl.size > 50) throw new Error('Following supports at most 50 sources.');
    settings.followedSources = [...byUrl.values()];
    await saveSettings(settings, process.cwd());
    process.stdout.write(
      `${JSON.stringify({ imported: parsed.length, configured: settings.followedSources.length, acquisition: 'not_started' })}\n`,
    );
    process.exit(0);
  }
  throw new Error(
    'Usage: corpus briefing snapshot NEW_FILE.json | refresh --once [--request-id=UUID] | refresh-status --request-id=UUID | opml-import FILE.opml | opml-export NEW_FILE.opml',
  );
}
const corpus = await loadPublicCorpus();
if (operation === 'check') {
  const entities = await loadEntities();
  process.stdout.write(
    `${corpus.bundles.length} reviewed bundles; ${corpus.options.length} public options; ${entities.length} native entities.\n`,
  );
} else if (operation === 'search') {
  const filters: PublicFilters = {};
  const allowed = new Set([
    'query',
    'textMode',
    'type',
    'category',
    'concept',
    'sourceClass',
    'freshness',
    'disposition',
  ]);
  for (const argument of args) {
    const match = /^--([a-zA-Z]+)=(.*)$/.exec(argument);
    if (match?.[1] === 'githubOnly' && ['true', 'false'].includes(match[2]!)) {
      filters.githubOnly = match[2] === 'true';
      continue;
    }
    if (!match || !allowed.has(match[1]!))
      throw new Error('Use --query=TEXT or a documented exact filter.');
    // Literal is the only mode here; ranked search uses the shared Library index.
    if (match[1] === 'textMode') {
      if (match[2] !== 'literal')
        throw new Error('Text mode must be literal; use library-query for ranked search.');
      continue;
    }
    Object.assign(filters, { [match[1]!]: match[2]! });
  }
  process.stdout.write(
    `${JSON.stringify({ universe: 'reviewed-public-files', filters, items: filterPublicOptions(corpus.options, filters) }, null, 2)}\n`,
  );
} else if (operation === 'build') {
  await publishPublicData(corpus, 'dist', await loadEntities());
} else if (operation === 'preview' && args.length === 0) {
  const preview = previewPublicData(corpus, await loadEntities());
  process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
} else if (operation === 'build-reviewed') {
  const values: Record<string, string> = {};
  for (const arg of args) {
    const match = /^--(review-sha256|reviewer)=(.*)$/.exec(arg);
    if (!match || !match[2])
      throw new Error(
        'Usage: corpus build-reviewed --review-sha256=PREVIEW_SHA256 --reviewer=LABEL',
      );
    if (Object.hasOwn(values, match[1]!)) throw new Error('Duplicate review option.');
    values[match[1]!] = match[2]!;
  }
  if (Object.keys(values).length !== 2 || !/^[a-f0-9]{64}$/.test(values['review-sha256'] ?? ''))
    throw new Error('Usage: corpus build-reviewed --review-sha256=PREVIEW_SHA256 --reviewer=LABEL');
  const entities = await loadEntities();
  const preview = previewPublicData(corpus, entities);
  const review = reviewPublicDataPreview(preview, {
    confirmedSha256: values['review-sha256']!,
    reviewer: values.reviewer!,
    reviewedAt: new Date().toISOString(),
  });
  const result = await exportReviewedPublicData(corpus, 'dist', entities, review);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else if (operation === 'verify-reviewed-site') {
  if (args.length !== 1 || !/^--preview-sha256=[a-f0-9]{64}$/.test(args[0]!))
    throw new Error('Usage: corpus verify-reviewed-site --preview-sha256=SHA256');
  const entities = await loadEntities();
  const preview = previewPublicData(corpus, entities);
  const expectedSha256 = args[0]!.slice('--preview-sha256='.length);
  if (preview.sha256 !== expectedSha256)
    throw new Error('Current public inputs differ from the reviewed preview.');
  const result = await verifyPublicSiteArtifacts(preview, 'dist/public-site');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else
  throw new Error(
    'Usage: corpus check | search --query=TEXT [--type=VALUE] | build | preview | build-reviewed --review-sha256=SHA256 --reviewer=LABEL | verify-reviewed-site --preview-sha256=SHA256',
  );
