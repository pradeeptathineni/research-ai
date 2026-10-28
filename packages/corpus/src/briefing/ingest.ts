import { createHash, randomUUID } from 'node:crypto';
import { fetchEvidence, normalizeText } from '../search-fetch.js';
import { extractHtml, publicLink } from '../search-document.js';
import { scanSources } from '../search-sources.js';
import { loadSettings, updateSettingsForBriefingOpml } from '../search-settings.js';
import type { SearchSettings } from '../search-settings.js';
import type { AllDayEvent, Item, MetricObservation, Source, Story, TimedEvent } from './schema.js';
import {
  beginBriefingRefresh,
  completeBriefingRefresh,
  createBriefingApi,
  githubPublicRepositoryList,
  isHackerNewsIndexUri,
  listSourceTerms,
  mastodonTagTimeline,
  retainBriefingRecords,
  type BriefingRefreshSummary,
} from './store.js';

function id(prefix: string, value: string) {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}
function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

const hackerNewsItemLimit = 20;
const hackerNewsItemUrl = (itemId: number) =>
  `https://hacker-news.firebaseio.com/v0/item/${itemId}.json`;
const hackerNewsDiscussionUrl = (itemId: number) =>
  `https://news.ycombinator.com/item?id=${itemId}`;
const mastodonTimelineLimit = 10;

type MetricSnapshot = Omit<MetricObservation, 'id' | 'itemId'> & { item: Item };

function deterministicUuid(value: string) {
  const bytes = Buffer.from(createHash('sha256').update(value).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function hackerNewsMetrics(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  return (['score', 'descendants'] as const).flatMap((field) => {
    const metric = record[field];
    if (typeof metric !== 'number' || !Number.isSafeInteger(metric) || metric < 0) return [];
    return [{ name: field === 'descendants' ? 'comments' : 'score', value: metric }];
  });
}

function mastodonMetrics(value: Record<string, unknown>) {
  const fields: Array<[string, unknown]> = [
    ['replies', value.replies_count],
    ['boosts', value.reblogs_count],
    ['favourites', value.favourites_count],
  ];
  return fields.flatMap(([name, count]) =>
    typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
      ? [{ name, value: count }]
      : [],
  );
}

function mastodonPlatform(origin: string) {
  const host = new URL(origin).hostname
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
  return `mastodon-${host || 'instance'}-${hash(origin).slice(0, 8)}`;
}

const githubListLimit = 20;

function parseGitHubPublicList(
  value: unknown,
  source: Source,
  observedAt: string,
): { items: Item[]; stories: Story[]; summary: { returned: number; retained: number } } {
  const repository = githubPublicRepositoryList(source.url);
  if (!repository || !Array.isArray(value) || value.length > githubListLimit)
    throw new Error('invalid_github_public_list');
  const items: Item[] = [];
  const identities = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('invalid_github_public_record');
    const record = entry as Record<string, unknown>;
    let identity: string;
    let title: string;
    let excerpt: string;
    let canonicalUrl: string;
    let author: string | null = null;
    let publishedAt: string | null = null;
    if (repository.collection === 'releases') {
      if (
        typeof record.id !== 'number' ||
        !Number.isSafeInteger(record.id) ||
        record.id < 1 ||
        typeof record.tag_name !== 'string' ||
        !record.tag_name.trim() ||
        record.tag_name.length > 256 ||
        typeof record.draft !== 'boolean'
      )
        throw new Error('invalid_github_release');
      if (record.draft) continue;
      const tag = record.tag_name;
      identity = `release:${record.id}:${tag}`;
      title = normalizeText(typeof record.name === 'string' ? record.name : '') || tag;
      if (typeof record.body === 'string') excerpt = normalizeText(record.body).slice(0, 5000);
      else excerpt = '';
      canonicalUrl = `https://github.com/${repository.owner}/${repository.repository}/releases/tag/${encodeURIComponent(tag)}`;
      const releaseAuthor =
        record.author && typeof record.author === 'object' && !Array.isArray(record.author)
          ? (record.author as Record<string, unknown>).login
          : null;
      if (typeof releaseAuthor === 'string') author = normalizeText(releaseAuthor).slice(0, 300);
      const dateValue = record.published_at ?? record.created_at;
      if (typeof dateValue === 'string' && Number.isFinite(Date.parse(dateValue)))
        publishedAt = new Date(dateValue).toISOString();
    } else {
      const commit =
        record.commit && typeof record.commit === 'object' && !Array.isArray(record.commit)
          ? (record.commit as Record<string, unknown>)
          : null;
      if (
        typeof record.name !== 'string' ||
        !record.name.trim() ||
        record.name.length > 256 ||
        typeof commit?.sha !== 'string' ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit.sha)
      )
        throw new Error('invalid_github_tag');
      identity = `tag:${record.name}:${commit.sha.toLowerCase()}`;
      title = `${repository.owner}/${repository.repository} · tag ${record.name}`;
      excerpt = `Git tag ${record.name} points to commit ${commit.sha.toLowerCase()}.`;
      canonicalUrl = `https://github.com/${repository.owner}/${repository.repository}/tree/${encodeURIComponent(record.name)}`;
    }
    if (identities.has(identity)) throw new Error('duplicate_github_public_identity');
    identities.add(identity);
    const contentDigest = hash(
      JSON.stringify({
        collection: repository.collection,
        identity,
        canonicalUrl,
        title,
        author,
        publishedAt,
        excerpt,
      }),
    );
    items.push({
      id: id('item', `${source.id}\n${identity}\n${contentDigest}`),
      sourceId: source.id,
      canonicalUrl,
      title: title.slice(0, 500),
      author,
      publishedAt,
      observedAt,
      contentDigest,
      excerpt,
      metrics: [],
      interestIds: source.interestIds,
      storyId: null,
    });
  }
  const stories = items.map((item) => ({
    id: id('story', item.id),
    itemIds: [item.id],
    representativeItemId: item.id,
    firstSeen: observedAt,
    lastSeen: observedAt,
    relation: 'single' as const,
    groupingEvidence: [],
    interestMatches: [],
  }));
  items.forEach((item, index) => (item.storyId = stories[index]!.id));
  return { items, stories, summary: { returned: value.length, retained: items.length } };
}

