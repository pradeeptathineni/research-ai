import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { interpretationSchema, relevanceSchema } from './search-assessment.js';
const refs = Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
  maxItems: 60,
  uniqueItems: true,
});
const schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    policy: Type.Literal('query-relevance-v1'),
    query: Type.String({ maxLength: 2000 }),
    interpretation: Type.Union([interpretationSchema, Type.Null()]),
    items: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 200 }),
          relevance: Type.Union([
            Type.Object(
              {
                value: relevanceSchema.properties.value,
                reason: relevanceSchema.properties.reason,
                source_ids: refs,
                constraints: Type.Array(
                  Type.Object(
                    {
                      text: Type.String({ minLength: 1, maxLength: 1600 }),
                      state: Type.Enum(['satisfied', 'conflicts', 'unknown']),
                      source_ids: refs,
                    },
                    { additionalProperties: false },
                  ),
                  { maxItems: 20 },
                ),
              },
              { additionalProperties: false },
            ),
            Type.Null(),
          ]),
        },
        { additionalProperties: false },
      ),
      { maxItems: 60 },
    ),
  },
  { additionalProperties: false },
);
/** Exchange IDs refer to the exported source table, never a different run's numeric order. */
export function parseQueryAssessment(
  value: unknown,
  sources: { id: string }[],
  candidates: { id: string }[],
) {
  if (!Value.Check(schema, value)) throw new Error('unsupported_or_invalid_query_assessment');
  const sourceIds = new Set(sources.map((source) => source.id));
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  if (
    new Set(value.items.map((item) => item.id)).size !== value.items.length ||
    value.items.some(
      (item) =>
        !candidateIds.has(item.id) ||
        [
          ...(item.relevance?.source_ids ?? []),
          ...(item.relevance?.constraints.flatMap((constraint) => constraint.source_ids) ?? []),
        ].some((id) => !sourceIds.has(id)),
    )
  )
    throw new Error('unbound_query_assessment');
  return value;
}
