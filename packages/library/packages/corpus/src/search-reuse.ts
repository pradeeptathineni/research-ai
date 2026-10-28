import { createLibraryIndex } from '../../domain/src/library-search.js';
import type { Entity, SearchRequest, Source } from '../../domain/src/search-contract.js';
import { activeObservations } from '../../domain/src/search-score.js';
import { normalizeConsiderUrl } from '../../domain/src/url.js';
import { loadResearchLibrary } from './library.js';
import { fetchEvidence } from './search-fetch.js';
import { currentHtmlText } from '../../domain/src/source-text.js';

const recordLimit = 5;
const textLimit = 12000;
type NativeFact = ReturnType<typeof sourceFacts>[number];
type RetainedFact = Omit<NativeFact, 'status' | 'source'> & {
  status: string;
  freshness?: 'current' | 'due' | 'unknown';
  source: Omit<NativeFact['source'], 'publisher' | 'origin'> & {
    publisher: string | null | undefined;
    origin: string | null | undefined;
  };
};

function sourceFacts(entity: Entity) {
  return activeObservations(entity, entity.assessment.policy)
    .filter(
      (observation) =>
        observation.verified && ['supported', 'contradicted'].includes(observation.status),
    )
    .flatMap((observation) => {
      const source = entity.evidence.find((item) => item.id === observation.evidenceId);
      if (
        !source ||
        source.state !== 'fetched' ||
        source.reason === 'provider_final_identity_unverified'
      )
        return [];
      try {
        normalizeConsiderUrl(source.uri);
      } catch {
        return [];
      }
      return [
        {
          observationId: observation.id,
          feature: observation.feature,
          status: observation.status,
          statement: observation.statement,
          quote: observation.quote,
          independent: observation.independent,
          source: {
            evidenceId: source.id,
            uri: source.uri,
            title: source.title,
            publisher: source.publisher,
            origin: source.origin,
            publishedAt: source.publishedAt,
            fetchedAt: source.fetchedAt,
          },
        },
      ];
    });
}

/** Read-only lexical reuse of bound public-source observations, never personal/runtime state. */
export async function researchCorpusSlice(request: SearchRequest, root: string) {
  const slice = {
    kind: 'retained-source-observations' as const,
    method: 'lexical' as const,
    records: [] as {
      id: string;
      key: string;
      name: string;
      uri: string;
      kind: string;
      assessmentAsOf: string;
      facts: RetainedFact[];
      omittedFacts: number;
    }[],
    gaps: [] as string[],
  };
  const loaded = await loadResearchLibrary(root);
  slice.gaps.push(...loaded.gaps);
  const records = loaded.findings;
  const candidates = records.map((finding) => ({
    finding,
    facts: finding.native
      ? sourceFacts(finding.native)
      : (finding.legacy?.claims ?? [])
          .filter((claim) => ['supported', 'observed', 'contradicted'].includes(claim.status))
          .flatMap((claim) =>
            claim.source_ids.flatMap((id) => {
              const source = finding.legacy!.sources.find((source) => source.id === id);
              if (!source) return [];
              return [
                {
                  observationId: claim.id,
                  feature: 'historical-claim',
                  status: claim.status,
                  statement: claim.text,
                  quote: '',
                  independent: false,
                  source: {
                    evidenceId: source.id,
                    uri: source.uri,
                    title: source.title,
                    publisher: source.independence_group ?? null,
                    origin: source.independence_group ?? null,
                    publishedAt: source.observed_at ?? null,
                    fetchedAt: finding.legacy!.reviewedAt,
                  },
                  freshness: claim.freshness,
                },
              ];
            }),
          ),
  }));
  const factsByKey = new Map(
    candidates.filter((item) => item.facts.length).map((item) => [item.finding.key, item.facts]),
  );
  // The Library's lexical rules (function words, inflection, coverage) over title and retained facts.
  const hits = createLibraryIndex(
    candidates.filter((item) => factsByKey.has(item.finding.key)).map((item) => item.finding),
    (finding) =>
      factsByKey
        .get(finding.key)!
        .map((fact) => `${fact.statement} ${fact.quote} ${fact.source.title}`),
  )
    .search(`${request.query} ${request.context ?? ''}`, {}, ['title', 'evidenceText'])
    .filter((hit) => hit.matchedTerms.length);
  if (!hits.length)
    slice.gaps.push(
      `No record with eligible retained facts lexically matched the request among ${factsByKey.size} searched; absence here is not evidence that none exists.`,
    );
  for (const { finding } of hits) {
    if (slice.records.length >= recordLimit) break;
    const facts = factsByKey.get(finding.key)!;
    const selected = [...facts]
      .sort(
        (a, b) =>
          Number(b.feature === 'defining') - Number(a.feature === 'defining') ||
          Number(b.status === 'contradicted' || b.feature === 'risk') -
            Number(a.status === 'contradicted' || a.feature === 'risk'),
      )
      .slice(0, 6);
    const projection = {
      id: finding.id,
      key: finding.key,
      name: finding.title,
      uri: finding.uri,
      kind: finding.kind,
      assessmentAsOf: finding.observedAt ?? '',
      facts: selected,
      omittedFacts: facts.length - selected.length,
    };
    while (
      projection.facts.length &&
      JSON.stringify({ ...slice, records: [...slice.records, projection] }).length > textLimit
    ) {
      projection.facts.pop();
      projection.omittedFacts++;
    }
    if (projection.facts.length) slice.records.push(projection);
  }
  if (hits.length > slice.records.length)
    slice.gaps.push(
      'Saved-knowledge context is a bounded lexical slice; remaining matching records were not supplied.',
    );
  // Reserve room for the bounded-slice gap without truncating statements or source spans.
  while (JSON.stringify(slice).length > textLimit) slice.records.pop();
  return slice;
}