function parseMastodonTagTimeline(
  value: unknown,
  source: Source,
  tag: string,
  observedAt: string,
  sourceRef: string,
): { items: Item[]; stories: Story[]; metrics: MetricSnapshot[]; summary: Record<string, number> } {
  if (!Array.isArray(value) || value.length > mastodonTimelineLimit)
    throw new Error('invalid_mastodon_timeline');
  const instance = mastodonTagTimeline(source.url);
  if (!instance) throw new Error('invalid_mastodon_source');
  const items: Item[] = [];
  const metrics: MetricSnapshot[] = [];
  const seenStatusIds = new Set<string>();
  const summary = {
    returned: value.length,
    retained: 0,
    wrongTag: 0,
    nonPublic: 0,
    sensitiveOrWarned: 0,
    reblog: 0,
    empty: 0,
    duplicate: 0,
  };
  const platform = mastodonPlatform(instance.origin);

  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('invalid_mastodon_status');
    const status = entry as Record<string, unknown>;
    if (
      typeof status.id !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(status.id) ||
      typeof status.visibility !== 'string' ||
      typeof status.sensitive !== 'boolean' ||
      typeof status.spoiler_text !== 'string' ||
      !Array.isArray(status.tags)
    )
      throw new Error('invalid_mastodon_status');
    if (seenStatusIds.has(status.id)) {
      summary.duplicate++;
      continue;
    }
    seenStatusIds.add(status.id);
    if (status.visibility !== 'public') {
      summary.nonPublic++;
      continue;
    }
    if (
      status.sensitive === true ||
      (typeof status.spoiler_text === 'string' && status.spoiler_text.trim())
    ) {
      summary.sensitiveOrWarned++;
      continue;
    }
    if (status.reblog !== null && status.reblog !== undefined) {
      summary.reblog++;
      continue;
    }
    const tags = status.tags.flatMap((entry) =>
      entry &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      typeof (entry as Record<string, unknown>).name === 'string'
        ? [(entry as Record<string, unknown>).name as string]
        : [],
    );
    if (!tags.some((value) => value.toLowerCase() === tag.toLowerCase())) {
      summary.wrongTag++;
      continue;
    }
    if (typeof status.content !== 'string' || typeof status.created_at !== 'string')
      throw new Error('invalid_mastodon_status');
    const timestamp = Date.parse(status.created_at);
    if (!Number.isFinite(timestamp)) throw new Error('invalid_mastodon_status_date');
    const canonicalUrl =
      (typeof status.url === 'string' ? publicLink(status.url, sourceRef) : null) ??
      (typeof status.uri === 'string' ? publicLink(status.uri, sourceRef) : null);
    if (!canonicalUrl) throw new Error('invalid_mastodon_status_url');
    const visibleText = extractHtml(
      `<html><body><main>${status.content}</main></body></html>`,
      canonicalUrl,
    ).text;
    if (!visibleText) {
      summary.empty++;
      continue;
    }
    const account =
      status.account && typeof status.account === 'object' && !Array.isArray(status.account)
        ? (status.account as Record<string, unknown>)
        : null;
    const author =
      typeof account?.acct === 'string' ? normalizeText(account.acct).slice(0, 300) : null;
    const publishedAt = new Date(timestamp).toISOString();
    const excerpt = visibleText.slice(0, 5000);
    const contentDigest = hash(
      JSON.stringify({ statusId: status.id, canonicalUrl, author, publishedAt, visibleText }),
    );
    const item: Item = {
      id: id('item', `${source.id}\n${canonicalUrl}\n${contentDigest}`),
      sourceId: source.id,
      canonicalUrl,
      title: excerpt.slice(0, 500),
      author,
      publishedAt,
      observedAt,
      contentDigest,
      excerpt,
      metrics: [],
      interestIds: source.interestIds,
      storyId: null,
    };
    item.storyId = id('story', item.id);
    items.push(item);
    summary.retained++;
    metrics.push(
      ...mastodonMetrics(status).map(({ name, value }) => ({
        item,
        platform,
        name,
        value,
        observedAt,
        scope: 'instance-view counts; not cross-instance totals',
        method: 'public-adapter' as const,
        sourceRef,
      })),
    );
  }
  const stories = items.map((item) => ({
    id: item.storyId!,
    itemIds: [item.id],
    representativeItemId: item.id,
    firstSeen: observedAt,
    lastSeen: observedAt,
    relation: 'single' as const,
    groupingEvidence: [],
    interestMatches: [],
  }));
  return { items, stories, metrics, summary };
}

