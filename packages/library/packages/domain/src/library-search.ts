import MiniSearch from 'minisearch';
import type { Entity } from './search-contract.js';
import type { PublicOption } from './public-corpus.js';

export interface LibraryFinding {
  key: string;
  id: string;
  title: string;
  uri: string;
  description: string;
  kind: string;
  aliases: string[];
  domains: string[];
  capabilities: string[];
  useCases: string[];
  technologies: string[];
  tags: string[];
  sourceNames: string[];
  intrinsicStrength: { policy: string; score: number | null; legacyLevel?: 'high' | 'held' };
  license: { state: 'known' | 'unknown'; values: string[]; openSource: boolean | null };
  access: { state: 'known' | 'unknown'; freeToUse: boolean | null };
  origin: {
    format: 'native' | 'legacy' | 'lead' | 'answer' | 'note';
    destination: 'public' | 'private';
    recordId: string;
  };
  saved: boolean;
  notes?: string;
  feedback?: 'none' | 'skip' | 'mute' | 'useful';
  novelty?: 'confirmed-new' | 'known' | 'unknown';
  observedAt: string | null;
  // Indexed only by the local lexical index; excluded from remote metadata projections.
  answerText?: string;
  answer?: {
    runId: string;
    sha256: string;
    provenance: { receipt: string; requestedModel: string | null; servedModel: string | null };
    limits: string[];
  };
  partialNote?: {
    runId: string;
    sha256: string | null;
    status: 'partial' | 'failed' | 'cancelled' | 'unknown';
    unavailableReason: string | null;
    limits: string[];
  };
  native?: Entity;
  legacy?: PublicOption;
  lead?: {
    limits: string[];
    query: string;
    savedAt: string;
    history: {
      runId: string;
      query: string;
      savedAt: string;
      name: string;
      description: string;
      limits: string[];
    }[];
  };
}
export interface LibraryFilters {
  kind?: string;
  domain?: string;
  destination?: 'public' | 'private';
  saved?: boolean;
  acquisition?: 'all' | 'open-source' | 'free-to-use';
}
export interface LibraryHit {
  finding: LibraryFinding;
  retrievalScore: number;
  matchedFields: string[];
  matchedTerms: string[];
  meaningReason?: string;
}
const unique = (values: readonly string[]) => [...new Set(values.filter(Boolean))];
// Recognized captured license identifiers, not an inference from host, price or popularity.
const openLicenses = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MPL-2.0',
  'GPL-2.0-only',
  'GPL-2.0-or-later',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'Unlicense',
  '0BSD',
]);
function license(values: string[], kind: string): LibraryFinding['license'] {
  const known = unique(values);
  return {
    state: known.length ? 'known' : 'unknown',
    values: known,
    openSource:
      kind === 'software' && known.length && known.every((value) => openLicenses.has(value))
        ? true
        : null,
  };
}
/** Derive a browser record from canonical native metadata; never score retrieval as evidence. */
export function projectNativeLibrary(
  record: { entity: Entity },
  destination: 'public' | 'private',
): LibraryFinding {
  const entity = record.entity;
  return {
    key: `native:${destination}:${entity.id}`,
    id: entity.id,
    title: entity.name,
    uri: entity.uri,
    description: entity.description,
    kind: entity.kind,
    aliases: [...entity.aliases],
    domains: [...entity.facets.domains],
    capabilities: [...entity.facets.capabilities],
    useCases: [],
    technologies: unique([
      ...entity.facets.interfaces,
      ...entity.facets.platforms,
      ...entity.facets.deliveryForms,
    ]),
    tags: [...entity.facets.tags],
    sourceNames: unique(entity.evidence.flatMap((source) => [source.title, source.publisher])),
    intrinsicStrength: { policy: entity.assessment.policy, score: entity.assessment.score },
    license: license(entity.facets.licenses, entity.kind),
    access: { state: 'unknown', freeToUse: null },
    origin: { format: 'native', destination, recordId: entity.id },
    saved: true,
    observedAt: entity.assessment.asOf,
    native: entity,
  };
}
/** Preserve legacy review meaning and original evidence instead of manufacturing native scores. */
export function projectLegacyLibrary(option: PublicOption): LibraryFinding {
  return {
    key: `legacy:public:${option.id}`,
    id: option.id,
    title: option.name,
    uri: option.uri,
    description: [option.reason, ...option.claims.map((claim) => claim.text)].join(' '),
    kind: option.type,
    aliases: [],
    domains: [option.category],
    capabilities: [...option.concepts],
    useCases: [option.need],
    technologies: [],
    tags: [...option.concepts],
    sourceNames: unique(option.sources.map((source) => source.title)),
    intrinsicStrength: {
      policy: 'signal-review-v1',
      score: option.quality?.score ?? null,
      ...(option.quality ? { legacyLevel: option.quality.level } : {}),
    },
    license: { state: 'unknown', values: [], openSource: null },
    access: { state: 'unknown', freeToUse: null },
    origin: { format: 'legacy', destination: 'public', recordId: option.bundleId },
    saved: true,
    observedAt: option.reviewedAt,
    legacy: option,
  };
}
const fieldWeights = {
  answerText: 1,
  title: 6,
  aliases: 5,
  description: 3,
  capabilities: 4,
  useCases: 3,
  technologies: 3,
  tags: 2,
  kind: 2,
  domains: 1,
  sourceNames: 3,
  notes: 2,
  // Caller-supplied retained statements; empty unless a caller indexes them.
  evidenceText: 3,
};
type SearchField = keyof typeof fieldWeights;
function fieldValues(finding: LibraryFinding, field: Exclude<SearchField, 'evidenceText'>) {
  const value = finding[field];
  return typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
}
function tokenize(value: string): string[] {
  return value.replace(/([\p{Ll}\d])([\p{Lu}])/gu, '$1 $2').match(/[\p{L}\p{N}]+/gu) ?? [];
}
// Function words only: domain terms and original metadata remain untouched.
const stopWords = new Set(
  `a an and are as at be been being but by can could did do does doing for from had has have
  having he her hers herself him himself his how i if in into is it its itself may me might
  more most must my myself no nor not of on once only or other our ours ourselves out over
  own same she should so some such than that the their theirs them themselves then there
  these they this those through to too under up us very was we were what when where which
  while who whom why will with would you your yours yourself yourselves`.split(/\s+/u),
);
function processTerm(value: string): string[] {
  const term = value.normalize('NFKC').toLocaleLowerCase('en-US');
  if (stopWords.has(term)) return [];
  // General English inflection recall; originals stay indexed and no concepts/names are added.
  return unique([
    term,
    ...(term.length > 6 && term.endsWith('ing') ? [term.slice(0, -3)] : []),
    ...(term.length > 4 && term.endsWith('s') && !term.endsWith('ss') ? [term.slice(0, -1)] : []),
  ]);
}
const normalized = (text: string) =>
  tokenize(text).join(' ').normalize('NFKC').toLocaleLowerCase('en-US');