function checkablePrimary(entity: Entity): Source | undefined {
  const defining = new Set(
    activeObservations(entity, entity.assessment.policy)
      .filter(
        (observation) =>
          observation.verified &&
          observation.feature === 'defining' &&
          observation.status === 'supported',
      )
      .map((observation) => observation.evidenceId),
  );
  return entity.evidence.find(
    (source) =>
      defining.has(source.id) &&
      source.state === 'fetched' &&
      source.reason !== 'provider_final_identity_unverified' &&
      (source.family === 'primary' || source.role === 'primary'),
  );
}

/** A primary hash check says only whether that material changed; it never renews claims. */
export async function checkPrimaryMaterial(
  entity: Entity,
  options: { fetch?: typeof fetchEvidence; signal?: AbortSignal } = {},
) {
  options.signal?.throwIfAborted();
  const source = checkablePrimary(entity);
  const base = {
    kind: 'primary-material-check' as const,
    entityId: entity.id,
    source: source ? structuredClone(source) : null,
    checkedAt: new Date().toISOString(),
    claimsRenewed: false as const,
    independentChangesChecked: false as const,
    modelCalls: 0,
  };
  if (!source?.digest)
    return {
      ...base,
      status: 'not-checkable' as const,
      reason: 'No bound defining primary material is available.',
      material: null,
    };
  try {
    normalizeConsiderUrl(source.uri);
    const material = await (options.fetch ?? fetchEvidence)(source.uri, options.signal, 0, false, {
      conditional: source.normalizer === currentHtmlText ? source.transport : undefined,
      allowNotModified:
        source.normalizer === currentHtmlText && !!source.transport && !!source.digest,
    });
    options.signal?.throwIfAborted();
    const expected = normalizeConsiderUrl(source.finalUri ?? source.uri).normalizedUrl;
    if (
      material.identityUnverified ||
      normalizeConsiderUrl(material.uri).normalizedUrl !== expected
    )
      return {
        ...base,
        status: 'identity-changed' as const,
        reason:
          'The fetched primary identity is changed or unverified; interpretation is required.',
        material,
      };
    if (material.response?.status === 304 && source.normalizer !== currentHtmlText)
      return {
        ...base,
        status: 'changed' as const,
        reason:
          'Transport is unchanged, but the retained representation is not current. A body is required before renewing any check.',
        material,
      };
    const unchanged =
      (material.response?.status === 304 && source.normalizer === currentHtmlText) ||
      (source.digest === material.digest && source.normalizer === material.normalizer);
    return {
      ...base,
      status: unchanged ? ('unchanged' as const) : ('changed' as const),
      reason: unchanged
        ? 'This primary material is unchanged. Retained claims keep their original dates; independent developments were not checked.'
        : 'Primary material or its text representation changed; interpretation is required.',
      material,
    };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const reason =
      error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
        ? error.message
        : 'primary_material_check_failed';
    return { ...base, status: 'failed' as const, reason, material: null };
  }
}
