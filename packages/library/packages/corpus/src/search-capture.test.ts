import { expect, it } from 'vitest';
import { parseRequest } from '../../domain/src/search-contract.js';

it('accepts distinct public capture URLs and rejects private/credential URLs before any model runs', () => {
  expect(
    parseRequest({
      query: 'Capture',
      captureUrls: ['https://example.com/a/', 'https://example.com/a'],
    }).captureUrls,
  ).toEqual(['https://example.com/a']);
  for (const uri of ['https://127.0.0.1/a', 'file:///tmp/a', 'https://user:password@example.com'])
    expect(() => parseRequest({ query: 'Capture', captureUrls: [uri] })).toThrow();
});
