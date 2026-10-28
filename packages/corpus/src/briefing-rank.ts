import {
  DEFAULT_VELOCITY_WEIGHT,
  effectiveRankingWeights,
  rankingTotal,
  type BriefingRankInput,
  type RankingExplanation,
} from './briefing/schema.js';

const DAY = 86_400_000;
const clamp = (value: number, low = 0, high = 100) => Math.max(low, Math.min(high, value));
const normalized = (value: string) => value.normalize('NFKC').toLocaleLowerCase();

function relevance(input: BriefingRankInput): RankingExplanation['components']['relevance'] {
  const candidates = input.items.filter(({ item, interests, source }) =>
    interests.some(
      (interest) =>
        interest.enabled &&
        (!interest.sources.length || interest.sources.includes(source.id)) &&
        !interest.excludeTerms.some((term) =>
          normalized(`${item.title} ${item.excerpt}`).includes(normalized(term)),
        ),
    ),
  );
  const weighted = new Map<string, { points: number; weight: number; interestId: string }>();
  for (const { item, interests, source } of candidates) {
    const text = normalized(`${item.title} ${item.excerpt}`);
    for (const interest of interests) {
      if (!interest.enabled || (interest.sources.length && !interest.sources.includes(source.id)))
        continue;
      if (interest.excludeTerms.some((term) => text.includes(normalized(term)))) continue;
      const matched = interest.includeTerms.filter((term) =>
        text.includes(normalized(term)),
      ).length;
      if (matched) {
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
    const age = Math.max(0, now - Date.parse(item.observedAt));
    return { score: 100 * 2 ** (-age / (interest.halfLifeDays * DAY)), interestId: interest.id };
  });
  return {
    value: Math.round(Math.max(...scores.map((entry) => entry.score))),
    status: 'available',
    reason:
      'Exponential decay from host observedAt using the matching interest half-life (default 18 hours).',
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
  const groups = new Map<string, typeof input.metrics>();
  for (const metric of input.metrics) {
    const key = `${metric.platform}:${metric.name}`;
    groups.set(key, [...(groups.get(key) ?? []), metric]);
  }
  const changes = [...groups.entries()].flatMap(([key, rows]) => {
    const sorted = [...rows].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    if (sorted.length < 2) return [];
    const first = sorted[0]!;
    const last = sorted.at(-1)!;
    const hours = (Date.parse(last.observedAt) - Date.parse(first.observedAt)) / 3_600_000;
    if (!(hours > 0)) return [];
    const perHour = Math.max(0, last.value - first.value) / hours;
    return [
      {
        key,
        score: clamp((100 * perHour) / Math.max(1, last.value)),
        refs: sorted.map((row) => row.id),
      },
    ];
  });
  if (!changes.length)
    return {
      value: null,
      status: 'insufficient-observations',
      reason: 'Velocity needs at least two time-ordered observations for one platform and metric.',
      refs: [],
    };
  const best = changes.reduce((a, b) => (b.score > a.score ? b : a));
  return {
    value: Math.round(best.score),
    status: 'available',
    reason: `Highest nonnegative per-hour change within ${best.key}; values from different platforms are never added.`,
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
