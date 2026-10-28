import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import Parser from 'rss-parser';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { normalizeConsiderUrl } from '../../domain/src/url.js';
import { normalizeSpan, digest } from './search-fetch.js';
import { currentHtmlText, type SourceText } from '../../domain/src/source-text.js';
import {
  htmlLayout,
  explicitlyHidden,
  layoutProjectionDigest,
  validateLayoutProjection,
} from './search-html-layout.js';

export interface DocumentMaterial {
  text: string;
  title: string;
  author: string | null;
  publishedAt: string | null;
  links: { uri: string; title: string }[];
  sections: { locator: string; text: string; provenance?: unknown[] }[];
  extractor: string;
  scope?: Omit<
    ReturnType<typeof htmlLayout>['scope'],
    'excludedContentTextUnits' | 'excludedStructuredDataTextUnits' | 'excludedTextCountOverflow'
  > &
    Partial<
      Pick<
        ReturnType<typeof htmlLayout>['scope'],
        'excludedContentTextUnits' | 'excludedStructuredDataTextUnits' | 'excludedTextCountOverflow'
      >
    >;
}
const bounded = Type.String({ maxLength: 2000000 });
const materialSchema = Type.Object(
  {
    text: bounded,
    title: bounded,
    author: Type.Union([bounded, Type.Null()]),
    publishedAt: Type.Union([bounded, Type.Null()]),
    links: Type.Array(Type.Object({ uri: bounded, title: bounded }), { maxItems: 200 }),
    sections: Type.Array(
      Type.Object({
        locator: bounded,
        text: bounded,
        provenance: Type.Optional(Type.Array(Type.Unknown())),
      }),
      { maxItems: 1000 },
    ),
    extractor: bounded,
    scope: Type.Optional(
      Type.Object(
        {
          kind: Type.Literal('html-layout-v1'),
          textDigest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
          projectionDigest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
          excludedNodes: Type.Integer({ minimum: 0 }),
          excludedContentTextUnits: Type.Optional(Type.Integer({ minimum: 0, maximum: 2000000 })),
          excludedStructuredDataTextUnits: Type.Optional(
            Type.Integer({ minimum: 0, maximum: 2000000 }),
          ),
          excludedTextCountOverflow: Type.Optional(Type.Boolean()),
          tables: Type.Integer({ minimum: 0 }),
          omittedTables: Type.Integer({ minimum: 0 }),
          omittedDepth: Type.Integer({ minimum: 0 }),
          computedStylesEvaluated: Type.Literal(false),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export function cachedMaterial(value: unknown): DocumentMaterial | undefined {
  if (value === undefined) return undefined;
  if (!Value.Check(materialSchema, value)) throw new Error('invalid_cached_document');
  for (const link of value.links) normalizeConsiderUrl(link.uri);
  if (value.scope && value.scope.textDigest !== digest(value.text))
    throw new Error('invalid_document_layout_digest');
  if (value.scope) {
    const counters = [
      value.scope.excludedContentTextUnits,
      value.scope.excludedStructuredDataTextUnits,
      value.scope.excludedTextCountOverflow,
    ];
    if (
      counters.some((counter) => counter !== undefined) &&
      counters.some((counter) => counter === undefined)
    )
      throw new Error('invalid_document_omission_scope');
    if (
      value.scope.excludedTextCountOverflow &&
      value.scope.excludedContentTextUnits !== 2000000 &&
      value.scope.excludedStructuredDataTextUnits !== 2000000
    )
      throw new Error('invalid_document_omission_scope');
    if (value.scope.projectionDigest !== layoutProjectionDigest(value.sections))
      throw new Error('invalid_document_projection_digest');
    validateLayoutProjection(value.text, value.sections);
  }
  return value;
}

/** Disclosure only: neither measured zero nor complete normalization proves source completeness. */
export function materialOmissions(
  material?: Pick<DocumentMaterial, 'extractor' | 'scope'>,
): string[] {
  if (
    !material ||
    (!material.scope && !/^readability-0\.6\.0(?:\+html-layout-v1)?$/.test(material.extractor))
  )
    return [];
  const scope = material.scope;
  const count = scope?.excludedContentTextUnits;
  const structured = scope?.excludedStructuredDataTextUnits;
  return [
    'HTML extraction is a retained DOM projection, not complete source coverage. Hidden or accessibility-marked content and script data can contain omitted terms, conditions or exceptions. Computed CSS and interactions were not evaluated.',
    count === undefined || structured === undefined
      ? 'Excluded source-text coverage was not measured in this historical material; missing counters do not mean zero omissions.'
      : `Excluded DOM content: ${count} normalized UTF16 units. Excluded inert JSON-script text: ${structured} normalized UTF16 units.${scope?.excludedTextCountOverflow ? ' Counts reached the reporting bound; further excluded text is unmeasured.' : ''} Measured zero does not prove semantic completeness.`,
  ];
}
const date = (value?: string | null) =>
  value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
export function publicLink(value: string, base: string, fragment = false) {
  try {
    const resolved = new URL(value, base);
    return (
      normalizeConsiderUrl(resolved.toString()).normalizedUrl + (fragment ? resolved.hash : '')
    );
  } catch {
    return null;
  }
}

/** Inert DOM only: no script execution, browser, resource loader or network convenience methods. */
function legacyHtml(raw: string, uri: string): DocumentMaterial {
  const { document } = parseHTML(raw);
  const title = document.querySelector('title')?.textContent?.trim() ?? '';
  const publishedAt = date(
    document.querySelector('meta[property="article:published_time"]')?.getAttribute('content'),
  );
  const links = [...document.querySelectorAll('a[href]')].slice(0, 1000).flatMap((node) => {
    const link = publicLink(node.getAttribute('href') ?? '', uri);
    return link ? [{ uri: link, title: normalizeSpan(node.textContent ?? '').slice(0, 200) }] : [];
  });
  for (const node of document.querySelectorAll('script,style,iframe,object,embed')) node.remove();
  const fallback = normalizeSpan(document.body?.textContent ?? document.textContent ?? '');
  const sections = [...document.querySelectorAll('h1,h2,h3,table')]
    .slice(0, 80)
    .map((node, index) => ({
      locator: node.id ? `#${node.id}` : `section:${index + 1}`,
      text: normalizeSpan(node.textContent ?? '').slice(0, 4000),
    }));
  let article;
  try {
    article = new Readability(document, { maxElemsToParse: 30000 }).parse();
  } catch {
    /* Link-rich hubs retain their original text and outlinks. */
  }
  return {
    text: normalizeSpan(`${article?.title || title}\n${article?.textContent || fallback}`),
    title: article?.title || title,
    author: article?.byline || null,
    publishedAt: date(article?.publishedTime) ?? publishedAt,
    links: [...new Map(links.map((link) => [link.uri, link])).values()].slice(0, 200),
    sections,
    extractor: 'readability-0.6.0',
  };
}

export function extractHtml(
  raw: string,
  uri: string,
  normalizer: SourceText = currentHtmlText,
): DocumentMaterial {
  const legacy = legacyHtml(raw, uri);
  if (normalizer === 'text-v2') return legacy;
  const { document } = parseHTML(raw);
  const links = [...document.querySelectorAll('a[href]')].slice(0, 1000).flatMap((node) => {
    if (explicitlyHidden(node) || node.closest('script,style,iframe,object,embed')) return [];
    const link = publicLink(node.getAttribute('href') ?? '', uri, true);
    return link ? [{ uri: link, title: normalizeSpan(node.textContent ?? '').slice(0, 200) }] : [];
  });
  const layout = htmlLayout(raw, legacy.title);
  const headings = [...document.querySelectorAll('h1,h2,h3')]
    .filter(
      (node) =>
        !explicitlyHidden(node) &&
        !node.closest('nav,[role="navigation"],script,style,iframe,object,embed'),
    )
    .slice(0, 80)
    .map((node, index) => ({
      locator: node.id ? `#${node.id}` : `section:${index + 1}`,
      text: normalizeSpan(node.textContent ?? '').slice(0, 4000),
    }));
  return {
    ...legacy,
    ...layout,
    sections: [...headings, ...layout.sections].slice(0, 1000),
    links: [...new Map(links.map((link) => [link.uri, link])).values()].slice(0, 200),
    extractor: 'readability-0.6.0+html-layout-v1',
  };
}

export async function extractFeed(raw: string, uri: string): Promise<DocumentMaterial> {
  if (/<!DOCTYPE|<!ENTITY/i.test(raw)) throw new Error('feed_external_entity_denied');
  const feed = await new Parser().parseString(raw);
  const links = feed.items.slice(0, 100).flatMap((item) => {
    const link = publicLink(item.link ?? '', uri);
    return link ? [{ uri: link, title: (item.title ?? '').slice(0, 200) }] : [];
  });
  return {
    text: normalizeSpan(
      feed.items
        .slice(0, 100)
        .map((item) => `${item.title ?? ''} ${item.contentSnippet ?? ''}`)
        .join('\n'),
    ),
    title: feed.title ?? '',
    author: null,
    publishedAt: date(typeof feed.lastBuildDate === 'string' ? feed.lastBuildDate : null),
    links,
    sections: feed.items.slice(0, 100).map((item, index) => ({
      locator: `item:${index + 1}`,
      text: normalizeSpan(
        `${item.title ?? ''} ${item.contentSnippet ?? ''} ${date(item.isoDate) ?? ''}`,
      ),
    })),
    extractor: 'rss-parser-3.13.0',
  };
}
