import { expect, it } from 'vitest';
import { extractHtml, extractFeed, materialOmissions, cachedMaterial } from './search-document.js';

it('preserves curated outlinks before readability removes navigation and never runs resources', () => {
  const doc = extractHtml(
    '<html><head><title>Collection</title></head><body><nav><a href="/tool">A useful resource</a><a href="https://127.0.0.1/private">private</a></nav><article><h1 id="scope">Scope</h1><p>This does not provide automatic security. Compare evidence before choosing a tool.</p><table><tr><th>Tool</th><th>Limit</th></tr><tr><td>A</td><td>No network</td></tr></table></article><script>globalThis.compromised=true</script><img src="https://example.com/track"></body></html>',
    'https://example.com/list',
  );
  expect(doc.links).toEqual([{ uri: 'https://example.com/tool', title: 'A useful resource' }]);
  expect(doc.text).toContain('does not provide automatic security');
  expect(doc.sections).toContainEqual({ locator: '#scope', text: 'Scope' });
  expect(doc.sections.some((x) => x.text.includes('No network'))).toBe(true);
  expect('compromised' in globalThis).toBe(false);
});

it('discloses excluded qualifiers separately from navigation and executable noise without admitting them', () => {
  const qualifier = 'Not permitted unless the supporting component is installed.';
  const json = JSON.stringify({ terms: 'Permission excludes redistributed assets.' });
  const doc = extractHtml(
    `<html><body><p>Permission is conditional.</p><div style="display:none"><span aria-hidden="true">${qualifier}</span></div><nav hidden>Navigation only.</nav><script>globalThis.omissionExecuted=true</script><script type="application/json">${json}</script></body></html>`,
    'https://example.org/any-subject',
  );
  expect(doc.scope).toMatchObject({
    excludedContentTextUnits: qualifier.length,
    excludedStructuredDataTextUnits: json.length,
    excludedTextCountOverflow: false,
  });
  expect(doc.text).toContain('Permission is conditional.');
  expect(doc.text).not.toContain(qualifier);
  expect(doc.text).not.toContain('redistributed');
  expect(doc.text).not.toContain('Navigation only');
  expect('omissionExecuted' in globalThis).toBe(false);
  expect(materialOmissions(doc).join(' ')).toContain('not complete source coverage');
  expect(cachedMaterial(doc)).toEqual(doc);
});

it('preserves visible negatives, reports measured zero cautiously and keeps legacy counters unmeasured', () => {
  const raw = '<html><body><p>Not safe unless the tested condition holds.</p></body></html>';
  const doc = extractHtml(raw, 'https://example.org/conditions');
  expect(doc.text).toContain('Not safe unless');
  expect(doc.scope?.excludedContentTextUnits).toBe(0);
  expect(materialOmissions(doc).join(' ')).toContain(
    'Measured zero does not prove semantic completeness',
  );
  const historical = structuredClone(doc);
  delete historical.scope!.excludedContentTextUnits;
  delete historical.scope!.excludedStructuredDataTextUnits;
  delete historical.scope!.excludedTextCountOverflow;
  const bytes = JSON.stringify(historical);
  expect(cachedMaterial(historical)).toEqual(historical);
  expect(JSON.stringify(historical)).toBe(bytes);
  expect(materialOmissions(historical).join(' ')).toContain('was not measured');
  expect(
    materialOmissions(extractHtml(raw, 'https://example.org/conditions', 'text-v2')).join(' '),
  ).toContain('was not measured');
  expect(materialOmissions({ ...historical, scope: undefined, extractor: 'plain-text' })).toEqual(
    [],
  );
  expect(() =>
    cachedMaterial({ ...doc, scope: { ...doc.scope, excludedTextCountOverflow: undefined } }),
  ).toThrow('invalid_document_omission_scope');
  expect(() =>
    cachedMaterial({ ...doc, scope: { ...doc.scope, excludedContentTextUnits: -1 } }),
  ).toThrow('invalid_cached_document');
  expect(() =>
    cachedMaterial({ ...doc, scope: { ...doc.scope, excludedTextCountOverflow: true } }),
  ).toThrow('invalid_document_omission_scope');
});

it('bounds reported UTF16 exclusion counts and reports overflow explicitly', () => {
  const doc = extractHtml(
    `<html><body><div hidden>${'🧪'.repeat(1000001)}</div></body></html>`,
    'https://example.org/bounded',
  );
  expect(doc.scope).toMatchObject({
    excludedContentTextUnits: 2000000,
    excludedTextCountOverflow: true,
  });
  expect(materialOmissions(doc).join(' ')).toContain('further excluded text is unmeasured');
});
it('parses RSS and Atom strings with dates and absolute links, rejecting entity declarations', async () => {
  for (const raw of [
    '<rss version="2.0"><channel><title>Scout</title><item><title>Update</title><link>https://example.com/update</link><pubDate>Tue, 06 Oct 2026 12:00:00 GMT</pubDate></item></channel></rss>',
    '<feed xmlns="http://www.w3.org/2005/Atom"><title>Scout</title><entry><title>Update</title><link href="https://example.com/update"/><updated>2026-10-06T12:00:00Z</updated></entry></feed>',
  ]) {
    const doc = await extractFeed(raw, 'https://example.com/feed');
    expect(doc.links[0]?.uri).toBe('https://example.com/update');
    expect(doc.sections[0]?.text).toContain('2026-10-06');
  }
  await expect(
    extractFeed(
      '<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>',
      'https://example.com',
    ),
  ).rejects.toThrow('feed_external_entity_denied');
});
