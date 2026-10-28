import { randomUUID } from 'node:crypto';
import {
  budgets,
  channels,
  parseProposal,
  parseRequest,
  type SearchResult,
  type SearchRequest,
  type Source,
  type Entity,
  type Proposal,
  type SearchItem,
  type ProvisionalLead,
} from '../../domain/src/search-contract.js';
import { normalizeConsiderUrl } from '../../domain/src/url.js';
import { assessEntity, filterSearchItems, saveDecision } from '../../domain/src/search-score.js';
import {
  digest,
  fetchEvidence,
  normalizeText,
  normalizeSpan,
  boundedTextReceipt,
} from './search-fetch.js';
import { materialOmissions } from './search-document.js';
import {
  codexRunner,
  answerFirstOperation,
  RunnerFailure,
  type SearchRunner,
  type EnrichmentMaterial,
} from './search-runner.js';
import { privateCacheFetch } from './search-cache.js';
import { runClaimCheck } from './search-claim.js';
import type { SelectedPrimaryProducer } from './search-selected-source.js';
import { atomicJson, saveEntities, retainRun, loadEntities, loadRun } from './search-store.js';
import { planResearchRetention } from './research-answer.js';
import {
  checkSuggestions,
  offeredPayload,
  rejectedSuggestionsSchema,
} from '../../domain/src/search-suggestions.js';
import { resolve } from 'node:path';
import { loadAcquisitionConfig, type AcquisitionConfig } from './search-acquisition.js';
import { configuredDocumentFetch } from './search-extractors.js';
import { contextualize, entityDelta } from '../../domain/src/search-priority.js';
import { loadPersonal } from './search-personal.js';
import { loadSettings } from './search-settings.js';
import { updateInbox } from './search-inbox.js';
import { recordSourceResultExposures } from './search-sources.js';
import { decodeNativeResearch } from '../../domain/src/search-native.js';
import type { AcquisitionHints, ResearchObserver } from './search-runner.js';
import { dimensionNames, type SignalBasis } from '../../domain/src/search-assessment.js';

function entityUri(uri: string) {
  return `${normalizeConsiderUrl(uri).normalizedUrl}${new URL(uri).hash}`;
}
export function entityIdentity(uri: string) {
  const normalized = normalizeConsiderUrl(uri);
  const repository =
    normalized.hostname === 'github.com' &&
    !new URL(uri).hash &&
    new URL(normalized.normalizedUrl).pathname.split('/').filter(Boolean).length === 2;
  return `entity-${digest(repository && normalized.strongIdentity ? `github:${normalized.strongIdentity.value}` : entityUri(uri)).slice(0, 24)}`;
}
export function reconcileDiscoveryTrail(
  candidate: Pick<Proposal['candidates'][number], 'uri' | 'name' | 'aliases' | 'discovery'>,
  request: SearchRequest,
  linkVerified: boolean,
  followedSources: string[] = [],
  gaps: string[] = [],
): SearchItem['discovery'] {
  const uri = candidate.uri;
  const id = entityIdentity(uri);
  const parent = candidate.discovery?.parentUri
    ? normalizeConsiderUrl(candidate.discovery.parentUri).normalizedUrl
    : undefined;
  const captured = request.captureUrls?.some((seed) => entityIdentity(seed) === id) ?? false;
  const configuredParent =
    !!parent &&
    followedSources.some(
      (source) =>
        normalizeConsiderUrl(source).normalizedUrl === normalizeConsiderUrl(parent).normalizedUrl,
    );
  const words = (text: string) =>
    ` ${text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()} `;
  const query = candidate.discovery?.query ?? '';
  const target = new URL(uri);
  const named =
    !!query &&
    ([candidate.name, ...candidate.aliases].some(
      (name) => name.trim().length > 3 && words(query).includes(words(name)),
    ) ||
      query
        .toLowerCase()
        .includes(
          `${target.hostname}${target.pathname === '/' ? '' : target.pathname}`.toLowerCase(),
        ));
  let introducedBy = captured ? ('user-seeded' as const) : candidate.discovery?.introducedBy;
  if (
    (introducedBy === 'followed-source' && !configuredParent) ||
    (introducedBy === 'unseeded-query' && named)
  ) {
    const gap = `${candidate.name}: model-reported discovery mechanism not substantiated; retained as model-nominated.`;
    if (!gaps.includes(gap)) gaps.push(gap);
    introducedBy = 'model-nominated';
  }
  const discovery = introducedBy
    ? {
        ...candidate.discovery,
        ...(parent ? { parentUri: parent } : {}),
        introducedBy,
        linkVerified,
        provenanceBasis: captured
          ? ('request-seed' as const)
          : introducedBy === 'followed-source' && configuredParent
            ? ('configured-source' as const)
            : linkVerified
              ? ('matched-outlink' as const)
              : ('model-report' as const),
        ...(candidate.discovery && candidate.discovery.introducedBy !== introducedBy
          ? { proposedIntroducedBy: candidate.discovery.introducedBy }
          : {}),
      }
    : undefined;
  return discovery;
}

export function observationIdentity(
  entityId: string,
  evidenceId: string,
  observation: Omit<Proposal['candidates'][number]['observations'][number], 'source'> & {
    identityVersion?: 2;
  },
  basisEvidenceId = evidenceId,
  literal = false,
) {
  const quote = literal ? normalizeSpan(observation.quote) : normalizeText(observation.quote);
  const basisId = `basis-${digest(`${entityId}:${basisEvidenceId}:${observation.feature}:${quote.toLowerCase()}`).slice(0, 24)}`;
  return {
    basisId,
    id: `observation-${digest(`${basisId}:${observation.indicator}:${observation.status}:${observation.independent}:${observation.origin.trim().toLowerCase()}${basisEvidenceId === evidenceId ? '' : `:${evidenceId}`}${observation.attention ? `:${observation.attention.metric}:${observation.attention.value}` : ''}${observation.identityVersion === 2 ? `:claim-v2:${normalizeSpan(observation.statement).toLowerCase()}` : ''}`).slice(0, 24)}`,
  };
}

