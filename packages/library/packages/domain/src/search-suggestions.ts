import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { normalizeConsiderUrl } from './url.js';
import { linkedClaimReceiptSchema } from './claim-check.js';

const closed = { additionalProperties: false };
const shortText = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const suggestionSchema = Type.Object(
  {
    claim: shortText(1600),
    basis: shortText(400),
    why: shortText(400),
    urls: Type.Array(shortText(2048), { minItems: 1, maxItems: 2, uniqueItems: true }),
  },
  closed,
);
export const suggestedAnswerSchema = Type.Object(
  {
    answer: shortText(24000),
    suggestions: Type.Array(suggestionSchema, { maxItems: 3 }),
  },
  closed,
);
const receiptSchema = Type.Object(
  {
    version: Type.Literal(1),
    state: Type.Literal('unverified'),
    answerDigest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    offeredDigest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    offered: suggestedAnswerSchema.properties.suggestions,
  },
  closed,
);
export type CheckSuggestions = Static<typeof receiptSchema>;
export const rejectedSuggestionsSchema = Type.Object(
  {
    version: Type.Literal(1),
    answerDigest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    scope: Type.Literal('parsed-final-suggestions'),
    presence: Type.Enum(['missing', 'serializable', 'nonserializable']),
    reason: Type.Enum([
      'invalid_check_suggestions',
      'invalid_check_suggestion_text',
      'check_suggestion_not_cited',
      'invalid_check_suggestion_url',
      'duplicate_check_suggestion_url',
    ]),
    diagnostic: Type.Optional(
      Type.Omit(linkedClaimReceiptSchema.properties.rejectedOutput, ['captureScope'], closed),
    ),
  },
  closed,
);
export type RejectedCheckSuggestions = Static<typeof rejectedSuggestionsSchema>;
export const offeredPayload = (offered: CheckSuggestions['offered']) =>
  JSON.stringify(offered.map(({ claim, basis, why, urls }) => [claim, basis, why, urls]));
export const suggestionSelectionPayload = (
  parentRunId: string,
  answerDigest: string,
  offeredDigest: string,
  index: number,
) => JSON.stringify(['check-selection-v1', parentRunId, answerDigest, offeredDigest, index]);

/** Citation membership is a locator boundary, never evidence of a source's role or support. */
export function checkSuggestions(input: unknown, answerDigest: string, citations: string[]) {
  if (!Value.Check(receiptSchema, input) || input.answerDigest !== answerDigest)
    throw new Error('invalid_check_suggestions');
  for (const offered of input.offered) {
    // JSON Schema counts code points; retained metadata budgets count JS UTF-16 units.
    if (
      ![offered.claim, offered.basis, offered.why].every((text) => text.trim()) ||
      offered.claim.length > 1600 ||
      offered.basis.length > 400 ||
      offered.why.length > 400
    )
      throw new Error('invalid_check_suggestion_text');
    const destinations = new Set<string>();
    for (const uri of offered.urls) {
      let normalized: string;
      try {
        normalized = normalizeConsiderUrl(uri).normalizedUrl + new URL(uri).hash;
      } catch {
        throw new Error('invalid_check_suggestion_url');
      }
      if (uri.length > 2048 || normalized.length > 2048)
        throw new Error('invalid_check_suggestion_url');
      if (!citations.includes(normalized)) throw new Error('check_suggestion_not_cited');
      if (destinations.has(normalized)) throw new Error('duplicate_check_suggestion_url');
      destinations.add(normalized);
    }
  }
  return input;
}
