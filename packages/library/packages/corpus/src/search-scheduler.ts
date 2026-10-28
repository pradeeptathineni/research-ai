import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { type SearchResult, type SearchRequest } from '../../domain/src/search-contract.js';
import { loadSettings, type SearchSettings } from './search-settings.js';
import {
  atomicJson,
  secureDirectory,
  loadEntities,
  retainRun,
  saveEntities,
  cleanRuns,
  readPrivateJson,
  withWriter,
} from './search-store.js';
import { signalSearch } from './signal-search.js';
import { codexRunner } from './search-runner.js';
import { loadAcquisitionConfig } from './search-acquisition.js';
import { digest } from './search-fetch.js';
import { publicationReadiness, publishCorpus } from './search-publish.js';
import { checkPrimaryMaterial } from './search-reuse.js';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

interface JobState {
  slot: number;
  status: 'running' | 'completed' | 'uncertain' | 'failed' | 'cancelled';
  runId?: string;
  started: string;
  reason?: string;
  primaryCheck?: { checkedAt: string; status: string; reason: string };
  reusedFromKey?: string;
}
type ScheduleState = Record<string, JobState>;
const stateSchema = Type.Record(
  Type.String({ maxLength: 300 }),
  Type.Object(
    {
      slot: Type.Integer({ minimum: 0 }),
      status: Type.Enum(['running', 'completed', 'uncertain', 'failed', 'cancelled']),
      runId: Type.Optional(Type.String({ maxLength: 100 })),
      started: Type.String({ maxLength: 40 }),
      reason: Type.Optional(Type.String({ maxLength: 100000 })),
      primaryCheck: Type.Optional(
        Type.Object(
          {
            checkedAt: Type.String({ maxLength: 40 }),
            status: Type.String({ maxLength: 40 }),
            reason: Type.String({ maxLength: 100000 }),
          },
          { additionalProperties: false },
        ),
      ),
      reusedFromKey: Type.Optional(Type.String({ maxLength: 300 })),
    },
    { additionalProperties: false },
  ),
);

