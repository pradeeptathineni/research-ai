import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ClaimCheck } from './claim-check.js';
import type { ClaimReceipt } from '../../../packages/domain/src/claim-check.js';
import { signalSearch } from '../../../packages/corpus/src/signal-search.js';
import { searchEvidenceBundle } from '../../../packages/corpus/src/search-exchange.js';
it('shows denial, Unknown, memory authority and original scope without inventing a verdict', () => {
  const receipt: ClaimReceipt = {
    version: 1,
    claimText: 'Metadata does not establish object rights.',
    claimDigest: 'a'.repeat(64),
    parentRunId: '00000000-0000-0000-0000-000000000000',
    parentAnswerDigest: 'b'.repeat(64),
    originalNeed: 'Full original need; never upload originals.',
    originalContext: 'Application uncertain.',
    selectedMaterial: [
      {
        sourceIndex: 0,
        requestedUri: 'https://example.org/policy',
        state: 'denied',
        reason: 'source_denied_403',
      },
    ],
    reviewState: 'not-reviewed',
    verdict: null,
    reason: 'No primary material reviewed.',
    nextCheck: 'Inspect public primary material.',
    findings: [],
    gaps: [{ reason: 'Acquisition denied; permission remains unresolved.', decisive: true }],
    confidence: 'Unknown',
    historySaved: false,
    stages: { acquisitionMs: 2, nativeMs: 0, validationMs: 0 },
    abortOrigin: null,
  };
  const html = renderToStaticMarkup(<ClaimCheck receipt={receipt} />);
  for (const value of [
    'Confidence Unknown',
    'Not saved to history',
    'not-reviewed',
    'Not available',
    'source_denied_403',
    'never upload originals',
    'permission remains unresolved',
    'No numeric Signal',
    'complete normalization does not mean complete source coverage',
  ])
    expect(html).toContain(value);
  receipt.rejectedOutput = {
    text: '',
    capturedDigest: 'c'.repeat(64),
    capturedBytes: 100000,
    omittedBytes: 100000,
    captureComplete: false,
    captureScope: 'runner-stdout',
  };
  const diagnostic = renderToStaticMarkup(<ClaimCheck receipt={receipt} />);
  expect(diagnostic).toContain('unclassified text omitted');
  expect(diagnostic).toContain('100000 captured bytes omitted');
  expect(diagnostic).toContain('incomplete');
});

it('renders a direct request and an unavailable verdict without an invented original answer', async () => {
  const result = await signalSearch(
    {
      query: 'Does the primary source establish this outcome?',
      context: 'Keep the scope explicit.',
      claimOrigin: 'request',
      claimText: 'The source establishes an outcome.',
      captureUrls: ['https://example.org/study'],
      profile: 'quick',
      save: 'never',
      cache: 'memory',
    },
    {
      fetch: async () => {
        throw new Error('source_denied_403');
      },
    },
  );
  const receipt = result.claimCheck!;
  const html = renderToStaticMarkup(<ClaimCheck receipt={receipt} />);
  expect(html).toContain('without an original research answer');
  expect(html).toContain('Not available');
  expect(html).toContain('Confidence Unknown');
  expect(html).not.toContain('Saved privately with the original answer link');
  receipt.historySaved = true;
  expect(renderToStaticMarkup(<ClaimCheck receipt={receipt} />)).toContain(
    'Saved privately with the original request and primary snapshots',
  );
  const bundle = searchEvidenceBundle(result, 'a'.repeat(40));
  expect(bundle.claims).toEqual([]);
  expect(bundle.sources).toEqual([]);
  expect(bundle.candidates).toEqual([]);
  expect(bundle.limitations.join(' ')).toContain(
    'omits the selected proposition verdict and primary snapshots',
  );
  expect(bundle.limitations.join(' ')).toContain('no claim-check adoption evidence');
});
