import { isIP } from 'node:net';

const MAX_URL_LENGTH = 2048;

class UrlPolicyError extends Error {
  constructor(
    public readonly code:
      | 'invalid_url'
      | 'unsupported_scheme'
      | 'userinfo_forbidden'
      | 'port_forbidden'
      | 'blocked_host'
      | 'too_long',
    message: string,
  ) {
    super(message);
  }
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a = 0, b = 0, c = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === '::' ||
    host === '::1' ||
    host.startsWith('::ffff:') ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.startsWith('fe8') ||
    host.startsWith('fe9') ||
    host.startsWith('fea') ||
    host.startsWith('feb') ||
    host.startsWith('fec') ||
    host.startsWith('fed') ||
    host.startsWith('fee') ||
    host.startsWith('fef') ||
    host.startsWith('ff') ||
    host.startsWith('2001:db8:')
  );
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return true;
  }
  const ipVersion = isIP(host);
  return (ipVersion === 4 && isPrivateIpv4(host)) || (ipVersion === 6 && isPrivateIpv6(host));
}

export interface NormalizedUrl {
  originalUrl: string;
  normalizedUrl: string;
  hostname: string;
  fetchDisposition: 'allowlisted_metadata' | 'manual_review_required';
  strongIdentity?: { scheme: 'github_repository'; value: string };
}

export function normalizeConsiderUrl(input: string): NormalizedUrl {
  const originalUrl = input.trim();
  if (originalUrl.length > MAX_URL_LENGTH) {
    throw new UrlPolicyError('too_long', `URL exceeds ${MAX_URL_LENGTH} characters.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(originalUrl);
  } catch {
    throw new UrlPolicyError('invalid_url', 'Enter an absolute HTTPS URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new UrlPolicyError('unsupported_scheme', 'Only HTTPS URLs can be considered.');
  }
  if (parsed.username || parsed.password) {
    throw new UrlPolicyError('userinfo_forbidden', 'Credentials in URLs are not accepted.');
  }
  if (parsed.port && parsed.port !== '443') {
    throw new UrlPolicyError('port_forbidden', 'Only the standard HTTPS port is accepted.');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (isBlockedHostname(hostname)) {
    throw new UrlPolicyError('blocked_host', 'Local, private, and reserved hosts are blocked.');
  }
  parsed.hostname = hostname;
  parsed.hash = '';
  parsed.port = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$)/i.test(key)) {
      parsed.searchParams.delete(key);
    }
  }
  parsed.searchParams.sort();
  parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/');
  if (parsed.pathname.length > 1) {
    parsed.pathname = parsed.pathname.replace(/\/$/, '');
  }
  const result: NormalizedUrl = {
    originalUrl,
    normalizedUrl: parsed.toString(),
    hostname,
    fetchDisposition: hostname === 'github.com' ? 'allowlisted_metadata' : 'manual_review_required',
  };
  if (hostname === 'github.com') {
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length >= 2) {
      const owner = segments[0];
      const repository = segments[1]?.replace(/\.git$/i, '');
      if (owner && repository) {
        result.strongIdentity = {
          scheme: 'github_repository',
          value: `${owner.toLowerCase()}/${repository.toLowerCase()}`,
        };
      }
    }
  }
  return result;
}
