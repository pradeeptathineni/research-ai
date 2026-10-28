import { createHash } from 'node:crypto';
import { fetchEvidence } from '../search-fetch.js';
import { scanSources } from '../search-sources.js';
import { loadSettings, updateSettingsForBriefingOpml } from '../search-settings.js';
import type { SearchSettings } from '../search-settings.js';
import type { AllDayEvent, Item, Source, Story, TimedEvent } from './schema.js';
import {
  beginBriefingRefresh,
  completeBriefingRefresh,
  createBriefingApi,
  listSourceTerms,
  retainBriefingRecords,
  type BriefingRefreshSummary,
} from './store.js';

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

/** One explicit, request-identified Following refresh. Pending claims are never replayed. */
export async function refreshDue(
  root: string,
  request: { once: true; requestId: string; interest?: string },
  options: { fetch?: typeof fetchEvidence } = {},
) {
  if (request.once !== true) throw new Error('briefing_refresh_once_required');
  const claim = await beginBriefingRefresh(root, request.requestId, request.interest);
  if (!claim.claimed) return { ...claim.receipt, replayed: true };

  // This uses the existing Following scan, including its conditional ETag/Last-Modified path.
  // If the process stops before its receipt is completed, the durable request remains pending;
  // a duplicate caller can read status, but it will not reacquire any source automatically.
  const pass = await refreshBriefing(root, { interest: request.interest, fetch: options.fetch });
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
