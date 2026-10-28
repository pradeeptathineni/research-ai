import { it, expect } from 'vitest';
import { rejectedNativeLeads } from './search-rejected.js';
import { nativeProposal } from './search-native.js';

it('keeps rejected nominations separate from validation and admission inputs', () => {
  const rejectedProposal = {
    version: 2,
    sources: [],
    candidates: [
      {
        name: 'Unverified lead',
        description: 'Model nomination only',
        uri: 'https://example.org/resource',
        limits: ['Unverified'],
        observations: [{ signal: 'verification/documented' }],
      },
    ],
    coverage: [],
    gaps: [],
  };
  expect(() => nativeProposal(rejectedProposal)).toThrow('invalid_native_brief');
  expect(rejectedNativeLeads({ rejectedProposal })).toEqual([
    {
      name: 'Unverified lead',
      description: 'Model nomination only',
      uri: 'https://example.org/resource',
      limits: ['Unverified'],
    },
  ]);
  expect(
    rejectedNativeLeads({
      rejectedProposal: {
        candidates: [null, { name: 12 }, { name: 'Bad', description: 'x', uri: 'x', limits: [{}] }],
      },
    }),
  ).toEqual([]);
  expect(rejectedNativeLeads(null)).toEqual([]);
});

it('returns bounded text only; raw nominations never add executable link or observation fields', () => {
  const leads = rejectedNativeLeads({
    rejectedProposal: {
      candidates: [
        {
          name: '<script>run()</script>',
          description: 'x'.repeat(2000),
          uri: 'javascript:run()',
          limits: [],
          observations: [{ verified: true }],
          eligible: true,
        },
      ],
    },
  });
  expect(leads[0]?.description).toHaveLength(1600);
  expect(Object.keys(leads[0]!)).toEqual(['name', 'description', 'uri', 'limits']);
});
