import { readFile, lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { atomicJson } from './search-store.js';
import { fetchEvidence, digest } from './search-fetch.js';
import { normalizeConsiderUrl } from '../../domain/src/url.js';
import { cachedMaterial } from './search-document.js';
import { currentHtmlText, supportedSourceText } from '../../domain/src/source-text.js';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

const header = Type.Optional(Type.String({ maxLength: 4096, pattern: '^[^\\r\\n]*$' }));
const cachedResponseSchema = Type.Object(
  {
    status: Type.Integer({ minimum: 100, maximum: 599 }),
    etag: header,
    lastModified: header,
    link: header,
    retryAfter: header,
    rateRemaining: header,
    rateReset: header,
  },
  { additionalProperties: false },
);

/** Explicit private caching retains bounded fetched text; memory/no-save never calls this. */
export function privateCacheFetch(
  root: string,
  progress?: (event: string) => void,
  fetch = fetchEvidence,
) {
  return async (uri: string, signal?: AbortSignal) => {
    const normalized = normalizeConsiderUrl(uri).normalizedUrl;
    const legacyPath = resolve(root, '.signals/source-cache', `${digest(normalized)}.json`);
    const currentPath = resolve(
      root,
      '.signals/source-cache',
      `${digest(`${normalized}:${currentHtmlText}`)}.json`,
    );
    const plainPath = resolve(
      root,
      '.signals/source-cache',
      `${digest(`${normalized}:text-v2`)}.json`,
    );
    for (const path of [currentPath, plainPath, legacyPath]) {
      const stat = await lstat(path).catch(() => null);
      if (stat && (!stat.isFile() || stat.isSymbolicLink() || (await realpath(path)) !== path))
        throw new Error('symlink_source_cache');
      if (stat && Date.now() - stat.mtimeMs < 3600000 && stat.size < 2200000) {
        const cached: unknown = JSON.parse(await readFile(path, 'utf8'));
        const material =
          cached && typeof cached === 'object' && 'material' in cached
            ? cachedMaterial(cached.material)
            : undefined;
        if (
          cached &&
          typeof cached === 'object' &&
          'normalizer' in cached &&
          cached.normalizer === 'text-v2' &&
          material?.extractor === 'readability-0.6.0'
        )
          continue;
        if (
          cached &&
          typeof cached === 'object' &&
          'normalizer' in cached &&
          supportedSourceText(cached.normalizer) &&
          'uri' in cached &&
          cached.uri === normalized &&
          'text' in cached &&
          typeof cached.text === 'string' &&
          cached.text.length <= 2000000 &&
          'digest' in cached &&
          typeof cached.digest === 'string' &&
          /^[a-f0-9]{64}$/.test(cached.digest) &&
          (cached.normalizer !== currentHtmlText ||
            (material?.scope && material.text === cached.text))
        ) {
          signal?.throwIfAborted();
          const response = 'response' in cached ? cached.response : undefined;
          if (response !== undefined && !Value.Check(cachedResponseSchema, response))
            throw new Error('invalid_source_cache');
          progress?.(`Private cache hit: ${new URL(normalized).hostname}`);
          return {
            uri:
              'finalUri' in cached && typeof cached.finalUri === 'string'
                ? normalizeConsiderUrl(cached.finalUri).normalizedUrl
                : normalized,
            text: cached.text,
            digest: cached.digest,
            normalizer: cached.normalizer,
            ...(response
              ? {
                  response: {
                    status: response.status,
                    etag: response.etag,
                    lastModified: response.lastModified,
                  },
                }
              : {}),
            material,
            identityUnverified:
              'identityUnverified' in cached && cached.identityUnverified === true,
            truncated: 'truncated' in cached && cached.truncated === true,
            cached: true,
            fetchedAt:
              'fetchedAt' in cached && typeof cached.fetchedAt === 'string'
                ? cached.fetchedAt
                : stat.mtime.toISOString(),
          };
        }
        if (
          cached &&
          typeof cached === 'object' &&
          'normalizer' in cached &&
          supportedSourceText(cached.normalizer)
        )
          throw new Error('invalid_source_cache');
      }
    }
    const fetched = await fetch(normalized, signal);
    const normalizer = fetched.normalizer ?? 'text-v2';
    if (
      !supportedSourceText(normalizer) ||
      (normalizer === currentHtmlText &&
        (!fetched.material?.scope ||
          fetched.material.text !== fetched.text ||
          fetched.material.scope.textDigest !== digest(fetched.text)))
    )
      throw new Error('invalid_source_representation');
    const fetchedAt = new Date().toISOString();
    await atomicJson(normalizer === currentHtmlText ? currentPath : plainPath, {
      ...fetched,
      normalizer,
      uri: normalized,
      finalUri: fetched.uri,
      fetchedAt,
    });
    return { ...fetched, normalizer, cached: false, fetchedAt };
  };
}
