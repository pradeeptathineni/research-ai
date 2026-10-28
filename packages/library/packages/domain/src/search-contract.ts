import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { normalizeConsiderUrl } from './url.js';
import {
  interpretationSchema,
  relevanceSchema,
  signalJudgmentSchema,
  type SignalBasis,
  type SignalJudgment,
  type QueryInterpretation,
  type QueryRelevance,
} from './search-assessment.js';

const closed = { additionalProperties: false };
const text = Type.String({ minLength: 1, maxLength: 1600 });
const label = Type.String({ minLength: 1, maxLength: 200 });
const labels = Type.Array(label, { maxItems: 40, uniqueItems: true });
import { kinds, channels } from './search-vocabulary.js';
import type { budgets } from './search-vocabulary.js';
import type { ClaimReceipt } from './claim-check.js';
import { claimCitationSchema } from './claim-check.js';
import type { SourceText } from './source-text.js';
import type { Grounding } from '@pradeeptathineni/research-ai';
import type { CheckSuggestions, RejectedCheckSuggestions } from './search-suggestions.js';
export { channels, budgets } from './search-vocabulary.js';
const enumOf = <const T extends string>(values: readonly T[]) => Type.Enum<T[]>(values);
export const indicators = {
  corroboration: ['applied', 'mention', 'promotion', 'unknown'],
  adoption: ['unknown', 'attention', 'single-user', 'multiple-users', 'sustained', 'broad'],
  maturity: ['track-record', 'stable-interface', 'supported-or-complete', 'documented'],
  currentness: ['current', 'minor-gaps', 'mixed', 'stale', 'unknown'],
  authority: ['secondary', 'primary', 'recognized', 'formal-current', 'unknown'],
  verification: ['inspectable', 'worked-example', 'independent-applied', 'replicated', 'unknown'],
  risk: ['bounded', 'material', 'decisive'],
  defining: ['defines'],
} as const;
export const observationSchema = Type.Object(
  {
    source: Type.Integer({ minimum: 0, maximum: 59 }),
    feature: enumOf(Object.keys(indicators)),
    indicator: Type.Enum([...new Set(Object.values(indicators).flat())]),
    statement: text,
    quote: Type.String({ minLength: 1, maxLength: 400 }),
    independent: Type.Boolean(),
    origin: label,
    status: enumOf(['supported', 'contradicted', 'uncertain']),
    attention: Type.Optional(
      Type.Object(
        {
          metric: enumOf(['stars', 'forks', 'downloads', 'points', 'mentions']),
          value: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        },
        closed,
      ),
    ),
  },
  closed,
);
export function modelObservationSchema(properties = observationSchema.properties) {
  return Type.Union(
    Object.entries(indicators).map(([feature, values]) =>
      Type.Object(
        {
          ...properties,
          feature: Type.Literal(feature),
          indicator: Type.Enum<string[]>([...values]),
        },
        closed,
      ),
    ),
  );
}
export const candidateSchema = Type.Object(
  {
    uri: Type.String({ maxLength: 2048 }),
    name: label,
    kind: enumOf(kinds),
    identity: enumOf(['resolved', 'ambiguous']),
    aliases: labels,
    description: text,
    facets: Type.Object(
      {
        domains: labels,
        capabilities: labels,
        interfaces: labels,
        deliveryForms: labels,
        platforms: labels,
        licenses: labels,
        tags: labels,
      },
      closed,
    ),
    observations: Type.Array(observationSchema, { maxItems: 100 }),
    signalJudgment: Type.Optional(signalJudgmentSchema),
    relevance: Type.Optional(relevanceSchema),
    inspection: Type.Optional(
      Type.Object(
        {
          state: Type.Enum(['complete', 'deferred']),
          deferredObservations: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
          reason: text,
        },
        closed,
      ),
    ),
    match: Type.Object(
      {
        level: enumOf(['direct', 'related', 'unknown', 'out-of-scope']),
        reason: text,
        sources: Type.Array(Type.Integer({ minimum: 0, maximum: 59 }), {
          maxItems: 60,
          uniqueItems: true,
        }),
      },
      closed,
    ),
    limits: Type.Array(text, { maxItems: 30 }),
    priority: Type.Optional(
      Type.Object(
        {
          applicability: enumOf(['direct', 'partial', 'incompatible', 'unknown']),
          value: enumOf(['high', 'medium', 'low', 'unknown']),
          action: enumOf(['use', 'wrap', 'adapt', 'study', 'watch', 'reject']),
          reason: text,
          constraints: Type.Array(text, { maxItems: 10 }),
          sources: Type.Array(Type.Integer({ minimum: 0, maximum: 59 }), {
            maxItems: 20,
            uniqueItems: true,
          }),
          relations: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  uri: Type.String({ maxLength: 2048 }),
                  kind: enumOf(['alternative', 'related', 'contrary']),
                  reason: text,
                },
                closed,
              ),
              { maxItems: 10 },
            ),
          ),
        },
        closed,
      ),
    ),
    discovery: Type.Optional(
      Type.Object(
        {
          introducedBy: enumOf([
            'user-seeded',
            'model-nominated',
            'unseeded-query',
            'hub-discovered',
            'followed-source',
            'unknown',
          ]),
          parentUri: Type.Optional(Type.String({ maxLength: 2048 })),
          query: Type.Optional(Type.String({ maxLength: 2000 })),
        },
        closed,
      ),
    ),
  },
  closed,
);
export const proposalSchema = Type.Object(
  {
    assessmentPolicy: Type.Optional(
      Type.Union([
        Type.Literal('signal-strength-v7'),
        Type.Literal('signal-strength-v8'),
        Type.Literal('signal-strength-v9'),
        Type.Literal('signal-strength-v10'),
      ]),
    ),
    interpretation: Type.Optional(interpretationSchema),
    sources: Type.Array(
      Type.Object(
        {
          uri: Type.String({ maxLength: 2048 }),
          title: label,
          publisher: label,
          family: enumOf(channels),
          publishedAt: Type.Union([Type.String({ maxLength: 40 }), Type.Null()]),
          origin: label,
          role: Type.Optional(
            enumOf([
              'primary',
              'hub',
              'community',
              'practitioner',
              'registry',
              'scholarly',
              'counterevidence',
            ]),
          ),
        },
        closed,
      ),
      { maxItems: 60 },
    ),
    candidates: Type.Array(candidateSchema, { maxItems: 60 }),
    coverage: Type.Array(
      Type.Object(
        {
          channel: enumOf(channels),
          state: enumOf([
            'searched',
            'skipped',
            'denied',
            'failed',
            'not_configured',
            'budget_exhausted',
          ]),
          searches: Type.Integer({ minimum: 0, maximum: 24 }),
          reason: text,
        },
        closed,
      ),
      { maxItems: 12 },
    ),
    gaps: Type.Array(text, { maxItems: 30 }),
  },
  closed,
);
export const discoverySchema = Type.Object(
  {
    ...proposalSchema.properties,
    candidates: Type.Array(
      Type.Object(
        {
          ...candidateSchema.properties,
          observations: Type.Array(modelObservationSchema(), { maxItems: 100 }),
        },
        closed,
      ),
      { maxItems: 60 },
    ),
  },
  closed,
);
const requestSchema = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: 2000 }),
    context: Type.Optional(Type.String({ maxLength: 4000 })),
    captureUrls: Type.Optional(
      Type.Array(Type.String({ maxLength: 2048 }), { maxItems: 10, uniqueItems: true }),
    ),
    supplementalSites: Type.Optional(
      Type.Array(Type.String({ maxLength: 2048 }), { maxItems: 20, uniqueItems: true }),
    ),
    runner: Type.Optional(Type.Literal('codex')),
    sources: Type.Optional(
      Type.Array(Type.Enum(channels), { minItems: 1, maxItems: 12, uniqueItems: true }),
    ),
    profile: Type.Optional(enumOf(['quick', 'wide'])),
    route: Type.Optional(enumOf(['native', 'assessed'])),
    method: Type.Optional(enumOf(['native', 'answer-first'])),
    suggestChecks: Type.Optional(Type.Boolean()),
    suggestionIndex: Type.Optional(Type.Integer({ minimum: 0, maximum: 2 })),
    offeredDigest: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
    assessmentOf: Type.Optional(Type.String({ pattern: '^[a-f0-9-]{36}$' })),
    claimText: Type.Optional(Type.String({ minLength: 1, maxLength: 1600 })),
    claimOrigin: Type.Optional(Type.Enum(['request', 'retained-partial', 'selected-primary'])),
    selectedPacketDigest: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
    parentSnapshotDigest: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
    claimCitations: Type.Optional(Type.Array(claimCitationSchema, { minItems: 1, maxItems: 2 })),
    claimSources: Type.Optional(
      Type.Array(
        Type.Object(
          {
            sourceIndex: Type.Integer({ minimum: 0, maximum: 1 }),
            runId: Type.String({ pattern: '^[a-f0-9-]{36}$' }),
            sourceId: Type.String({ minLength: 1, maxLength: 200 }),
          },
          closed,
        ),
        { maxItems: 2 },
      ),
    ),
    save: Type.Optional(enumOf(['never', 'eligible'])),
    cache: Type.Optional(enumOf(['memory', 'private'])),
    review: Type.Optional(Type.Boolean()),
    threshold: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
    interpretation: Type.Optional(interpretationSchema),
  },
  closed,
);
export type SearchRequest = Static<typeof requestSchema>;
export type Proposal = Omit<Static<typeof proposalSchema>, 'candidates'> & {
  candidates: Candidate[];
};
type Candidate = Omit<Static<typeof candidateSchema>, 'signalJudgment'> & {
  signalJudgment?: SignalJudgment;
};
type Observation = Static<typeof observationSchema>;
export type Source = Proposal['sources'][number] & {
  id: string;
  fetchedAt: string;
  digest: string | null;
  excerptDigest?: string;
  normalizer?: SourceText;
  state: 'fetched' | 'failed' | 'denied';
  reason: string;
  excerpt: string;
  finalUri?: string;
  extractor?: string;
  transport?: { etag?: string; lastModified?: string };
};
export interface Entity extends Omit<
  Candidate,
  'observations' | 'match' | 'signalJudgment' | 'relevance'