export async function acceptDiscovery(
  input: unknown,
  request: SearchRequest,
  dependencies: {
    signal?: AbortSignal;
    fetch?: typeof fetchEvidence;
    asOf?: string;
    evidenceClass?: Entity['acquisition'];
    followedSources?: string[];
    progress?: (event: string) => void;
    enrich?: (proposal: Proposal, material: EnrichmentMaterial[]) => Promise<Proposal>;
  } = {},
) {
  const research = decodeNativeResearch(input);
  let proposal = structuredClone(research.proposal);
  if (request.interpretation) {
    if (JSON.stringify(proposal.interpretation) !== JSON.stringify(request.interpretation)) {
      proposal.gaps.push(
        'Returned interpretation differs from the requested correction; prior relevance judgments are held until assessed against the corrected need.',
      );
      proposal.candidates.forEach((candidate) => {
        if (candidate.relevance)
          candidate.relevance = {
            ...candidate.relevance,
            value: null,
            reason: 'Needs reassessment against the explicitly corrected interpretation.',
          };
      });
    }
    proposal.interpretation = request.interpretation;
  }
  let asOf = dependencies.asOf ?? new Date().toISOString();
  const limits = budgets[request.profile ?? 'wide'];
  const compact = research.brief !== undefined;
  if (
    !compact &&
    (proposal.coverage.some((item) => item.searches > limits.searches) ||
      proposal.sources.length > limits.documents ||
      proposal.candidates.length > limits.entities)
  )
    throw new Error('budget_exhausted');
  const gaps = [...proposal.gaps];
  if (compact && proposal.coverage.some((item) => item.searches > limits.searches))
    gaps.push(
      'Reported search coverage exceeded the selected budget; acquisition counts are unverified.',
    );
  if (compact && proposal.candidates.length > limits.entities) {
    research.provisionalLeads.push(
      ...proposal.candidates.slice(limits.entities).map(({ uri, name, description, limits }) => ({
        uri,
        name,
        description,
        limits: [...limits, 'Candidate inspection budget exhausted; retained without admission.'],
      })),
    );
    proposal.candidates = proposal.candidates.slice(0, limits.entities);
    gaps.push('Candidate inspection budget exhausted; remaining leads are unassessed.');
  }
  const acquisitionGapCount = gaps.length;
  const sources: Source[] = [];
  const documents = new Map<string, Awaited<ReturnType<typeof fetchEvidence>>>();
  let documentActions = 0;
  const inspect = new Set<number>();
  if (request.route === 'native') {
    for (const candidate of proposal.candidates) {
      // Every claimed fact must still be checked, including adverse/rejected findings.
      candidate.observations.forEach((observation) => inspect.add(observation.source));
      candidate.relevance?.sources.forEach((index) => inspect.add(index));
      candidate.signalJudgment?.originInspections?.forEach((inspection) =>
        inspect.add(inspection.source),
      );
      candidate.relevance?.constraints.forEach((constraint) =>
        constraint.sources.forEach((index) => inspect.add(index)),
      );
      if (candidate.priority?.action !== 'reject' && candidate.match.level !== 'out-of-scope') {
        candidate.match.sources.forEach((index) => inspect.add(index));
        candidate.priority?.sources.forEach((index) => inspect.add(index));
      }
      if (candidate.discovery?.parentUri) {
        const parent = normalizeConsiderUrl(candidate.discovery.parentUri).normalizedUrl;
        proposal.sources.forEach((source, index) => {
          try {
            if (normalizeConsiderUrl(source.uri).normalizedUrl === parent) inspect.add(index);
          } catch {
            /* invalid source is handled below */
          }
        });
      }
    }
    // A small rejected-lead audit, rather than exhaustive inspection of unused locators.
    const audit = proposal.candidates.find((candidate) => candidate.priority?.action === 'reject');
    audit?.match.sources.slice(0, 1).forEach((index) => inspect.add(index));
  }
  for (const source of proposal.sources) {
    let uri: string;
    try {
      uri = normalizeConsiderUrl(source.uri).normalizedUrl;
    } catch {
      uri = '';
    }
    const accepted: Source = {
      ...source,
      uri: uri || source.uri,
      id: `evidence-${digest(uri || source.uri).slice(0, 24)}`,
      fetchedAt: asOf,
      digest: null,
      state: 'failed',
      reason: '',
      excerpt: '',
    };
    try {
      if (!uri) throw new Error('source_url_denied');
      if (request.sources && !request.sources.includes(source.family))
        throw new Error('source_channel_disabled');
      if (
        source.publishedAt &&
        (!Number.isFinite(Date.parse(source.publishedAt)) ||
          Date.parse(source.publishedAt) > Date.parse(asOf))
      )
        throw new Error('invalid_source_date');
      dependencies.signal?.throwIfAborted();
      if (request.route === 'native' && !inspect.has(sources.length)) {
        accepted.reason = 'native_inspection_deferred';
        sources.push(accepted);
        continue;
      }
      if (!documents.has(uri) && documentActions >= limits.documents)
        throw new Error('document_inspection_budget_exhausted');
      if (!documents.has(uri)) documentActions++;
      dependencies.progress?.(`Fetching ${new URL(uri).hostname}`);
      const fetched =
        documents.get(uri) ??
        (await (dependencies.fetch ?? fetchEvidence)(uri, dependencies.signal));
      documents.set(uri, fetched);
      accepted.state = 'fetched';
      accepted.digest = fetched.digest;
      accepted.finalUri = fetched.uri;
      if (fetched.response?.etag || fetched.response?.lastModified)
        accepted.transport = {
          etag: fetched.response.etag,
          lastModified: fetched.response.lastModified,
        };
      normalizeConsiderUrl(fetched.uri);
      if (fetched.material) accepted.extractor = fetched.material.extractor;
      if (fetched.normalizer) accepted.normalizer = fetched.normalizer;
      if ('cached' in fetched && fetched.cached) accepted.reason = 'private-cache-hit';
      if ('identityUnverified' in fetched && fetched.identityUnverified) {
        accepted.reason = 'provider_final_identity_unverified';
        gaps.push(`${source.title}: provider final source identity unverified`);
      }
      if (fetched.truncated) gaps.push(`${source.title}: provider document truncated`);
      gaps.push(
        ...materialOmissions(fetched.material).map((omission) => `${source.title}: ${omission}`),
      );
      const accessFailure =
        /retrieval (?:failed|errors?)|could not be retrieved|inaccessible|could not (?:fetch|access)|not accessible/i;
      const stale =
        accessFailure.test(source.title) ||
        proposal.gaps.some(
          (gap) =>
            accessFailure.test(gap) &&
            (gap.includes(source.uri) ||
              gap.includes(source.title) ||
              proposal.candidates.some(
                (candidate) =>
                  gap.toLowerCase().includes(candidate.name.toLowerCase()) &&
                  (candidate.match.sources.includes(sources.length) ||
                    candidate.observations.some(
                      (observation) => observation.source === sources.length,
                    )),
              )),
        );
      if (stale) {
        if (!accepted.reason) accepted.reason = 'kernel_fetched_model_assessment_stale';
        gaps.push(
          `${source.title}: kernel fetched successfully; earlier model access/assessment remains stale. Inspect fetched material; no automatic reinterpretation or rescore.${fetched.material?.publishedAt ? ` Extracted publication metadata: ${fetched.material.publishedAt}.` : ''}`,
        );
      }
      if ('fetchedAt' in fetched && typeof fetched.fetchedAt === 'string')
        accepted.fetchedAt = fetched.fetchedAt;
      accepted.id = `evidence-${digest(`${uri}:${fetched.digest}`).slice(0, 24)}`;
    } catch (failure) {
      accepted.reason = failure instanceof Error ? failure.message : 'source_failed';
      if (accepted.reason === 'invalid_source_date') accepted.publishedAt = null;
      if (/denied|blocked|forbidden/.test(accepted.reason)) accepted.state = 'denied';
      gaps.push(`${source.title}: ${accepted.reason}`);
    }
    sources.push(accepted);
  }
  if (dependencies.enrich && !dependencies.signal?.aborted) {
    const allowance = Math.floor(48000 / Math.max(1, documents.size));
    const material = sources.flatMap((source, index) => {
      const document = documents.get(source.uri);
      const text = document?.text;
      const omissions = materialOmissions(document?.material);
      if (!text) return [];
      if (text.length <= allowance)
        return [{ index, uri: source.uri, text, ...(omissions.length ? { omissions } : {}) }];
      const mentions = proposal.candidates.filter(
        (candidate) =>
          candidate.match.sources.includes(index) ||
          candidate.observations.some((observation) => observation.source === index),
      );
      const locations = mentions
        .flatMap((candidate) => [
          ...candidate.observations
            .filter((observation) => observation.source === index)
            .map((observation) =>
              text.toLowerCase().indexOf(normalizeSpan(observation.quote).toLowerCase()),
            ),
          text.toLowerCase().lastIndexOf(candidate.name.toLowerCase()),
        ])
        .filter((location) => location >= 0);
      const anchored = [
        ...[...new Set(locations)]
          .slice(0, 5)
          .map((location) => text.slice(Math.max(0, location - 100), location + 700)),
      ]
        .join(' … ')
        .slice(0, Math.floor(allowance * 0.4));
      const remaining = Math.max(0, allowance - anchored.length - 40);
      const width = Math.floor(remaining / 5);
      const windows = Array.from({ length: 5 }, (_, index) => {
        const start = Math.floor(((text.length - width) * index) / 4);
        return text.slice(start, start + width);
      });
      const excerpts = [anchored, ...windows].filter(Boolean).join(' … ').slice(0, allowance);
      const windowGap = `${source.title}: frozen review receives selected passages, not the whole normalized document.`;
      gaps.push(windowGap);
      return [{ index, uri: source.uri, text: excerpts, omissions: [...omissions, windowGap] }];
    });
    try {
      const key = (candidate: Proposal['candidates'][number]) => {
        try {
          return entityUri(candidate.uri);
        } catch {
          return candidate.uri;
        }
      };
      const counts = new Map<string, number>();
      for (const candidate of proposal.candidates)
        counts.set(key(candidate), (counts.get(key(candidate)) ?? 0) + 1);
      const reviewable = proposal.candidates.filter(
        (candidate) => counts.get(key(candidate)) === 1,
      );
      const unresolved = proposal.candidates.filter(
        (candidate) => counts.get(key(candidate)) !== 1,
      );
      proposal = reviewable.length
        ? parseProposal(
            await dependencies.enrich({ ...proposal, candidates: reviewable }, material),
          )
        : { ...proposal, candidates: [] };
      proposal = {
        ...proposal,
        candidates: [
          ...proposal.candidates,
          ...unresolved.map((candidate) => ({ ...candidate, observations: [] })),
        ],
        gaps: unresolved.length
          ? [
              ...proposal.gaps,
              'Repeated candidate identities require resolution before feature review.',
            ]
          : proposal.gaps,
      };
      // Review can resolve preliminary uncertainty, but cannot erase actual fetch failures.
      gaps.splice(0, acquisitionGapCount, ...proposal.gaps);
    } catch (failure) {
      gaps.push(
        `Grounded extraction unavailable: ${failure instanceof Error ? failure.message : 'failed'}`,
      );
      // A requested second assessment cannot erase the original source-bound research.
    }
  }
  // An immutable evidence projection includes its selected spans. The same raw document
  if (!dependencies.asOf) asOf = new Date().toISOString();
  // can later support new spans without overwriting the earlier public evidence bytes.
  sources.forEach((source) => {
    if (source.state !== 'fetched') return;
    const text = documents.get(source.uri)?.text.toLowerCase() ?? '';
    const quotes = proposal.candidates
      .flatMap((candidate) => [
        ...candidate.observations
          .filter((observation) => sources[observation.source]?.uri === source.uri)
          .map((observation) => normalizeSpan(observation.quote)),
        ...(candidate.signalJudgment?.originInspections ?? [])
          .filter((inspection) => sources[inspection.source]?.uri === source.uri)
          .map((inspection) => normalizeSpan(inspection.quote)),
      ])
      .filter((quote) => quote.length >= 8 && text.includes(quote.toLowerCase()));
    const excerpt = [...new Set(quotes)].sort().join(' … ');
    source.excerpt = excerpt.slice(0, 12000);
    if (excerpt.length > 12000) gaps.push(`${source.title}: verified excerpt budget exhausted`);
    source.excerptDigest = digest(source.excerpt);
    source.id = `evidence-${digest(`${source.uri}:${source.digest}:${source.excerptDigest}${source.normalizer ? `:${source.normalizer}` : ''}`).slice(0, 24)}`;
  });
  const entities = new Map<
    string,
    {
      entity: Entity;
      match: Proposal['candidates'][number]['match'];
      discovery?: SearchResult['items'][number]['discovery'];
      priority?: SearchResult['items'][number]['priority'];
      relevance?: SearchItem['relevance'];
    }
  >();
  let duplicates = 0,
    omitted = 0;
  const safeEvidence = new Set(
    sources.flatMap((source) => {
      try {
        normalizeConsiderUrl(source.uri);
        return [source.id];
      } catch {
        return [];
      }
    }),
  );
  for (const candidate of proposal.candidates) {
    let uri: string;
    try {
      uri = entityUri(candidate.uri);
    } catch {
      gaps.push(`Invalid identity: ${candidate.name}`);
      omitted++;
      continue;
    }
    const id = entityIdentity(uri);
    const observations = candidate.observations
      .filter((observation) => safeEvidence.has(sources[observation.source]!.id))
      .map((observation) => {
        const { source: index, ...fields } = observation;
        const source = sources[index]!;
        const quote = normalizeSpan(observation.quote);
        const text = documents.get(source.uri)?.text ?? '';
        const verified =
          source.state === 'fetched' &&
          quote.length >= 8 &&
          text.toLowerCase().includes(quote.toLowerCase()) &&
          source.excerpt.toLowerCase().includes(quote.toLowerCase());
        return {
          ...fields,
          identityVersion: 2 as const,
          ...observationIdentity(
            id,
            source.id,
            { ...observation, identityVersion: 2 },
            source.excerptDigest
              ? `evidence-${digest(`${source.uri}:${source.digest}${source.normalizer ? `:${source.normalizer}` : ''}`).slice(0, 24)}`
              : source.id,
            true,
          ),
          supersedes: [],
          derivation: 'model-assessment' as const,
          evidenceId: source.id,
          verified,
        };
      });
    const evidenceIds = new Set([
      ...observations.map((item) => item.evidenceId),
      ...candidate.match.sources
        .map((index) => sources[index]?.id)
        .filter((id): id is string => !!id),
      ...(candidate.signalJudgment?.originInspections ?? []).flatMap((inspection) =>
        sources[inspection.source] ? [sources[inspection.source]!.id] : [],
      ),
    ]);
    const evidence = [
      ...new Map(
        sources.filter((source) => evidenceIds.has(source.id)).map((source) => [source.id, source]),
      ).values(),
    ];
    const currentEvidence = [
      ...new Map(
        evidence
          .filter((source) => source.state === 'fetched')
          .map((source) => [source.uri, source.id]),
      ).values(),
    ].sort();
    const currentChecks = Object.fromEntries(
      evidence
        .filter((source) => source.state === 'fetched')
        .map((source) => [source.uri, source.fetchedAt]),
    );
    const signalBasis: SignalBasis | undefined = candidate.signalJudgment
      ? ({
          ...candidate.signalJudgment,
          gaps: [...candidate.signalJudgment.gaps],
          ...(candidate.signalJudgment.originInspections
            ? {
                originInspections: candidate.signalJudgment.originInspections.flatMap(
                  (inspection) =>
                    sources[inspection.source] && safeEvidence.has(sources[inspection.source]!.id)
                      ? [{ ...inspection, source: sources[inspection.source]!.id }]
                      : [],
                ),
              }
            : {}),
          dimensions: Object.fromEntries(
            dimensionNames.map((key) => {
              const judgment = candidate.signalJudgment!.dimensions[key];
              const ids = judgment.observations.flatMap((index) => {
                const original = candidate.observations[index];
                const retained =
                  original &&
                  observations.find(
                    (item) =>
                      item.evidenceId === sources[original.source]?.id &&
                      item.feature === original.feature &&
                      item.indicator === original.indicator &&
                      item.statement === original.statement &&
                      item.quote === original.quote,
                  );
                return retained ? [retained.id] : [];
              });
              return [
                key,
                {
                  ...judgment,
                  observations: [...new Set(ids)],
                  ...(ids.length !== judgment.observations.length ? { level: null } : {}),
                },
              ];
            }),
          ),
        } as SignalBasis)
      : undefined;
    if (
      signalBasis &&
      dimensionNames.some(
        (key) =>
          signalBasis.dimensions[key].level !== candidate.signalJudgment!.dimensions[key].level,
      )
    )
      signalBasis.gaps.push({
        reason: 'Rubric observation was excluded by the safe evidence boundary.',
        decisive: true,
        nextVerification: 'Inspect and bind the omitted observation to a safe original source.',
      });
    const entity: Entity = {
      ...candidate,
      uri,
      id,
      acquisition: dependencies.evidenceClass ?? (dependencies.fetch ? 'fixture' : 'native-agent'),
      observations,
      evidence,
      currentEvidence,
      currentChecks,
      ...(signalBasis ? { signalBasis } : {}),
      assessment: assessEntity(
        {
          observations,
          evidence,
          currentEvidence,
          currentChecks,
          kind: candidate.kind,
          identity: candidate.identity,
          uri,
          ...(signalBasis ? { signalBasis } : {}),
        },
        asOf,
        proposal.assessmentPolicy ??
          (candidate.signalJudgment ? 'signal-strength-v7' : 'signal-strength-v6'),
      ),
    };
    // Query-dependent fields never enter the reusable entity.
    const canonical = Object.fromEntries(
      Object.entries(entity).filter(
        ([key]) => !['match', 'discovery', 'priority', 'relevance', 'signalJudgment'].includes(key),
      ),
    ) as unknown as Entity;
    if (entities.has(id)) {
      duplicates++;
      gaps.push(`Duplicate candidate merged: ${candidate.name}`);
      const prior = entities.get(id)!;
      const name = (value: string) => value.trim().toLowerCase();
      const sameName =
        name(prior.entity.name) === name(candidate.name) ||
        candidate.aliases.some((alias) => name(alias) === name(prior.entity.name)) ||
        prior.entity.aliases.some((alias) => name(alias) === name(candidate.name));
      if (prior.entity.kind !== candidate.kind || !sameName) {
        prior.entity.identity = 'ambiguous';
        prior.entity.limits.push(
          `Unresolved lead sharing this URI: ${candidate.name} (${candidate.kind}). Resolve separate resource identities before saving.`,
        );
      }
      prior.entity.observations = [
        ...new Map(
          [...prior.entity.observations, ...observations].map((item) => [item.id, item]),
        ).values(),
      ];
      prior.entity.evidence = [
        ...new Map(
          [...prior.entity.evidence, ...entity.evidence].map((item) => [item.id, item]),
        ).values(),
      ];
      prior.entity.currentEvidence = [
        ...new Set([...(prior.entity.currentEvidence ?? []), ...(entity.currentEvidence ?? [])]),
      ].sort();
      prior.entity.assessment = assessEntity(prior.entity, asOf, prior.entity.assessment.policy);
    } else {
      const requiredConstraints = new Set(
        proposal.interpretation?.constraints
          .filter((item) => item.required)
          .map((item) => item.text),
      );
      const parent = candidate.discovery?.parentUri
        ? normalizeConsiderUrl(candidate.discovery.parentUri).normalizedUrl
        : undefined;
      const linkVerified =
        !!parent &&
        !!documents.get(parent)?.material?.links.some((link) => entityIdentity(link.uri) === id);
      if (parent && !linkVerified)
        gaps.push(`${candidate.name}: introducing parent link not verified in fetched material`);
      const discovery = reconcileDiscoveryTrail(
        { ...candidate, uri },
        request,
        linkVerified,
        dependencies.followedSources,
        gaps,
      );
      entities.set(id, {
        entity: canonical,
        match: candidate.match,
        ...(candidate.relevance
          ? {
              relevance: {
                ...candidate.relevance,
                value:
                  !proposal.interpretation ||
                  !candidate.relevance.sources.length ||
                  candidate.relevance.sources.some((index) => sources[index]?.state !== 'fetched')
                    ? null
                    : candidate.relevance.constraints.some(
                          (item) =>
                            requiredConstraints.has(item.text) &&
                            item.state === 'conflicts' &&
                            item.sources.length &&
                            item.sources.every((index) => sources[index]?.state === 'fetched'),
                        )
                      ? 0
                      : candidate.relevance.value === 100 &&
                          (candidate.relevance.constraints.some(
                            (item) =>
                              requiredConstraints.has(item.text) &&
                              (item.state !== 'satisfied' ||
                                !item.sources.length ||
                                item.sources.some((index) => sources[index]?.state !== 'fetched')),
                          ) ||
                            proposal.interpretation.constraints
                              .filter((item) => item.required)
                              .some(
                                (required) =>
                                  !candidate.relevance!.constraints.some(
                                    (item) =>
                                      item.text === required.text && item.state === 'satisfied',
                                  ),
                              ))
                        ? 50
                        : candidate.relevance.value,
              },
            }
          : [
                'signal-strength-v7',
                'signal-strength-v8',
                'signal-strength-v9',
                'signal-strength-v10',
              ].includes(proposal.assessmentPolicy ?? '')
            ? {
                relevance: {
                  value: null,
                  reason: 'No supported query relevance assessment returned.',
                  sources: [],
                  constraints: [],
                },
              }
            : {}),
        ...(candidate.priority
          ? {
              priority: {
                ...candidate.priority,
                policy: 'contextual-priority-v1',
                score: null,
                novelty: 'unknown',
                personalNovelty: 'unknown',
                feedback: 'none',
                evidenceIds: candidate.priority.sources.map((index) => sources[index]!.id),
              },
            }
          : {}),
        ...(discovery ? { discovery } : {}),
      });
    }
  }
  const items = filterSearchItems(
    [...entities.values()].map(({ entity, match, discovery, priority, relevance }) => ({
      entity,
      match,
      ...(relevance ? { relevance } : {}),
      ...(discovery ? { discovery } : {}),
      ...(priority ? { priority } : {}),
      ...saveDecision(entity, match, request.threshold ?? 75),
    })),
  );
  const coverage = channels.map(
    (channel) =>
      proposal.coverage.find((item) => item.channel === channel) ?? {
        channel,
        state: 'skipped' as const,
        searches: 0,
        reason: 'Runner did not report acquisition for this channel.',
      },
  );
  return {
    ...(proposal.interpretation ? { interpretation: proposal.interpretation } : {}),
    ...(research.brief ? { brief: research.brief } : {}),
    ...(research.provisionalLeads.length ? { provisionalLeads: research.provisionalLeads } : {}),
    items,
    sources,
    coverage,
    gaps,
    counts: {
      leads: proposal.candidates.length + research.provisionalLeads.length,
      distinct: items.length,
      duplicates,
      omitted: omitted + research.provisionalLeads.length,
    },
  };
}

