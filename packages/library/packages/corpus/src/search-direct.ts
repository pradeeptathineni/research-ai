import { fetchEvidence, normalizeText } from './search-fetch.js';
import { normalizeConsiderUrl } from '../../domain/src/url.js';
import { parseRequest, type SearchRequest } from '../../domain/src/search-contract.js';
import { githubSearch, type GitHubPlan, type GitHubCache } from './search-github.js';

interface DirectHit {
  provider: 'github' | 'hacker-news' | 'wikipedia';
  rank: number;
  uri: string;
  title: string;
  summary: string;
  evidenceUri: string;
  popularity: { stars?: number; points?: number; comments?: number };
}
export interface DirectSearchResult {
  schemaVersion: number;
  query: string;
  kind: string;
  hits: DirectHit[];
  gaps: string[];
  searches: number;
  modelCalls: number;
  pages?: Awaited<ReturnType<typeof githubSearch>>['pages'];
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === 'string' ? value.slice(0, 800) : '');
const count = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Ranked locators, never assessed entities. Explicit GitHub plans add bounded recipe pages. */
export async function directSearch(
  input: SearchRequest,
  signal?: AbortSignal,
  fetch = fetchEvidence,
  github?: { plans: GitHubPlan[]; cache?: GitHubCache },
): Promise<DirectSearchResult> {
  const request = parseRequest(input);
  const choices = request.supplementalSites ?? [
    'https://github.com',
    'https://news.ycombinator.com',
  ];
  const hits: DirectHit[] = [],
    gaps: string[] = [];
  let searches = 0;
  const scopes = choices.filter((uri) => new URL(uri).hostname === 'github.com');
  const pathScopes = scopes.filter((uri) => new URL(uri).pathname !== '/');
  let selectedGithub: Awaited<ReturnType<typeof githubSearch>> | null = null;
  if ((!request.sources || request.sources.includes('github')) && !signal?.aborted) {
    if (pathScopes.length > 1 && pathScopes.length === scopes.length)
      gaps.push('github: multiple path scopes require scoped broad search');
    else if (
      !github &&
      (request.query.length > 120 ||
        request.query.split(/\s+/).length > 8 ||
        /[?\r\n]/.test(request.query))
    )
      gaps.push(
        'github: supply a short capability query or native-selected topic plan; whole questions are not sent to repository search',
      );
    else {
      const scope = pathScopes.length === scopes.length ? pathScopes[0] : undefined;
      const plans: GitHubPlan[] = github?.plans ?? [
        { lane: 'capability-established', terms: request.query, perPage: 20, maxPages: 2 },
        {
          lane: 'emerging',
          terms: request.query,
          windowStart: new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10),
          perPage: 10,
          maxPages: 1,
        },
      ];
      try {
        selectedGithub = await githubSearch(
          plans.map((plan) => ({ ...plan, ...(scope ? { scope } : {}) })),
          { signal, fetch, cache: github?.cache },
        );
      } catch (failure) {
        gaps.push(`github: ${failure instanceof Error ? failure.message : 'direct_search_failed'}`);
      }
    }
  }
  if (selectedGithub) {
    hits.push(...selectedGithub.hits.map((hit, index) => ({ ...hit, rank: index + 1 })));
    gaps.push(...selectedGithub.gaps);
    searches += selectedGithub.searches;
  }
  for (const provider of ['hacker-news'] as const) {
    if (request.sources && !request.sources.includes(provider)) continue;
    const scopes = choices.filter((uri) => new URL(uri).hostname === 'news.ycombinator.com');
    if (provider === 'hacker-news' && scopes.some((uri) => new URL(uri).pathname !== '/')) {
      gaps.push('hacker-news: path-scoped direct search unavailable; use scoped broad search');
      continue;
    }
    if (signal?.aborted) {
      gaps.push('cancelled');
      break;
    }
    if (request.query.length > 256) {
      gaps.push(`${provider}: query exceeds direct endpoint limit; broad search remains available`);
      continue;
    }
    const endpoint = new URL('https://hn.algolia.com/api/v1/search');
    endpoint.searchParams.set('query', request.query);
    endpoint.searchParams.set('hitsPerPage', '5');
    endpoint.searchParams.set('tags', 'story');
    try {
      searches++;
      const response = object((await fetch(endpoint.toString(), signal)).json);
      const rows = response.hits;
      if (!Array.isArray(rows)) throw new Error('invalid_direct_response');
      for (const [index, raw] of rows.slice(0, 5).entries()) {
        const row = object(raw);
        try {
          const uri = normalizeConsiderUrl(
            text(row.url) ||
              `https://news.ycombinator.com/item?id=${encodeURIComponent(text(row.objectID))}`,
          ).normalizedUrl;
          const evidenceUri = normalizeConsiderUrl(
            `https://hn.algolia.com/api/v1/items/${encodeURIComponent(text(row.objectID))}`,
          ).normalizedUrl;
          hits.push({
            provider,
            rank: index + 1,
            uri,
            evidenceUri,
            title: text(row.title),
            summary: text(row.description),
            popularity: { points: count(row.points), comments: count(row.num_comments) },
          });
        } catch {
          gaps.push(`${provider}: unsafe or malformed result omitted`);
        }
      }
    } catch (failure) {
      gaps.push(
        `${provider}: ${failure instanceof Error ? failure.message : 'direct_search_failed'}`,
      );
    }
  }
  if ((!request.sources || request.sources.includes('open-web')) && !signal?.aborted) {
    const scopes = choices.filter((uri) => new URL(uri).hostname === 'en.wikipedia.org');
    if (scopes.some((uri) => new URL(uri).pathname !== '/'))
      gaps.push('wikipedia: path-scoped direct search unavailable; use scoped broad search');
    else if (request.query.length > 256)
      gaps.push('wikipedia: query exceeds direct endpoint limit; broad search remains available');
    else {
      const endpoint = new URL('https://en.wikipedia.org/w/api.php');
      for (const [key, value] of Object.entries({
        action: 'query',
        list: 'search',
        srsearch: request.query,
        srlimit: '5',
        format: 'json',
        formatversion: '2',
        srprop: 'snippet',
      }))
        endpoint.searchParams.set(key, value);
      try {
        searches++;
        const response = object((await fetch(endpoint.toString(), signal)).json);
        const rows = object(response.query).search;
        if (!Array.isArray(rows)) throw new Error('invalid_direct_response');
        for (const [index, raw] of rows.slice(0, 5).entries()) {
          const row = object(raw);
          if (!text(row.title) || count(row.pageid) === undefined) {
            gaps.push('wikipedia: malformed result omitted');
            continue;
          }
          const uri = normalizeConsiderUrl(
            `https://en.wikipedia.org/wiki/${encodeURIComponent(text(row.title).replace(/ /g, '_'))}`,
          ).normalizedUrl;
          hits.push({
            provider: 'wikipedia',
            rank: index + 1,
            uri,
            evidenceUri: uri,
            title: text(row.title),
            summary: normalizeText(text(row.snippet)),
            popularity: {},
          });
        }
      } catch (failure) {
        gaps.push(
          `wikipedia: ${failure instanceof Error ? failure.message : 'direct_search_failed'}`,
        );
      }
    }
  }
  return {
    schemaVersion: 1,
    query: request.query,
    kind: 'unassessed-source-hits',
    hits,
    gaps,
    searches,
    pages: selectedGithub?.pages ?? [],
    modelCalls: 0,
  };
}
