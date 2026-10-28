import { publishPublicData } from '../packages/corpus/src/public-export.js';
import { loadPublicCorpus } from '../packages/corpus/src/public-corpus.js';
import { filterPublicOptions, type PublicFilters } from '../packages/domain/src/public-corpus.js';
import { readFile, writeFile } from 'node:fs/promises';
import { encodePublicEvidence } from '../packages/corpus/src/public-record.js';
import { loadEntities } from '../packages/corpus/src/search-store.js';
import { exportOpml, parseOpml, refreshBriefing } from '../packages/corpus/src/briefing/ingest.js';
import { createBriefingApi } from '../packages/corpus/src/briefing/store.js';
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
  if (action === 'refresh' && briefingArgs.length === 1 && briefingArgs[0] === '--once') {
    process.stdout.write(`${JSON.stringify(await refreshBriefing(process.cwd()), null, 2)}\n`);
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
    'Usage: corpus briefing refresh --once | opml-import FILE.opml | opml-export NEW_FILE.opml',
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
} else throw new Error('Usage: corpus check | search --query=TEXT [--type=VALUE] | build');
