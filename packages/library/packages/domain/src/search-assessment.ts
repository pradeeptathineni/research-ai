import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import type { Assessment, Entity } from './search-contract.js';

const closed = { additionalProperties: false };
const reason = Type.String({ minLength: 1, maxLength: 1600 });
export const dimensionNames = ['basis', 'work', 'scrutiny', 'applicability'] as const;
export const rubricIds = [
  'software-v1',
  'scientific-v1',
  'news-v1',
  'discussion-v1',
  'learning-v1',
  'practice-v1',
  'standard-v1',
  'other-v1',
] as const;
const gap = Type.Object({ reason, decisive: Type.Boolean(), nextVerification: reason }, closed);
function judgmentSchema(
  reference: ReturnType<typeof Type.Integer> | ReturnType<typeof Type.String>,
  sourceReference: ReturnType<typeof Type.Integer> | ReturnType<typeof Type.String>,
) {
  return Type.Object(
    {
      rubric: Type.Enum(rubricIds),
      rubricReason: reason,
      dimensions: Type.Object(
        Object.fromEntries(
          dimensionNames.map((key) => [
            key,
            Type.Object(
              {
                level: Type.Union([Type.Integer({ minimum: 0, maximum: 4 }), Type.Null()]),
                reason,
                observations: Type.Array(reference, { maxItems: 24, uniqueItems: true }),
              },
              closed,
            ),
          ]),
        ),
        closed,
      ),
      contrary: Type.Enum(['inspected', 'unresolved']),
      status: Type.Enum(['inspected', 'unresolved']),
      gaps: Type.Array(gap, { maxItems: 24 }),
      originInspections: Type.Optional(
        Type.Array(
          Type.Object(
            {
              source: sourceReference,
              quote: Type.String({ minLength: 8, maxLength: 800 }),
              reason: Type.String({ minLength: 1, maxLength: 800 }),
              relationship: Type.Enum(['independent', 'resource-own', 'derived', 'unknown']),
            },
            closed,
          ),
          { maxItems: 60 },
        ),
      ),
      ...(reference.type === 'string'
        ? {
            retainedDecisiveObservations: Type.Optional(
              Type.Array(reference, { maxItems: 1000, uniqueItems: true }),
            ),
          }
        : {}),
    },
    closed,
  );
}
export const signalJudgmentSchema = judgmentSchema(
  Type.Integer({ minimum: 0, maximum: 23 }),
  Type.Integer({ minimum: 0, maximum: 59 }),
);
export const signalBasisSchema = judgmentSchema(
  Type.String({ minLength: 1, maxLength: 100 }),
  Type.String({ minLength: 1, maxLength: 100 }),
);
// Explicit types keep the dynamically generated closed dimension object precise for consumers.
export interface SignalBasis {
  rubric: (typeof rubricIds)[number];
  rubricReason: string;
  dimensions: Record<
    (typeof dimensionNames)[number],
    { level: number | null; reason: string; observations: string[] }
  >;
  contrary: 'inspected' | 'unresolved';
  status: 'inspected' | 'unresolved';
  gaps: { reason: string; decisive: boolean; nextVerification: string }[];
  originInspections?: {
    source: string;
    quote: string;
    reason: string;
    relationship: 'independent' | 'resource-own' | 'derived' | 'unknown';
  }[];
  retainedDecisiveObservations?: string[];
}
export type SignalJudgment = Omit<
  SignalBasis,
  'dimensions' | 'originInspections' | 'retainedDecisiveObservations'