/** One private, process-owned lease covers finite due runs and every query batch. */
export async function acquireResearchLease(root: string) {
  const path = resolve(root, '.signals/discovery-lease.json');
  const token = randomUUID();
  const acquired = await withWriter(root, async () => {
    const owner = (await readPrivateJson(root, 'discovery-lease.json', null, 10000)) as {
      pid?: number;
    } | null;
    if (owner) {
      if (!Number.isInteger(owner.pid) || owner.pid! < 1) throw new Error('invalid_research_lease');
      try {
        process.kill(owner.pid!, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
      }
    }
    await atomicJson(path, { pid: process.pid, token, startedAt: new Date().toISOString() });
    return true;
  });
  if (!acquired) return null;
  return async () =>
    withWriter(root, async () => {
      const owner = (await readPrivateJson(root, 'discovery-lease.json', null, 10000)) as {
        token?: string;
      } | null;
      if (owner?.token === token) await unlink(path);
    });
}
export function dueSlot(now: number, days: number, offsetMinutes = 0) {
  const interval = days * 86400000,
    offset = offsetMinutes * 60000;
  return Math.floor((now - offset) / interval) * interval + offset;
}
export function refreshRequest(
  entity: { uri: string; name: string; aliases: string[] },
  settings: SearchSettings,
): SearchRequest {
  return {
    query: `Refresh exact entity ${entity.name} (${entity.uri}); aliases ${entity.aliases.join(', ')}. Find material changes, new independent applied use, alternatives, deprecation and contrary evidence. Preserve exact canonical identity.`,
    profile: settings.profile,
    route: settings.route,
    review: settings.groundedReview ?? false,
    threshold: settings.threshold,
    cache: 'private',
    sources: settings.sources,
    supplementalSites: settings.supplementalSites,
    save: 'never',
  };
}
/** One lease protects AI work; completion follows idempotent entity writes, never inference alone. */
export async function runDueOnce(
  options: {
    root?: string;
    now?: number;
    settings?: SearchSettings;
    search?: typeof signalSearch;
    signal?: AbortSignal;
    progress?: (event: string) => void;
    check?: typeof checkPrimaryMaterial;
  } = {},
) {
  const root = options.root ?? process.cwd(),
    now = options.now ?? Date.now();
  const settings = options.settings ?? (await loadSettings(root));
  if (!settings.queryDiscovery && !settings.corpusDiscovery) return { enabled: false, jobs: [] };
  if (settings.publication === 'unattended') await publicationReadiness(root, true);
  const directory = resolve(root, '.signals');
  await secureDirectory(directory);
  const release = await acquireResearchLease(root);
  if (!release) return { enabled: true, busy: true, jobs: [] };
  try {
    const statePath = resolve(directory, 'discovery-state.json');
    const raw = await readPrivateJson(root, 'discovery-state.json', {}, 8000000);
    if (!Value.Check(stateSchema, raw)) throw new Error('invalid_discovery_state');
    const state: ScheduleState = raw;
    const jobs: { key: string; status: string; runId?: string; reason?: string }[] = [];
    const researchConfig = {
      runner: settings.runner,
      model: settings.model,
      effort: settings.effort,
      extractionModel: settings.extractionModel,
      extractionEffort: settings.extractionEffort,
      profile: settings.profile,
      route: settings.route,
      threshold: settings.threshold,
      groundedReview: settings.groundedReview ?? false,
      sources: settings.sources,
      supplementalSites: settings.supplementalSites,
      destination: settings.destination,
    };
    const revision = digest(
      JSON.stringify({ ...researchConfig, everyDays: settings.corpusEveryDays }),
    ).slice(0, 16);
    const planned: {
      identity: string;
      slot: number;
      request: SearchRequest;
      kind: 'query' | 'corpus';
      revision: string;
      entity?: Awaited<ReturnType<typeof loadEntities>>[number]['entity'];
    }[] = [];
    if (settings.queryDiscovery)
      for (const query of settings.queries.filter((item) => item.enabled))
        planned.push({
          identity: query.id,
          slot: dueSlot(now, query.everyDays, query.offsetMinutes),
          request: {
            query: query.query,
            context: query.context,
            profile: settings.profile,
            route: settings.route,
            review: settings.groundedReview ?? false,
            threshold: settings.threshold,
            sources: settings.sources,
            supplementalSites: [
              ...new Set([
                ...(settings.supplementalSites ?? []),
                ...(query.supplementalSites ?? []),
              ]),
            ],
            save: 'never',
            cache: 'private',
          },
          kind: 'query',
          revision: digest(
            JSON.stringify({
              ...researchConfig,
              query: query.query,
              context: query.context,
              supplementalSites: [
                ...new Set([
                  ...(settings.supplementalSites ?? []),
                  ...(query.supplementalSites ?? []),
                ]),
              ],
              everyDays: query.everyDays,
              offsetMinutes: query.offsetMinutes,
            }),
          ).slice(0, 16),
        });
    if (settings.corpusDiscovery) {
      const corpus = await loadEntities(
        resolve(
          root,
          settings.destination === 'public' ? 'signals/entities' : '.signals/corpus/entities',
        ),
      );
      const slot = dueSlot(now, settings.corpusEveryDays);
      for (const record of corpus.sort(
        (a, b) =>
          (state[`corpus:${a.entity.id}:${revision}`]?.slot ?? 0) -
            (state[`corpus:${b.entity.id}:${revision}`]?.slot ?? 0) ||
          a.entity.id.localeCompare(b.entity.id),
      ))
        planned.push({
          identity: record.entity.id,
          slot,
          request: refreshRequest(record.entity, settings),
          kind: 'corpus',
          revision,
          entity: record.entity,
        });
    }
    const started = Date.now();
    const exactRequests = new Map<string, { result: SearchResult; key: string }>();
    for (const job of planned) {
      if (
        jobs.length >= settings.batchSize ||
        Date.now() - started >= 1200000 ||
        options.signal?.aborted
      )
        break;
      const key = `${job.kind}:${job.identity}:${job.revision}`;
      const prior = state[key];
      if (prior?.status === 'running') {
        prior.status = 'uncertain';
        prior.reason =
          'Interrupted after possible inference. Inspect the frozen run; explicit retry is required.';
        await atomicJson(statePath, state);
        jobs.push({ key, status: 'uncertain', reason: prior.reason });
        continue;
      }
      if (prior && (prior.status === 'uncertain' || prior.slot >= job.slot)) continue;
      state[key] = { slot: job.slot, status: 'running', started: new Date(now).toISOString() };
      await atomicJson(statePath, state);
      let result: SearchResult;
      try {
        if (job.kind === 'corpus' && job.entity) {
          const check = await (options.check ?? checkPrimaryMaterial)(job.entity, {
            signal: options.signal,
          });
          state[key].primaryCheck = {
            checkedAt: check.checkedAt,
            status: check.status,
            reason: check.reason,
          };
          await atomicJson(statePath, state);
          if (['unchanged', 'failed', 'identity-changed'].includes(check.status)) {
            state[key].status = check.status === 'unchanged' ? 'completed' : 'failed';
            state[key].reason = check.reason;
            await atomicJson(statePath, state);
            jobs.push({ key, ...state[key] });
            options.progress?.(
              `Refresh ${job.identity}: ${check.status}; no inference, retained observations preserved.`,
            );
            continue;
          }
          options.progress?.(
            `Refresh ${job.identity}: ${check.status}; native interpretation required.`,
          );
        }
        const needDigest = digest(JSON.stringify({ request: job.request, researchConfig }));
        const reused = job.kind === 'query' ? exactRequests.get(needDigest) : undefined;
        result = reused
          ? structuredClone(reused.result)
          : await (options.search ?? signalSearch)(job.request, {
              root,
              runner: codexRunner(settings.model || undefined, settings.effort || undefined, {
                root,
                acquisition: await loadAcquisitionConfig(root),
                extractionModel: settings.extractionModel || undefined,
                extractionEffort: settings.extractionEffort || undefined,
              }),
              signal: options.signal,
              progress: options.progress,
            });
        if (job.kind === 'query' && !reused) exactRequests.set(needDigest, { result, key });
        if (reused) state[key].reusedFromKey = reused.key;
        await retainRun(result, root);
        state[key].runId = result.runId;
        options.signal?.throwIfAborted();
        if (
          result.status === 'failed' ||
          result.status === 'not_configured' ||
          result.status === 'cancelled'
        )
          throw new Error(result.gaps.join('; ') || result.status);
        const targets =
          job.kind === 'corpus'
            ? result.items.filter((item) => item.entity.id === job.identity)
            : result.items;
        if (job.kind === 'corpus' && !targets.length) throw new Error('refresh_target_missing');
        const saved = await saveEntities(
          targets,
          job.kind === 'corpus' ? 'refresh' : 'eligible',
          root,
          settings.destination,
          settings.threshold,
          false,
          {
            runId: result.runId,
            query: result.query,
            kind: job.kind === 'query' ? 'query-discovery' : 'corpus-refresh',
            ...(job.kind === 'query'
              ? {
                  queryId: job.identity,
                  concepts:
                    settings.queries.find((query) => query.id === job.identity)?.concepts ?? [],
                }
              : {}),
          },
        );
        if (job.kind === 'corpus' && saved.skipped.length)
          throw new Error('refresh_target_not_updated');
        state[key] = {
          ...state[key],
          slot: job.slot,
          status: 'completed',
          started: new Date(now).toISOString(),
          runId: result.runId,
        };
      } catch (failure) {
        state[key] = {
          ...state[key],
          slot: job.slot,
          status: options.signal?.aborted ? 'cancelled' : 'failed',
          started: new Date(now).toISOString(),
          reason: failure instanceof Error ? failure.message : 'job_failed',
        };
      }
      await atomicJson(statePath, state);
      jobs.push({ key, ...state[key] });
    }
    await cleanRuns(root, settings.retentionDays);
    const publication =
      settings.publication === 'unattended'
        ? await publishCorpus(root)
        : { published: false, reason: settings.publication };
    return { enabled: true, jobs, publication };
  } finally {
    await release();
  }
}