async function recordMetricSnapshots(root: string, batchId: string, snapshots: MetricSnapshot[]) {
  const api = createBriefingApi(root);
  for (const snapshot of snapshots) {
    const { item, ...observation } = snapshot;
    const identity = `${batchId}\n${item.id}\n${observation.name}`;
    await api.recordMetricObservation({
      requestId: deterministicUuid(`request\n${identity}`),
      observation: { id: id('metric', identity), itemId: item.id, ...observation },
    });
  }
}

function parseHackerNewsIndex(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.length > 500 ||
    value.some((itemId) => !Number.isSafeInteger(itemId) || typeof itemId !== 'number' || itemId < 1)
  )
    throw new Error('invalid_hacker_news_index');
  return [...new Set(value as number[])];
}

function parseHackerNewsItem(
  value: unknown,
  expectedId: number,
  source: Source,
  observedAt: string,
): Item | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_hacker_news_item');
  const record = value as Record<string, unknown>;
  if (record.id !== expectedId) throw new Error('hacker_news_item_identity_mismatch');
  if (record.deleted === true || record.dead === true) return null;
  if (record.type !== 'story' && record.type !== 'job') return null;
  if (typeof record.title !== 'string') throw new Error('invalid_hacker_news_item');
  const title = normalizeText(record.title).slice(0, 500);
  if (!title) return null;
  const discussionUrl = hackerNewsDiscussionUrl(expectedId);
  const canonicalUrl =
    typeof record.url === 'string' ? publicLink(record.url, discussionUrl) ?? discussionUrl : discussionUrl;
  const author = typeof record.by === 'string' ? normalizeText(record.by).slice(0, 300) : null;
  const seconds = record.time;
  const publishedAt =
    typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds > 0
      ? Number.isFinite(new Date(seconds * 1000).getTime())
        ? new Date(seconds * 1000).toISOString()
        : null
      : null;
  const excerpt = typeof record.text === 'string' ? normalizeText(record.text).slice(0, 5000) : '';
  const contentDigest = hash(
    JSON.stringify({ id: expectedId, canonicalUrl, title, author, publishedAt, excerpt }),
  );
  const itemId = id('item', `${source.id}\n${canonicalUrl}\n${contentDigest}`);
  return {
    id: itemId,
    sourceId: source.id,
    canonicalUrl,
    title,
    author,
    publishedAt,
    observedAt,
    contentDigest,
    excerpt,
    metrics: [],
    interestIds: source.interestIds,
    storyId: id('story', itemId),
  };
}

function localTimeToUtc(value: string, zone: string) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (!match) throw new Error('invalid_ics_datetime');
  const wanted = match.slice(1).map(Number);
  let candidate = Date.UTC(
    wanted[0]!,
    wanted[1]! - 1,
    wanted[2]!,
    wanted[3]!,
    wanted[4]!,
    wanted[5]!,
  );
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const partsAt = (timestamp: number) => {
    const parts = Object.fromEntries(
      format.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]),
    );
    return [
      Number(parts.year),
      Number(parts.month),
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    ];
  };
  for (let index = 0; index < 4; index++) {
    const local = partsAt(candidate);
    const represented = Date.UTC(
      local[0]!,
      local[1]! - 1,
      local[2]!,
      local[3]!,
      local[4]!,
      local[5]!,
    );
    const target = Date.UTC(
      wanted[0]!,
      wanted[1]! - 1,
      wanted[2]!,
      wanted[3]!,
      wanted[4]!,
      wanted[5]!,
    );
    const delta = target - represented;
    if (delta === 0) break;
    candidate += delta;
  }
  if (partsAt(candidate).some((part, index) => part !== wanted[index]))
    throw new Error('ics_nonexistent_local_time');
  const ambiguous = [-3600000, 3600000].some(
    (shift) =>
      shift !== 0 && partsAt(candidate + shift).every((part, index) => part === wanted[index]),
  );
  return { timestamp: new Date(candidate).toISOString(), ambiguous };
}

function unfoldIcs(input: string) {
  return input.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
}

