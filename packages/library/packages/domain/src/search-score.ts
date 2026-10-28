import type { Entity, Assessment, SearchItem } from './search-contract.js';
import { assessSuccessor, assessmentHolds, sameObservationClaim } from './search-assessment.js';

const weights = {
  corroboration: 25,
  adoption: 20,
  maturity: 20,
  currentness: 15,
  authority: 10,
  verification: 10,
};
const standardWeights = {
  corroboration: 10,
  adoption: 0,
  maturity: 15,
  currentness: 25,
  authority: 40,
  verification: 10,
};
const attentionAnchors = {
  stars: 10000,
  forks: 1000,
  downloads: 1000000,
  points: 1000,
  mentions: 10,
};
const bands: Record<string, Record<string, number>> = {
  adoption: {
    attention: 0.25,
    'single-user': 0.25,
    'multiple-users': 0.5,
    sustained: 0.75,
    broad: 1,
  },
  currentness: { current: 1, 'minor-gaps': 0.75, mixed: 0.5, stale: 0.25 },
  authority: { secondary: 0.25, primary: 0.5, recognized: 0.75, 'formal-current': 1 },
  verification: {
    inspectable: 0.25,
    'worked-example': 0.5,
    'independent-applied': 0.75,
    replicated: 1,
  },
};
const profiles: Record<Entity['kind'], number> = {
  software: 90,
  service: 90,
  model: 30,
  dataset: 365,
  standard: 1825,
  practice: 730,
  publication: 1825,
  'learning-resource': 365,
  product: 365,
  organization: 365,
  other: 90,
};

/** The mutable projection selects snapshots; evidence bytes and old judgments stay immutable. */
export function activeEvidenceIds(entity: Pick<Entity, 'evidence' | 'currentEvidence'>) {
  if (entity.currentEvidence) return new Set(entity.currentEvidence);
  // Early native snapshots predate the explicit projection. Recover conservatively.
  const newest = new Map<string, { date: string; id: string | null }>();
  for (const source of entity.evidence.filter((item) => item.state === 'fetched')) {
    const prior = newest.get(source.uri);
    if (!prior || source.fetchedAt > prior.date)
      newest.set(source.uri, { date: source.fetchedAt, id: source.id });
    else if (source.fetchedAt === prior.date && source.id !== prior.id) prior.id = null;
  }
  return new Set([...newest.values()].flatMap((item) => (item.id ? [item.id] : [])));
}
export function activeObservations(
  entity: Pick<Entity, 'evidence' | 'currentEvidence' | 'observations'>,
  policy: Assessment['policy'] = 'signal-strength-v6',
) {
  const evidence =
    policy === 'signal-strength-v0'
      ? new Set(entity.evidence.map((source) => source.id))
      : activeEvidenceIds(entity);
  if (
    [
      'signal-strength-v2',
      'signal-strength-v3',
      'signal-strength-v4',
      'signal-strength-v5',
      'signal-strength-v6',
      'signal-strength-v7',
      'signal-strength-v8',
      'signal-strength-v9',
      'signal-strength-v10',
    ].includes(policy)
  ) {
    const physical = new Set(
      entity.evidence
        .filter((source) => evidence.has(source.id))
        .map(
          (source) =>
            `${source.uri}:${source.digest}${policy !== 'signal-strength-v2' ? `:${source.normalizer ?? 'legacy'}` : ''}`,
        ),
    );
    entity.evidence.forEach((source) => {
      if (
        source.digest &&
        physical.has(
          `${source.uri}:${source.digest}${policy !== 'signal-strength-v2' ? `:${source.normalizer ?? 'legacy'}` : ''}`,
        )
      )
        evidence.add(source.id);
    });
  }
  const superseded = new Set(
    entity.observations.flatMap((item) =>
      item.supersedes.filter((id) => {
        if (policy !== 'signal-strength-v10') return true;
        const prior = entity.observations.find((entry) => entry.id === id);
        return (
          !prior ||
          (prior.feature !== 'risk' && prior.status === 'supported') ||
          (item.verified &&
            item.status !== 'uncertain' &&
            evidence.has(item.evidenceId) &&
            sameObservationClaim(entity, item, prior))
        );
      }),
    ),
  );
  return entity.observations.filter(
    (item) => evidence.has(item.evidenceId) && !superseded.has(item.id),
  );
}

