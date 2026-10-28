import { createHash } from 'node:crypto';
import { fetchEvidence } from '../search-fetch.js';
import { scanSources } from '../search-sources.js';
import { loadSettings } from '../search-settings.js';
import type { AllDayEvent, Item, Source, Story, TimedEvent } from './schema.js';
import { createBriefingApi, listSourceTerms, retainBriefingRecords } from './store.js';

function id(prefix: string, value: string) {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}
function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
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
  options: { interest?: string; signal?: AbortSignal; fetch?: typeof fetchEvidence } = {},
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
      const document = await (options.fetch ?? fetchEvidence)(uri, signal, redirects, allowPdf, {
        ...fetchOptions,
        includeBytes: true,
      });
      if (
        document.response?.status !== 304 &&
        ((document.material && /xml/i.test(document.contentType ?? '')) ||
          sourceByUri.get(uri)?.kind === 'ics' ||
          sourceByUri.get(uri)?.kind === 'jsonfeed')
      ) {
        const source = sourceByUri.get(uri);
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

/** Pure parsers retain only explicit feed data and avoid executing embedded content. */
export function parseOpml(input: string) {
  if (input.length > 1000000 || /<!DOCTYPE|<!ENTITY/i.test(input)) throw new Error('invalid_opml');
  const rows: Array<{ url: string; label: string; type: 'rss' | 'ics' | 'jsonfeed' }> = [];
  for (const match of input.matchAll(/<outline\b([^>]*)\/?\s*>/gi)) {
    const attrs = new Map<string, string>();
    for (const attribute of match[1]!.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g))
      attrs.set(attribute[1]!.toLowerCase(), attribute[3]!);
    const url = attrs.get('xmlurl') ?? attrs.get('url');
    if (!url) continue;
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
      throw new Error('invalid_opml_source');
    rows.push({
      url: parsed.toString(),
      label: attrs.get('text') ?? attrs.get('title') ?? parsed.hostname,
      type:
        /^(?:ical|ics)$/i.test(attrs.get('type') ?? '') || /\.ics$/i.test(parsed.pathname)
          ? 'ics'
          : /^(?:json|jsonfeed)$/i.test(attrs.get('type') ?? '') || /\.json$/i.test(parsed.pathname)
            ? 'jsonfeed'
            : 'rss',
    });
  }
  if (rows.length > 200) throw new Error('opml_source_limit');
  return rows;
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
        `<outline text="${escape(source.attribution)}" title="${escape(source.attribution)}" type="${source.kind === 'ics' ? 'ical' : 'rss'}" xmlUrl="${escape(source.url)}"/>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0"><head><title>Signals Following</title></head><body>\n${outlines}\n</body></opml>\n`;
}