/** Parses bounded VEVENT fields without executing or fetching recurrence data. */
export function parseIcs(input: string, source: Source, observedAt = new Date().toISOString()) {
  if (input.length > 1000000 || /<!DOCTYPE|<!ENTITY/i.test(input)) throw new Error('invalid_ics');
  const rows: Array<{ item: Item; event: AllDayEvent | TimedEvent }> = [];
  let current: string[] | null = null;
  for (const line of unfoldIcs(input)) {
    if (line === 'BEGIN:VEVENT') current = [];
    else if (line === 'END:VEVENT' && current) {
      const properties = new Map<string, { params: Map<string, string>; value: string }>();
      for (const property of current) {
        const colon = property.indexOf(':');
        if (colon < 1) continue;
        const [name, ...paramParts] = property.slice(0, colon).split(';');
        const params = new Map(paramParts.map((part) => part.split('=', 2) as [string, string]));
        properties.set(name!.toUpperCase(), { params, value: property.slice(colon + 1) });
      }
      const start = properties.get('DTSTART');
      if (start) {
        const uid = properties.get('UID')?.value ?? hash(current.join('\n'));
        const summary =
          properties.get('SUMMARY')?.value.replaceAll('\\,', ',').replaceAll('\\n', '\n') ??
          'Calendar event';
        const description =
          properties.get('DESCRIPTION')?.value.replaceAll('\\,', ',').replaceAll('\\n', '\n') ?? '';
        const zone = start.params.get('TZID') ?? 'UTC';
        const end = properties.get('DTEND');
        const allDay = start.params.get('VALUE') === 'DATE' || /^\d{8}$/.test(start.value);
        const eventUrl = properties.get('URL')?.value ?? null;
        const contentDigest = hash(current.join('\n'));
        const itemId = id('item', `${source.id}\n${uid}\n${start.value}\n${contentDigest}`);
        const eventId = id('event', `${source.id}\n${uid}\n${start.value}\n${contentDigest}`);
        const canonicalUrl = eventUrl ?? `${source.url}#${encodeURIComponent(uid)}`;
        const item: Item = {
          id: itemId,
          sourceId: source.id,
          canonicalUrl,
          title: summary.slice(0, 500),
          author: null,
          publishedAt: null,
          observedAt,
          contentDigest,
          excerpt: description.slice(0, 5000),
          metrics: [],
          interestIds: source.interestIds,
          storyId: null,
        };
        const common = {
          id: eventId,
          itemId,
          originalTz: zone,
          dstAmbiguous: false,
          url: eventUrl,
          location: properties.get('LOCATION')?.value ?? null,
          recurrence: properties.get('RRULE')?.value ?? null,
        };
        let event: AllDayEvent | TimedEvent;
        if (allDay) {
          const localDate = (date: string) =>
            `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
          event = {
            ...common,
            allDay: true,
            startDate: localDate(start.value),
            endDate: end ? localDate(end.value) : null,
          };
        } else {
          const toInstant = (entry: { value: string; params: Map<string, string> }) => {
            if (/Z$/.test(entry.value))
              return {
                timestamp: `${entry.value.slice(0, 4)}-${entry.value.slice(4, 6)}-${entry.value.slice(6, 8)}T${entry.value.slice(9, 11)}:${entry.value.slice(11, 13)}:${entry.value.slice(13, 15)}.000Z`,
                ambiguous: false,
              };
            return localTimeToUtc(entry.value, entry.params.get('TZID') ?? zone);
          };
          const startTime = toInstant(start);
          const endTime = end ? toInstant(end) : null;
          event = {
            ...common,
            allDay: false,
            startUtc: startTime.timestamp,
            endUtc: endTime?.timestamp ?? null,
            dstAmbiguous: startTime.ambiguous || Boolean(endTime?.ambiguous),
          };
        }
        rows.push({ item, event });
      }
      current = null;
    } else if (current) current.push(line);
  }
  if (rows.length > 500) throw new Error('ics_event_limit');
  return rows;
}

/** Parses the text-only subset of JSON Feed; HTML is represented only in its digest. */
export function parseJsonFeed(
  input: unknown,
  source: Source,
  observedAt = new Date().toISOString(),
): Item[] {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('invalid_json_feed');
  const feed = input as { version?: unknown; items?: unknown };
  if (
    typeof feed.version !== 'string' ||
    !/^https:\/\/jsonfeed\.org\/version\/1(?:\.1)?$/.test(feed.version) ||
    !Array.isArray(feed.items) ||
    feed.items.length > 100
  )
    throw new Error('invalid_json_feed');
  return feed.items.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const value = entry as Record<string, unknown>;
    const link =
      typeof value.url === 'string'
        ? value.url
        : typeof value.external_url === 'string'
          ? value.external_url
          : null;
    if (!link || typeof value.title !== 'string') return [];
    const url = new URL(link);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return [];
    const excerpt = typeof value.content_text === 'string' ? value.content_text.slice(0, 5000) : '';
    const author =
      Array.isArray(value.authors) && typeof value.authors[0]?.name === 'string'
        ? value.authors[0].name.slice(0, 300)
        : null;
    const publishedAt =
      typeof value.date_published === 'string' && Number.isFinite(Date.parse(value.date_published))
        ? new Date(value.date_published).toISOString()
        : null;
    const contentDigest = hash(
      JSON.stringify({
        url: url.toString(),
        title: value.title,
        content_text: value.content_text ?? null,
        content_html: value.content_html ?? null,
        date_published: value.date_published ?? null,
      }),
    );
    return [
      {
        id: id('item', `${source.id}\n${url.toString()}\n${contentDigest}`),
        sourceId: source.id,
        canonicalUrl: url.toString(),
        title: value.title.slice(0, 500),
        author,
        publishedAt,
        observedAt,
        contentDigest,
        excerpt,
        metrics: [],
        interestIds: source.interestIds,
        storyId: null,
      } satisfies Item,
    ];
  });
}

/** One caller-requested pass through the established Following acquisition path. */
export async function refreshBriefing(
  root: string,
  options: {
    interest?: string;
    signal?: AbortSignal;
    fetch?: typeof fetchEvidence;
    requestId?: string;
    clock?: () => Date;
  } = {},
) {
  const settings = await loadSettings(root);
  const api = createBriefingApi(root);
  const sources = await api.listSources();
  const blocked = new Set<string>();
  const sourceByUri = new Map(sources.map(({ record }) => [record.url, record]));
  const sourceTerms = await listSourceTerms(root);
  for (const policy of sourceTerms)
    if (policy.status === 'blocked') {
      const source = sources.find((candidate) => candidate.record.id === policy.sourceId);
      if (source) blocked.add(source.record.url);
    }
  const eligibleSettings = {
    ...settings,
    followedSources: (settings.followedSources ?? []).filter((source) => !blocked.has(source.uri)),
  };
  const captured: Array<{ uri: string; document: Awaited<ReturnType<typeof fetchEvidence>> }> = [];
  const result = await scanSources(eligibleSettings, root, {
    interest: options.interest,
    persist: true,
    signal: options.signal,
    fetch: async (uri, signal, redirects, allowPdf, fetchOptions) => {
      const source = sourceByUri.get(uri);
      // HN's index contains only IDs, so a conditional 304 could hide changed item details.
      // One explicit pass therefore rechecks the bounded item set instead of trusting only
      // the index validator; every other source keeps the established conditional behavior.
      const documentOptions =
        source?.kind === 'api:hacker-news'
          ? { includeBytes: true }
          : { ...fetchOptions, includeBytes: true };
      let requestUri = uri;
      if (source?.kind === 'api:mastodon-tag') {
        if (!mastodonTagTimeline(uri)) throw new Error('invalid_mastodon_source');
        const boundedRequest = new URL(uri);
        boundedRequest.searchParams.set('limit', String(mastodonTimelineLimit));
        requestUri = boundedRequest.toString();
      }
      const githubList = source ? githubPublicRepositoryList(uri) : null;
      if (source?.kind === 'api:github-releases' || source?.kind === 'api:github-tags') {
        if (
          !githubList ||
          (githubList.collection === 'releases') !== (source.kind === 'api:github-releases')
        )
          throw new Error('invalid_github_public_source');
        const boundedRequest = new URL(uri);
        boundedRequest.searchParams.set('per_page', String(githubListLimit));
        boundedRequest.searchParams.set('page', '1');
        requestUri = boundedRequest.toString();
      }
      let document = await (options.fetch ?? fetchEvidence)(
        requestUri,
        signal,
        redirects,
        allowPdf,
        githubList ? { ...documentOptions, githubPublicApi: true } : documentOptions,
      );
      if (document.response?.status !== 304 && githubList) {
        if (
          !document.uri ||
          new URL(document.uri).origin !== 'https://api.github.com' ||
          new URL(document.uri).pathname !== new URL(requestUri).pathname
        )
          throw new Error('github_api_redirected');
        const observedAt = (options.clock ?? (() => new Date()))().toISOString();
        const parsed = parseGitHubPublicList(document.json, source!, observedAt);
        await retainBriefingRecords(root, { items: parsed.items, stories: parsed.stories });
        document = {
          ...document,
          text: JSON.stringify({
            collection: githubList.collection,
            repository: `${githubList.owner}/${githubList.repository}`,
            ...parsed.summary,
            records: parsed.items.map((item) => ({
              id: item.id,
              contentDigest: item.contentDigest,
              canonicalUrl: item.canonicalUrl,
            })),
          }),
          material: {
            text: parsed.items.map(({ title, excerpt }) => `${title} ${excerpt}`).join('\n'),
            title: `${githubList.owner}/${githubList.repository} ${githubList.collection}`,
            author: null,
            publishedAt: null,
            links: parsed.items.map((item) => ({ uri: item.canonicalUrl, title: item.title })),
            sections: parsed.items.map((item) => ({ locator: item.id, text: item.excerpt })),
            extractor: 'github-public-repository-list-v1',
          },
        };
      }
      if (document.response?.status !== 304 && source?.kind === 'api:hacker-news') {
        if (!isHackerNewsIndexUri(uri)) throw new Error('invalid_hacker_news_source');
        const itemIds = parseHackerNewsIndex(document.json);
        const observedAt = (options.clock ?? (() => new Date()))().toISOString();
        const observationBatchId = options.requestId ?? randomUUID();
        const items: Item[] = [];
        const observations: MetricSnapshot[] = [];
        for (const itemId of itemIds.slice(0, hackerNewsItemLimit)) {
          const detail = await (options.fetch ?? fetchEvidence)(
            hackerNewsItemUrl(itemId),
            signal,
            0,
            false,
            { includeBytes: true },
          );
          if (detail.response?.status === 304) throw new Error('unexpected_hacker_news_item_304');
          const item = parseHackerNewsItem(detail.json, itemId, source, observedAt);
          if (item) {
            items.push(item);
            observations.push(
              ...hackerNewsMetrics(detail.json).map((metric) => ({
                item,
                ...metric,
                platform: 'hacker-news',
                observedAt,
                scope: 'public Hacker News item detail snapshot',
                method: 'public-adapter' as const,
                sourceRef: hackerNewsItemUrl(itemId),
              })),
            );
          }
        }
        const stories: Story[] = items.map((item) => ({
          id: item.storyId!,
          itemIds: [item.id],
          representativeItemId: item.id,
          firstSeen: observedAt,
          lastSeen: observedAt,
          relation: 'single',
          groupingEvidence: [],
          interestMatches: [],
        }));
        await retainBriefingRecords(root, { items, stories });
        await recordMetricSnapshots(root, observationBatchId, observations);
        document = {
          ...document,
          text: JSON.stringify({
            ids: itemIds,
            details: items.map((item) => ({
              itemId: item.id,
              contentDigest: item.contentDigest,
              metrics: observations
                .filter((observation) => observation.item.id === item.id)
                .map(({ name, value }) => ({ name, value })),
            })),
          }),
          material: {
            text: itemIds.map(String).join('\n'),
            title: 'Hacker News public story index',
            author: null,
            publishedAt: null,
            links: itemIds.map((itemId) => ({
              uri: hackerNewsDiscussionUrl(itemId),
              title: `Hacker News item ${itemId}`,
            })),
            sections: [],
            extractor: 'hacker-news-public-api-v0',
          },
        };
      }
      if (document.response?.status !== 304 && source?.kind === 'api:mastodon-tag') {
        const timeline = mastodonTagTimeline(uri);
        if (!timeline) throw new Error('invalid_mastodon_source');
        if (!document.uri || new URL(document.uri).origin !== timeline.origin)
          throw new Error('mastodon_instance_redirected');
        const observedAt = (options.clock ?? (() => new Date()))().toISOString();
        const observationBatchId = options.requestId ?? randomUUID();
        const requestedUrl = new URL(uri);
        requestedUrl.searchParams.set('limit', String(mastodonTimelineLimit));
        const sourceRef = requestedUrl.toString();
        const parsed = parseMastodonTagTimeline(
          document.json,
          source,
          timeline.tag,
          observedAt,
          sourceRef,
        );
        await retainBriefingRecords(root, { items: parsed.items, stories: parsed.stories });
        await recordMetricSnapshots(root, observationBatchId, parsed.metrics);
        document = {
          ...document,
          text: JSON.stringify({
            source: uri,
            scope: 'instance-view-only',
            tag: timeline.tag,
            ...parsed.summary,
            statuses: parsed.items.map((item) => ({
              itemId: item.id,
              contentDigest: item.contentDigest,
              metrics: parsed.metrics
                .filter((metric) => metric.item.id === item.id)
                .map(({ name, value }) => ({ name, value })),
            })),
          }),
          material: {
            text: `Mastodon #${timeline.tag} public tag timeline; instance view from ${timeline.origin}.`,
            title: `#${timeline.tag} · ${new URL(timeline.origin).host} instance view`,
            author: null,
            publishedAt: null,
            links: parsed.items.map((item) => ({ uri: item.canonicalUrl, title: item.title })),
            sections: parsed.items.map((item, index) => ({
              locator: `status:${index + 1}`,
              text: item.excerpt,
            })),
            extractor: 'mastodon-public-tag-v1',
          },
        };
      }
      if (
        document.response?.status !== 304 &&
        ((document.material && /xml/i.test(document.contentType ?? '')) ||
          source?.kind === 'ics' ||
          source?.kind === 'jsonfeed')
      ) {
        if (source) {
          const now = new Date().toISOString();
          if (source.kind === 'ics') {
            const parsed = parseIcs(document.text, source, now);
            const stories: Story[] = parsed.map(({ item }) => ({
              id: id('story', item.id),
              itemIds: [item.id],
              representativeItemId: item.id,
              firstSeen: now,
              lastSeen: now,
              relation: 'single',
              groupingEvidence: [],
              interestMatches: [],
            }));
            parsed.forEach(({ item }, index) => {
              item.storyId = stories[index]!.id;
            });
            await retainBriefingRecords(root, {
              items: parsed.map(({ item }) => item),
              stories,
              events: parsed.map(({ event }) => event),
            });
          } else if (source.kind === 'jsonfeed') {
            const items = parseJsonFeed(document.json, source, now);
            const stories: Story[] = items.map((item) => ({
              id: id('story', item.id),
              itemIds: [item.id],
              representativeItemId: item.id,
              firstSeen: now,
              lastSeen: now,
              relation: 'single',
              groupingEvidence: [],
              interestMatches: [],
            }));
            items.forEach((item, index) => {
              item.storyId = stories[index]!.id;
            });
            await retainBriefingRecords(root, { items, stories });
          } else {
            const items: Item[] = document.material!.links.map((link, index) => {
              const excerpt = document.material!.sections[index]?.text.slice(0, 5000) ?? '';
              const contentDigest = hash(`${link.uri}\n${link.title}\n${excerpt}`);
              return {
                id: id('item', `${source.id}\n${link.uri}\n${contentDigest}`),
                sourceId: source.id,
                canonicalUrl: link.uri,
                title: link.title || document.material!.title || link.uri,
                author: null,
                publishedAt: null,
                observedAt: now,
                contentDigest,
                excerpt,
                metrics: [],
                interestIds: source.interestIds,
                storyId: null,
              };
            });
            const stories: Story[] = items.map((item) => ({
              id: id('story', item.id),
              itemIds: [item.id],
              representativeItemId: item.id,
              firstSeen: now,
              lastSeen: now,
              relation: 'single',
              groupingEvidence: [],
              interestMatches: [],
            }));
            items.forEach((item, index) => {
              item.storyId = stories[index]!.id;
            });
            await retainBriefingRecords(root, { items, stories });
          }
        }
      }
      captured.push({ uri, document });
      return document;
    },
  });
  return {
    ...result,
    briefing: {
      capturedDocuments: captured.length,
      retainedItems: (await api.listItems({ limit: 100000 })).length,
      blockedSources: [...blocked],
      eventRecords: (await api.listEvents({ limit: 100000 })).length,
    },
  };
}

