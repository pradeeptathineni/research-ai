import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { createHash } from 'node:crypto';
import { normalizeConsiderUrl } from '../../domain/src/url.js';
import { extractHtml, extractFeed, type DocumentMaterial } from './search-document.js';
import { currentHtmlText, type SourceText } from '../../domain/src/source-text.js';

export interface FetchMetadata {
  status: number;
  etag?: string;
  lastModified?: string;
  link?: string;
  retryAfter?: string;
  rateRemaining?: string;
  rateReset?: string;
}
export interface FetchOptions {
  conditional?: { etag?: string; lastModified?: string };
  allowNotModified?: boolean;
  includeBytes?: boolean;
}
export class FetchHttpError extends Error {
  constructor(
    message: string,
    readonly response: FetchMetadata,
  ) {
    super(message);
  }
}

const header = (value: string | string[] | undefined, max = 4096) => {
  const text = Array.isArray(value) ? value.join(', ') : value;
  return text && !/[\r\n]/.test(text) ? text.slice(0, max) : undefined;
};

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function boundedTextReceipt(raw: string, complete = true) {
  const bytes = Buffer.from(raw);
  let end = Math.min(bytes.length, 32768);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return {
    text: bytes.subarray(0, end).toString(),
    capturedDigest: digest(raw),
    capturedBytes: bytes.length,
    omittedBytes: bytes.length - end,
    captureComplete: complete,
  };
}
export const normalizeSpan = (value: string) => value.replace(/\s+/g, ' ').trim();
const character = (value: number) =>
  Number.isInteger(value) &&
  value >= 0 &&
  value <= 0x10ffff &&
  !(value >= 0xd800 && value <= 0xdfff)
    ? String.fromCodePoint(value)
    : '\uFFFD';
export const normalizeText = (value: string) =>
  value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => character(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code: string) => character(parseInt(code, 16)))
    .replace(
      /&(?:nbsp|amp|lt|gt|quot|apos);/g,
      (match) =>
        ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[
          match
        ]!,
    )
    .replace(/\s+/g, ' ')
    .trim();

export function publicTransportUrl(input: string) {
  normalizeConsiderUrl(input);
  // Identity normalization removes trailing slashes; transport must preserve
  // them or a canonical slash redirect becomes an endless redirect loop.
  const url = new URL(input);
  url.hash = '';
  return url;
}

export async function resolvePublicUrl(input: string) {
  const url = publicTransportUrl(input);
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length) throw new Error('dns_empty');
  for (const address of addresses)
    normalizeConsiderUrl(
      `https://${address.family === 6 ? `[${address.address}]` : address.address}/`,
    );
  return { url, address: addresses[0]! };
}

/** DNS is checked once then pinned for the actual connection; each redirect repeats the check. */
export async function fetchEvidence(
  input: string,
  signal?: AbortSignal,
  redirects = 0,
  allowPdf = false,
  options: FetchOptions = {},
): Promise<{
  text: string;
  digest: string;
  uri: string;
  json?: unknown;
  normalizer?: SourceText;
  material?: DocumentMaterial;
  bytes?: Buffer;
  identityUnverified?: boolean;
  truncated?: boolean;
  response?: FetchMetadata;
  contentType?: string;
}> {
  for (const value of Object.values(options.conditional ?? {}))
    if (value !== undefined && (value.length > 4096 || /[\r\n]/.test(value)))
      throw new Error('invalid_conditional_header');
  signal?.throwIfAborted();
  const { url, address } = await resolvePublicUrl(input);
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        signal,
        timeout: 15000,
        headers: {
          'user-agent':
            'SignalsAI/0.3 public-evidence (+https://github.com/pradeeptathineni/signals-ai)',
          accept: 'text/html,text/plain,application/json',
          ...(options.conditional?.etag ? { 'if-none-match': options.conditional.etag } : {}),
          ...(options.conditional?.lastModified
            ? { 'if-modified-since': options.conditional.lastModified }
            : {}),
        },
        lookup: (_hostname, _options, callback) =>
          callback(null, [{ address: address.address, family: address.family }]),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const metadata: FetchMetadata = {
          status,
          etag: header(response.headers.etag),
          lastModified: header(response.headers['last-modified']),
          link: header(response.headers.link),
          retryAfter: header(response.headers['retry-after']),
          rateRemaining: header(response.headers['x-ratelimit-remaining'], 40),
          rateReset: header(response.headers['x-ratelimit-reset'], 40),
        };
        if (status === 304 && options.allowNotModified) {
          response.resume();
          resolve({ text: '', digest: digest(''), uri: url.toString(), response: metadata });
          return;
        }
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (redirects >= 3) return reject(new Error('redirect_limit'));
          const target = new URL(response.headers.location, url);
          void fetchEvidence(
            target.toString(),
            signal,
            redirects + 1,
            allowPdf,
            target.origin === url.origin ? options : {},
          ).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(
            new FetchHttpError(
              status === 401 || status === 403 || status === 429
                ? `source_denied_${status}`
                : `source_http_${status}`,
              metadata,
            ),
          );
          return;
        }
        if (
          !(allowPdf && /application\/pdf/i.test(response.headers['content-type'] ?? '')) &&
          !/text\/|application\/(?:json|(?:[\w.-]+\+)?xml)/i.test(
            response.headers['content-type'] ?? '',
          )
        ) {
          response.resume();
          reject(new Error('unsupported_content'));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 2000000) {
            req.destroy(new Error('document_bytes_limit'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          const received = Buffer.concat(chunks);
          const contentType = response.headers['content-type'] ?? '';
          const raw = received.toString('utf8');
          void (async () => {
            try {
              if (/application\/pdf/i.test(contentType)) {
                resolve({
                  text: '',
                  digest: createHash('sha256').update(received).digest('hex'),
                  uri: url.toString(),
                  bytes: received,
                  contentType,
                  response: metadata,
                });
                return;
              }
              const material = /html/i.test(contentType)
                ? extractHtml(raw, url.toString())
                : /xml/i.test(contentType)
                  ? await extractFeed(raw, url.toString())
                  : undefined;
              resolve({
                text: material?.text ?? normalizeSpan(raw),
                digest: digest(raw),
                uri: url.toString(),
                normalizer: /html/i.test(contentType) ? currentHtmlText : 'text-v2',
                ...(material?.scope && (material.scope.omittedTables || material.scope.omittedDepth)
                  ? { truncated: true }
                  : {}),
                response: metadata,
                ...(options.includeBytes ? { bytes: received, contentType } : {}),
                ...(material ? { material } : {}),
                ...(/application\/json/i.test(response.headers['content-type'] ?? '')
                  ? { json: JSON.parse(raw) as unknown }
                  : {}),
              });
            } catch (error) {
              reject(error instanceof Error ? error : new Error('invalid_source_document'));
            }
          })();
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('source_timeout')));
    req.on('error', reject);
    req.end();
  });
}