// Conservative connected origin groups: labels cannot create extra support for
// the same canonical page, publisher or originating work.
function originGroups(entity: Pick<Entity, 'evidence'>) {
  const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
  const groups = new Map<string, Set<string>>();
  for (const source of entity.evidence) {
    const keys = new Set([
      `uri:${source.uri}`,
      `publisher:${normalize(source.publisher)}`,
      `origin:${normalize(source.origin)}`,
    ]);
    for (const [id, prior] of groups) {
      if ([...keys].some((key) => prior.has(key))) {
        for (const key of prior) keys.add(key);
        groups.delete(id);
      }
    }
    groups.set(source.id, keys);
  }
  return new Map(
    entity.evidence.map((source) => [
      source.id,
      [...groups].find(([, keys]) => keys.has(`uri:${source.uri}`))![0],
    ]),
  );
}

/** Equal known acquired payloads exclude extra support; they do not establish creator identity. */
function duplicateSupportGroups(
  entity: Pick<Entity, 'evidence' | 'currentEvidence'>,
  active: Entity['observations'],
) {
  const selected = new Set([
    ...activeEvidenceIds(entity),
    ...active.map((item) => item.evidenceId),
  ]);
  const groups: { ids: Set<string>; keys: Set<string> }[] = [];
  for (const source of entity.evidence
    .filter((item) => selected.has(item.id) && item.state === 'fetched')
    .sort((a, b) => a.id.localeCompare(b.id))) {
    const group = { ids: new Set([source.id]), keys: new Set([`uri:${source.uri}`]) };
    if (source.digest && /^[a-f0-9]{64}$/.test(source.digest))
      group.keys.add(`payload:${source.digest}`);
    for (let index = groups.length - 1; index >= 0; index--) {
      const prior = groups[index]!;
      if ([...group.keys].some((key) => prior.keys.has(key))) {
        prior.ids.forEach((id) => group.ids.add(id));
        prior.keys.forEach((key) => group.keys.add(key));
        groups.splice(index, 1);
      }
    }
    groups.push(group);
  }
  return new Map(
    groups.flatMap((group) => {
      const representative = [...group.ids].sort()[0]!;
      return [...group.ids].map((id) => [id, representative] as const);
    }),
  );
}

