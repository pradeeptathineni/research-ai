type Schema = {
  type?: unknown;
  properties?: Record<string, Schema>;
  required?: string[];
  anyOf?: Schema[];
  items?: Schema;
  [key: string]: unknown;
};

/** Provider transport requires nullable required keys; domain optionality stays authoritative. */
export function providerSchema(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(providerSchema);
  if (!input || typeof input !== 'object') return input;
  const schema = input as Schema;
  const encoded = Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => key !== 'uniqueItems')
      .map(([key, value]) => [key, providerSchema(value)]),
  ) as Schema;
  if (schema.properties) {
    encoded.required = Object.keys(schema.properties);
    encoded.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [
        key,
        schema.required?.includes(key)
          ? providerSchema(value)
          : { anyOf: [providerSchema(value), { type: 'null' }] },
      ]),
    ) as Record<string, Schema>;
  }
  return encoded;
}

export function restoreOptionals(value: unknown, input: unknown): unknown {
  if (!input || typeof input !== 'object') return value;
  const schema = input as Schema;
  if (schema.anyOf)
    return schema.anyOf.reduce((result, branch) => restoreOptionals(result, branch), value);
  if (Array.isArray(value)) return value.map((item) => restoreOptionals(item, schema.items));
  if (!value || typeof value !== 'object' || !schema.properties) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      const field = schema.properties![key];
      return field &&
        !schema.required?.includes(key) &&
        item === null &&
        field.type !== 'null' &&
        !field.anyOf?.some((branch) => branch.type === 'null')
        ? []
        : [[key, restoreOptionals(item, field)]];
    }),
  );
}
