import { expect, it } from 'vitest';
import {
  createLibraryIndex,
  searchLibrary,
  projectLegacyLibrary,
  type LibraryFinding,
} from './library-search.js';
import type { PublicOption } from './public-corpus.js';

// Synthetic retrieval controls only; these are never corpus or discovery records.
function finding(id: string, overrides: Partial<LibraryFinding> = {}): LibraryFinding {
  return {
    key: `native:public:${id}`,
    id,
    title: 'Portable utility',
    uri: 'https://example.com/' + id,
    description: 'A retained finding.',
    kind: 'software',
    aliases: [],
    domains: [],
    capabilities: [],
    useCases: [],
    technologies: [],
    tags: [],
    sourceNames: [],
    intrinsicStrength: { policy: 'signal-strength-v6', score: 0 },
    license: { state: 'unknown', values: [], openSource: null },
    access: { state: 'unknown', freeToUse: null },
    origin: { format: 'native', destination: 'public', recordId: id },
    saved: true,
    observedAt: null,
    ...overrides,
  };
}
it('retrieves descriptions, aliases, kinds, capabilities, use cases, technologies and source names across the whole input', () => {
  const rows = [
    finding('runtime', {
      title: 'River',
      description: 'A small language for portable scripts.',
      kind: 'software',
      aliases: ['RiverLang'],
      technologies: ['shell runtime'],
    }),
    finding('method', {
      title: 'Fold',
      kind: 'practice',
      capabilities: ['output filtering'],
      useCases: ['Recover verbose test output'],
      sourceNames: ['Engineering Handbook'],
    }),
    finding('garden', {
      title: 'Pollinator guide',
      kind: 'learning-resource',
      domains: ['Gardening'],
      tags: ['perennial'],
    }),
    ...Array.from({ length: 80 }, (_, i) =>
      finding('unrelated-' + i, { title: 'Other finding ' + i }),
    ),
  ];
  const index = createLibraryIndex(rows);
  for (const [query, id] of [
    ['scripting', 'runtime'],
    ['RiverL', 'runtime'],
    ['RivrLang', 'runtime'],
    ['verbose', 'method'],
    ['filtering', 'method'],
    ['handbook', 'method'],
    ['shell', 'runtime'],
    ['perennial', 'garden'],
  ]) {
    const hit = index.search(query!).find((row) => row.finding.id === id);
    expect(hit, query).toBeDefined();
    expect(hit!.retrievalScore).toBeGreaterThan(0);
  }
  expect(index.search('unrelated scientific claim absent from corpus')).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ finding: rows[0] })]),
  );
  expect(index.search('zzzznonexistent')).toEqual([]);
  expect(index.search('')).toHaveLength(rows.length);
});
it('keeps exact phrase meaning and intrinsic strength separate from query rank', () => {
  const direct = finding('direct', {
    title: 'Output filtering',
    description: 'Retain original command observations.',
    intrinsicStrength: { policy: 'signal-strength-v6', score: 0 },
  });
  const scattered = finding('scattered', {
    title: 'Filtering',
    description: 'Retrieve output.',
    intrinsicStrength: { policy: 'signal-strength-v6', score: 95 },
  });
  const before = JSON.stringify([direct, scattered]);
  const index = createLibraryIndex([scattered, direct]);
  expect(index.search('output filtering')[0]!.finding.id).toBe('direct');
  expect(index.search('"output filtering"').map((hit) => hit.finding.id)).toEqual(['direct']);
  expect(index.search('output filtering')[0]!.finding.intrinsicStrength.score).toBe(0);
  expect(JSON.stringify([direct, scattered])).toBe(before);
});
it('favors more distinct query words over one strong title match while retaining partial recall', () => {
  const narrow = finding('narrow', {
    title: 'Package',
    description: 'A registry manual.',
    intrinsicStrength: { policy: 'signal-strength-v6', score: 95 },
  });
  const broad = finding('broad', {
    title: 'Deployment guide',
    description: 'Package signing and release verification procedures.',
  });
  const results = searchLibrary([narrow, broad], 'package signing verification');
  expect(results.map((hit) => hit.finding.id)).toEqual(['broad', 'narrow']);
  expect(results[0]!.retrievalScore).toBeGreaterThan(results[1]!.retrievalScore);
  expect(results[1]!.matchedTerms).toContain('package');
  expect(results[0]!.finding.intrinsicStrength.score).toBe(0);
  // Repetition and inflected variants cannot manufacture additional distinct query coverage.
  expect(
    searchLibrary([narrow, broad], 'packages signing signing verification')[0]!.finding.id,
  ).toBe('broad');
});
it('searches a natural question without ranking function words or losing original quoted phrases', () => {
  const generic = finding('generic', {
    title: 'The guide',
    description: 'How can I help you with what you should do and how it will work?',
  });
  const specific = finding('specific', {
    title: 'Publisher manual',
    sourceNames: ['Package signing and release verification procedures'],
  });
  const rows = [generic, specific];
  const before = JSON.stringify(rows);
  const index = createLibraryIndex(rows);
  const results = index.search(
    'How can I find a guide that will help me with package signing and release verification?',
  );
  expect(results[0]!.finding.id).toBe('specific');
  expect(results[0]!.matchedFields).toContain('sourceNames');
  expect(
    results.every((hit) => !hit.matchedTerms.some((term) => ['the', 'can', 'how'].includes(term))),
  ).toBe(true);
  expect(index.search('the and how can I')).toEqual([]);
  expect(index.search('"the guide"').map((hit) => hit.finding.id)).toEqual(['generic']);
  expect(JSON.stringify(rows)).toBe(before);
});
it('filters only explicit saved/license/access metadata and retains independently scoped identities', () => {
  const publicRow = finding('same', {
    license: { state: 'known', values: ['MIT'], openSource: true },
  });
  const privateRow = finding('same', {
    key: 'native:private:same',
    origin: { format: 'native', destination: 'private', recordId: 'same' },
    saved: false,
    notes: 'secret annotation',
  });
  const free = finding('free', {
    kind: 'publication',
    access: { state: 'known', freeToUse: true },
  });
  expect(
    searchLibrary([publicRow, privateRow, free], '', { acquisition: 'open-source' }).map(
      (hit) => hit.finding.key,
    ),
  ).toEqual([publicRow.key]);
  expect(
    searchLibrary([publicRow, privateRow, free], '', { acquisition: 'free-to-use' }).map(
      (hit) => hit.finding.id,
    ),
  ).toEqual(['free']);
  expect(
    searchLibrary([publicRow, privateRow, free], 'annotation', { saved: false })[0]!.finding.origin
      .destination,
  ).toBe('private');
  expect(() => createLibraryIndex([publicRow, publicRow])).toThrow('duplicate_library_identity');
});
it('preserves legacy evidence/review policy and searches its general use case instead of inventing a native score', () => {
  const option = {
    id: 'old-option',
    name: 'Practice',
    uri: 'https://example.com/practice',
    type: 'practices',
    bundleId: 'old-bundle',
    category: 'Development',
    concepts: ['portable-shell'],
    need: 'Run repeatable automation scripts.',
    reason: 'A documented procedure.',
    claims: [{ text: 'Preserves output artifacts.' }],
    sources: [{ title: 'Source manual' }],
    quality: { level: 'high', score: 75 },
    reviewedAt: '2026-10-01T00:00:00Z',
  } as PublicOption;
  const row = projectLegacyLibrary(option);
  expect(row.legacy).toBe(option);
  expect(row.origin.recordId).toBe('old-bundle');
  expect(row.intrinsicStrength).toEqual({
    policy: 'signal-review-v1',
    score: 75,
    legacyLevel: 'high',
  });
  expect(searchLibrary([row], 'automation')[0]!.matchedFields).toContain('useCases');
});
