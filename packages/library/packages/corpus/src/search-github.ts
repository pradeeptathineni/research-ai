import { resolve } from 'node:path';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { normalizeConsiderUrl } from '../../domain/src/url.js';
import { fetchEvidence, FetchHttpError, type FetchMetadata } from './search-fetch.js';
import { atomicJson, readPrivateJson, withWriter } from './search-store.js';

const lanes = [
  'global-established-orientation',
  'topic-established',
  'capability-established',
  'emerging',
  'low-attention-neighbors',
] as const;
const closed = { additionalProperties: false };
const planSchema = Type.Object(
  {
    lane: Type.Enum(lanes),
    topic: Type.Optional(Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,49}$' })),
    terms: Type.Optional(Type.String({ minLength: 1, maxLength: 120, pattern: '^[^\r\n]+$' })),
    scope: Type.Optional(Type.String({ maxLength: 2048 })),
    windowStart: Type.Optional(Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' })),
    starBand: Type.Optional(
      Type.Tuple([
        Type.Integer({ minimum: 0, maximum: 1000000000 }),
        Type.Integer({ minimum: 0, maximum: 1000000000 }),
      ]),
    ),
    perPage: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    maxPages: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
  },
  closed,
);
export type GitHubPlan = Static<typeof planSchema>;
const hitSchema = Type.Object(
  {
    provider: Type.Literal('github'),
    repositoryId: Type.Integer({ minimum: 1 }),
    uri: Type.String({ maxLength: 2048 }),
    evidenceUri: Type.String({ maxLength: 2048 }),
    title: Type.String({ maxLength: 200 }),
    summary: Type.String({ maxLength: 1600 }),
    topics: Type.Array(Type.String({ maxLength: 100 }), { maxItems: 40 }),
    popularity: Type.Object({ stars: Type.Integer({ minimum: 0 }) }, closed),
    archived: Type.Boolean(),
    disabled: Type.Boolean(),
    createdAt: Type.Union([Type.String(), Type.Null()]),
    pushedAt: Type.Union([Type.String(), Type.Null()]),
    licenseHint: Type.Union([Type.String({ maxLength: 100 }), Type.Null()]),
  },
  closed,
);
type GitHubHit = Static<typeof hitSchema>;
const cachedSchema = Type.Object(
  {
    version: Type.Literal(1),
    hits: Type.Array(hitSchema, { maxItems: 100 }),
    returned: Type.Integer({ minimum: 0, maximum: 100 }),
    excluded: Type.Integer({ minimum: 0, maximum: 100 }),
    total: Type.Integer({ minimum: 0 }),
    incomplete: Type.Boolean(),
    next: Type.Union([Type.String({ maxLength: 4096 }), Type.Null()]),
    retrievedAt: Type.String(),
    checkedAt: Type.String(),
    etag: Type.Optional(Type.String({ maxLength: 4096, pattern: '^[^\r\n]*$' })),
    lastModified: Type.Optional(Type.String({ maxLength: 4096, pattern: '^[^\r\n]*$' })),
  },
  closed,
);
type CachedGitHubPage = Static<typeof cachedSchema>;
export interface GitHubCache {
  get(key: string): Promise<unknown>;
  set(key: string, value: CachedGitHubPage): Promise<void>;
}
export function memoryGitHubCache(): GitHubCache {
  const pages = new Map<string, CachedGitHubPage>();
  return {
    get(key) {
      return Promise.resolve(pages.get(key));
    },
    set(key, value) {
      pages.delete(key);
      pages.set(key, structuredClone(value));
      if (pages.size > 32) pages.delete(pages.keys().next().value!);
      return Promise.resolve();
    },
  };
}

/** Explicit private adapter; ordinary memory acquisition never touches the filesystem. */
export function privateGitHubCache(root: string): GitHubCache {
  const schema = Type.Record(Type.String({ maxLength: 4096 }), cachedSchema);
  const read = async () => {
    const input = await readPrivateJson(root, 'github-acquisition.json', {}, 2000000);
    if (!Value.Check(schema, input)) throw new Error('invalid_github_cache');
    return input;
  };
  return {
    async get(key) {
      return (await read())[key];
    },
    async set(key, value) {
      await withWriter(root, async () => {
        const pages = { ...(await read()), [key]: value };
        const recent = Object.entries(pages)
          .sort((a, b) => b[1].checkedAt.localeCompare(a[1].checkedAt))
          .slice(0, 32);
        const retained: Record<string, CachedGitHubPage> = {};
        let bytes = 2;
        for (const [key, page] of recent) {
          const size = Buffer.byteLength(JSON.stringify({ [key]: page }));
          if (bytes + size > 1800000) continue;
          retained[key] = page;
          bytes += size;
        }
        await atomicJson(resolve(root, '.signals/github-acquisition.json'), retained);
      });
    },
  };
}

const object = (input: unknown): Record<string, unknown> =>
  input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
const text = (input: unknown, maximum = 1600) =>
  typeof input === 'string' ? input.slice(0, maximum) : '';
const count = (input: unknown) =>
  typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 ? input : null;
const date = (input: unknown) =>
  typeof input === 'string' && Number.isFinite(Date.parse(input))
    ? new Date(input).toISOString()
    : null;

function endpoint(plan: GitHubPlan) {
  if (!Value.Check(planSchema, plan)) throw new Error('invalid_github_plan');
  if (plan.starBand && plan.starBand[0] > plan.starBand[1])
    throw new Error('invalid_github_star_band');
  const requiresTopic = ['topic-established', 'low-attention-neighbors'].includes(plan.lane);
  const requiresTerms = ['capability-established', 'emerging'].includes(plan.lane);
  if ((requiresTopic && !plan.topic) || (requiresTerms && !plan.terms?.trim()))
    throw new Error('missing_github_lane_input');
  if (
    plan.lane === 'emerging' &&
    (!plan.windowStart || date(plan.windowStart)?.slice(0, 10) !== plan.windowStart)
  )
    throw new Error('invalid_github_window');
  let scope = '';
  if (plan.scope) {
    const url = new URL(normalizeConsiderUrl(plan.scope).normalizedUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.origin !== 'https://github.com' || url.search || url.hash || parts.length > 2)
      throw new Error('unsupported_github_scope');
    scope =
      parts.length === 1 ? `user:${parts[0]}` : parts.length === 2 ? `repo:${parts.join('/')}` : '';
  }
  const query = [
    requiresTopic ? `topic:${plan.topic}` : requiresTerms ? plan.terms : '',
    plan.lane === 'capability-established' ? 'in:name,description,readme' : '',
    plan.lane === 'emerging' ? `created:>=${plan.windowStart}` : '',
    plan.starBand
      ? `stars:${plan.starBand[0]}..${plan.starBand[1]}`
      : plan.lane === 'global-established-orientation'
        ? 'stars:>100000'
        : plan.lane === 'low-attention-neighbors'
          ? 'stars:0..999'
          : '',
    'archived:false',
    scope,
  ]
    .filter(Boolean)
    .join(' ');
  const url = new URL('https://api.github.com/search/repositories');
  for (const [key, value] of Object.entries({
    q: query,
    sort: plan.lane === 'low-attention-neighbors' ? 'updated' : 'stars',
    order: 'desc',
    per_page: String(plan.perPage ?? 30),
    page: '1',
  }))
    url.searchParams.set(key, value);
  return url;
}

/** Validates explicit caller-selected lanes; it never derives routes from the question. */
export function parseGitHubPlans(input: unknown): GitHubPlan[] {
  if (!Value.Check(Type.Array(planSchema, { minItems: 1, maxItems: 3 }), input))
    throw new Error('invalid_github_plans');
  input.map(endpoint);
  if (input.reduce((sum, plan) => sum + (plan.maxPages ?? 2), 0) > 6)
    throw new Error('github_page_budget_exceeded');
  return structuredClone(input);
}

function validatedPage(input: string, current: URL, advancing: boolean) {
  const url = new URL(input);
  if (
    url.origin !== 'https://api.github.com' ||
    url.pathname !== '/search/repositories' ||
    url.username ||
    url.password ||
    url.hash ||
    [...url.searchParams.keys()].some(
      (key) => !['q', 'sort', 'order', 'per_page', 'page'].includes(key),
    )
  )
    throw new Error('unsafe_github_page');
  for (const key of ['q', 'sort', 'order', 'per_page'])
    if (
      url.searchParams.getAll(key).length !== 1 ||
      url.searchParams.get(key) !== current.searchParams.get(key)
    )
      throw new Error('changed_github_page_query');
  const page = Number(url.searchParams.get('page'));
  if (
    url.searchParams.getAll('page').length !== 1 ||
    !Number.isInteger(page) ||
    page < 1 ||
    page * Number(url.searchParams.get('per_page')) > 1000 ||
    (advancing
      ? page !== Number(current.searchParams.get('page')) + 1
      : page !== Number(current.searchParams.get('page')))
  )
    throw new Error('invalid_github_page_number');
  return url;
}

function nextLink(header: string | undefined, current: URL) {
  if (!header) return null;
  const next = [...header.matchAll(/<([^>]+)>\s*;\s*rel="([^"]+)"/g)].filter((match) =>
    match[2]!.split(/\s+/).includes('next'),
  );
  if (next.length > 1) throw new Error('ambiguous_github_next_page');
  return next.length ? validatedPage(next[0]![1]!, current, true).toString() : null;
}

