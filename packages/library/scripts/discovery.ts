import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadSettings, saveSettings } from '../packages/corpus/src/search-settings.js';
import { runDueOnce, acquireResearchLease } from '../packages/corpus/src/search-scheduler.js';
import { budgets, type SearchResult } from '../packages/domain/src/search-contract.js';
import { saveEntities, atomicJson, readPrivateJson } from '../packages/corpus/src/search-store.js';
import { randomUUID } from 'node:crypto';
import { publishCorpus } from '../packages/corpus/src/search-publish.js';
import {
  runQueryListOnce,
  planQueryAcquisition,
} from '../packages/corpus/src/search-query-list.js';
import { parseArgs } from 'node:util';

const [operation, ...args] = process.argv.slice(2);
try {
  const settings = await loadSettings();
  if (operation === 'setup-concepts') {
    const catalog = JSON.parse(await readFile(resolve('config/context-concepts.json'), 'utf8')) as {
      concepts: Record<string, { definition: string }>;
    };
    const queries = Object.entries(catalog.concepts).map(([concept, entry]) => ({
      id: `concept-${concept.replace(/[._]/g, '-')}`,
      query: concept.replace(/[._]/g, ' '),
      context: entry.definition,
      enabled: true,
      everyDays: 21,
      offsetMinutes: 0,
      concepts: [concept],
      supplementalSites: [],
    }));
    settings.queries.push(
      ...queries.filter((query) => !settings.queries.some((item) => item.id === query.id)),
    );
    console.log(JSON.stringify(await saveSettings(settings)));
  } else if (operation === 'plan-list') {
    console.log(JSON.stringify(planQueryAcquisition(settings, args.length ? args : undefined)));
  } else if (operation === 'run-list' && args[0] === '--once') {
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    process.once('SIGTERM', () => controller.abort());
    const { values, positionals: ids } = parseArgs({
      args: args.slice(1),
      allowPositionals: true,
      options: {
        resume: { type: 'string' },
        limit: { type: 'string' },
        model: { type: 'string' },
        effort: { type: 'string' },
        profile: { type: 'string' },
        'extract-model': { type: 'string' },
        'extract-effort': { type: 'string' },
        'no-share': { type: 'boolean' },
      },
    });
    if (values.profile && !['quick', 'wide'].includes(values.profile))
      throw new Error('invalid_profile');
    console.log(
      JSON.stringify(
        await runQueryListOnce({
          ids: ids.length ? ids : undefined,
          resume: values.resume,
          settings: {
            ...settings,
            ...(values['no-share'] ? { acquisitionGroups: [] } : {}),
            model: values.model ?? settings.model,
            effort: values.effort ?? settings.effort,
            profile: (values.profile as 'quick' | 'wide') ?? settings.profile,
            extractionModel: values['extract-model'] ?? settings.extractionModel,
            extractionEffort: values['extract-effort'] ?? settings.extractionEffort,
          },
          limit: values.limit ? Number(values.limit) : undefined,
          signal: controller.signal,
          progress: (event) => process.stderr.write(`${event}\n`),
        }),
      ),
    );
  } else if (operation === 'setup') {
    const pack = JSON.parse(await readFile(resolve('config/queries.example.json'), 'utf8')) as {
      queries: {
        id: string;
        query: string;
        enabled: boolean;
        schedule: { every_days: number; stagger_minutes: number };
        concept_refs: string[];
        supplemental_sites?: string[];
      }[];
    };
    const catalog = JSON.parse(
      await readFile(resolve('config/context-concepts.json'), 'utf8'),
    ) as unknown;
    const encoded = JSON.stringify(catalog);
    const mapped = pack.queries.map((query) => ({
      id: query.id,
      query: query.query,
      enabled: query.enabled,
      everyDays: query.schedule.every_days,
      offsetMinutes: query.schedule.stagger_minutes,
      concepts: query.concept_refs,
      supplementalSites: query.supplemental_sites ?? [],
    }));
    const missing = mapped
      .flatMap((query) => query.concepts)
      .filter((id) => !encoded.includes(`"${id}"`));
    if (missing.length) throw new Error(`Unknown pinned concepts: ${missing.join(', ')}`);
    settings.queries = [
      ...settings.queries,
      ...mapped.filter((query) => !settings.queries.some((item) => item.id === query.id)),
    ];
    console.log(JSON.stringify(await saveSettings(settings)));
  } else if (operation === 'publish') console.log(JSON.stringify(await publishCorpus()));
  else if (operation === 'retry') {
    if (args.length !== 1 || args[0]!.length > 300) throw new Error('retry JOB_KEY');
    const release = await acquireResearchLease(process.cwd());
    if (!release) throw new Error('research_busy');
    try {
      const path = resolve('.signals/discovery-state.json');
      const state = (await readPrivateJson(
        process.cwd(),
        'discovery-state.json',
        {},
        8000000,
      )) as Record<string, { slot: number; status: string }>;
      const prior = state[args[0]!];
      if (!prior || !['failed', 'uncertain'].includes(prior.status))
        throw new Error('retry_requires_failed_or_uncertain_slot');
      await atomicJson(resolve('.signals/discovery-attempts', `${randomUUID()}.json`), {
        key: args[0],
        prior,
        retriedAt: new Date().toISOString(),
      });
      delete state[args[0]!];
      await atomicJson(path, state);
      console.log(
        JSON.stringify({
          retryEnabled: args[0],
          inference: 'Next explicit run-due/timer activation may retry within configured budgets.',
          limits: budgets[settings.profile],
        }),
      );
    } finally {
      await release();
    }
  } else if (operation === 'status')
    console.log(
      JSON.stringify({
        settings,
        limits: budgets[settings.profile],
        publication: settings.publication,
        automaticPublication: settings.publication === 'unattended',
      }),
    );
  else if (operation === 'enable' || operation === 'disable') {
    if (!['query', 'corpus', 'both'].includes(args[0] ?? ''))
      throw new Error('Choose query, corpus or both.');
    if (args[0] !== 'corpus') settings.queryDiscovery = operation === 'enable';
    if (args[0] !== 'query') settings.corpusDiscovery = operation === 'enable';
    process.stderr.write(
      `Codex recurring inference: ${settings.profile}, ${JSON.stringify(budgets[settings.profile])}, UTC, threshold ${settings.threshold}, retention ${settings.retentionDays} days, ${settings.destination} corpus, ${settings.publication} publication.\n`,
    );
    console.log(JSON.stringify(await saveSettings(settings)));
  } else if (operation === 'run-due' && args[0] === '--once') {
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    process.once('SIGTERM', () => controller.abort());
    console.log(
      JSON.stringify(
        await runDueOnce({
          signal: controller.signal,
          progress: (event) => process.stderr.write(`${event}\n`),
        }),
      ),
    );
  } else if (operation === 'timer') {
    process.stderr.write(
      'Local discovery timer. Enabled modes run only while this process is open and the laptop is awake. Ctrl-C stops it.\n',
    );
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    process.once('SIGTERM', () => controller.abort());
    while (!controller.signal.aborted) {
      console.log(
        JSON.stringify(
          await runDueOnce({
            signal: controller.signal,
            progress: (event) => process.stderr.write(`${event}\n`),
          }),
        ),
      );
      if (!controller.signal.aborted)
        await new Promise<void>((resolveWait) => {
          const timeout = setTimeout(resolveWait, 30000);
          controller.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timeout);
              resolveWait();
            },
            { once: true },
          );
        });
    }
  } else if (operation === 'save-run') {
    if (args.length < 1 || !/^[a-f0-9-]{36}$/.test(args[0]!))
      throw new Error('save-run RUN_ID [ENTITY_ID...]');
    const result = JSON.parse(
      await readFile(resolve('.signals/runs', `${args[0]}.json`), 'utf8'),
    ) as SearchResult;
    const selected = args.slice(1);
    console.log(
      JSON.stringify(
        await saveEntities(
          result.items.filter((item) => !selected.length || selected.includes(item.entity.id)),
          'manual',
          process.cwd(),
          settings.destination,
          settings.threshold,
          false,
          { runId: result.runId, query: result.query, kind: 'one-off' },
        ),
      ),
    );
  } else
    throw new Error(
      'discovery setup | setup-concepts | status | plan-list [INTEREST_ID...] | run-list --once [--no-share] [INTEREST_ID...] | enable/disable query/corpus/both | run-due --once | timer | retry JOB_KEY | save-run RUN_ID [ENTITY_ID...] | publish',
    );
} catch (failure) {
  console.log(
    JSON.stringify({
      status: 'failed',
      code: failure instanceof Error ? failure.message : 'discovery_failed',
    }),
  );
  process.exitCode = 1;
}
