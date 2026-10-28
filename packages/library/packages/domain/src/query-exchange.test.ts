import { it, expect } from 'vitest';
import { parseQueryAssessment } from './query-exchange.js';
it('binds query exchange to actual exported source IDs and rejects unknown versions and identities', () => {
  const value = {
    schema_version: 1,
    policy: 'query-relevance-v1',
    query: 'A query',
    interpretation: null,
    items: [
      {
        id: 'resource',
        relevance: {
          value: 75,
          reason: 'Direct with a visible limitation',
          source_ids: ['actual-original'],
          constraints: [],
        },
      },
    ],
  };
  expect(
    parseQueryAssessment(
      value,
      [{ id: 'independent' }, { id: 'actual-original' }],
      [{ id: 'resource' }],
    ),
  ).toEqual(value);
  expect(() =>
    parseQueryAssessment(
      { ...value, schema_version: 2 },
      [{ id: 'actual-original' }],
      [{ id: 'resource' }],
    ),
  ).toThrow('unsupported');
  expect(() => parseQueryAssessment(value, [{ id: 'wrong' }], [{ id: 'resource' }])).toThrow(
    'unbound',
  );
  expect(() => parseQueryAssessment(value, [{ id: 'actual-original' }], [{ id: 'other' }])).toThrow(
    'unbound',
  );
});