/** One explicit, request-identified Following refresh. Pending claims are never replayed. */
export async function refreshDue(
  root: string,
  request: { once: true; requestId: string; interest?: string },
  options: { fetch?: typeof fetchEvidence; clock?: () => Date } = {},
) {
  if (request.once !== true) throw new Error('briefing_refresh_once_required');
  const claim = await beginBriefingRefresh(root, request.requestId, request.interest);
  if (!claim.claimed) return { ...claim.receipt, replayed: true };

  // This uses the existing Following scan, including its conditional ETag/Last-Modified path.
  // If the process stops before its receipt is completed, the durable request remains pending;
  // a duplicate caller can read status, but it will not reacquire any source automatically.
  const pass = await refreshBriefing(root, {
    interest: request.interest,
    fetch: options.fetch,
    requestId: request.requestId,
    clock: options.clock,
  });
  const sources = await createBriefingApi(root).listSources();
  const sourceIds = new Map(sources.map(({ record }) => [record.url, record.id]));
  const summary: BriefingRefreshSummary = {
    capturedDocuments: pass.briefing.capturedDocuments,
    retainedItems: pass.briefing.retainedItems,
    eventRecords: pass.briefing.eventRecords,
    blockedSourceIds: pass.briefing.blockedSources.flatMap((url) => {
      const sourceId = sourceIds.get(url);
      return sourceId ? [sourceId] : [];
    }),
    sources: pass.sources.map((source) => {
      const sourceId = sourceIds.get(source.uri);
      if (!sourceId) throw new Error('briefing_refresh_source_identity_changed');
      return {
        sourceId,
        state: source.state === 'failed' ? 'failed' as const : 'fetched' as const,
        delta: (source.state === 'failed' ? null : source.delta ?? null) as
          BriefingRefreshSummary['sources'][number]['delta'],
        newLinkCount: source.newLinks.length,
        checkedAt: source.health?.lastAttempt?.checkedAt ?? null,
        failureReason: source.state === 'failed' ? source.reason ?? null : null,
      };
    }),
  };
  const receipt = await completeBriefingRefresh(
    root,
    request.requestId,
    claim.receipt.inputDigest,
    summary,
  );
  return { ...receipt, replayed: false };
}