> {
  id: string;
  acquisition?: 'configured-live' | 'native-agent' | 'fixture';
  currentEvidence?: string[];
  retainedDecisiveObservations?: string[];
  currentChecks?: Record<string, string>;
  observations: (Omit<Observation, 'source'> & {
    id: string;
    identityVersion?: 2;
    basisId: string;
    supersedes: string[];
    evidenceId: string;
    verified: boolean;
    derivation: 'model-assessment';
  })[];
  evidence: Source[];
  assessment: Assessment;
  signalBasis?: SignalBasis;
}
export interface Assessment {
  policy:
    | 'signal-strength-v0'
    | 'signal-strength-v1'
    | 'signal-strength-v2'
    | 'signal-strength-v3'
    | 'signal-strength-v4'
    | 'signal-strength-v5'
    | 'signal-strength-v6'
    | 'signal-strength-v7'
    | 'signal-strength-v8'
    | 'signal-strength-v9'
    | 'signal-strength-v10';
  asOf: string;
  score: number | null;
  features: Record<
    string,
    {
      value: number;
      contribution: number;
      observations: string[];
      state: 'observed' | 'unknown' | 'not-applicable';
    }
  >;
  risk: number;
  coverage: number;
  missing: string[];
  state: 'assessed' | 'provisional' | 'unassessed';
  rubric?: SignalBasis['rubric'] | null;
  disposition?: 'completed' | 'provisional' | 'not-scoreable';
  reasons?: string[];
  nextVerification?: string | null;
}
export interface SearchItem {
  entity: Entity;
  match: Candidate['match'];
  eligible: boolean;
  reasons: string[];
  relevance?: QueryRelevance;
  change?: 'new-to-corpus' | 'unchanged' | 'supported-description-or-status-changed';
  discovery?: Candidate['discovery'] & {
    linkVerified: boolean;
    provenanceBasis?: 'request-seed' | 'configured-source' | 'matched-outlink' | 'model-report';
    proposedIntroducedBy?: NonNullable<Candidate['discovery']>['introducedBy'];
  };
  priority?: NonNullable<Candidate['priority']> & {
    policy: 'contextual-priority-v1' | 'contextual-priority-v2';
    proposedAction?: NonNullable<Candidate['priority']>['action'];
    score: number | null;
    novelty: 'new-to-corpus' | 'known-in-corpus' | 'unknown';
    personalNovelty: 'confirmed-new' | 'known' | 'unknown';
    feedback: 'none' | 'skip' | 'mute' | 'useful';
    evidenceIds: string[];
  };
}
interface SingleParentFollowup {
  version: 1;
  scope: 'saved-context-only';
  parent: {
    owner: 'signals-ai';
    kind: 'answer' | 'research_note';
    id: string;
    revision: string;
    digest: string;
  };
  parentQuery: string;
  parentStatus: 'completed' | 'partial' | 'cancelled' | 'failed' | 'not_configured';
  requestDigest: string;
  frozen: {
    material: {
      entityId: string;
      observationId: string;
      evidenceId: string;
      statement: string;
      quote: string;
      feature: string;
      entityName: string;
      status: string;
    }[];
    context: {
      id: string;
      name: string;
      uri: string;
      description: string;
      capabilities: string[];
      limits: string[];
    }[];
    priorSynthesis?: string;
    gaps: string[];
  };
  frozenDigest: string;
  cited: string[];
}
type MultiParentFollowup = Omit<
  SingleParentFollowup,
  'version' | 'parent' | 'parentQuery' | 'parentStatus'
