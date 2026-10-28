import { randomUUID } from 'node:crypto';
import { readFile, unlink, readdir, lstat, realpath } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { loadSettings, type SearchSettings } from './search-settings.js';
import { atomicJson, retainRun, saveEntities, withWriter } from './search-store.js';
import { signalSearch } from './signal-search.js';
import { codexRunner } from './search-runner.js';
import { loadAcquisitionConfig } from './search-acquisition.js';
import { parseRequest, budgets } from '../../domain/src/search-contract.js';
import { digest } from './search-fetch.js';
import { directSearch } from './search-direct.js';
import { acquireResearchLease } from './search-scheduler.js';

const acquisitionPlanSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-z0-9-]{1,80}$' }),
    members: Type.Array(Type.String(), { minItems: 2, maxItems: 30, uniqueItems: true }),
    query: Type.String({ minLength: 1, maxLength: 120 }),
    reason: Type.String({ minLength: 1, maxLength: 1000 }),
    proposedBy: Type.Literal('native'),
    scopeDigest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  },
  { additionalProperties: false },
);

const batchSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-f0-9-]{36}$' }),
    createdAt: Type.String(),
    acquisitionPlan: Type.Optional(Type.Array(acquisitionPlanSchema, { maxItems: 32 })),
    jobs: Type.Array(
      Type.Object(
        {
          id: Type.String(),
          query: Type.String(),
          context: Type.Optional(Type.String()),
          concepts: Type.Array(Type.String()),
          supplementalSites: Type.Array(Type.String()),
          status: Type.Enum([
            'pending',
            'running',
            'completed',
            'partial',
            'failed',
            'cancelled',
            'uncertain',
          ]),
          runId: Type.Optional(Type.String()),
          reusedFromJobId: Type.Optional(Type.String()),
          saved: Type.Array(Type.String()),
          gaps: Type.Array(Type.String()),
        },
        { additionalProperties: false },
      ),
      { maxItems: 512 },
    ),
  },
  { additionalProperties: false },
);
export type QueryBatch = Static<typeof batchSchema>;
/** Validate a model-authored acquisition proposal without interpreting or merging interests. */
export function planQueryAcquisition(settings: SearchSettings, ids?: string[]) {
  const chosen = settings.queries.filter((query) => (ids ? ids.includes(query.id) : query.enabled));
  const groups: NonNullable<QueryBatch['acquisitionPlan']> = [];
  const seen = new Set<string>();
  for (const group of settings.acquisitionGroups ?? []) {
    const members = chosen.filter(
      (query) => group.members.includes(query.id) && query.shareAcquisition !== false,
    );
    if (members.length < 2) continue;
    const scopes = members.map((query) =>
      JSON.stringify(
        [
          ...(parseRequest({
            query: query.query,
            supplementalSites: [
              ...new Set([
                ...(settings.supplementalSites ?? []),
                ...(query.supplementalSites ?? []),
              ]),
            ],
          }).supplementalSites ?? []),
        ].sort(),
      ),
    );
    if (new Set(scopes).size > 1) throw new Error('incompatible_acquisition_scopes');
    for (const member of members) {
      if (seen.has(member.id)) throw new Error('overlapping_acquisition_groups');
      seen.add(member.id);
    }
    groups.push({
      ...group,
      members: members.map((query) => query.id),
      scopeDigest: digest(
        JSON.stringify({
          sources: settings.sources,
          sites: scopes[0],
          destination: settings.destination,
        }),
      ),
    });
  }
  return {
    groups,
    optedOut: chosen.filter((query) => query.shareAcquisition === false).map((query) => query.id),
    explanation:
      'Native-suggested groups share only unassessed acquisition. Original constraints, reasoning, delivery and run status remain separate. Exact-request deduplication is a different mechanism.',
  };
}
export async function loadQueryBatch(id: string, root = process.cwd()) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('invalid_batch_id');
  const path = resolve(root, '.signals/query-batches', `${id}.json`);
  const stat = await lstat(path);
  if (
    stat.isSymbolicLink() ||
    stat.size > 8000000 ||
    !relative(await realpath(root), await realpath(path)).startsWith('.signals/query-batches/')
  )
    throw new Error('unsafe_query_batch');
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (
    !Value.Check(batchSchema, raw) ||
    raw.id !== id ||
    new Set(raw.jobs.map((job) => job.id)).size !== raw.jobs.length
  )
    throw new Error('invalid_query_batch');
  raw.jobs.forEach((job) =>
    parseRequest({
      query: job.query,
      context: job.context,
      supplementalSites: job.supplementalSites,
    }),
  );
  for (const job of raw.jobs) {
    if (job.reusedFromJobId) {
      const owner = raw.jobs.find((item) => item.id === job.reusedFromJobId);
      if (!owner || owner.id === job.id || owner.reusedFromJobId)
        throw new Error('invalid_query_batch_reuse');
    }
  }
  const grouped = new Set<string>();
  for (const group of raw.acquisitionPlan ?? []) {
    parseRequest({ query: group.query });
    const scopes: string[] = [];
    for (const id of group.members) {
      if (!raw.jobs.some((job) => job.id === id) || grouped.has(id))
        throw new Error('invalid_batch_acquisition_plan');
      grouped.add(id);
      scopes.push(
        JSON.stringify([...raw.jobs.find((job) => job.id === id)!.supplementalSites].sort()),
      );
    }
    if (new Set(scopes).size !== 1) throw new Error('incompatible_acquisition_scopes');
  }
  return raw;
}
export async function queryBatchHistory(root = process.cwd()) {
  const directory = resolve(root, '.signals/query-batches');
  const files = await readdir(directory).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return [] as string[];
  });
  const candidates = await Promise.all(
    files
      .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
      .map(async (name) => ({ name, stat: await lstat(resolve(directory, name)) })),
  );
  const batches = await Promise.all(
    candidates
      .filter((item) => !item.stat.isSymbolicLink())
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .slice(0, 30)
      .map((item) => loadQueryBatch(item.name.slice(0, -5), root)),
  );
  return batches.map((batch) => ({
    id: batch.id,
    createdAt: batch.createdAt,
    total: batch.jobs.length,
    pending: batch.jobs.filter((job) => job.status === 'pending').length,
    uncertain: batch.jobs.filter((job) => job.status === 'running' || job.status === 'uncertain')
      .length,
  }));
}