/** Pure parsers retain only explicit feed data and avoid executing embedded content. */
export function parseOpml(input: string) {
  if (input.length > 1000000 || /<!DOCTYPE|<!ENTITY/i.test(input)) throw new Error('invalid_opml');
  if (!/<opml\b[^>]*>/i.test(input) || !/<\/opml\s*>/i.test(input)) throw new Error('invalid_opml');
  const decode = (value: string) =>
    value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (_entity, name: string) => {
      if (name[0] !== '#')
        return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' } as Record<string, string>)[
          name.toLowerCase()
        ]!;
      const point =
        name[1]?.toLowerCase() === 'x'
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10);
      if (
        !Number.isSafeInteger(point) ||
        point < 1 ||
        point > 0x10ffff ||
        (point >= 0xd800 && point <= 0xdfff)
      )
        throw new Error('invalid_opml_entity');
      return String.fromCodePoint(point);
    });
  const rows: Array<{
    url: string;
    label: string;
    type: 'rss' | 'atom' | 'ics' | 'jsonfeed';
  }> = [];
  for (const match of input.matchAll(/<outline\b([^>]*)\/?\s*>/gi)) {
    const attrs = new Map<string, string>();
    for (const attribute of match[1]!.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g))
      attrs.set(attribute[1]!.toLowerCase(), attribute[3]!);
    const rawUrl = attrs.get('xmlurl') ?? attrs.get('url');
    const url = rawUrl === undefined ? undefined : decode(rawUrl);
    if (!url) continue;
    const parsed = new URL(url);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.toString().length > 2048 ||
      [...parsed.searchParams.keys()].some((key) =>
        /^(?:api[-_]?key|access[-_]?token|token|auth|authorization|password|secret|signature)$/i.test(
          key,
        ),
      )
    )
      throw new Error('invalid_opml_source');
    const label = decode(attrs.get('text') ?? attrs.get('title') ?? parsed.hostname).trim();
    if (!label || label.length > 200) throw new Error('invalid_opml_source_label');
    rows.push({
      url: parsed.toString(),
      label,
      type:
        /^(?:ical|ics)$/i.test(attrs.get('type') ?? '') || /\.ics$/i.test(parsed.pathname)
          ? 'ics'
          : /^(?:json|jsonfeed)$/i.test(attrs.get('type') ?? '') || /\.json$/i.test(parsed.pathname)
            ? 'jsonfeed'
            : /^(?:atom)$/i.test(attrs.get('type') ?? '') || /\.atom$/i.test(parsed.pathname)
              ? 'atom'
              : 'rss',
    });
  }
  if (rows.length > 200) throw new Error('opml_source_limit');
  return rows;
}

