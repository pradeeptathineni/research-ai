import { expect, it } from 'vitest';
import {
  jinaDocument,
  configuredDocumentFetch,
  normalizeDocling,
  doclingDocument,
} from './search-extractors.js';
it('limits hosted fallback to timeouts/parse failures and reads denials only from protocol status headers', async () => {
  const read = async (text: string) =>
    jinaDocument('https://example.com', undefined, {
      validate: async () => ({
        url: new URL('https://example.com'),
        address: { address: '93.184.216.34', family: 4 },
      }),
      fetch: async (uri) => ({ uri, text, digest: 'a'.repeat(64) }),
    });
  const document = await read(
    'Title: HTTP status reference\nMarkdown Content:\n401 and 403 are HTTP response codes; login required is an example phrase.',
  );
  expect(document.text).toContain('403');
  await expect(
    read(
      'Title: Denied\nWarning: Target URL returned error 403: Forbidden\nMarkdown Content:\nDenied',
    ),
  ).rejects.toThrow('reader_source_denied');
  let dispatched = 0;
  const reader = async () => {
    dispatched++;
    return document;
  };
  for (const error of [
    'source_http_410',
    'source_http_429',
    'source_http_500',
    'private_target_denied',
    'redirect_limit',
    'bytes_limit',
    'source_aborted',
  ]) {
    await expect(
      configuredDocumentFetch(
        true,
        async () => {
          throw new Error(error);
        },
        undefined,
        reader,
      )('https://example.com'),
    ).rejects.toThrow(error);
  }
  expect(dispatched).toBe(0);
  await configuredDocumentFetch(
    true,
    async () => {
      throw new Error('source_timeout');
    },
    undefined,
    reader,
  )('https://example.com');
  expect(dispatched).toBe(1);
});
it('validates target before hosted dispatch and never uses a reader to bypass denied access', async () => {
  let called = false;
  await expect(
    jinaDocument('https://127.0.0.1', undefined, {
      validate: async () => {
        throw new Error('private_target_denied');
      },
      fetch: async () => {
        called = true;
        throw new Error('unexpected');
      },
    }),
  ).rejects.toThrow('private_target_denied');
  expect(called).toBe(false);
  await expect(
    configuredDocumentFetch(true, async () => {
      throw new Error('source_denied_403');
    })('https://example.com'),
  ).rejects.toThrow('source_denied_403');
});
it('keeps Docling page/table locators and negation, failing closed before unauthorized models', async () => {
  const material = normalizeDocling({
    schema_version: 1,
    text: 'Local does not guarantee privacy.\n|Tool|Local|\n|A|No|',
    sections: [
      {
        locator: '#/tables/0',
        text: '|Tool|Local|\n|A|No|',
        provenance: [{ page: 2, bbox: { l: 10, t: 50 } }],
      },
    ],
  });
  expect(material.text).toContain('does not');
  expect(material.sections[0]?.provenance).toEqual([{ page: 2, bbox: { l: 10, t: 50 } }]);
  await expect(
    doclingDocument('https://example.com/paper.pdf', {
      python: '/missing/python3',
      artifactsPath: '/missing/artifacts',
      modelsAuthorized: false,
      version: '2.135.0',
    }),
  ).rejects.toThrow('models_not_authorized');
  expect(() => normalizeDocling({ schema_version: 2, text: 'Snippet', sections: [] })).toThrow(
    'invalid_docling_document',
  );
});
it('preserves provider uncertainty and publication uncertainty rather than claiming original bytes', async () => {
  const result = await jinaDocument('https://example.com', undefined, {
    validate: async () => ({
      url: new URL('https://example.com'),
      address: { address: '93.184.216.34', family: 4 },
    }),
    fetch: async (uri) => ({
      uri,
      text: 'Title: Public page\nContent: short extracted text',
      digest: 'a'.repeat(64),
    }),
  });
  expect(result.identityUnverified).toBe(true);
  expect(result.material.publishedAt).toBeNull();
  expect(result.material.extractor).toBe('jina-reader-hosted');
});
it('refuses a hosted Cloudflare block only with exact protocol title and challenge structure', async () => {
  const read = async (text: string) =>
    jinaDocument('https://example.com', undefined, {
      validate: async () => ({
        url: new URL('https://example.com'),
        address: { address: '93.184.216.34', family: 4 },
      }),
      fetch: async (uri) => ({ uri, text, digest: 'a'.repeat(64) }),
    });
  for (const challenge of [
    'Title: Attention Required! | Cloudflare\nMarkdown Content:\nSorry, you have been blocked.\nCloudflare Ray ID: abc123',
    'Title: ATTENTION REQUIRED! | CLOUDFLARE\r\nContent:\r\nSorry, you have been blocked. /cdn-cgi/challenge-platform/',
  ]) {
    await expect(read(challenge)).rejects.toThrow('reader_source_denied');
  }
  for (const article of [
    'Title: HTTP security reference\nMarkdown Content:\nTitle: Attention Required! | Cloudflare\nSorry, you have been blocked. Cloudflare Ray ID: abc123',
    'Title: Attention Required! | Cloudflare documentation example\nMarkdown Content:\nCloudflare Ray ID: abc123',
    'Title: Attention Required! | Cloudflare\nMarkdown Content:\nA source title alone does not establish a block response.',
    'Title: Attention Required! | Cloudflare\nMarkdown Content:\nThis article explains the Cloudflare Ray ID: field without a block message.',
    'Title: Attention Required! | Cloudflare\nContent:\nSorry, you have been blocked is quoted without a provider block marker.',
    `Title: Attention Required! | Cloudflare\nMarkdown Content:\nSorry, you have been blocked.${' '.repeat(4096)}Cloudflare Ray ID: outside the bounded prefix`,
    'Title: Attention Required! | Cloudflare\nURL Source: https://example.org/security-notes\nMarkdown Content:\n# Diagnostic reference\nThis article explains an error message. The following quoted example is not an access denial:\n> Sorry, you have been blocked.\n> Cloudflare Ray ID: placeholder\nRecord the ID when reporting the error.',
    'Title: Attention Required! | Cloudflare\nMarkdown Content:\n# Troubleshooting reference\nExample response, reproduced for documentation:\n```text\nSorry, you have been blocked.\nCloudflare Ray ID: abc123\n```\nThe example above illustrates a message, rather than the status of this article.',
    'Title: Attention Required! | Cloudflare\nMarkdown Content:\n> Sorry, you have been blocked.\n> Cloudflare Ray ID: placeholder',
    'Title: Attention Required! | Cloudflare\nMarkdown Content:\n```text\nSorry, you have been blocked.\nCloudflare Ray ID: abc123\n```',
  ]) {
    const result = await read(article);
    expect(result.text).toBe(article);
    expect(result.digest).toBeTruthy();
    expect(result.identityUnverified).toBe(true);
    expect(result.material.publishedAt).toBeNull();
  }
});
