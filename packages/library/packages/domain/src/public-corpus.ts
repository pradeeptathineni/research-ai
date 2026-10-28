import type { EvidenceBundle } from './evidence-exchange.js';
import type { SignalReview, assessSignalQuality } from './signal-quality.js';

export interface ClaimReview {
  claimId: string;
  basis: 'stable' | 'volatile' | 'unknown';
  reviewAfterDays: number | null;
}

export interface PublicAdmission {
  file: string;
  digest: string;
  category: string;
  reviewedAt: string;
  reviewer: 'human' | 'agent-reviewed';
  rationale: string;
  claimReviews: ClaimReview[];
  state?: 'admitted' | 'withdrawn';
  quality?: SignalReview;
}

export interface PublicOption {
  quality?: ReturnType<typeof assessSignalQuality>[number];
  id: string;
  type: string;
  bundleId: string;
  bundleDigest: string;
  name: string;
  uri: string;
  category: string;
  concepts: string[];
  need: string;
  reason: string;
  disposition: EvidenceBundle['candidates'][number]['disposition'];
  limitations: string[];
  reviewedAt: string;
  reviewer: PublicAdmission['reviewer'];
  publishedAt: string;
  claims: Array<
    EvidenceBundle['claims'][number] & {
      freshness: 'current' | 'due' | 'unknown';
      review: ClaimReview;
    }
  >;
  sources: EvidenceBundle['sources'];
}

/** Freshness assesses a claim's observation, never the export or review timestamp. */
export function claimFreshness(
  claim: EvidenceBundle['claims'][number],
  sources: EvidenceBundle['sources'],
  review: ClaimReview,
  asOf: string,
): 'current' | 'due' | 'unknown' {
  if (review.basis === 'unknown') return 'unknown';
  const bound = sources.filter((source) => claim.source_ids.includes(source.id));
  const times = bound.map((source) => Date.parse(source.observed_at ?? ''));
  const now = Date.parse(asOf);
  if (!Number.isFinite(now)) return 'unknown';
  if (!bound.length || times.some((time) => !Number.isFinite(time) || time > now)) return 'unknown';
  if (review.basis === 'stable') return 'current';
  return times.some((time) => now - time > (review.reviewAfterDays ?? 0) * 86_400_000)
    ? 'due'
    : 'current';
}

export function projectPublicOptions(
  bundle: EvidenceBundle,
  admission: PublicAdmission,
  asOf: string,
): PublicOption[] {
  return bundle.candidates.map((candidate) => {
    const claims = bundle.claims.filter((claim) => candidate.claim_ids.includes(claim.id));
    const sources = bundle.sources.filter((source) =>
      claims.some((claim) => claim.source_ids.includes(source.id)),
    );
    return {
      id: candidate.id,
      type: admission.file.includes('/') ? admission.file.split('/')[0]! : 'legacy',
      bundleId: bundle.bundle_id,
      bundleDigest: admission.digest,
      name: candidate.name,
      uri: candidate.canonical_uri,
      category: admission.category,
      concepts: bundle.need.concept_ids ?? [],
      need: bundle.need.query,
      reason: candidate.reason,
      disposition: candidate.disposition,
      limitations: [...bundle.limitations, ...candidate.limitations],
      reviewedAt: admission.reviewedAt,
      reviewer: admission.reviewer,
      publishedAt: bundle.created_at,
      claims: claims.map((claim) => ({
        ...claim,
        review: admission.claimReviews.find((review) => review.claimId === claim.id)!,
        freshness: claimFreshness(
          claim,
          sources,
          admission.claimReviews.find((review) => review.claimId === claim.id)!,
          asOf,
        ),
      })),
      sources,
    };
  });
}

/** Static exports retain review inputs so a later browser visit can recompute due dates. */
export function refreshPublicFreshness(options: PublicOption[], asOf: string): PublicOption[] {
  return options.map((option) => ({
    ...option,
    claims: option.claims.map((claim) => ({
      ...claim,
      freshness: claimFreshness(claim, option.sources, claim.review, asOf),
    })),
  }));
}

/** Ranked text search over these records is `library-query`'s shared Library index. */
export interface PublicFilters {
  query?: string;
  type?: string;
  category?: string;
  concept?: string;
  sourceClass?: string;
  githubOnly?: boolean;
  freshness?: string;
  disposition?: string;
}

/** Shared literal matching for machine and human views; no semantic inference or hidden dictionary. */
export function filterPublicOptions(options: readonly PublicOption[], filters: PublicFilters) {
  const words = (filters.query ?? '')
    .toLocaleLowerCase('en-US')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return options.filter((option) => {
    if (filters.type && option.type !== filters.type) return false;
    if (filters.category && option.category !== filters.category) return false;
    if (filters.concept && !option.concepts.includes(filters.concept)) return false;
    if (filters.sourceClass && !option.sources.some((s) => s.source_class === filters.sourceClass))
      return false;
    if (filters.githubOnly && new URL(option.uri).hostname !== 'github.com') return false;
    if (filters.disposition && option.disposition !== filters.disposition) return false;
    if (filters.freshness && !option.claims.some((claim) => claim.freshness === filters.freshness))
      return false;
    const text = [
      option.name,
      option.need,
      option.reason,
      option.category,
      ...option.concepts,
      ...option.claims.map((c) => c.text),
      ...option.sources.map((s) => s.title),
    ]
      .join(' ')
      .toLocaleLowerCase('en-US');
    return words.every((word) => text.includes(word));
  });
}
