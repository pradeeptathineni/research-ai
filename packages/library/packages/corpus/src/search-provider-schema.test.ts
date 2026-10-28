import { expect, it } from 'vitest';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { providerSchema, restoreOptionals } from './search-provider-schema.js';
import { proposalSchema, discoverySchema } from '../../domain/src/search-contract.js';
import { bindExtractions } from './search-runner.js';

it('constrains discovery feature indicators before accepting a provider response', () => {
  const schema = discoverySchema.properties.candidates.items.properties.observations.items;
  const valid = {
    source: 0,
    feature: 'maturity',
    indicator: 'documented',
    statement: 'Published documentation exists.',
    quote: 'documentation',
    independent: false,
    origin: 'publisher',
    status: 'supported',
    attention: null,
  };
  const wire = providerSchema(schema);
  expect(Value.Check(wire as typeof schema, valid)).toBe(true);
  expect(Value.Check(wire as typeof schema, { ...valid, feature: 'verification' })).toBe(false);
  expect(Value.Check(schema, restoreOptionals(valid, schema))).toBe(true);
});

it('accepts mechanically equivalent extraction URIs while rejecting aliases, versions, fragments and duplicate bindings', () => {
  const candidates = [{ uri: 'https://example.org/resource/' }];
  expect(
    bindExtractions(candidates, [{ uri: 'https://example.org/resource', observations: [] }]).get(
      candidates[0]!.uri,
    ),
  ).toBeDefined();
  for (const uri of [
    'https://other.example.org/resource',
    'https://example.org/resource/v2',
    'https://example.org/resource#different',
  ])
    expect(() => bindExtractions(candidates, [{ uri }])).toThrow('extraction_identity_change');
  expect(() =>
    bindExtractions(candidates, [
      { uri: candidates[0]!.uri },
      { uri: 'https://example.org/resource' },
    ]),
  ).toThrow('extraction_identity_change');
  expect(() =>
    bindExtractions(
      [...candidates, { uri: 'https://example.org/resource' }],
      [{ uri: candidates[0]!.uri }],
    ),
  ).toThrow('extraction_identity_change');
});

it('encodes every provider object with required keys while preserving domain null and optional meanings', () => {
  const domain = Type.Object(
    {
      items: Type.Array(
        Type.Object(
          {
            required: Type.Union([Type.String(), Type.Null()]),
            optional: Type.Optional(Type.Integer()),
          },
          { additionalProperties: false },
        ),
      ),
    },
    { additionalProperties: false },
  );
  const wire = providerSchema(domain);
  const response = {
    items: [
      { required: null, optional: null },
      { required: 'value', optional: 10 },
    ],
  };
  expect(Value.Check(wire as typeof domain, response)).toBe(true);
  const decoded = restoreOptionals(response, domain);
  expect(decoded).toEqual({ items: [{ required: null }, { required: 'value', optional: 10 }] });
  expect(Value.Check(domain, decoded)).toBe(true);
  expect(
    Value.Check(domain, restoreOptionals({ items: [{ required: 10, optional: null }] }, domain)),
  ).toBe(false);
  const assertProviderObjects = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    if (node.properties) expect(node.required).toEqual(Object.keys(node.properties));
    expect(node).not.toHaveProperty('uniqueItems');
    Object.values(node).forEach(assertProviderObjects);
  };
  assertProviderObjects(providerSchema(proposalSchema));
  assertProviderObjects(providerSchema(discoverySchema));
});