> & {
  version: 2;
  parents: {
    ref: SingleParentFollowup['parent'];
    query: string;
    status: SingleParentFollowup['parentStatus'];
  }[];
  selection: {
    method: 'bm25-v1';
    question_sha256: string;
    per_parent: { parent_id: string; total: number; kept: number }[];
  };
};
export interface SearchResult {
  /** Owner-produced self-contained claim/source closure; absence is unassessed history. */
  grounding?: Grounding;
  checkSuggestions?: CheckSuggestions;
  rejectedCheckSuggestions?: RejectedCheckSuggestions;
  suggestionIndex?: number;
  suggestionDigest?: string;
  claimCheck?: ClaimReceipt;
  assessmentOf?: string;
  assessmentTargets?: string[];
  /** A saved-context-only discussion child; validated by search-followup's closed closure. */
  followupOf?: SingleParentFollowup | MultiParentFollowup;
  answerReceipt?: {
    context?: string;
    observedAt: string;
    sha256: string;
    state: 'unassessed';
    confidence: 'unknown';
    provenance: { receipt: string; requestedModel: string | null; servedModel: string | null };
  };
  interpretation?: QueryInterpretation;
  brief?: { format: 'markdown'; text: string };
  provisionalLeads?: ProvisionalLead[];
  schemaVersion: 2;
  runId: string;
  query: string;
  status: 'completed' | 'partial' | 'cancelled' | 'failed' | 'not_configured';
  items: SearchItem[];
  sources: Source[];
  coverage: Proposal['coverage'];
  gaps: string[];
  usage: {
    searches: number;
    documents: number;
    elapsedMs: number;
    modelCalls: number;
    providerUsage: unknown;
    stop?: {
      reason: 'deadline' | 'external' | null;
      elapsedMonotonicMs: number;
    };
    stages?: {
      readinessMs: number;
      researchMs: number;
      answerReadyMs: number;
      inspectionMs: number;
      firstValidatedMs?: number;
    };
    cost: null;
  };
  counts: { leads: number; distinct: number; duplicates: number; omitted: number };
  limits: typeof budgets.quick;
  persistence?: { changed: string[]; skipped: string[]; privateRun: boolean };
}
export type ProvisionalLead = Pick<
  Proposal['candidates'][number],
  'uri' | 'name' | 'description' | 'limits'
