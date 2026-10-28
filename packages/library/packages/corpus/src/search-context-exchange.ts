import { Type } from 'typebox';
import { Value } from 'typebox/value';
const text = Type.String({ maxLength: 2000 });
const schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    query: text,
    items: Type.Array(
      Type.Object(
        {
          id: text,
          policy: Type.Enum(['contextual-priority-v1', 'contextual-priority-v2']),
          score: Type.Union([Type.Number({ minimum: 0, maximum: 100 }), Type.Null()]),
          applicability: Type.Enum(['direct', 'partial', 'incompatible', 'unknown']),
          value: Type.Enum(['high', 'medium', 'low', 'unknown']),
          action: Type.Enum(['use', 'wrap', 'adapt', 'study', 'watch', 'reject']),
          reason: text,
          constraints: Type.Array(text),
          evidence_ids: Type.Array(text),
          relations: Type.Array(
            Type.Object(
              { uri: text, kind: Type.Enum(['alternative', 'related', 'contrary']), reason: text },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export function parseContextualExchange(value: unknown) {
  if (!Value.Check(schema, value)) throw new Error('unsupported_or_invalid_contextual_exchange');
  return value;
}