> & {
  dimensions: Record<
    (typeof dimensionNames)[number],
    { level: number | null; reason: string; observations: number[] }
  >;
  originInspections?: (Omit<NonNullable<SignalBasis['originInspections']>[number], 'source'> & {
    source: number;
  })[];
};
export const interpretationSchema = Type.Object(
  {
    policy: Type.Literal('query-relevance-v1'),
    need: reason,
    constraints: Type.Array(Type.Object({ text: reason, required: Type.Boolean() }, closed), {
      maxItems: 20,
    }),
    resourceTypes: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
      maxItems: 20,
      uniqueItems: true,
    }),
    timeWindow: Type.Union([reason, Type.Null()]),
    correctsRunId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  },
  closed,
);
export type QueryInterpretation = Static<typeof interpretationSchema>;
export const relevanceSchema = Type.Object(
  {
    value: Type.Union([Type.Enum([0, 25, 50, 75, 100]), Type.Null()]),
    reason,
    sources: Type.Array(Type.Integer({ minimum: 0, maximum: 59 }), {
      maxItems: 60,
      uniqueItems: true,
    }),
    constraints: Type.Array(
      Type.Object(
        {
          text: reason,
          state: Type.Enum(['satisfied', 'conflicts', 'unknown']),
          sources: Type.Array(Type.Integer({ minimum: 0, maximum: 59 }), {
            maxItems: 60,
            uniqueItems: true,
          }),
        },
        closed,
      ),
      { maxItems: 20 },
    ),
  },
  closed,
);
export type QueryRelevance = Static<typeof relevanceSchema>;

export const rubricCriteria: Record<SignalBasis['rubric'], readonly string[]> = {
  'software-v1': [
    'Documented capability and identity',
    'Inspectable interfaces, worked examples and operation',
    'Distinct-origin use or verification beyond promotion',
    'Supported versions, access, license and known failure scope',
  ],
  'scientific-v1': [
    'Specific claims and applicable versions',
    'Methods, baselines, artifacts and reproducibility',
    'Independent tests, critique, replication and corrections',
    'Limitations, withdrawal status and data scope',
  ],
  'news-v1': [
    'Original event, attribution and dates',
    'Original records and reporting basis',
    'Independent corroboration and contrary accounts',
    'Corrections, uncertainty and event recency',
  ],
  'discussion-v1': [
    'Actual thread problem and firsthand status',
    'Attributable concrete examples',
    'Independent experiences and substantive disagreement',
    'Context, exceptions and changed circumstances',
  ],
  'learning-v1': [
    'Audience, need and scope',
    'Worked examples and supported explanation',
    'Independent application or critique',
    'Prerequisites, exceptions and maintained guidance',
  ],
  'practice-v1': [
    'Stated need and scope',
    'Worked application and supporting explanation',
    'Distinct practitioner use and critique',
    'Exceptions, prerequisites and applicability',
  ],
  'standard-v1': [
    'Issuer and normative identity',
    'Normative and supporting material',
    'Implementation and conformance evidence',
    'Current official issuer status and limits',
  ],
  'other-v1': [
    'Explained identity and suitable rubric',
    'Appropriate inspectable supporting work',
    'Explained relevant independent scrutiny',
    'Explained currentness and limits',
  ],
};
const attentionAnchors = {
  stars: 10000,
  forks: 1000,
  downloads: 1000000,
  points: 1000,
  mentions: 10,
};

/** Current admission holds never reinterpret a historical numerical receipt. */
export function sameObservationClaim(
  entity: Pick<Entity, 'evidence'>,
  left: Entity['observations'][number],
  right: Entity['observations'][number],
) {
  const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
  return (
    left.feature === right.feature &&
    left.indicator === right.indicator &&
    normalize(left.statement) === normalize(right.statement) &&
    normalize(left.quote) === normalize(right.quote) &&
    entity.evidence.find((source) => source.id === left.evidenceId)?.uri ===
      entity.evidence.find((source) => source.id === right.evidenceId)?.uri
  );
}

const normalizedAttribution = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');

