import { createHash } from 'node:crypto';

const schemaVersion = 'signals-library-explore-v1' as const;
const itemVersion = 'signals-library-item-v1' as const;
const byteLimit = 4 * 1024 * 1024;
const itemLimit = 1000;

type LibraryExploreRef = {
  owner: string;
  kind: string;
  id: string;
  revision: string | null;
  digest: string | null;
};

export type LibraryExploreSummary = {
  ref: LibraryExploreRef;
  kind: string;
  updated_at: string | null;
  observed_at: string;
  [key: string]: unknown;
};

export type LibraryExploreFilters = {
  q: string;
  kinds: string[];
  project_ref: LibraryExploreRef | null;
};

export type LibraryExploreCoverage = {
  owner: string;
  state: string;
  observed_at: string;
  [key: string]: unknown;
};

export type LibraryExploreSnapshot = {
  schema_version: typeof schemaVersion;
  snapshot: string;
  filters: LibraryExploreFilters;
  items: {
    key: string;
    record: LibraryExploreSummary;
    observed_at: string | null;
  }[];
  facets: {
    dated_keys: string[];
    undated_keys: string[];
    kinds: { kind: string; count: number; keys: string[] }[];
  };
  owner_coverage: LibraryExploreCoverage[];
  qualifications: string[];
};

export class LibraryExploreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly reason: string,
  ) {
    super(code);
  }
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function exactRef(ref: LibraryExploreRef) {
  return {
    owner: ref.owner,
    kind: ref.kind,
    id: ref.id,
    revision: ref.revision,
    digest: ref.digest,
  };
}

/** Ambiguous local-time strings remain undated; source text is preserved on the record. */
export function normalizeLibraryObservationDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):?(\d{2}))$/i.exec(
      value,
    );
  if (!match) return null;
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  const maxDay = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (
    Number(month) < 1 ||
    Number(month) > 12 ||
    Number(day) < 1 ||
    Number(day) > maxDay ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    Number(offsetHour ?? 0) > 23 ||
    Number(offsetMinute ?? 0) > 59
  )
    return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function stableSummary(record: LibraryExploreSummary) {
  return { ...record, observed_at: null };
}

function stableCoverage(coverage: LibraryExploreCoverage[]) {
  return coverage.map((row) => ({ ...row, observed_at: null }));
}

export function buildLibraryExploreSnapshot(input: {
  identity: string;
  epoch: string;
  filters: LibraryExploreFilters;
  records: LibraryExploreSummary[];
  owner_coverage: LibraryExploreCoverage[];
  kinds: readonly string[];
}): LibraryExploreSnapshot {
  if (input.records.length > itemLimit)
    throw new LibraryExploreError(
      413,
      'library_explore_too_large',
      `The complete Library snapshot exceeds ${itemLimit} records. Narrow the existing Library filters; no partial result was returned.`,
    );

  const items = input.records.map((record) => {
    const ref = exactRef(record.ref);
    const key = sha256(JSON.stringify([itemVersion, ref]));
    return {
      key,
      record,
      observed_at: normalizeLibraryObservationDate(record.updated_at),
    };
  });
  if (new Set(items.map((item) => item.key)).size !== items.length)
    throw new LibraryExploreError(
      503,
      'invalid_library_snapshot',
      'The owner Library returned duplicate exact record references; no ambiguous snapshot was returned.',
    );

  const dated_keys = items.filter((item) => item.observed_at !== null).map((item) => item.key);
  const dated = new Set(dated_keys);
  const facets = {
    dated_keys,
    undated_keys: items.filter((item) => !dated.has(item.key)).map((item) => item.key),
    kinds: input.kinds.map((kind) => {
      const keys = items.filter((item) => item.record.kind === kind).map((item) => item.key);
      return { kind, count: keys.length, keys };
    }),
  };
  const owner_coverage = input.owner_coverage;
  const stable = {
    schema_version: schemaVersion,
    owner: { owner: 'signals-ai', instance_id: input.identity, owner_epoch: input.epoch },
    filters: input.filters,
    items: items.map((item) => ({
      key: item.key,
      record: stableSummary(item.record),
      observed_at: item.observed_at,
    })),
    facets,
    owner_coverage: stableCoverage(owner_coverage),
  };
  const snapshot = sha256(JSON.stringify(stable));
  const result: LibraryExploreSnapshot = {
    schema_version: schemaVersion,
    snapshot,
    filters: input.filters,
    items,
    facets,
    owner_coverage,
    qualifications: [
      'This is a complete snapshot of currently retained owner metadata under the supplied Library filters; unsupported legacy bundles remain excluded by the existing Library owner.',
      'Observed dates are retained metadata dates normalized to UTC when their timezone is explicit; unknown or ambiguous dates stay undated.',
      'Owner observation time is not source publication, factual freshness, evidence quality or relevance.',
      'Library matching and counts locate retained records; they do not grade evidence or establish truth.',
      'Selection returns exact metadata from this unchanged snapshot and starts no research or persistence.',
    ],
  };
  if (Buffer.byteLength(JSON.stringify(result)) > byteLimit)
    throw new LibraryExploreError(
      413,
      'library_explore_too_large',
      `The complete Library snapshot exceeds ${byteLimit} bytes. Narrow the existing Library filters; no partial result was returned.`,
    );
  return result;
}

export function selectLibraryExploreKeys(snapshot: LibraryExploreSnapshot, requested: string[]) {
  if (new Set(requested).size !== requested.length)
    throw new LibraryExploreError(
      400,
      'invalid_library_selection',
      'Selection keys must be unique exact snapshot item keys.',
    );
  const requestedSet = new Set(requested);
  const selected = snapshot.items.filter((item) => requestedSet.has(item.key));
  if (selected.length !== requested.length)
    throw new LibraryExploreError(
      400,
      'invalid_library_selection',
      'Every selected key must belong to the supplied current snapshot.',
    );
  return {
    schema_version: 'signals-library-selection-v1' as const,
    snapshot: snapshot.snapshot,
    keys: selected.map((item) => item.key),
    records: selected.map((item) => item.record),
  };
}
