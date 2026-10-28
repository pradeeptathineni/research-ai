import { Type } from 'typebox';
import { Value } from 'typebox/value';
import type { EvidenceBundle } from './evidence-exchange.js';

const SIGNAL_POLICY_VERSION = 'signal-review-v1' as const;
export const SIGNAL_THRESHOLD = 75;
export const signalDimensions = ['relevance', 'evidence', 'usefulness', 'clarity'] as const;
type Dimension = (typeof signalDimensions)[number];
export interface SignalReview {
  policyVersion: typeof SIGNAL_POLICY_VERSION;
  evidenceDigest: string;
  researchRunId: string;
  reviewRunId: string;
  reviewer: string;
  reviewedAt: string;
  options: Array<{
    optionId: string;
    ratings: Record<Dimension, number>;
    reasons: Record<Dimension, string>;
    blockers: string[];
  }>;
}
const identity = Type.String({ minLength: 1, maxLength: 160 });
const reason = Type.String({ minLength: 20, maxLength: 2000 });
const ratings = Type.Object(
  Object.fromEntries(
    signalDimensions.map((key) => [key, Type.Integer({ minimum: 0, maximum: 4 })]),
  ),
  { additionalProperties: false },
);
const reasons = Type.Object(Object.fromEntries(signalDimensions.map((key) => [key, reason])), {
  additionalProperties: false,
});
export const signalAssessmentSchema = Type.Object(
  {
    optionId: identity,
    policyVersion: Type.Literal(SIGNAL_POLICY_VERSION),
    score: Type.Integer({ minimum: 0, maximum: 100, multipleOf: 25 }),
    level: Type.Union([Type.Literal('high'), Type.Literal('held')]),
    ratings,
    reasons,
    blockers: Type.Array(reason, { maxItems: 24 }),
  },
  { additionalProperties: false },
);
export const signalReviewSchema = Type.Object(
  {
    policyVersion: Type.Literal(SIGNAL_POLICY_VERSION),
    evidenceDigest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    researchRunId: identity,
    reviewRunId: identity,
    reviewer: identity,
    reviewedAt: Type.String({ minLength: 20, maxLength: 40 }),
    options: Type.Array(
      Type.Object(
        { optionId: identity, ratings, reasons, blockers: Type.Array(reason, { maxItems: 20 }) },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 100 },
    ),
  },
  { additionalProperties: false },
);

/** The weakest dimension decides admission; ratings are ordinal judgment, never probability. */
export function assessSignalQuality(bundle: EvidenceBundle, digest: string, raw: unknown) {
  if (!Value.Check(signalReviewSchema, raw)) throw new Error('Invalid closed signal review.');
  const review = raw as SignalReview;
  if (
    review.evidenceDigest !== digest ||
    review.researchRunId === review.reviewRunId ||
    !Number.isFinite(Date.parse(review.reviewedAt)) ||
    new Set(review.options.map((option) => option.optionId)).size !== review.options.length ||
    review.options.length !== bundle.candidates.length ||
    review.options.some((option) => !bundle.candidates.some((c) => c.id === option.optionId))
  )
    throw new Error(
      'Signal review must bind the exact bytes, every option and a separate review run.',
    );
  return review.options.map((option) => {
    const candidate = bundle.candidates.find((c) => c.id === option.optionId)!;
    const unsupported = candidate.claim_ids.some((id) =>
      bundle.claims.some(
        (claim) => claim.id === id && !['supported', 'observed'].includes(claim.status),
      ),
    );
    const score = Math.min(...signalDimensions.map((key) => option.ratings[key])) * 25;
    const blockers = [
      ...option.blockers,
      ...(unsupported ? ['Material claims lack supported source evidence.'] : []),
      ...(bundle.mode === 'fixture' ? ['Synthetic evidence cannot qualify as knowledge.'] : []),
      ...(!candidate.claim_ids.length ? ['No supported material claim.'] : []),
    ];
    return {
      optionId: option.optionId,
      policyVersion: SIGNAL_POLICY_VERSION,
      score,
      level: !blockers.length && score >= SIGNAL_THRESHOLD ? ('high' as const) : ('held' as const),
      ratings: option.ratings,
      reasons: option.reasons,
      blockers,
    };
  });
}