/** Shared attribution binding status; a match never proves real-world independence. */
export function originInspectionBinding(
  entity: Pick<Entity, 'kind' | 'evidence' | 'currentChecks' | 'signalBasis'>,
  inspection: NonNullable<SignalBasis['originInspections']>[number],
  asOf: string,
) {
  const unknown = (reason: string) => ({ state: 'unknown' as const, reason });
  const quote = normalizedAttribution(inspection.quote);
  if (quote.length < 8 || !normalizedAttribution(inspection.reason))
    return unknown('Attribution needs a meaningful short passage and nonempty inspection reason.');
  const source = entity.evidence.find((item) => item.id === inspection.source);
  if (!source || source.state !== 'fetched') return unknown('Attribution source is unavailable.');
  if (
    entity.signalBasis?.originInspections?.filter((item) => item.source === inspection.source)
      .length !== 1
  )
    return unknown('Multiple attribution judgments for this source remain unresolved.');
  if (
    inspection.relationship === 'unknown' ||
    !normalizedAttribution(source.origin) ||
    normalizedAttribution(source.origin) === 'unknown'
  )
    return unknown('Originating effort or relationship is unknown.');
  const now = Date.parse(asOf),
    fetched = Date.parse(source.fetchedAt);
  const checked = Date.parse(entity.currentChecks?.[source.uri] ?? source.fetchedAt);
  const published = source.publishedAt === null ? null : Date.parse(source.publishedAt);
  const days = ['publication', 'practice'].includes(entity.kind) ? 1825 : 365;
  if (
    ![now, fetched, checked].every(Number.isFinite) ||
    fetched > now ||
    checked > now ||
    (published !== null && (!Number.isFinite(published) || published > now)) ||
    (now - checked) / 86400000 > days
  )
    return unknown('Attribution source status is stale, future-dated or unavailable.');
  if (!normalizedAttribution(source.excerpt).includes(quote))
    return unknown('Reported attribution passage is unmatched in retained source text.');
  return {
    state: 'native-reviewed' as const,
    reason:
      'Matched attribution passage with a native relationship judgment; credit also depends on effort and duplicate exclusions.',
  };
}