function allows(finding: LibraryFinding, filters: LibraryFilters): boolean {
  return (
    (!filters.kind || finding.kind === filters.kind) &&
    (!filters.domain || finding.domains.includes(filters.domain)) &&
    (!filters.destination || finding.origin.destination === filters.destination) &&
    (filters.saved === undefined || finding.saved === filters.saved) &&
    (filters.acquisition !== 'open-source' || finding.license.openSource === true) &&
    (filters.acquisition !== 'free-to-use' || finding.access.freeToUse === true)
  );
}
/**
 * One shared, reusable lexical index for local and public browsers and retained-knowledge reuse;
 * no I/O or inference. `evidenceText` lets a caller index statements without adding them to records.
 */
export function createLibraryIndex(
  records: readonly LibraryFinding[],
  evidenceText: (finding: LibraryFinding) => string[] = () => [],
) {
  const byKey = new Map<string, LibraryFinding>();
  const allFields = Object.keys(fieldWeights) as SearchField[];
  const values = (finding: LibraryFinding, field: SearchField) =>
    field === 'evidenceText' ? evidenceText(finding) : fieldValues(finding, field);
  const index = new MiniSearch({ idField: 'key', fields: allFields, tokenize, processTerm });
  for (const finding of records) {
    if (byKey.has(finding.key)) throw new Error('duplicate_library_identity');
    byKey.set(finding.key, finding);
    index.add({
      key: finding.key,
      ...Object.fromEntries(allFields.map((field) => [field, values(finding, field).join(' ')])),
    });
  }
  return {
    search(
      query: string,
      filters: LibraryFilters = {},
      fields: readonly SearchField[] = allFields,
    ): LibraryHit[] {
      const text = query.trim().slice(0, 2000);
      if (!tokenize(text).length)
        return [...byKey.values()]
          .filter((finding) => allows(finding, filters))
          .sort((a, b) => a.title.localeCompare(b.title) || a.key.localeCompare(b.key))
          .map((finding) => ({ finding, retrievalScore: 0, matchedFields: [], matchedTerms: [] }));
      const phrases = [...text.matchAll(/"([^"\n]+)"/gu)].map((match) => normalized(match[1]!));
      const whole = normalized(text);
      const queryTerms = unique(tokenize(text).map(normalized))
        .map(processTerm)
        .filter((variants) => variants.length);
      return index
        .search(text, {
          fields: [...fields],
          combineWith: 'OR',
          boost: fieldWeights,
          prefix: (term) => term.length >= 3,
          fuzzy: (term) => (term.length >= 4 ? 0.2 : false),
        })
        .flatMap((hit) => {
          const finding = byKey.get(String(hit.id))!;
          if (!allows(finding, filters)) return [];
          const exact = fields.filter((field) =>
            values(finding, field).some((value) => normalized(value).includes(whole)),
          );
          if (
            !phrases.every((phrase) =>
              fields.some((field) =>
                values(finding, field).some((value) => normalized(value).includes(phrase)),
              ),
            )
          )
            return [];
          // Count original query words once even when their inflected variants match.
          // OR retains partial matches; broader lexical coverage receives more weight.
          const matched = new Set(hit.queryTerms);
          const coveredTerms = queryTerms.filter((variants) =>
            variants.some((term) => matched.has(term)),
          ).length;
          const coverage = coveredTerms / queryTerms.length;
          return [
            {
              finding,
              retrievalScore:
                hit.score *
                (coveredTerms / hit.queryTerms.length) *
                coverage ** 2 *
                (exact.includes('title') || exact.includes('aliases')
                  ? 1.6
                  : exact.length
                    ? 1.25
                    : 1),
              matchedFields: unique(Object.values(hit.match).flat()),
              matchedTerms: Object.keys(hit.match),
            },
          ];
        })
        .sort(
          (a, b) =>
            b.retrievalScore - a.retrievalScore || a.finding.key.localeCompare(b.finding.key),
        );
    },
  };
}
export function searchLibrary(
  records: readonly LibraryFinding[],
  query: string,
  filters: LibraryFilters = {},
): LibraryHit[] {
  return createLibraryIndex(records).search(query, filters);
}
