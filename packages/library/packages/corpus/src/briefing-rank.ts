import {
  DEFAULT_VELOCITY_WEIGHT,
  effectiveRankingWeights,
  rankingTotal,
  type BriefingRankInput,
  type RankingExplanation,
} from './briefing/schema.js';
import { summarizeBriefingPulse } from './briefing-pulse.js';
import { briefingEventFreshness } from './briefing-event-freshness.js';

const DAY = 86_400_000;
const clamp = (value: number, low = 0, high = 100) => Math.max(low, Math.min(high, value));
const normalized = (value: string) => value.normalize('NFKC').toLocaleLowerCase();

export type BriefingMatchedTerms = { interestId: string; terms: string[] };

function itemInterestTerms(
  item: BriefingRankInput['items'][number]['item'],
  interest: BriefingRankInput['items'][number]['interests'][number],
  sourceId: string,
) {
  if (!interest.enabled || (interest.sources.length > 0 && !interest.sources.includes(sourceId)))
    return [];
  const text = normalized(`${item.title} ${item.excerpt}`);
  if (interest.excludeTerms.some((term) => text.includes(normalized(term)))) return [];
  return interest.includeTerms.filter((term) => text.includes(normalized(term)));
}

/** Read-time term matches use the same exact retained inputs as the score and never rewrite Story records. */
export function briefingMatchedTerms(input: BriefingRankInput): BriefingMatchedTerms[] {
  const matches = new Map<string, Set<string>>();
  for (const match of input.story.interestMatches) {
    const prior = matches.get(match.interestId) ?? new Set<string>();
    for (const term of match.matchedTerms) prior.add(term);
    matches.set(match.interestId, prior);
  }
  for (const { item, source, interests } of input.items) {
    for (const interest of interests) {
      const terms = itemInterestTerms(item, interest, source.id);
      if (!terms.length) continue;
      const prior = matches.get(interest.id) ?? new Set<string>();
      for (const term of terms) prior.add(term);
      matches.set(interest.id, prior);
    }
  }
  return [...matches]
    .map(([interestId, terms]) => ({
      interestId,
      terms: [...terms].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.interestId.localeCompare(right.interestId));
}

function relevance(input: BriefingRankInput): RankingExplanation['components']['relevance'] {
  const weighted = new Map<string, { points: number; weight: number; interestId: string }>();
  for (const { item, interests, source } of input.items) {
    for (const interest of interests) {
      const matched = itemInterestTerms(item, interest, source.id).length;
      if (matched > 0) {
        const candidate = {
          points: (matched / interest.includeTerms.length) * 100,
          weight: interest.weight,
          interestId: interest.id,
        };
        if (!weighted.has(interest.id) || candidate.points > weighted.get(interest.id)!.points)
          weighted.set(interest.id, candidate);
      }
    }
  }
  const entries = [...weighted.values()];
  const weight = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (!weight)
    return {
      value: null,
      status: 'unknown',
      reason: 'No enabled configured interest terms matched this story.',
      refs: [],
    };
  const undone = new Set(
    input.feedback
      .filter((entry) => entry.action === 'undo')
      .map((entry) => entry.undoesFeedbackId),
  );
  const adjustments = input.feedback.filter(
    (entry) =>
      entry.targetKind === 'story' &&
      entry.targetId === input.story.id &&
      !undone.has(entry.id) &&
      (entry.action === 'more' || entry.action === 'less'),
  );
  const base = entries.reduce((sum, entry) => sum + entry.points * entry.weight, 0) / weight;
  const adjustment = adjustments.reduce(
    (sum, entry) => sum + (entry.action === 'more' ? 10 : -10),
    0,
  );
  return {
    value: Math.round(clamp(base + adjustment)),
    status: 'available',
    reason: `Share of configured include terms matched across enabled, source-scoped interests; excluded terms remove a match${adjustment ? `; active explicit feedback adjusts by ${adjustment > 0 ? '+' : ''}${adjustment}` : ''}.`,
    refs: [
      ...new Set([
        ...entries.map((entry) => entry.interestId),
        ...adjustments.map((entry) => entry.id),
      ]),
    ],
  };
}

function freshness(
  input: BriefingRankInput,
  now: number,
): RankingExplanation['components']['freshness'] {
  const events = input.events;
  if (events !== undefined) {
    const targets = input.items.map(({ item, source, interests }) => ({
      itemId: item.id,
      interests: interests.filter(
        (interest) => itemInterestTerms(item, interest, source.id).length > 0,
      ),
    }));
    return briefingEventFreshness(events, targets, now);
  }
  const values = input.items.flatMap(({ item, interests }) =>
    interests
      .filter((interest) => interest.enabled && interest.weight > 0)
      .map((interest) => ({ interest, item })),
  );
  if (!values.length)
    return {
      value: null,
      status: 'unknown',
      reason: 'No enabled positive-weight interest has a freshness half-life.',
      refs: [],
    };
  const scores = values.map(({ interest, item }) => {
    const observedAt = Date.parse(item.observedAt);
    const publishedAt = item.publishedAt === null ? NaN : Date.parse(item.publishedAt);
    // A feed's date is source-reported. Reject dates after the host observation so a
    // future-dated entry cannot gain freshness it has not established.
    const usePublishedAt = Number.isFinite(publishedAt) && publishedAt <= observedAt;
    const age = Math.max(0, now - (usePublishedAt ? publishedAt : observedAt));
    return {
      score: 100 * 2 ** (-age / (interest.halfLifeDays * DAY)),
      interestId: interest.id,
      usePublishedAt,
    };
  });
  return {
    value: Math.round(Math.max(...scores.map((entry) => entry.score))),
    status: 'available',
    reason: scores.some((entry) => entry.usePublishedAt)
      ? 'Exponential decay from source-reported publishedAt when no later than host observedAt, otherwise from host observedAt; source dates are not independently verified. Uses the configured interest half-life (default 18 hours).'
      : 'Exponential decay from host observedAt because no usable source-reported publishedAt is available. Uses the configured interest half-life (default 18 hours).',
    refs: [...new Set(scores.map((entry) => entry.interestId))],
  };
}

function sourcePriority(
  input: BriefingRankInput,
): RankingExplanation['components']['sourcePriority'] {
  if (!input.items.length)
    return { value: null, status: 'unknown', reason: 'No source records are available.', refs: [] };
  const scores = input.items.map(({ source }) => ({
    value: (source.priority + 100) / 2,
    id: source.id,
  }));
  return {
    value: Math.round(scores.reduce((sum, entry) => sum + entry.value, 0) / scores.length),
    status: 'available',
    reason: 'Mean configured source priority normalized from [-100, 100] to [0, 100].',
    refs: [...new Set(scores.map((entry) => entry.id))],
  };
}

function novelty(input: BriefingRankInput): RankingExplanation['components']['novelty'] {
  if (!input.items.length || input.items.some(({ seen }) => seen.status === 'unknown'))
    return {
      value: null,
      status: 'unknown',
      reason: 'Seen tracking is unknown for at least one story item.',
      refs: [],
    };
  const unseen = input.items.filter(({ seen }) => seen.status === 'not-seen-since-capture');
  return {
    value: unseen.length ? 100 : 0,
    status: 'available',
    reason: unseen.length
      ? 'At least one retained item has not been seen since capture.'
      : 'All retained items have recorded seen state.',
    refs: unseen.map(({ item }) => item.id),
  };
}

function velocity(input: BriefingRankInput): RankingExplanation['components']['velocity'] {
  const changes = summarizeBriefingPulse(input.metrics)
    .filter(
      (pulse) =>
        pulse.status === 'available' && pulse.latestValue !== null && pulse.perHour !== null,
    )
    .map((pulse) => ({
      key: `${pulse.itemId}:${pulse.platform}:${pulse.name}:${pulse.scope}:${pulse.method}:${pulse.sourceRef ?? 'no-source-ref'}`,
      score: clamp((100 * pulse.perHour!) / Math.max(1, pulse.latestValue!)),
      refs: input.metrics
        .filter(
          (metric) =>
            metric.itemId === pulse.itemId &&
            metric.platform === pulse.platform &&
            metric.name === pulse.name &&
            metric.scope === pulse.scope &&
            metric.method === pulse.method &&
            metric.sourceRef === pulse.sourceRef,
        )
        .map((metric) => metric.id),
    }));
  if (!changes.length)
    return {
      value: null,
      status: 'insufficient-observations',
      reason:
        'Velocity needs two unambiguous time-ordered observations for one item and exact source provenance stream.',
      refs: [],
    };
  const best = changes.reduce((a, b) => (b.score > a.score ? b : a));
  return {
    value: Math.round(best.score),
    status: 'available',
    reason: `Highest per-hour change within ${best.key}; observations from different item or source provenance streams are never combined.`,
    refs: best.refs,
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function inputDigest(input: BriefingRankInput) {
  const bytes = new TextEncoder().encode(canonical(input));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function rankBriefingStory(
  input: BriefingRankInput,
  options: { now?: string | number; velocityWeight?: number } = {},
): Promise<RankingExplanation> {
  const now =
    typeof options.now === 'string' ? Date.parse(options.now) : (options.now ?? Date.now());
  if (!Number.isFinite(now)) throw new TypeError('Ranking time must be a valid instant.');
  const velocityWeight = options.velocityWeight ?? DEFAULT_VELOCITY_WEIGHT;
  if (!Number.isFinite(velocityWeight) || velocityWeight < 0 || velocityWeight > 0.25)
    throw new RangeError('Velocity weight must be between 0 and 0.25.');
  const components = {
    relevance: relevance(input),
    freshness: freshness(input, now),
    sourcePriority: sourcePriority(input),
    novelty: novelty(input),
    velocity: velocity(input),
  };
  const weights = effectiveRankingWeights(velocityWeight);
  return {
    storyId: input.story.id,
    formula: 'briefing-linear-v1',
    components,
    weights,
    completeness: Object.values(components).every((component) => component.status === 'available')
      ? 'complete'
      : 'partial',
    total: rankingTotal(components, weights),
    computedAt: new Date(now).toISOString(),
    inputDigest: await inputDigest(input),
  };
}