export function assessEntity(
  entity: Pick<
    Entity,
    | 'observations'
    | 'evidence'
    | 'kind'
    | 'identity'
    | 'currentEvidence'
    | 'currentChecks'
    | 'uri'
    | 'signalBasis'
  >,
  asOf: string,
  policy: Assessment['policy'] = 'signal-strength-v6',
): Assessment {
  if (!Number.isFinite(Date.parse(asOf))) throw new Error('invalid_assessment_date');
  const active = activeObservations(entity, policy);
  if (
    [
      'signal-strength-v7',
      'signal-strength-v8',
      'signal-strength-v9',
      'signal-strength-v10',
    ].includes(policy)
  )
    return assessSuccessor(
      entity,
      asOf,
      active,
      policy === 'signal-strength-v10'
        ? duplicateSupportGroups(entity, active)
        : originGroups(entity),
      policy as
        'signal-strength-v7' | 'signal-strength-v8' | 'signal-strength-v9' | 'signal-strength-v10',
    );
  const usable = active.filter(
    (observation) => observation.verified && observation.status === 'supported',
  );
  const freshStatusCheck = (evidenceId: string, maxAge = 365) => {
    if (policy === 'signal-strength-v0') return true;
    const source = entity.evidence.find((source) => source.id === evidenceId)!;
    const age =
      (Date.parse(asOf) -
        Date.parse(
          ([
            'signal-strength-v2',
            'signal-strength-v3',
            'signal-strength-v4',
            'signal-strength-v5',
            'signal-strength-v6',
          ].includes(policy)
            ? entity.currentChecks?.[source.uri]
            : undefined) ?? source.fetchedAt,
        )) /
      86400000;
    return age >= 0 && age <= maxAge;
  };
  const groups = originGroups(entity);
  const sharedHosts = new Set([
    'arxiv.org',
    'doi.org',
    'reddit.com',
    'news.ycombinator.com',
    'youtube.com',
    'stackoverflow.com',
    'zenodo.org',
  ]);
  const owner = (uri: string) => {
    const url = new URL(uri);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    if (['github.com', 'api.github.com', 'raw.githubusercontent.com'].includes(host))
      return {
        host: `github:${url.pathname
          .replace(/^\/repos\//, '/')
          .split('/')[1]
          ?.toLowerCase()}`,
        path: '',
      };
    const identifier =
      host === 'news.ycombinator.com'
        ? url.searchParams.get('id')
        : host === 'youtube.com'
          ? url.searchParams.get('v')
          : null;
    return {
      host,
      path: sharedHosts.has(host)
        ? url.pathname.replace(/^\/(abs|pdf)\//, '/').replace(/\.pdf$/, '') +
          (identifier ? `:${identifier}` : '')
        : '',
    };
  };
  const canonicalOwner = owner(entity.uri);
  const ownGroups = new Set(
    entity.evidence
      .filter((source) => {
        const sourceOwner = owner(source.uri);
        return (
          (sourceOwner.host === canonicalOwner.host ||
            sourceOwner.host.endsWith(`.${canonicalOwner.host}`) ||
            canonicalOwner.host.endsWith(`.${sourceOwner.host}`)) &&
          sourceOwner.path === canonicalOwner.path
        );
      })
      .map((source) => groups.get(source.id)),
  );
  const independentOrigin = (evidenceId: string) => {
    const source = entity.evidence.find((item) => item.id === evidenceId)!;
    return (policy === 'signal-strength-v3' ||
    policy === 'signal-strength-v4' ||
    policy === 'signal-strength-v5' ||
    policy === 'signal-strength-v6'
      ? !ownGroups.has(groups.get(source.id))
      : source.family !== 'primary') && source.origin.trim().toLowerCase() !== 'unknown'
      ? groups.get(source.id)
      : undefined;
  };
  const features: Assessment['features'] = {};
  const profile =
    policy !== 'signal-strength-v0' && entity.kind === 'standard' ? standardWeights : weights;
  for (const [feature, weight] of Object.entries(profile)) {
    const observations = usable.filter(
      (observation) => observation.feature === feature && observation.indicator !== 'unknown',
    );
    let value: number;
    if (feature === 'corroboration') {
      const origins = new Map<string, number>();
      for (const observation of observations.filter((item) => item.independent)) {
        const origin = independentOrigin(observation.evidenceId);
        if (!origin) continue;
        origins.set(
          origin,
          Math.max(
            origins.get(origin) ?? 0,
            observation.indicator === 'applied' ? 1 : observation.indicator === 'mention' ? 0.5 : 0,
          ),
        );
      }
      value = 1 - Math.exp(-[...origins.values()].reduce((sum, credit) => sum + credit, 0) / 3);
    } else if (feature === 'maturity') {
      value = new Set(observations.map((item) => item.indicator)).size / 4;
    } else {
      value = Math.max(
        0,
        ...observations.map((item) =>
          (policy === 'signal-strength-v4' ||
            policy === 'signal-strength-v5' ||
            policy === 'signal-strength-v6') &&
          feature === 'adoption' &&
          item.indicator === 'attention' &&
          item.attention
            ? 0.25 *
              Math.min(
                1,
                Math.log1p(item.attention.value) /
                  Math.log1p(attentionAnchors[item.attention.metric]),
              )
            : (bands[feature]?.[item.indicator] ?? 0),
        ),
      );
      if (
        feature === 'authority' &&
        entity.kind === 'standard' &&
        policy !== 'signal-strength-v0'
      ) {
        value = Math.max(
          0,
          ...observations.map((item) =>
            item.indicator === 'formal-current' && !freshStatusCheck(item.evidenceId)
              ? 0.75
              : (bands.authority?.[item.indicator] ?? 0),
          ),
        );
      }
      if (feature === 'adoption') {
        const independent = new Set(
          observations
            .filter((item) => item.independent && (bands.adoption?.[item.indicator] ?? 0) > 0)
            .map((item) => independentOrigin(item.evidenceId))
            .filter(Boolean),
        );
        if (independent.size < 2) value = Math.min(value, 0.25);
        else if (independent.size < 3) value = Math.min(value, 0.75);
      }
      if (feature === 'currentness') {
        const relevant = observations.map((item) =>
          entity.evidence.find((source) => source.id === item.evidenceId)!,
        );
        const current = relevant.some(
          (source) =>
            source.publishedAt &&
            ((policy !== 'signal-strength-v5' && policy !== 'signal-strength-v6') ||
              Date.parse(source.publishedAt) <= Date.parse(asOf)) &&
            (Date.parse(asOf) - Date.parse(source.publishedAt)) / 86400000 <= profiles[entity.kind],
        );
        const formallyCurrent =
          entity.kind === 'standard' &&
          usable.some((item) => {
            if (item.feature !== 'authority' || item.indicator !== 'formal-current') return false;
            // Normative publication dates do not expire; mutable catalogue status checks do.
            return freshStatusCheck(item.evidenceId);
          });
        const issuerCurrent =
          policy === 'signal-strength-v6' &&
          observations.some(
            (item) =>
              item.indicator === 'current' &&
              freshStatusCheck(item.evidenceId, Math.min(365, profiles[entity.kind])) &&
              usable.some(
                (issuer) =>
                  issuer.evidenceId === item.evidenceId &&
                  issuer.feature === 'authority' &&
                  (bands.authority?.[issuer.indicator] ?? 0) >= 0.5,
              ),
          );
        if (!current && !formallyCurrent && !issuerCurrent) value = Math.min(value, 0.5);
      }
    }
    features[feature] = {
      value,
      contribution: value * weight,
      observations: observations.map((item) => item.id),
      state: weight === 0 ? 'not-applicable' : observations.length ? 'observed' : 'unknown',
    };
  }
  const risks = active.filter(
    (item) => item.verified && item.feature === 'risk' && item.status === 'supported',
  );
  const risk = Math.max(
    0,
    ...risks.map(
      (item) => ({ bounded: 5, material: 15, decisive: 25 })[item.indicator as 'bounded'] ?? 0,
    ),
  );
  const defining = usable.some((item) => item.feature === 'defining');
  const applicable = Object.keys(profile).filter(
    (feature) => profile[feature as keyof typeof profile] > 0,
  );
  const missing = applicable.filter((feature) => features[feature]!.state === 'unknown');
  return {
    policy,
    asOf,
    score: defining
      ? Math.round(
          Math.max(
            0,
            Math.min(
              100,
              Object.values(features).reduce((sum, item) => sum + item.contribution, 0) - risk,
            ),
          ),
        )
      : null,
    features,
    risk,
    coverage: (applicable.length - missing.length) / applicable.length,
    missing,
    state: !defining ? 'unassessed' : entity.identity === 'ambiguous' ? 'provisional' : 'assessed',
  };
}

export function saveDecision(entity: Entity, match: SearchItem['match'], threshold = 75) {
  const reasons: string[] = [];
  if (entity.identity !== 'resolved') reasons.push('ambiguous_identity');
  if (entity.assessment.score === null)
    reasons.push(
      [
        'signal-strength-v7',
        'signal-strength-v8',
        'signal-strength-v9',
        'signal-strength-v10',
      ].includes(entity.assessment.policy)
        ? 'assessment_not_scoreable'
        : 'no_supported_defining_claim',
    );
  else if (entity.assessment.score < threshold) reasons.push('below_threshold');
  if (match.level !== 'direct') reasons.push('not_direct');
  if (entity.inspection?.state === 'deferred') reasons.push('inspection_incomplete');
  if (
    [
      'signal-strength-v7',
      'signal-strength-v8',
      'signal-strength-v9',
      'signal-strength-v10',
    ].includes(entity.assessment.policy)
  ) {
    if (entity.assessment.disposition !== 'completed') reasons.push('assessment_incomplete');
    if (
      ['basis', 'work', 'applicability'].some(
        (name) =>
          entity.assessment.features[name]?.state !== 'observed' ||
          (entity.assessment.features[name]?.value ?? 0) <= 0,
      )
    )
      reasons.push('essential_dimension_has_no_positive_support');
  }
  if (assessmentHolds(entity, entity.assessment.asOf).length)
    reasons.push('unresolved_decisive_evidence');
  const defining = activeObservations(entity, entity.assessment.policy).filter(
    (observation) =>
      observation.feature === 'defining' &&
      observation.verified &&
      observation.status === 'supported',
  );
  if (
    defining.length &&
    defining.every(
      (observation) =>
        entity.evidence.find((source) => source.id === observation.evidenceId)?.reason ===
        'provider_final_identity_unverified',
    )
  )
    reasons.push('source_identity_unverified');
  if (
    activeObservations(entity, entity.assessment.policy).some(
      (item) => item.feature === 'defining' && item.verified && item.status === 'contradicted',
    )
  )
    reasons.push('contradicted_defining_claim');
  return { eligible: !reasons.length, reasons };
}

/** Personal automatic retention is separate from the public inclusion boundary. */
export function personalSaveDecision(
  entity: Entity,
  match: SearchItem['match'],
  relevance: SearchItem['relevance'],
  threshold = 75,
) {
  const decision = saveDecision(entity, match, threshold);
  const reasons = [...decision.reasons];
  if (
    ![
      'signal-strength-v7',
      'signal-strength-v8',
      'signal-strength-v9',
      'signal-strength-v10',
    ].includes(entity.assessment.policy) ||
    entity.assessment.disposition !== 'completed'
  )
    reasons.push('assessment_incomplete');
  if ((relevance?.value ?? -1) < 75) reasons.push('topic_relevance_below_threshold');
  return { eligible: !reasons.length, reasons };
}

export interface SearchFilters {
  text?: string;
  kind?: string;
  facet?: string;
  host?: string;
  family?: string;
  min?: number;
  max?: number;
  match?: string;
  state?: string;
  saved?: 'saved' | 'unsaved';
  sort?: 'match' | 'relevance' | 'score' | 'newest' | 'type' | 'priority';
}
export function sourceHost(uri: string) {
  try {
    return new URL(uri).hostname;
  } catch {
    return 'invalid-source';
  }
}
export function filterSearchItems(
  items: SearchItem[],
  filters: SearchFilters = {},
  saved = new Set<string>(),
) {
  const rank = { direct: 0, related: 1, unknown: 2, 'out-of-scope': 3 };
  const candidates = items.filter(
    ({ entity, match }) =>
      (!filters.text ||
        `${entity.name} ${entity.description} ${Object.values(entity.facets).flat().join(' ')}`
          .toLowerCase()
          .includes(filters.text.toLowerCase())) &&
      (!filters.kind || entity.kind === filters.kind) &&
      (!filters.facet ||
        Object.values(entity.facets).some((values) => values.includes(filters.facet!))) &&
      (!filters.host ||
        entity.evidence.some((source) => sourceHost(source.uri) === filters.host)) &&
      (!filters.family || entity.evidence.some((source) => source.family === filters.family)) &&
      (entity.assessment.score === null ||
        (entity.assessment.score >= (filters.min ?? 0) &&
          entity.assessment.score <= (filters.max ?? 100))) &&
      (!filters.match || match.level === filters.match) &&
      (!filters.state || entity.assessment.state === filters.state) &&
      (!filters.saved || saved.has(entity.id) === (filters.saved === 'saved')),
  );
  const comparable =
    new Set(
      candidates.map(
        ({ entity }) =>
          `${entity.kind}:${entity.assessment.policy}:${entity.assessment.rubric ?? 'historical'}`,
      ),
    ).size <= 1;
  const numeric = candidates.some((item) => item.relevance !== undefined);
  const relevance = (a: SearchItem, b: SearchItem) =>
    (numeric
      ? (b.relevance?.value ?? -1) - (a.relevance?.value ?? -1)
      : rank[a.match.level] - rank[b.match.level]) || a.entity.id.localeCompare(b.entity.id);
  // Contextual priority is the only owner of contextual order; equal priority falls back to
  // query relevance, never to intrinsic strength.
  const held = (item: SearchItem) =>
    (item.priority?.feedback === 'mute' ? 2 : 0) +
    (item.priority?.applicability === 'incompatible' || item.match.level === 'out-of-scope'
      ? 1
      : 0);
  return candidates.sort((a, b) => {
    if (!filters.sort || filters.sort === 'match' || filters.sort === 'relevance')
      return relevance(a, b);
    if (filters.sort === 'priority')
      return (
        held(a) - held(b) ||
        (b.priority?.score ?? -1) - (a.priority?.score ?? -1) ||
        relevance(a, b)
      );
    const type = filters.sort === 'type' ? a.entity.kind.localeCompare(b.entity.kind) : 0;
    const newest =
      filters.sort === 'newest'
        ? b.entity.assessment.asOf.localeCompare(a.entity.assessment.asOf)
        : 0;
    return (
      type ||
      newest ||
      (comparable ? (b.entity.assessment.score ?? -1) - (a.entity.assessment.score ?? -1) : 0) ||
      a.entity.id.localeCompare(b.entity.id)
    );
  });
}