/** Explicit one-shot activation snapshots the selected interests; it never enables recurrence. */
type BatchOptions = {
  root?: string;
  settings?: SearchSettings;
  ids?: string[];
  resume?: string;
  limit?: number;
  signal?: AbortSignal;
  progress?: (event: string) => void;
  search?: typeof signalSearch;
  acquire?: typeof directSearch;
};
export async function runQueryListOnce(options: BatchOptions = {}) {
  const root = options.root ?? process.cwd();
  const id = options.resume ?? randomUUID();
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('invalid_batch_id');
  const lease = resolve(root, '.signals/query-batches', `${id}.lease.json`);
  const release = await acquireResearchLease(root);
  if (!release) throw new Error('research_busy');
  try {
    await withWriter(root, async () => {
      const stat = await lstat(lease).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return null;
      });
      if (
        stat &&
        (!stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.size > 10000 ||
          (await realpath(lease)) !== lease)
      )
        throw new Error('unsafe_batch_lease');
      const owner = stat ? (JSON.parse(await readFile(lease, 'utf8')) as { pid: number }) : null;
      if (owner) {
        if (!Number.isInteger(owner.pid) || owner.pid < 1) throw new Error('invalid_batch_lease');
        let alive = true;
        try {
          process.kill(owner.pid, 0);
        } catch (error) {
          alive = (error as NodeJS.ErrnoException).code !== 'ESRCH';
        }
        if (alive) throw new Error('query_batch_busy');
      }
      await atomicJson(lease, { pid: process.pid });
    });
    try {
      return await executeBatch(options, id);
    } finally {
      await unlink(lease);
    }
  } finally {
    await release();
  }
}
async function executeBatch(options: BatchOptions, batchId: string) {
  const root = options.root ?? process.cwd();
  const settings = structuredClone(options.settings ?? (await loadSettings(root)));
  const limit = options.limit ?? settings.batchSize;
  if (!Number.isInteger(limit) || limit < 1 || limit > 512)
    throw new Error('invalid_query_batch_limit');
  if (!/^[a-f0-9-]{36}$/.test(batchId)) throw new Error('invalid_batch_id');
  const path = resolve(root, '.signals/query-batches', `${batchId}.json`);
  let batch: QueryBatch;
  if (options.resume) {
    batch = await loadQueryBatch(batchId, root);
    // A previous process may have performed paid inference. Never repeat it implicitly.
    batch.jobs.forEach((job) => {
      if (job.status === 'running') job.status = 'uncertain';
    });
  } else {
    const chosen = settings.queries.filter((query) =>
      options.ids ? options.ids.includes(query.id) : query.enabled,
    );
    if (options.ids?.some((id) => !chosen.some((query) => query.id === id)))
      throw new Error('unknown_query_id');
    batch = {
      id: batchId,
      createdAt: new Date().toISOString(),
      jobs: chosen.map((query) => ({
        id: query.id,
        query: query.query,
        context: query.context,
        concepts: query.concepts,
        supplementalSites: [
          ...new Set([...(settings.supplementalSites ?? []), ...(query.supplementalSites ?? [])]),
        ],
        status: 'pending',
        saved: [],
        gaps: [],
      })),
    };
    // Reject the whole malformed plan before spending inference or writing a receipt.
    batch.jobs.forEach((job) =>
      parseRequest({
        query: job.query,
        context: job.context,
        supplementalSites: job.supplementalSites,
      }),
    );
    batch.acquisitionPlan = planQueryAcquisition(
      settings,
      chosen.map((query) => query.id),
    ).groups;
  }
  await atomicJson(path, batch);
  options.progress?.(
    `Batch ${batchId}: ${batch.jobs.length} interests, sequential ${settings.profile} runs; ${JSON.stringify(budgets[settings.profile])} per distinct exact need, threshold ${settings.threshold}, ${settings.destination}, local saves only.`,
  );
  const acquisition = await loadAcquisitionConfig(root);
  const runner = codexRunner(settings.model || undefined, settings.effort || undefined, {
    root,
    acquisition,
    extractionModel: settings.extractionModel || undefined,
    extractionEffort: settings.extractionEffort || undefined,
  });
  const selected = batch.jobs.filter((job) => job.status === 'pending').slice(0, limit);
  const operationScope = {
    runner: settings.runner,
    model: settings.model,
    effort: settings.effort,
    extractionModel: settings.extractionModel,
    extractionEffort: settings.extractionEffort,
    destination: settings.destination,
    acquisition,
    budget: budgets[settings.profile],
  };
  const groups = new Map<
    string,
    { request: ReturnType<typeof parseRequest>; jobs: QueryBatch['jobs'] }
  >();
  const shared = new Map<string, Awaited<ReturnType<typeof directSearch>>>();
  const acquisitionCounted = new Set<string>();
  for (const job of selected) {
    const request = parseRequest({
      query: job.query,
      context: job.context,
      profile: settings.profile,
      route: settings.route,
      review: settings.groundedReview ?? false,
      threshold: settings.threshold,
      sources: settings.sources,
      supplementalSites: job.supplementalSites,
      save: 'never',
      cache: 'private',
    });
    const key = digest(JSON.stringify({ request, operationScope }));
    const group = groups.get(key);
    if (group) group.jobs.push(job);
    else groups.set(key, { request, jobs: [job] });
  }
  const started = Date.now();
  for (const [needDigest, group] of groups) {
    if (options.signal?.aborted || Date.now() - started >= 1200000) break;
    const owner = group.jobs[0]!;
    // Persist the uncertainty boundary before invoking AI. Do not hold the corpus writer during research.
    await withWriter(root, async () => {
      const current = await loadQueryBatch(batch.id, root);
      const stored = group.jobs.map((job) => current.jobs.find((item) => item.id === job.id)!);
      if (stored.some((job) => job.status !== 'pending'))
        throw new Error('batch_job_already_claimed');
      for (const job of stored) {
        job.status = 'running';
        if (job.id !== owner.id) job.reusedFromJobId = owner.id;
      }
      await atomicJson(path, current);
    });
    for (const job of group.jobs) {
      job.status = 'running';
      if (job.id !== owner.id) job.reusedFromJobId = owner.id;
    }
    options.progress?.(
      `Research ${owner.id}: ${owner.query}; ${group.jobs.length} exact interest(s).`,
    );
    try {
      let acquisitionHints;
      const plan = batch.acquisitionPlan?.find(
        (candidate) =>
          candidate.members.includes(owner.id) &&
          candidate.members.filter((id) => selected.some((job) => job.id === id)).length > 1,
      );
      if (plan) {
        let pool = shared.get(plan.id);
        if (!pool) {
          options.progress?.(
            `Shared acquisition ${plan.id}: ${plan.query}; independent reasoning for each interest.`,
          );
          pool = await (options.acquire ?? directSearch)(
            {
              query: plan.query,
              sources: settings.sources,
              supplementalSites: owner.supplementalSites,
            },
            options.signal,
          );
          shared.set(plan.id, pool);
        }
        acquisitionHints = {
          groupId: plan.id,
          query: plan.query,
          reason: plan.reason,
          hits: pool.hits.map(({ uri, title, summary, evidenceUri }) => ({
            uri,
            title,
            summary,
            evidenceUri,
          })),
          gaps: pool.gaps,
          searches: acquisitionCounted.has(plan.id) ? 0 : pool.searches,
        };
        acquisitionCounted.add(plan.id);
      }
      const result = await (options.search ?? signalSearch)(group.request, {
        root,
        runner,
        signal: options.signal,
        progress: options.progress,
        acquisitionHints,
      });
      await retainRun(result, root);
      for (const job of group.jobs) {
        job.runId = result.runId;
        job.gaps = [...result.gaps];
        job.status = options.signal?.aborted
          ? 'cancelled'
          : result.status === 'not_configured'
            ? 'failed'
            : result.status;
        if (['completed', 'partial'].includes(result.status) && !options.signal?.aborted) {
          try {
            const saved = await saveEntities(
              result.items,
              'eligible',
              root,
              settings.destination,
              settings.threshold,
              false,
              {
                runId: result.runId,
                query: result.query,
                kind: 'query-discovery',
                queryId: job.id,
                concepts: job.concepts,
                needDigest,
              },
            );
            job.saved = saved.changed;
          } catch (failure) {
            job.status = 'failed';
            job.gaps.push(failure instanceof Error ? failure.message : 'query_batch_save_failed');
          }
        }
      }
    } catch (failure) {
      for (const job of group.jobs) {
        job.status = options.signal?.aborted ? 'cancelled' : 'failed';
        job.gaps.push(failure instanceof Error ? failure.message : 'query_batch_failed');
      }
    }
    await atomicJson(path, batch);
    for (const job of group.jobs)
      options.progress?.(`${job.id}: ${job.status}; ${job.saved.length} canonical files changed.`);
  }
  return batch;
}