export function assessmentHolds(
  entity: Pick<
    Entity,
    | 'kind'
    | 'observations'
    | 'evidence'
    | 'signalBasis'
    | 'currentEvidence'
    | 'currentChecks'
    | 'retainedDecisiveObservations'
  >,
  asOf: string,
  historicalV9 = false,
) {
  const selected = entity.currentEvidence
    ? new Set(entity.currentEvidence)
    : new Set(
        entity.evidence.filter((source) => source.state === 'fetched').map((source) => source.id),
      );
  const available = (item: Entity['observations'][number]) =>
    selected.has(item.evidenceId) &&
    entity.evidence.some((source) => {
      const check = Date.parse(entity.currentChecks?.[source.uri] ?? source.fetchedAt);
      const limit = ['publication', 'practice'].includes(entity.kind) ? 1825 : 365;
      return (
        source.id === item.evidenceId &&
        source.state === 'fetched' &&
        Number.isFinite(check) &&
        check <= Date.parse(asOf) &&
        Date.parse(source.fetchedAt) <= Date.parse(asOf) &&
        (source.publishedAt === null || Date.parse(source.publishedAt) <= Date.parse(asOf)) &&
        (Date.parse(asOf) - check) / 86400000 <= limit
      );
    });
  // An unavailable or unverified successor cannot erase an earlier consequential finding.
  const retired = new Set(
    entity.observations
      .filter((item) => item.verified && item.status !== 'uncertain' && available(item))
      .flatMap((item) =>
        item.supersedes.filter((id) => {
          const prior = entity.observations.find((entry) => entry.id === id);
          return historicalV9 || (prior && sameObservationClaim(entity, item, prior));
        }),
      ),
  );
  const retained = entity.observations
    .filter((item) => !retired.has(item.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const holds: { reason: string; nextVerification: string }[] = [];
  const normalizeClaim = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
  const resolvedByCurrentRefutation = (item: Entity['observations'][number]) =>
    retained.some(
      (successor) =>
        successor.id !== item.id &&
        successor.verified &&
        available(successor) &&
        successor.status === 'contradicted' &&
        successor.feature === item.feature &&
        successor.indicator === item.indicator &&
        normalizeClaim(successor.statement) === normalizeClaim(item.statement) &&
        normalizeClaim(successor.quote) === normalizeClaim(item.quote) &&
        entity.evidence.find((source) => source.id === successor.evidenceId)?.uri ===
          entity.evidence.find((source) => source.id === item.evidenceId)?.uri,
    );
  for (const item of retained) {
    if (item.feature === 'risk' && ['material', 'decisive'].includes(item.indicator)) {
      if (resolvedByCurrentRefutation(item)) continue;
      if (item.verified && available(item) && item.status === 'contradicted') continue;
      if (!item.verified || !available(item) || item.status === 'uncertain')
        holds.push({
          reason: `Retained ${item.indicator} adverse evidence is unresolved: ${item.statement}`,
          nextVerification:
            'Check the retained adverse finding against current original and contrary evidence; unavailable retrieval is not disproof.',
        });
    }
    const dimensions = ['basis', 'work', 'applicability'].filter((name) =>
      entity.signalBasis?.dimensions[name as 'basis'].observations.includes(item.id),
    );
    if (
      !historicalV9 &&
      !dimensions.length &&
      (entity.signalBasis?.retainedDecisiveObservations?.includes(item.id) ||
        entity.retainedDecisiveObservations?.includes(item.id))
    )
      dimensions.push('previously decisive');
    if (
      item.feature !== 'risk' &&
      item.status === 'contradicted' &&
      (item.feature === 'defining' || dimensions.length)
    )
      holds.push({
        reason: item.verified
          ? `Retained decisive ${dimensions.join('/') || 'defining'} evidence is contradicted: ${item.statement}`
          : `Retained decisive ${dimensions.join('/') || 'defining'} contradiction is unverified: ${item.statement}`,
        nextVerification:
          'Resolve the decisive contradiction with a source-bound successor judgment, preserving the earlier finding.',
      });
    if (item.feature !== 'risk' && dimensions.length && item.status === 'uncertain')
      holds.push({
        reason: `Retained decisive ${dimensions.join('/')} evidence is uncertain: ${item.statement}`,
        nextVerification:
          'Inspect the uncertain decisive finding before treating the assessment as completed.',
      });
  }
  return holds;
}

/** Each successor consumes retained judgments under its declared replay policy. */
export function assessSuccessor(
  entity: Pick<
    Entity,
    | 'kind'
    | 'identity'
    | 'observations'
    | 'evidence'
    | 'signalBasis'
    | 'currentChecks'
    | 'currentEvidence'
  >,
  asOf: string,
  active: Entity['observations'],
  originGroups: Map<string, string>,
  policy:
    | 'signal-strength-v7'
    | 'signal-strength-v8'
    | 'signal-strength-v9'
    | 'signal-strength-v10' = 'signal-strength-v7',
): Assessment {
  const basis = entity.signalBasis;
  if (basis && !Value.Check(signalBasisSchema, basis)) throw new Error('invalid_signal_basis');
  const invalidDates = new Set(
    entity.evidence
      .filter((source) => {
        const check = entity.currentChecks?.[source.uri] ?? source.fetchedAt;
        const maxAge = entity.kind === 'publication' || entity.kind === 'practice' ? 1825 : 365;
        return (
          !Number.isFinite(Date.parse(check)) ||
          !Number.isFinite(Date.parse(source.fetchedAt)) ||
          Date.parse(source.fetchedAt) > Date.parse(asOf) ||
          (source.publishedAt !== null &&
            (!Number.isFinite(Date.parse(source.publishedAt)) ||
              Date.parse(source.publishedAt) > Date.parse(asOf))) ||
          Date.parse(check) > Date.parse(asOf) ||
          (Date.parse(asOf) - Date.parse(check)) / 86400000 > maxAge
        );
      })
      .map((source) => source.id),
  );
  const sourceBound = active
    .filter((item) => item.verified && item.status === 'supported')
    .sort((a, b) => a.id.localeCompare(b.id));
  const usable = sourceBound.filter((item) => !invalidDates.has(item.evidenceId));
  const materialRisks = usable.filter(
    (item) => item.feature === 'risk' && ['material', 'decisive'].includes(item.indicator),
  );
  const defining = usable.some((item) => item.feature === 'defining');
  const failures: { reason: string; nextVerification: string }[] = [];
  if (['signal-strength-v9', 'signal-strength-v10'].includes(policy))
    failures.push(...assessmentHolds(entity, asOf, policy === 'signal-strength-v9'));
  const dateGaps: { reason: string; decisive: boolean; nextVerification: string }[] = [];
  for (const item of sourceBound.filter(
    (entry) => entry.feature === 'risk' && invalidDates.has(entry.evidenceId),
  )) {
    const gap = {
      reason: `Retained ${item.indicator} adverse evidence has unavailable current status; it cannot be silently excluded.`,
      decisive: ['material', 'decisive'].includes(item.indicator),
      nextVerification:
        'Check whether the retained adverse finding still applies to the current version and scope.',
    };
    dateGaps.push(gap);
    if (gap.decisive) failures.push(gap);
  }
  if (!defining)
    failures.push({
      reason: 'No supported defining basis.',
      nextVerification: 'Inspect an original source defining the resource and its scope.',
    });
  if (entity.identity !== 'resolved')
    failures.push({
      reason: 'Resource identity is unresolved.',
      nextVerification: 'Resolve the canonical resource identity against original sources.',
    });
  if (!basis)
    failures.push({
      reason: 'No type rubric inspection was returned.',
      nextVerification:
        'Inspect decisive supporting work, contrary evidence and current status under a suitable rubric.',
    });
  if (
    basis &&
    ((entity.kind === 'software' && basis.rubric !== 'software-v1') ||
      (entity.kind === 'standard' && basis.rubric !== 'standard-v1') ||
      (['model', 'dataset'].includes(entity.kind) && basis.rubric !== 'scientific-v1'))
  )
    failures.push({
      reason: 'Rubric does not fit the declared resource type.',
      nextVerification: 'Use the reviewed rubric for this resource type.',
    });
  if (basis?.contrary !== 'inspected' || basis?.status !== 'inspected')
    failures.push({
      reason: 'Decisive contrary or status inspection is unresolved.',
      nextVerification: 'Inspect relevant contrary accounts and authoritative current status.',
    });
  for (const item of basis?.gaps ?? []) if (item.decisive) failures.push(item);
  const contradicted = active.some(
    (item) => item.verified && item.feature === 'defining' && item.status === 'contradicted',
  );
  if (contradicted)
    failures.push({
      reason: 'Defining evidence is contradicted.',
      nextVerification: 'Resolve the defining contradiction with original and contrary evidence.',
    });
  const weights = basis?.rubric === 'standard-v1' ? [40, 20, 10, 30] : [25, 25, 25, 25];
  const features: Assessment['features'] = {};
  const missing: string[] = [];
  const knownIds = new Set(entity.observations.map((item) => item.id));
  const primary = entity.evidence.filter((source) =>
    usable.some((item) => item.evidenceId === source.id && item.feature === 'defining'),
  );
  const primaryGroups = new Set(primary.map((source) => originGroups.get(source.id)));
  const sharedHosts = new Set([
    'arxiv.org',
    'doi.org',
    'reddit.com',
    'news.ycombinator.com',
    'youtube.com',
  ]);
  const owner = (uri: string) => {
    const parsed = new URL(uri);
    if (['github.com', 'api.github.com', 'raw.githubusercontent.com'].includes(parsed.hostname))
      return `github:${parsed.pathname
        .replace(/^\/repos\//, '/')
        .split('/')[1]
        ?.toLowerCase()}`;
    return parsed.hostname.replace(/^www\./, '').toLowerCase();
  };
  const reviewedOrigin = (item: Entity['observations'][number]) => {
    const inspections =
      basis?.originInspections?.filter((entry) => entry.source === item.evidenceId) ?? [];
    const inspection = inspections.length === 1 ? inspections[0] : undefined;
    return inspection &&
      originInspectionBinding(entity, inspection, asOf).state === 'native-reviewed'
      ? inspection
      : undefined;
  };
  const independent = (item: Entity['observations'][number]) => {
    const source = entity.evidence.find((entry) => entry.id === item.evidenceId)!;
    if (policy === 'signal-strength-v10') {
      const inspection = reviewedOrigin(item);
      return !!(
        item.independent &&
        inspection?.relationship === 'independent' &&
        originGroups.has(source.id) &&
        !primaryGroups.has(originGroups.get(source.id)) &&
        !primary.some(
          (entry) => normalizedAttribution(entry.origin) === normalizedAttribution(source.origin),
        )
      );
    }
    return (
      item.independent &&
      source.origin.trim().toLowerCase() !== 'unknown' &&
      !primaryGroups.has(originGroups.get(source.id)) &&
      (!primary.some((entry) => owner(entry.uri) === owner(source.uri)) ||
        sharedHosts.has(new URL(source.uri).hostname))
    );
  };
  const ceilingReasons: string[] = [];
  const provenanceGaps: { reason: string; decisive: boolean; nextVerification: string }[] = [];
  if (policy === 'signal-strength-v10') {
    const duplicates = new Map<string, string[]>();
    for (const source of entity.evidence.filter((entry) =>
      usable.some((item) => item.evidenceId === entry.id),
    )) {
      const group = originGroups.get(source.id);
      if (group) duplicates.set(group, [...(duplicates.get(group) ?? []), source.id]);
    }
    for (const ids of [...duplicates.values()]
      .map((ids) => ids.sort())
      .filter((ids) => ids.length > 1)
      .sort((a, b) => a[0]!.localeCompare(b[0]!)))
      ceilingReasons.push(
        `Duplicated acquired material counts once: ${ids.slice(0, 20).join(', ')}${ids.length > 20 ? ` and ${ids.length - 20} further retained sources` : ''}. Payload equality does not establish creator identity.`,
      );
  }
  for (const [index, name] of dimensionNames.entries()) {
    const judgment = basis?.dimensions[name];
    if (judgment?.observations.some((id) => !knownIds.has(id)))
      throw new Error('unbound_rubric_observation');
    const permitted = {
      basis: ['defining', 'authority'],
      work: ['verification', 'maturity', 'adoption', 'corroboration', 'risk'],
      scrutiny: ['verification', 'adoption', 'corroboration', 'risk'],
      applicability: [
        'currentness',
        'authority',
        'risk',
        ...(policy !== 'signal-strength-v7' && basis?.rubric !== 'standard-v1'
          ? ['verification']
          : []),
      ],
    };
    const bound = usable.filter(
      (item) =>
        judgment?.observations.includes(item.id) &&
        permitted[name].includes(item.feature) &&
        !(
          name === 'applicability' &&
          item.feature === 'verification' &&
          item.indicator !== 'inspectable'
        ) &&
        item.indicator !== 'unknown' &&
        !(name === 'work' && ['attention', 'promotion', 'mention'].includes(item.indicator)),
    );
    const support = bound.filter((item) => item.feature !== 'risk');
    const level = judgment?.level;
    if (
      sourceBound.some(
        (item) => judgment?.observations.includes(item.id) && invalidDates.has(item.evidenceId),
      )
    ) {
      const missingDate = {
        reason: `${name} evidence is future-dated or stale; it earns no current credit.`,
        decisive: name !== 'scrutiny',
        nextVerification:
          'Inspect current source status and applicable evidence, preserving the earlier snapshot.',
      };
      dateGaps.push(missingDate);
      if (missingDate.decisive) failures.push(missingDate);
    }
    // These ceilings validate the declared evidence class, not its factual entailment.
    // An ordinal label cannot promote inspectability to replication or secondary reporting to issuer status.
    const supportedLevel = (item: Entity['observations'][number]) => {
      if (item.feature === 'risk') return 0;
      if (name === 'basis')
        return item.feature === 'defining'
          ? basis?.rubric === 'standard-v1'
            ? 1
            : 4
          : ({ secondary: 1, primary: 2, recognized: 3, 'formal-current': 4 }[
              item.indicator as 'secondary'
            ] ?? 0);
      if (name === 'applicability')
        return item.feature === 'verification'
          ? item.indicator === 'inspectable'
            ? 1
            : 0
          : item.feature === 'currentness'
            ? ({ current: 4, 'minor-gaps': 3, mixed: 2, stale: 1 }[item.indicator as 'current'] ??
              0)
            : ({ secondary: 1, primary: 2, recognized: 3, 'formal-current': 4 }[
                item.indicator as 'secondary'
              ] ?? 0);
      if (item.feature === 'verification')
        return (
          {
            inspectable: 1,
            'worked-example': 2,
            'independent-applied': independent(item) ? 3 : policy === 'signal-strength-v10' ? 0 : 2,
            replicated: independent(item) ? 4 : policy === 'signal-strength-v10' ? 0 : 2,
          }[item.indicator as 'inspectable'] ?? 0
        );
      if (item.feature === 'maturity')
        return (
          { documented: 1, 'stable-interface': 2, 'supported-or-complete': 2, 'track-record': 3 }[
            item.indicator as 'documented'
          ] ?? 0
        );
      if (item.feature === 'corroboration')
        return item.indicator === 'applied' ? (independent(item) ? 3 : 2) : 0;
      return (
        {
          'single-user': 2,
          'multiple-users': independent(item) ? 3 : 2,
          sustained: independent(item) ? 3 : 2,
          broad: independent(item) ? 4 : 2,
        }[item.indicator as 'single-user'] ?? 0
      );
    };
    const ceiling = Math.max(0, ...bound.map(supportedLevel));
    const uninspectedOrigins =
      policy === 'signal-strength-v10' && ['work', 'scrutiny'].includes(name)
        ? bound.filter((item) => {
            if (item.feature === 'risk') return false;
            if (
              !item.independent &&
              !['independent-applied', 'replicated'].includes(item.indicator)
            )
              return false;
            const inspection = reviewedOrigin(item);
            return !inspection || inspection.relationship === 'unknown';
          })
        : [];
    if (uninspectedOrigins.length) {
      const gap = {
        reason: `${name} originating effort/relationship is unknown for ${[...new Set(uninspectedOrigins.map((item) => item.evidenceId))].sort().join(', ')}; asserted independence earns no origin-dependent credit.`,
        decisive: name === 'work' && ceiling === 0,
        nextVerification:
          'Inspect a short attribution passage and explain who generated the underlying effort and its relationship to the resource and other efforts.',
      };
      provenanceGaps.push(gap);
      if (gap.decisive) failures.push(gap);
    }
    if (level !== undefined && level !== null && level > ceiling && name !== 'scrutiny')
      ceilingReasons.push(
        `${name} proposed level ${level} exceeds the inspected evidence-class ceiling ${ceiling}; only supported credit is retained.`,
      );
    if (
      basis?.rubric === 'standard-v1' &&
      name === 'basis' &&
      !support.some(
        (item) =>
          item.feature === 'authority' &&
          ['primary', 'recognized', 'formal-current'].includes(item.indicator),
      )
    )
      failures.push({
        reason: 'Normative identity lacks inspected issuer evidence.',
        nextVerification: 'Inspect the issuing authority and normative identity.',
      });
    if (
      basis?.rubric === 'standard-v1' &&
      name === 'applicability' &&
      !support.some((item) => item.feature === 'authority' && item.indicator === 'formal-current')
    )
      failures.push({
        reason: 'Current official standard status is unresolved.',
        nextVerification: 'Inspect the issuer catalogue and current official status.',
      });
    let value =
      level === null || level === undefined || !bound.length || (level > 0 && !support.length)
        ? 0
        : Math.min(level, ceiling) / 4;
    let contribution = value * weights[index]!;
    if (name === 'scrutiny') {
      // Publisher/origin/mirror overlap cannot manufacture independent scrutiny.
      const independentSupport = support.filter(
        (item) =>
          independent(item) &&
          item.indicator !== 'attention' &&
          !['promotion', 'mention', 'unknown'].includes(item.indicator),
      );
      const origins = new Set(
        independentSupport.map((item) =>
          policy === 'signal-strength-v10'
            ? entity.evidence
                .find((entry) => entry.id === item.evidenceId)!
                .origin.trim()
                .toLowerCase()
                .replace(/\s+/g, ' ')
            : originGroups.get(item.evidenceId)!,
        ),
      );
      let originCount = origins.size;
      if (policy === 'signal-strength-v10') {
        const supportUnits: Set<string>[] = [];
        for (const item of independentSupport) {
          const source = entity.evidence.find((entry) => entry.id === item.evidenceId)!;
          const keys = new Set([
            `effort:${source.origin.trim().toLowerCase().replace(/\s+/g, ' ')}`,
            `material:${originGroups.get(item.evidenceId)}`,
          ]);
          for (let index = supportUnits.length - 1; index >= 0; index--) {
            if ([...keys].some((key) => supportUnits[index]!.has(key))) {
              supportUnits[index]!.forEach((key) => keys.add(key));
              supportUnits.splice(index, 1);
            }
          }
          supportUnits.push(keys);
        }
        originCount = supportUnits.length;
      }
      if (!originCount) contribution = 0;
      else if (originCount === 1) contribution = Math.min(contribution, weights[index]! / 2);
      if (basis?.rubric === 'software-v1' && level !== null && level !== undefined) {
        const attention = Math.max(
          0,
          ...bound
            .filter(
              (item) =>
                item.feature === 'adoption' && item.indicator === 'attention' && item.attention,
            )
            .map(
              (item) =>
                5 *
                Math.min(
                  1,
                  Math.log10(1 + item.attention!.value) /
                    Math.log10(1 + attentionAnchors[item.attention!.metric]),
                ),
            ),
        );
        contribution = Math.max(contribution, attention);
      }
      value = contribution / weights[index]!;
    }
    // Established material failures cap the affected work/limits; adverse scrutiny never earns positive credit.
    const materialFailure = materialRisks.length > 0;
    if (materialFailure && ['work', 'applicability'].includes(name)) {
      value = Math.min(value, name === 'work' ? 0.25 : 0);
      contribution = value * weights[index]!;
    }
    if (
      level === null ||
      level === undefined ||
      !bound.length ||
      (level > 0 && !support.length) ||
      (policy === 'signal-strength-v10' && name === 'work' && level > 0 && ceiling === 0) ||
      (policy === 'signal-strength-v10' && name === 'scrutiny' && uninspectedOrigins.length > 0)
    )
      missing.push(name);
    features[name] = {
      value,
      contribution,
      observations: [
        ...new Set([
          ...bound.map((item) => item.id),
          ...(materialFailure && ['work', 'applicability'].includes(name)
            ? materialRisks.map((item) => item.id)
            : []),
        ]),
      ].sort(),
      state: missing.includes(name) ? 'unknown' : 'observed',
    };
  }
  // A defining-only description cannot masquerade as a completed quality assessment.
  if (missing.includes('basis') || missing.includes('work') || missing.includes('applicability'))
    failures.push({
      reason: 'Decisive identity, supporting work or applicability remains unknown.',
      nextVerification:
        'Inspect identity, supporting work and applicable versions, scope and limitations.',
    });
  const decisiveSources = new Set(
    ['basis', 'work', 'applicability'].flatMap(
      (key) =>
        features[key]?.observations.flatMap((id) =>
          usable.filter((item) => item.id === id).map((item) => item.evidenceId),
        ) ?? [],
    ),
  );
  for (const source of entity.evidence.filter((item) => decisiveSources.has(item.id))) {
    const check = entity.currentChecks?.[source.uri] ?? source.fetchedAt;
    const maxAge =
      entity.kind === 'standard'
        ? 365
        : entity.kind === 'publication' || entity.kind === 'practice'
          ? 1825
          : 365;
    if (
      (source.publishedAt && Date.parse(source.publishedAt) > Date.parse(asOf)) ||
      Date.parse(check) > Date.parse(asOf) ||
      (Date.parse(asOf) - Date.parse(check)) / 86400000 > maxAge
    )
      failures.push({
        reason: 'Decisive source status is future-dated or stale.',
        nextVerification:
          'Check authoritative current status and applicable versions, preserving the earlier evidence.',
      });
  }
  const gaps = [...(basis?.gaps ?? []), ...dateGaps, ...provenanceGaps];
  const state = failures.length
    ? 'unassessed'
    : missing.length || gaps.length
      ? 'provisional'
      : 'assessed';
  const allReasons = [
    ...failures.map((item) => item.reason),
    ...ceilingReasons,
    ...materialRisks.map((item) => `Supported ${item.indicator} limitation: ${item.statement}`),
    ...gaps.filter((item) => !item.decisive).map((item) => item.reason),
  ];
  const reasons = policy === 'signal-strength-v10' ? [...new Set(allReasons)].sort() : allReasons;
  return {
    policy,
    asOf,
    score: failures.length
      ? null
      : Math.round(Object.values(features).reduce((sum, item) => sum + item.contribution, 0)),
    features,
    risk: 0,
    coverage: (4 - missing.length) / 4,
    missing,
    state,
    rubric: basis?.rubric ?? null,
    disposition:
      state === 'assessed'
        ? 'completed'
        : state === 'provisional'
          ? 'provisional'
          : 'not-scoreable',
    reasons:
      policy === 'signal-strength-v10'
        ? reasons
            .slice(0, 39)
            .map((item) => item.slice(0, 1600))
            .concat(
              reasons.length > 39
                ? [
                    `${reasons.length - 39} further reasons exceed the summary boundary; retained evidence and hold disposition remain inspectable.`,
                  ]
                : [],
            )
        : reasons,
    nextVerification: failures[0]?.nextVerification ?? gaps[0]?.nextVerification ?? null,
  };
}