function normalizePage(
  input: unknown,
  response: FetchMetadata | undefined,
  current: URL,
  now: string,
): CachedGitHubPage {
  const body = object(input);
  if (
    !Array.isArray(body.items) ||
    count(body.total_count) === null ||
    typeof body.incomplete_results !== 'boolean' ||
    body.items.length > Number(current.searchParams.get('per_page'))
  )
    throw new Error('invalid_github_search_response');
  const hits: GitHubHit[] = [];
  let excluded = 0;
  for (const raw of body.items) {
    try {
      const row = object(raw);
      const repositoryId = count(row.id),
        stars = count(row.stargazers_count);
      const uri = normalizeConsiderUrl(text(row.html_url, 2048)).normalizedUrl;
      const name = text(row.full_name, 200);
      const canonical = new URL(uri);
      if (
        !repositoryId ||
        stars === null ||
        canonical.hostname !== 'github.com' ||
        canonical.pathname !== `/${name}` ||
        !/^[^/]+\/[^/]+$/.test(name) ||
        typeof row.archived !== 'boolean' ||
        typeof row.disabled !== 'boolean'
      )
        throw new Error('invalid_github_repository');
      hits.push({
        provider: 'github',
        repositoryId,
        uri,
        evidenceUri: `https://api.github.com/repos/${name}`,
        title: name,
        summary: text(row.description),
        topics: Array.isArray(row.topics)
          ? row.topics
              .filter((x): x is string => typeof x === 'string')
              .slice(0, 40)
              .map((x) => x.slice(0, 100))
          : [],
        popularity: { stars },
        archived: row.archived,
        disabled: row.disabled,
        createdAt: date(row.created_at),
        pushedAt: date(row.pushed_at),
        licenseHint: text(object(row.license).spdx_id, 100) || null,
      });
    } catch {
      excluded++;
    }
  }
  return {
    version: 1,
    hits,
    returned: body.items.length,
    excluded,
    total: body.total_count as number,
    incomplete: body.incomplete_results,
    next: null,
    retrievedAt: now,
    checkedAt: now,
    ...(response?.etag ? { etag: response.etag } : {}),
    ...(response?.lastModified ? { lastModified: response.lastModified } : {}),
  };
}

