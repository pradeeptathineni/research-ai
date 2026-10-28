import { groundedAnswer } from '@pradeeptathineni/research-ai';

/** Authored support judgments exercise retention/display, never model quality. */
export function groundedFixture() {
  const sources = [
    {
      uri: 'https://example.org/export#guide',
      text: 'Plain files can be exported. Offline mode is unavailable. 😀',
      observedAt: '2026-10-22 synthetic capture',
      omissions: ['Pricing page omitted.'],
    },
    {
      uri: 'https://example.net/manual',
      text: 'Offline mode is supported. An account is required for exports.',
    },
  ];
  const j = (verdict: 'supports' | 'contradicts' | 'insufficient' | 'unknown') => ({
    verdict,
    reason: `Authored ${verdict} judgment for the offline demonstration.`,
  });
  const cite = (
    source: number,
    quote: string,
    verdict: 'supports' | 'contradicts' | 'insufficient' = 'supports',
    without: 'supports' | 'insufficient' = 'insufficient',
  ) => ({
    source,
    start: sources[source]!.text.indexOf(quote),
    end: sources[source]!.text.indexOf(quote) + quote.length,
    alone: j(verdict),
    without: j(without),
  });
  return groundedAnswer({
    sources,
    judge: { id: 'offline-authored-demo', kind: 'synthetic' },
    claims: [
      {
        text: 'Plain files can be exported.',
        joint: j('supports'),
        citations: [cite(0, 'Plain files can be exported.')],
      },
      {
        text: 'Offline mode is supported.',
        joint: j('supports'),
        citations: [
          cite(0, 'Offline mode is unavailable.', 'contradicts'),
          cite(1, 'Offline mode is supported.'),
        ],
      },
      {
        text: 'Pricing cannot be established from these captures.',
        joint: j('insufficient'),
        citations: [],
      },
      {
        text: 'File exports require an account.',
        joint: j('supports'),
        citations: [
          cite(1, 'An account is required for exports.'),
          cite(0, 'Plain files can be exported.', 'insufficient', 'supports'),
        ],
      },
      {
        text: 'Portability after account closure is unresolved.',
        joint: j('unknown'),
        citations: [cite(1, 'An account is required for exports.', 'insufficient')],
      },
    ],
  });
}
