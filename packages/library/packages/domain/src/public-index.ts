import { Type } from 'typebox';
import { Value } from 'typebox/value';
import type { PublicOption } from './public-corpus.js';
import { signalAssessmentSchema, signalDimensions, SIGNAL_THRESHOLD } from './signal-quality.js';

const text = Type.String({ maxLength: 5000 });
const identity = Type.String({ minLength: 1, maxLength: 160 });
const texts = Type.Array(text, { maxItems: 100 });
const review = Type.Object(
  {
    claimId: identity,
    basis: Type.Union([Type.Literal('stable'), Type.Literal('volatile'), Type.Literal('unknown')]),
    reviewAfterDays: Type.Union([Type.Integer({ minimum: 1, maximum: 3650 }), Type.Null()]),
  },
  { additionalProperties: false },
);
const publicIndex = Type.Array(
  Type.Object(
    {
      id: identity,
      quality: Type.Optional(signalAssessmentSchema),
      bundleId: Type.String({ pattern: '^[a-zA-Z0-9-]+$', maxLength: 160 }),
      bundleDigest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
      name: text,
      uri: text,
      category: text,
      type: text,
      concepts: texts,
      need: text,
      reason: text,
      disposition: Type.Union(
        ['consider', 'trial', 'adopt', 'defer', 'reject'].map((v) => Type.Literal(v)),
      ),
      limitations: texts,
      reviewedAt: text,
      reviewer: Type.Union([Type.Literal('human'), Type.Literal('agent-reviewed')]),
      publishedAt: text,
      claims: Type.Array(
        Type.Object(
          {
            id: identity,
            text,
            source_ids: texts,
            status: Type.Union(
              ['observed', 'supported', 'inferred', 'uncertain', 'contradicted'].map((v) =>
                Type.Literal(v),
              ),
            ),
            freshness: Type.Union(['current', 'due', 'unknown'].map((v) => Type.Literal(v))),
            review,
          },
          { additionalProperties: false },
        ),
        { maxItems: 200 },
      ),
      sources: Type.Array(
        Type.Object(
          {
            id: identity,
            uri: text,
            title: text,
            source_class: text,
            observed_at: Type.Optional(Type.Union([text, Type.Null()])),
            revision: Type.Optional(Type.Union([text, Type.Null()])),
            independence_group: Type.Optional(Type.Union([text, Type.Null()])),
          },
          { additionalProperties: false },
        ),
        { maxItems: 100 },
      ),
    },
    { additionalProperties: false },
  ),
  { maxItems: 1000 },
);

/** Interpret a downloaded index without eval, coercion or accepting arbitrary public fields. */
export function parsePublicIndex(value: unknown): PublicOption[] {
  if (!Value.Check(publicIndex, value))
    throw new Error('The public collection has an invalid format.');
  const options = value as PublicOption[];
  const ids = new Set<string>();
  for (const option of options) {
    if (ids.has(option.id)) throw new Error('Duplicate public option identity.');
    ids.add(option.id);
    if (option.quality) {
      const quality = option.quality;
      const score = Math.min(...signalDimensions.map((key) => quality.ratings[key])) * 25;
      if (
        quality.optionId !== option.id ||
        quality.score !== score ||
        quality.level !== (!quality.blockers.length && score >= SIGNAL_THRESHOLD ? 'high' : 'held')
      )
        throw new Error('Invalid signal assessment binding or calculation.');
    }
    const uris = [option.uri, ...option.sources.map((s) => s.uri)];
    for (const uri of uris) {
      const url = new URL(uri);
      if (url.protocol !== 'https:' || url.username || url.password || url.port)
        throw new Error('Unsafe public link.');
    }
    if (
      !Number.isFinite(Date.parse(option.reviewedAt)) ||
      !Number.isFinite(Date.parse(option.publishedAt))
    )
      throw new Error('Invalid public date.');
    if (
      option.claims.some(
        (claim) =>
          claim.review.claimId !== claim.id ||
          !claim.source_ids.length ||
          !claim.source_ids.every((id) => option.sources.some((s) => s.id === id)) ||
          (claim.review.basis === 'volatile'
            ? claim.review.reviewAfterDays === null
            : claim.review.reviewAfterDays !== null),
      )
    )
      throw new Error('Invalid public claim binding.');
  }
  return options;
}