interface PageReceipt {
  lane: GitHubPlan['lane'];
  query: string;
  sort: string;
  order: string;
  page: number;
  returned: number;
  total: number | null;
  incomplete: boolean | null;
  excluded: number;
  repositoryIds: number[];
  nextPage: string | null;
  retrievedAt: string;
  checkedAt: string;
  sourceStatus: 'fetched' | 'cached' | 'not-modified' | 'rate-limited' | 'failed';
  coverageBoundary: string;
  response?: FetchMetadata;
}

/** Native-selected acquisition recipes. Popularity and license hints never become evidence. */
export async function githubSearch(
  plans: GitHubPlan[],
  options: {
    signal?: AbortSignal;
    fetch?: typeof fetchEvidence;
    cache?: GitHubCache;
    now?: () => number;
  } = {},
) {
  plans = parseGitHubPlans(plans);
  const initial = plans.map(endpoint);
  const hits: (GitHubHit & {
      discovery: { lane: GitHubPlan['lane']; query: string; page: number }[];
    })[] = [],
    pages: PageReceipt[] = [],
    gaps: string[] = [];
  const seen = new Map<number, (typeof hits)[number]>();
  let searches = 0,
    stopped = false;
  for (const [index, plan] of plans.entries()) {
    let current: URL | null = initial[index]!;
    for (let step = 0; current && step < (plan.maxPages ?? 2); step++) {
      options.signal?.throwIfAborted();
      const now = (options.now ?? Date.now)();
      const at = new Date(now).toISOString();
      const receipt: PageReceipt = {
        lane: plan.lane,
        query: current.searchParams.get('q')!,
        sort: current.searchParams.get('sort')!,
        order: 'desc',
        page: Number(current.searchParams.get('page')),
        returned: 0,
        total: null,
        incomplete: null,
        excluded: 0,
        repositoryIds: [],
        nextPage: null,
        retrievedAt: at,
        checkedAt: at,
        sourceStatus: 'failed',
        coverageBoundary: 'request failed; collection unsearched',
      };
      try {
        let cached: CachedGitHubPage | undefined;
        try {
          const input = await options.cache?.get(current.toString());
          if (input !== undefined && !Value.Check(cachedSchema, input))
            throw new Error('invalid_github_cache_page');
          const candidate = input;
          if (candidate?.next) validatedPage(candidate.next, current, true);
          for (const hit of candidate?.hits ?? [])
            if (
              normalizeConsiderUrl(hit.uri).normalizedUrl !== hit.uri ||
              new URL(hit.uri).origin !== 'https://github.com' ||
              new URL(hit.uri).pathname !== `/${hit.title}` ||
              hit.evidenceUri !== `https://api.github.com/repos/${hit.title}`
            )
              throw new Error('invalid_github_cache_identity');
          cached = candidate;
        } catch (error) {
          gaps.push(`github/cache: ${error instanceof Error ? error.message : 'read_failed'}`);
        }
        const ttl = plan.lane === 'global-established-orientation' ? 86400000 : 900000;
        let page: CachedGitHubPage;
        if (
          cached &&
          now >= Date.parse(cached.checkedAt) &&
          now - Date.parse(cached.checkedAt) < ttl
        ) {
          page = cached;
          receipt.sourceStatus = 'cached';
        } else {
          searches++;
          const response = await (options.fetch ?? fetchEvidence)(
            current.toString(),
            options.signal,
            0,
            false,
            cached
              ? {
                  allowNotModified: true,
                  conditional: { etag: cached.etag, lastModified: cached.lastModified },
                }
              : {},
          );
          validatedPage(response.uri, current, false);
          receipt.response = response.response;
          if (response.response?.status === 304) {
            if (!cached) throw new Error('github_not_modified_without_cache');
            page = { ...cached, checkedAt: at };
            receipt.sourceStatus = 'not-modified';
          } else {
            page = normalizePage(response.json, response.response, current, at);
            try {
              page.next = nextLink(response.response?.link, current);
            } catch (error) {
              gaps.push(
                `github/pagination: ${error instanceof Error ? error.message : 'invalid_link'}`,
              );
            }
            receipt.sourceStatus = 'fetched';
          }
          try {
            await options.cache?.set(current.toString(), page);
          } catch (error) {
            gaps.push(`github/cache: ${error instanceof Error ? error.message : 'write_failed'}`);
          }
        }
        Object.assign(receipt, {
          returned: page.returned,
          total: page.total,
          incomplete: page.incomplete,
          excluded: page.excluded,
          repositoryIds: page.hits.map((hit) => hit.repositoryId),
          nextPage: page.next,
          retrievedAt: page.retrievedAt,
          checkedAt: page.checkedAt,
        });
        for (const hit of page.hits) {
          if (plan.scope) {
            const scope = new URL(plan.scope).pathname.replace(/\/$/, '');
            const path = new URL(hit.uri).pathname;
            if (scope && path !== scope && !path.startsWith(`${scope}/`)) {
              gaps.push(`github/${plan.lane}: out-of-scope repository omitted`);
              continue;
            }
          }
          const trail = { lane: plan.lane, query: receipt.query, page: receipt.page };
          const prior = seen.get(hit.repositoryId);
          if (prior) prior.discovery.push(trail);
          else {
            const acquired = { ...hit, discovery: [trail] };
            seen.set(hit.repositoryId, acquired);
            hits.push(acquired);
          }
        }
        receipt.coverageBoundary = page.incomplete
          ? 'service reports incomplete results'
          : page.next && step + 1 >= (plan.maxPages ?? 2)
            ? 'bounded pages reached; next page unsearched'
            : !page.next && page.total > 1000
              ? 'service search ceiling; partitions required for broader coverage'
              : !page.next &&
                  receipt.page * Number(current.searchParams.get('per_page')) >= page.total
                ? 'returned result set exhausted; GitHub as a whole not examined'
                : !page.next
                  ? 'no next-page link; reported total not covered'
                  : 'next page available';
        if (page.total > 1000 && page.next)
          receipt.coverageBoundary += '; service search ceiling is 1,000 results';
        if (!page.next && receipt.coverageBoundary.includes('not covered'))
          gaps.push(`github/${plan.lane}: reported total not covered; no safe next-page link`);
        if (page.incomplete) gaps.push(`github/${plan.lane}: incomplete results`);
        if (page.excluded)
          gaps.push(
            `github/${plan.lane}: ${page.excluded} malformed or unsafe metadata rows omitted`,
          );
        current = page.next ? new URL(page.next) : null;
        if (receipt.response?.rateRemaining === '0' && (current || index + 1 < plans.length)) {
          receipt.coverageBoundary += '; rate quota exhausted; next page unsearched';
          gaps.push('github: rate quota exhausted; no automatic retry');
          stopped = true;
        }
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (error instanceof FetchHttpError) {
          receipt.response = error.response;
          if (
            error.response.status === 429 ||
            (error.response.status === 403 &&
              (error.response.rateRemaining === '0' || error.response.retryAfter))
          ) {
            receipt.sourceStatus = 'rate-limited';
            receipt.coverageBoundary =
              'rate limit; remaining pages and lanes unsearched; no automatic retry';
            stopped = true;
          }
        }
        gaps.push(
          `github/${plan.lane}: ${error instanceof Error ? error.message : 'acquisition_failed'}`,
        );
        current = null;
      }
      pages.push(receipt);
      if (stopped) break;
    }
    if (stopped) {
      gaps.push(`github: acquisition stopped; ${plans.length - index - 1} later lanes unsearched`);
      break;
    }
  }
  return {
    kind: 'unassessed-source-hits' as const,
    hits,
    pages,
    gaps,
    searches,
    modelCalls: 0 as const,
    metadataWarning:
      'Stars, topics, dates and license hints nominate leads; they do not establish fit, inspected licenses, current claims or independent adoption.',
  };
}