export async function signalSearch(
  input: unknown,
  dependencies: {
    runner?: SearchRunner;
    claimRunner?: (task: string, schema: unknown) => SearchRunner;
    selectedPrimary?: SelectedPrimaryProducer;
    signal?: AbortSignal;
    progress?: (event: string) => void;
    activity?: ResearchObserver;
    provisional?: (leads: ProvisionalLead[]) => void;
    brief?: (brief: { format: 'markdown'; text: string }) => void;
    fetch?: typeof fetchEvidence;
    root?: string;
    acquisitionHints?: AcquisitionHints;
    acquisition?: AcquisitionConfig;
  } = {},
): Promise<SearchResult> {
  const request = { ...parseRequest(input), route: 'native' as const };
  if (request.claimText !== undefined) return runClaimCheck(request, dependencies);
  if (request.method === 'answer-first' && (request.save === 'eligible' || request.assessmentOf))
    throw new Error('answer_first_is_unassessed');
  if (request.assessmentOf) {
    const original = await loadRun(request.assessmentOf, dependencies.root ?? process.cwd());
    if (
      !original.answerReceipt ||
      !request.captureUrls?.length ||
      request.captureUrls.some(
        (uri) => !original.provisionalLeads?.some((lead) => lead.uri === uri),
      )
    )
      throw new Error('assessment_selection_not_cited');
  }
  const started = Date.now();
  const monotonicStarted = performance.now();
  const limits = budgets[request.profile ?? 'wide'];
  const controller = new AbortController();
  let stoppedBy: 'deadline' | 'external' | null = null;
  const abort = () => {
    stoppedBy ??= 'external';
    controller.abort();
  };
  dependencies.signal?.addEventListener('abort', abort, { once: true });
  if (dependencies.signal?.aborted) abort();
  const timer = setTimeout(() => {
    stoppedBy ??= 'deadline';
    controller.abort();
  }, limits.seconds * 1000);
  const base: SearchResult = {
    schemaVersion: 2,
    runId: randomUUID(),
    query: request.query,
    ...(request.assessmentOf
      ? { assessmentOf: request.assessmentOf, assessmentTargets: request.captureUrls }
      : {}),
    status: 'failed',
    items: [],
    sources: [],
    coverage: [],
    gaps: [],
    usage: {
      searches: 0,
      documents: 0,
      elapsedMs: 0,
      modelCalls: 0,
      providerUsage: null,
      cost: null,
    },
    counts: { leads: 0, distinct: 0, duplicates: 0, omitted: 0 },
    limits,
  };
  let receivingBrief = true;
  try {
    const acquisitionConfig =
      dependencies.acquisition ?? (await loadAcquisitionConfig(dependencies.root ?? process.cwd()));
    const runner =
      dependencies.runner ??
      codexRunner(undefined, undefined, {
        root: dependencies.root ?? process.cwd(),
        acquisition: acquisitionConfig,
        ...answerFirstOperation(request),
      });
    const readiness = await runner.readiness();
    const readinessMs = Date.now() - started;
    dependencies.progress?.(readiness.reason);
    if (!readiness.available || !readiness.broadSearch) {
      base.status = 'not_configured';
      base.gaps = [readiness.reason];
      return base;
    }
    base.usage.modelCalls = 1;
    const researchStarted = Date.now();
    const discovery = await runner.discover(
      request,
      controller.signal,
      dependencies.progress ?? (() => {}),
      dependencies.acquisitionHints,
      (brief) => {
        if (
          controller.signal.aborted ||
          !receivingBrief ||
          brief.format !== 'markdown' ||
          !brief.text.trim() ||
          brief.text.length > 24000
        )
          return;
        base.brief = { ...brief };
        dependencies.brief?.(base.brief);
      },
      dependencies.activity,
    );
    receivingBrief = false;
    base.usage.searches = discovery.searches;
    base.usage.providerUsage = discovery.usage;
    const answerReadyMs = Date.now() - started;
    if (
      discovery.proposal &&
      typeof discovery.proposal === 'object' &&
      'answer' in discovery.proposal &&
      typeof discovery.proposal.answer === 'string' &&
      discovery.proposal.answer.trim()
    ) {
      if (discovery.proposal.answer.length > (request.method === 'answer-first' ? 100000 : 24000))
        throw new Error('complete_answer_exceeds_retention_budget');
      base.brief = { format: 'markdown', text: discovery.proposal.answer };
      if (request.method === 'answer-first') {
        const usage = discovery.usage as { model?: unknown; servedModel?: unknown } | null;
        const plan = planResearchRetention({
          query: request.query,
          answer: base.brief.text,
          observedAt: new Date().toISOString(),
          provenance: {
            receipt: base.runId,
            requestedModel: typeof usage?.model === 'string' ? usage.model : null,
            servedModel: typeof usage?.servedModel === 'string' ? usage.servedModel : null,
          },
        });
        base.answerReceipt = {
          ...(request.context ? { context: request.context } : {}),
          observedAt: plan.input.observedAt,
          sha256: plan.answerSha256,
          state: 'unassessed',
          confidence: 'unknown',
          provenance: plan.input.provenance,
        };
        base.provisionalLeads = plan.citations.slice(0, 60).map((citation) => ({
          uri: citation.uri,
          name: citation.label,
          description: citation.context,
          limits: plan.limits,
        }));
        base.gaps = [
          'Answer and citation references are unassessed. Confidence Unknown. Select a cited resource for an explicit evidence assessment.',
          ...plan.limits,
        ];
        if (request.suggestChecks) {
          const present = Object.hasOwn(discovery.proposal, 'suggestions');
          const offered =
            'suggestions' in discovery.proposal ? discovery.proposal.suggestions : undefined;
          try {
            base.checkSuggestions = checkSuggestions(
              {
                version: 1,
                state: 'unverified',
                answerDigest: plan.answerSha256,
                offered,
                offeredDigest: digest(
                  offeredPayload(offered as Parameters<typeof offeredPayload>[0]),
                ),
              },
              plan.answerSha256,
              base.provisionalLeads.map((lead) => lead.uri),
            );
            base.gaps.push(
              'Suggested checks are unverified hypotheses; no proposition has been checked.',
            );
          } catch (error) {
            const reason = error instanceof Error ? error.message : '';
            base.rejectedCheckSuggestions = {
              version: 1,
              answerDigest: plan.answerSha256,
              scope: 'parsed-final-suggestions',
              presence: present ? 'nonserializable' : 'missing',
              reason: rejectedSuggestionsSchema.properties.reason.enum.some(
                (value) => value === reason,
              )
                ? (reason as NonNullable<SearchResult['rejectedCheckSuggestions']>['reason'])
                : 'invalid_check_suggestions',
            };
            if (present) {
              try {
                const parsed = JSON.stringify(offered);
                if (parsed !== undefined) {
                  base.rejectedCheckSuggestions.presence = 'serializable';
                  base.rejectedCheckSuggestions.diagnostic = boundedTextReceipt(parsed);
                }
              } catch {
                // No payload is claimed when the supplied parsed field cannot serialize.
              }
            }
            base.gaps.push(
              `Suggested checks omitted (${base.rejectedCheckSuggestions.reason}): invalid metadata or uncited references. The complete answer remains available for manual selection.`,
            );
          }
        }
        if (plan.rejectedReferences.length)
          base.gaps.push(
            `${plan.rejectedReferences.length} unsafe or unsupported citation destinations rejected; original text retained.`,
          );
        base.counts = {
          leads: plan.citations.length,
          distinct: 0,
          duplicates: 0,
          omitted: Math.max(0, plan.citations.length - 60),
        };
        base.usage.stages = {
          readinessMs,
          researchMs: answerReadyMs - (researchStarted - started),
          answerReadyMs,
          inspectionMs: 0,
        };
        dependencies.brief?.(base.brief);
        dependencies.provisional?.(base.provisionalLeads);
        base.status = controller.signal.aborted ? 'cancelled' : 'completed';
        if (discovery.searches > limits.searches) throw new Error('budget_exhausted');
        return base;
      }
      dependencies.brief?.(base.brief);
    }
    const research = decodeNativeResearch(discovery.proposal);
    if (research.brief && !base.brief) {
      base.brief = research.brief;
      dependencies.brief?.(research.brief);
    }
    if (research.provisionalLeads.length) base.provisionalLeads = research.provisionalLeads;
    const provisional = research.proposal;
    base.provisionalLeads = [
      ...provisional.candidates.map(({ uri, name, description, limits }) => ({
        uri,
        name,
        description,
        limits,
      })),
      ...research.provisionalLeads,
    ].slice(0, 60);
    base.counts.leads = base.provisionalLeads.length;
    dependencies.provisional?.(base.provisionalLeads);
    if (discovery.searches > limits.searches) throw new Error('budget_exhausted');
    if (request.cache === 'private')
      await atomicJson(
        resolve(dependencies.root ?? process.cwd(), '.signals/acquisitions', `${base.runId}.json`),
        {
          request,
          proposal: discovery.proposal,
          usage: discovery.usage,
          acquiredAt: new Date().toISOString(),
        },
      );
    const accepted = await acceptDiscovery(discovery.proposal, request, {
      followedSources: (await loadSettings(dependencies.root ?? process.cwd())).followedSources
        ?.filter((source) => source.enabled)
        .map((source) => source.uri),
      evidenceClass: dependencies.fetch ? 'fixture' : (runner.evidenceClass ?? 'fixture'),
      signal: controller.signal,
      fetch:
        dependencies.fetch ??
        (request.cache === 'private'
          ? privateCacheFetch(
              dependencies.root ?? process.cwd(),
              dependencies.progress,
              configuredDocumentFetch(acquisitionConfig.jina, undefined, acquisitionConfig.docling),
            )
          : configuredDocumentFetch(acquisitionConfig.jina, undefined, acquisitionConfig.docling)),
      progress: dependencies.progress,
      enrich:
        runner.enrich && request.review === true
          ? async (proposal, material) => {
              base.usage.modelCalls++;
              let recorded = false;
              const grounded = await runner.enrich!(
                proposal,
                material,
                request,
                controller.signal,
                dependencies.progress ?? (() => {}),
                async (proposal, usage) => {
                  base.usage.providerUsage = { discovery: discovery.usage, extraction: usage };
                  if (request.cache === 'private')
                    await atomicJson(
                      resolve(
                        dependencies.root ?? process.cwd(),
                        '.signals/extractions',
                        `${base.runId}.json`,
                      ),
                      { proposal, usage },
                    );
                  recorded = true;
                },
              );
              if (request.cache === 'private' && !recorded)
                await atomicJson(
                  resolve(
                    dependencies.root ?? process.cwd(),
                    '.signals/extractions',
                    `${base.runId}.json`,
                  ),
                  { proposal: grounded.proposal, usage: grounded.usage },
                );
              base.usage.providerUsage = { discovery: discovery.usage, extraction: grounded.usage };
              return grounded.proposal;
            }
          : undefined,
    });
    Object.assign(base, accepted);
    base.usage.stages = {
      readinessMs,
      researchMs: answerReadyMs - (researchStarted - started),
      answerReadyMs,
      inspectionMs: Date.now() - started - answerReadyMs,
      firstValidatedMs: Date.now() - started,
    };
    if (request.cache === 'private') {
      try {
        await recordSourceResultExposures(dependencies.root ?? process.cwd(), base.items);
      } catch {
        base.gaps.push(
          'Followed-source result exposure could not be recorded; research results retained.',
        );
      }
    }
    await contextualizeResult(base, dependencies.root ?? process.cwd());
    const inbox = (await loadSettings(dependencies.root ?? process.cwd())).promisingInbox;
    if (request.cache === 'private' && inbox?.enabled && !controller.signal.aborted) {
      await updateInbox(
        dependencies.root ?? process.cwd(),
        base,
        base.items
          .filter(
            (item) =>
              item.priority?.feedback !== 'mute' &&
              (item.priority?.score ?? -1) >= inbox.minimumPriority,
          )
          .map((item) => item.entity.id),
      );
    }
    base.usage.documents = base.sources.filter((source) => source.state === 'fetched').length;
    base.status = controller.signal.aborted
      ? 'cancelled'
      : base.gaps.length ||
          base.items.some((item) =>
            item.entity.observations.some((observation) => !observation.verified),
          )
        ? 'partial'
        : 'completed';
    if (request.save === 'eligible' && !controller.signal.aborted) {
      const saved = await saveEntities(
        base.items,
        'eligible',
        dependencies.root ?? process.cwd(),
        'public',
        request.threshold ?? 75,
        false,
        { runId: base.runId, query: base.query, kind: 'one-off' },
      );
      base.persistence = { changed: saved.changed, skipped: saved.skipped, privateRun: false };
    }
  } catch (failure) {
    receivingBrief = false;
    if (failure instanceof RunnerFailure) {
      base.usage.searches = failure.searches;
      base.usage.providerUsage = failure.providerUsage;
      if (failure.brief) {
        base.brief ??= failure.brief;
        dependencies.brief?.(base.brief);
      }
    }
    base.status = controller.signal.aborted ? 'cancelled' : 'failed';
    base.gaps.push(failure instanceof Error ? failure.message : 'search_failed');
  } finally {
    receivingBrief = false;
    clearTimeout(timer);
    dependencies.signal?.removeEventListener('abort', abort);
    base.usage.elapsedMs = Date.now() - started;
    if (['cancelled', 'failed'].includes(base.status)) {
      base.usage.stop = {
        reason: stoppedBy,
        elapsedMonotonicMs: Math.max(0, Math.round(performance.now() - monotonicStarted)),
      };
      base.gaps.push(
        base.brief
          ? 'Research stopped before completion. Retained narrative and candidate pointers are unassessed and may be incomplete; missing or contradictory sources remain unresolved. Discuss this frozen work or acquire evidence explicitly.'
          : 'Research stopped before producing usable narrative. No answer or verified result was recovered.',
      );
    }
    if (request.cache === 'private') {
      base.persistence = {
        changed: base.persistence?.changed ?? [],
        skipped: base.persistence?.skipped ?? [],
        privateRun: true,
      };
      try {
        await retainRun(base, dependencies.root ?? process.cwd());
      } catch (failure) {
        base.persistence.privateRun = false;
        base.gaps.push(
          `Private retention failed: ${failure instanceof Error ? failure.message : 'unknown'}`,
        );
        if (base.status === 'completed') base.status = 'partial';
      }
    }
  }
  return base;
}

export async function contextualizeResult(result: SearchResult, root: string) {
  const known = [
    ...(await loadEntities(resolve(root, 'signals/entities'))),
    ...(await loadEntities(resolve(root, '.signals/corpus/entities'))),
  ];
  result.items = filterSearchItems(
    contextualize(
      result.items,
      new Set(known.map((record) => record.entity.id)),
      await loadPersonal(root),
    ),
  );
  result.items = result.items.map((item) => {
    const prior = known.find((record) => record.entity.id === item.entity.id);
    return { ...item, change: prior ? entityDelta(prior.entity, item.entity) : 'new-to-corpus' };
  });
  return result;
}