>;
export function parseRequest(input: unknown): SearchRequest {
  if (!Value.Check(requestSchema, input) || !input.query.trim()) throw new Error('invalid_request');
  if (
    input.suggestChecks &&
    (input.method !== 'answer-first' ||
      input.save === 'eligible' ||
      input.assessmentOf !== undefined ||
      input.claimText !== undefined ||
      input.claimOrigin !== undefined ||
      input.claimSources !== undefined)
  )
    throw new Error('invalid_suggested_answer_request');
  if (
    input.suggestionIndex !== undefined &&
    (!input.assessmentOf ||
      !input.claimText ||
      input.claimOrigin !== undefined ||
      !input.offeredDigest)
  )
    throw new Error('invalid_suggestion_selection');
  if (input.offeredDigest !== undefined && input.suggestionIndex === undefined)
    throw new Error('invalid_suggestion_selection');
  if (
    input.claimOrigin === 'selected-primary' &&
    (!input.selectedPacketDigest ||
      !input.claimText?.trim() ||
      input.claimText.length > 1600 ||
      !input.claimText.isWellFormed() ||
      input.query.length > 2000 ||
      !input.query.isWellFormed() ||
      (input.context !== undefined &&
        (input.context.length > 4000 || !input.context.isWellFormed())) ||
      input.captureUrls?.length !== 1 ||
      input.captureUrls.some((uri) => uri.length > 2048 || !uri.isWellFormed()) ||
      input.assessmentOf !== undefined ||
      input.claimSources !== undefined ||
      input.profile !== 'quick' ||
      input.save !== 'never' ||
      input.method === 'answer-first' ||
      input.review === true ||
      input.sources !== undefined ||
      input.supplementalSites !== undefined)
  )
    throw new Error('invalid_selected_primary_request');
  if (input.claimOrigin !== 'selected-primary' && input.selectedPacketDigest !== undefined)
    throw new Error('unexpected_selected_primary_fields');
  if (
    input.claimOrigin === 'retained-partial' &&
    (!input.assessmentOf ||
      !input.parentSnapshotDigest ||
      !input.claimCitations?.length ||
      input.claimCitations.length !== input.captureUrls?.length ||
      !input.claimText?.trim() ||
      input.claimText.length > 1600 ||
      !input.claimText.isWellFormed() ||
      input.claimSources !== undefined ||
      !input.captureUrls?.length ||
      input.captureUrls.length > 2 ||
      input.captureUrls.some((uri) => uri.length > 2048 || !uri.isWellFormed()) ||
      !input.query.isWellFormed() ||
      input.context !== undefined ||
      input.profile !== 'quick' ||
      input.save !== 'never' ||
      input.method === 'answer-first' ||
      input.review === true ||
      input.sources !== undefined ||
      input.supplementalSites !== undefined)
  )
    throw new Error('invalid_partial_claim_request');
  if (
    input.claimOrigin === 'request' &&
    (!input.claimText?.trim() ||
      input.assessmentOf !== undefined ||
      input.claimSources !== undefined ||
      !input.captureUrls?.length ||
      input.captureUrls.length > 2 ||
      input.profile !== 'quick' ||
      input.save !== 'never' ||
      input.method === 'answer-first' ||
      input.review === true ||
      input.sources !== undefined ||
      input.supplementalSites !== undefined)
  )
    throw new Error('invalid_direct_claim_request');
  if (
    input.claimOrigin !== 'retained-partial' &&
    (input.parentSnapshotDigest !== undefined || input.claimCitations !== undefined)
  )
    throw new Error('unexpected_partial_claim_fields');
  if (
    input.claimText !== undefined &&
    (!input.claimText.trim() ||
      input.claimText.length > 1600 ||
      (!input.assessmentOf && !input.claimOrigin) ||
      !input.captureUrls?.length ||
      input.captureUrls.length > 2 ||
      input.method === 'answer-first' ||
      input.save === 'eligible')
  )
    throw new Error('invalid_claim_request');
  if (
    input.claimSources &&
    (!input.claimText ||
      new Set(input.claimSources.map((ref) => ref.sourceIndex)).size !==
        input.claimSources.length ||
      input.claimSources.some((ref) => !input.captureUrls?.[ref.sourceIndex]))
  )
    throw new Error('invalid_claim_sources');
  const sites = (input.supplementalSites ?? []).map((site) => {
    const original = new URL(site);
    if (original.search || original.hash) throw new Error('invalid_supplemental_site');
    return normalizeConsiderUrl(site).normalizedUrl;
  });
  const captureUrls = input.captureUrls?.map(
    (uri) => normalizeConsiderUrl(uri).normalizedUrl + new URL(uri).hash,
  );
  if (
    (input.claimOrigin === 'retained-partial' || input.claimOrigin === 'selected-primary') &&
    captureUrls?.some((uri, index) => uri.length > 2048 || uri !== input.captureUrls![index])
  )
    throw new Error('invalid_partial_claim_target');
  return {
    ...input,
    ...(input.claimOrigin ? {} : { supplementalSites: [...new Set(sites)] }),
    ...(captureUrls ? { captureUrls: [...new Set(captureUrls)] } : {}),
  };
}
export function parseProposal(input: unknown): Proposal {
  if (!Value.Check(proposalSchema, input)) throw new Error('invalid_model_output');
  const proposal = input as Proposal;
  const unique = new Set(proposal.coverage.map((item) => item.channel));
  if (unique.size !== proposal.coverage.length) throw new Error('duplicate_coverage');
  for (const candidate of proposal.candidates) {
    if (candidate.discovery?.parentUri) normalizeConsiderUrl(candidate.discovery.parentUri);
    for (const relation of candidate.priority?.relations ?? []) normalizeConsiderUrl(relation.uri);
    for (const observation of candidate.observations) {
      if (!attentionBound(observation)) throw new Error('unbound_attention_count');
      if (
        !proposal.sources[observation.source] ||
        !Object.hasOwn(indicators, observation.feature) ||
        !(indicators[observation.feature as keyof typeof indicators] as readonly string[]).includes(
          observation.indicator,
        )
      )
        throw new Error('invalid_evidence_binding');
    }
    if (candidate.match.sources.some((index) => !proposal.sources[index]))
      throw new Error('invalid_match_binding');
    if (candidate.priority?.sources.some((index) => !proposal.sources[index]))
      throw new Error('invalid_priority_binding');
    if (
      candidate.relevance &&
      [
        ...candidate.relevance.sources,
        ...candidate.relevance.constraints.flatMap((item) => item.sources),
      ].some((index) => !proposal.sources[index])
    )
      throw new Error('invalid_relevance_binding');
    if (
      candidate.signalJudgment &&
      Object.values(candidate.signalJudgment.dimensions).some((dimension) =>
        dimension.observations.some((index) => !candidate.observations[index]),
      )
    )
      throw new Error('invalid_rubric_binding');
  }
  return proposal;
}
export function attentionBound(
  observation: Pick<Observation, 'attention' | 'quote' | 'feature' | 'indicator'>,
) {
  return (
    !observation.attention ||
    (observation.feature === 'adoption' &&
      observation.indicator === 'attention' &&
      (observation.quote.match(/\d+(?:[,_]\d{3})*/g) ?? []).some(
        (number) => Number(number.replace(/[,_]/g, '')) === observation.attention!.value,
      ))
  );
}
