import { expect, it } from 'vitest';
import { bm25Scores, passageTokens, selectPassages } from './passage-rank.js';

it('ports plural stemming, Unicode tokens and BM25 frequency/length normalization', () => {
  expect(passageTokens('THE batteries, costs; boxes and glass. Ωμέγα')).toEqual([
    'battery',
    'cost',
    'box',
    'glass',
    'ωμέγα',
  ]);
  expect(bm25Scores('battery', ['batteries', 'sand', 'battery battery extra words'])).toEqual([
    expect.closeTo(0.6064563, 6),
    0,
    expect.closeTo(0.508112, 6),
  ]);
  expect(bm25Scores('x', [])).toEqual([]);
});

it('finds late relevant statements with fair parent shares and redistributes spare slots', () => {
  const parents = [
    Array.from({ length: 60 }, (_, index) =>
      index >= 45 && index <= 50
        ? `battery storage requirement ${index}`
        : `unrelated filler ${index}`,
    ),
    ['battery permission unresolved'],
    ['battery cost unknown'],
  ];
  const result = selectPassages('battery storage requirement', parents, (row) => row);
  expect(result.material).toEqual(expect.arrayContaining(parents[0]!.slice(45, 51)));
  expect(result.perParent).toEqual([
    { total: 60, kept: 38 },
    { total: 1, kept: 1 },
    { total: 1, kept: 1 },
  ]);
  expect(result.material).toHaveLength(40);
});

it('falls back to original order deterministically with no overlap and keeps the byte bound', () => {
  const parents = [
    Array.from({ length: 50 }, (_, index) => `sand ${index}`),
    Array.from({ length: 50 }, (_, index) => `water ${index}`),
  ];
  const result = selectPassages('battery', parents, (row) => row);
  expect(result.material).toEqual([...parents[0]!.slice(0, 20), ...parents[1]!.slice(0, 20)]);
  expect(selectPassages('battery', parents, (row) => row)).toEqual(result);
  const bounded = selectPassages(
    'battery',
    [['Ω'.repeat(20000), 'battery usable'], ['battery sibling']],
    (row) => row,
  );
  expect(Buffer.byteLength(JSON.stringify(bounded.material))).toBeLessThanOrEqual(18000);
  expect(bounded.material).toContain('battery sibling');
});
