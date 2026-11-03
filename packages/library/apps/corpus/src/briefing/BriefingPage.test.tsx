import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import BriefingPage from './BriefingPage.js';

describe('Briefing page startup', () => {
  it('renders a clear unavailable state when the owner adapter is not injected', () => {
    const html = renderToStaticMarkup(<BriefingPage />);
    expect(html).toContain('Briefing is not connected in this view.');
    expect(html).toContain('Select a story to inspect its sources and ranking.');
    expect(html).not.toContain('Unhandled');
  });
});