function canonicalSources(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSources).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalSources(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function buildOpmlPreview(
  input: string,
  current: NonNullable<Awaited<ReturnType<typeof loadSettings>>['followedSources']>,
) {
  const parsed = parseOpml(input);
  if (
    parsed.some(
      (source) =>
        (source.type === 'ics' && !/\.ics(?:$|\?)/i.test(source.url)) ||
        (source.type === 'jsonfeed' && !/\.json(?:$|\?)/i.test(source.url)) ||
        (source.type === 'atom' && !/\.atom(?:$|\?)/i.test(source.url)),
    )
  )
    throw new Error('opml_source_type_must_match_url');
  const byUrl = new Map(current.map((source) => [source.uri, source]));
  const changes = parsed.map((source) => {
    const prior = byUrl.get(source.url);
    const next = prior
      ? { ...prior, label: source.label }
      : { uri: source.url, label: source.label, enabled: true, interests: [] };
    const status = !prior
      ? 'add'
      : canonicalSources(prior) === canonicalSources(next)
        ? 'unchanged'
        : 'update';
    byUrl.set(source.url, next);
    return { ...source, status };
  });
  if (byUrl.size > 50) throw new Error('following_source_limit');
  const inputDigest = hash(input);
  const settingsDigest = hash(canonicalSources(current));
  const resultingSettingsDigest = hash(canonicalSources([...byUrl.values()]));
  const content = {
    schema: 'signals.briefing-opml-preview.v1',
    inputDigest,
    settingsDigest,
    sources: changes,
    currentCount: current.length,
    resultingCount: byUrl.size,
    resultingSettingsDigest,
  };
  return {
    ...content,
    previewDigest: hash(canonicalSources(content)),
    acquisition: 'not_started' as const,
  };
}

/** Preview and apply OPML to the existing Following settings; no acquisition occurs here. */
export async function previewBriefingOpml(root: string, input: string) {
  const settings = await loadSettings(root);
  return buildOpmlPreview(input, settings.followedSources ?? []);
}

/** Deterministic URL-keyed merge over the existing settings file; exact repeats are write-free. */
export async function importBriefingOpml(
  root: string,
  input: string,
  requestId: string,
  expected: { inputDigest: string; settingsDigest: string; previewDigest: string },
) {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(requestId))
    throw new Error('invalid_briefing_opml_request');
  if (
    !/^[a-f0-9]{64}$/.test(expected.inputDigest) ||
    !/^[a-f0-9]{64}$/.test(expected.settingsDigest) ||
    !/^[a-f0-9]{64}$/.test(expected.previewDigest)
  )
    throw new Error('invalid_briefing_opml_preview_binding');
  const requestDigest = hash(
    canonicalSources({
      actualInputDigest: hash(input),
      settingsDigest: expected.settingsDigest,
      previewDigest: expected.previewDigest,
    }),
  );
  let expectedSources: NonNullable<SearchSettings['followedSources']> = [];
  const { settings: retained, result } = await updateSettingsForBriefingOpml(root, (settings) => {
    const prior = (settings.briefingOpmlImports ?? []).find(
      (entry) => entry.requestId === requestId,
    );
    if (prior) {
      if (prior.requestDigest !== requestDigest) throw new Error('request_id_conflict');
      return {
        settings,
        result: { ...prior, replayed: true, acquisition: 'not_started' as const },
      };
    }
    if (hash(input) !== expected.inputDigest) throw new Error('opml_preview_stale');
    const before = settings.followedSources ?? [];
    const preview = buildOpmlPreview(input, before);
    if (
      preview.inputDigest !== expected.inputDigest ||
      preview.settingsDigest !== expected.settingsDigest ||
      preview.previewDigest !== expected.previewDigest
    )
      throw new Error('opml_preview_stale');
    const byUrl = new Map(before.map((source) => [source.uri, source]));
    for (const source of preview.sources) {
      const prior = byUrl.get(source.url);
      byUrl.set(
        source.url,
        prior
          ? { ...prior, label: source.label }
          : { uri: source.url, label: source.label, enabled: true, interests: [] },
      );
    }
    const followedSources = [...byUrl.values()];
    expectedSources = followedSources;
    if (followedSources.length > 50) throw new Error('following_source_limit');
    const changed = canonicalSources(before) !== canonicalSources(followedSources);
    const imports = settings.briefingOpmlImports ?? [];
    if (imports.length >= 10000) throw new Error('briefing_import_receipts_full');
    const receipt = {
      requestId,
      requestDigest,
      previewDigest: preview.previewDigest,
      inputDigest: preview.inputDigest,
      resultingSettingsDigest: preview.resultingSettingsDigest,
      imported: preview.sources.length,
      configured: followedSources.length,
      changed,
      completedAt: new Date().toISOString(),
    };
    return {
      settings: { ...settings, followedSources, briefingOpmlImports: [...imports, receipt] },
      result: {
        ...receipt,
        replayed: false,
        acquisition: 'not_started' as const,
        sources: preview.sources,
      },
    };
  });
  if (result.replayed) return result;
  if (canonicalSources(retained.followedSources ?? []) !== canonicalSources(expectedSources))
    throw new Error('opml_import_readback_mismatch');
  const savedReceipt = (retained.briefingOpmlImports ?? []).find(
    (entry) => entry.requestId === requestId,
  );
  if (!savedReceipt || savedReceipt.requestDigest !== requestDigest)
    throw new Error('opml_import_receipt_readback_mismatch');
  return result;
}

export async function readBriefingOpmlImport(root: string, requestId: string) {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(requestId))
    throw new Error('invalid_briefing_opml_request');
  const settings = await loadSettings(root);
  const receipt = (settings.briefingOpmlImports ?? []).find(
    (entry) => entry.requestId === requestId,
  );
  return {
    requestId,
    found: Boolean(receipt),
    ...(receipt ? { receipt } : {}),
    followedSources: settings.followedSources ?? [],
    settingsDigest: hash(canonicalSources(settings.followedSources ?? [])),
  };
}

export function exportOpml(sources: Source[]) {
  const escape = (value: string) =>
    value
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  const outlines = sources
    .map(
      (source) =>
        `<outline text="${escape(source.attribution)}" title="${escape(source.attribution)}" type="${source.kind === 'ics' ? 'ical' : source.kind === 'jsonfeed' ? 'json' : source.kind === 'atom' ? 'atom' : 'rss'}" xmlUrl="${escape(source.url)}"/>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0"><head><title>Signals Following</title></head><body>\n${outlines}\n</body></opml>\n`;
}
