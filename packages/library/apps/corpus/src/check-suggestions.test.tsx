import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CheckSuggestions } from './check-suggestions.js';
const suggestions = {
  version: 1 as const,
  state: 'unverified' as const,
  answerDigest: 'a'.repeat(64),
  offeredDigest: 'b'.repeat(64),
  offered: [
    {
      claim: 'Conditional proposition.',
      basis: 'Unknown prerequisite.',
      why: 'Decision scope.',
      urls: ['https://example.com/primary'],
    },
  ],
};
it('unretained suggestions disclose no automatic saving and cannot initiate linked checks', () => {
  const html = renderToStaticMarkup(
    <CheckSuggestions
      suggestions={suggestions}
      busy={false}
      retained={false}
      onCheck={() => {
        throw new Error('No automatic check');
      }}
    />,
  );
  expect(html).toContain('memory-only answer has not been saved automatically');
  expect(html).toContain('disabled=""');
  expect(html).toContain('whole-item Signal unassessed');
  expect(html).toContain('Unknown');
});
it('empty nomination is honest abstention with manual fallback', () => {
  const html = renderToStaticMarkup(
    <CheckSuggestions
      suggestions={{ ...suggestions, offered: [] }}
      busy={false}
      retained
      onCheck={() => {}}
    />,
  );
  expect(html).toContain('No eligible suggestion was offered');
  expect(html).not.toContain('<button');
});
