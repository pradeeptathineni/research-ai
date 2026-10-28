import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { default as formats } from 'ajv-formats';
import schema from '../../contracts/src/evidence-bundle-v1.schema.json' with { type: 'json' };
import { normalizeConsiderUrl } from './url.js';
import { parseQueryAssessment } from './query-exchange.js';

export interface EvidenceBundle {
  schema_version: 1;
  bundle_id: string;
  mode: 'agent-assisted' | 'model-led' | 'offline-curated' | 'fixture';
  created_at: string;
  producer: { repository: string; commit: string; protocol: string };
  need: { query: string; concept_ids?: string[]; constraints?: string[] };
  sources: Array<{
    id: string;
    uri: string;
    title: string;
    source_class: string;
    observed_at?: string | null;
    revision?: string | null;
    independence_group?: string | null;
  }>;
  claims: Array<{
    id: string;
    text: string;
    source_ids: string[];
    status: 'observed' | 'supported' | 'inferred' | 'uncertain' | 'contradicted';
  }>;
  candidates: Array<{
    id: string;
    name: string;
    canonical_uri: string;
    claim_ids: string[];
    disposition: 'consider' | 'trial' | 'adopt' | 'defer' | 'reject';
    reason: string;
    limitations: string[];
    signal?: {
      evidence_confidence?: 'low' | 'medium' | 'high' | 'unknown';
      project_fit?: 'low' | 'medium' | 'high' | 'unknown';
      [key: string]: unknown;
    };
  }>;
  limitations: string[];
  extensions?: Record<string, unknown>;
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
// CommonJS interop differs between NodeNext and tsx; use the named runtime default.
const addFormats = formats as unknown as (instance: Ajv2020) => void;
addFormats(ajv);
const check = ajv.compile<EvidenceBundle>(schema);
const MAX_EVIDENCE_BYTES = 262_144;
export function evidenceDigest(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

class EvidenceValidationError extends Error {}
function requireEvidence(condition: unknown, message: string): asserts condition {
  if (!condition) throw new EvidenceValidationError(message);
}

/** Reject ambiguous structured records before assigning validation or publication authority. */
export function requireUniqueJsonKeys(bytes: string) {
  const objects: Array<{ keys: Set<string>; expectsKey: boolean } | null> = [];
  for (const token of bytes.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\],:]/g)) {
    const part = token[0];
    if (part === '{' || part === '[') {
      requireEvidence(objects.length < 32, 'Evidence nesting budget exceeded.');
      objects.push(part === '{' ? { keys: new Set(), expectsKey: true } : null);
    } else if (part === '}' || part === ']') objects.pop();
    else {
      const object = objects.at(-1);
      if (part === ',' && object) object.expectsKey = true;
      else if (part.startsWith('"') && object?.expectsKey) {
        const key = JSON.parse(part) as string;
        requireEvidence(!object.keys.has(key), 'Duplicate JSON key.');
        object.keys.add(key);
        object.expectsKey = false;
      }
    }
  }
}

/** Validate exact bytes before parsing. Extensions are inert, never policy authority. */
export function parseEvidenceBundle(
  bytes: string,
  digest: string,
  options: { allowFixture?: boolean; conceptIds?: readonly string[] } = {},
): EvidenceBundle {
  requireEvidence(
    Buffer.byteLength(bytes, 'utf8') <= MAX_EVIDENCE_BYTES,
    'Evidence exceeds byte budget.',
  );
  requireEvidence(
    /^[a-f0-9]{64}$/.test(digest) && evidenceDigest(bytes) === digest,
    'Evidence digest mismatch.',
  );
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new EvidenceValidationError('Invalid evidence JSON.');
  }
  requireEvidence(check(value), 'Evidence schema v1 mismatch.');
  const bundle = value;
  // JSON.parse owns syntax. This bounded token pass rejects ambiguous duplicate names,
  // including escaped spellings, before exact bytes can be admitted or exported.
  requireUniqueJsonKeys(bytes);
  requireEvidence(Date.parse(bundle.created_at) <= Date.now(), 'Future evidence creation date.');
  requireEvidence(
    options.allowFixture || bundle.mode !== 'fixture',
    'Fixtures cannot enter real evidence admission.',
  );
  requireEvidence(
    /^[a-f0-9]{40}$/.test(bundle.producer.commit),
    'Producer must pin a full Git commit.',
  );
  requireEvidence(
    ['signals-evidence-v1', 'research-protocol-v2'].includes(bundle.producer.protocol),
    'Unknown producer protocol.',
  );
  const privatePattern =
    /(?:\/Users\/|\/home\/|file:\/\/|-----BEGIN .*PRIVATE KEY|\b(?:gh[pousr]_|github_pat_|sk-proj-)[A-Za-z0-9_-]{10,}|\b(?:password|api[_-]?key|secret|token)\s*[=:]\s*\S+)/i;
  function containsPrivate(input: unknown): boolean {
    if (typeof input === 'string') return privatePattern.test(input);
    if (Array.isArray(input)) return input.some(containsPrivate);
    if (input && typeof input === 'object')
      return Object.entries(input).some(
        ([key, item]) => privatePattern.test(key) || containsPrivate(item),
      );
    return false;
  }
  requireEvidence(!containsPrivate(bundle), 'Evidence contains private paths or credentials.');
  for (const collection of [bundle.sources, bundle.claims, bundle.candidates]) {
    requireEvidence(collection.length <= 100, 'Evidence exceeds record budget.');
    requireEvidence(
      new Set(collection.map((item) => item.id)).size === collection.length,
      'Duplicate evidence IDs.',
    );
  }
  const sourceIds = new Set(bundle.sources.map((source) => source.id));
  const claims = new Map(bundle.claims.map((claim) => [claim.id, claim]));
  for (const source of bundle.sources) {
    const url = normalizeConsiderUrl(source.uri);
    requireEvidence(
      url.hostname.includes('.') && !/\.(?:lan|internal|test|invalid)$/.test(url.hostname),
      'Public sources cannot name local or reserved hosts.',
    );
    requireEvidence(
      !['fixture', 'synthetic'].includes(source.source_class),
      'Synthetic sources cannot enter real evidence.',
    );
    requireEvidence(
      !source.observed_at || Date.parse(source.observed_at) <= Date.parse(bundle.created_at),
      'Observation postdates bundle.',
    );
  }
  for (const claim of bundle.claims) {
    requireEvidence(
      claim.source_ids.every((id) => sourceIds.has(id)),
      'Unknown claim source.',
    );
  }
  for (const candidate of bundle.candidates) {
    const candidateUrl = normalizeConsiderUrl(candidate.canonical_uri);
    requireEvidence(
      candidateUrl.hostname.includes('.') &&
        !/\.(?:lan|internal|test|invalid)$/.test(candidateUrl.hostname),
      'Public candidates cannot name local or reserved hosts.',
    );
    requireEvidence(
      candidate.claim_ids.every((id) => claims.has(id)),
      'Unknown candidate claim.',
    );
    if (['adopt', 'trial'].includes(candidate.disposition)) {
      requireEvidence(
        candidate.claim_ids.some((id) =>
          ['supported', 'observed'].includes(claims.get(id)!.status),
        ),
        'Adoption/trial needs a supported claim.',
      );
      requireEvidence(
        !candidate.claim_ids.some((id) => claims.get(id)!.status === 'contradicted'),
        'Contradicted claims block adoption/trial pending reassessment.',
      );
    }
    // Only the known categorical signals are interpreted. Additional signals remain inert.
    requireEvidence(
      !('policy_id' in (candidate.signal ?? {})),
      'Unknown signal policy cannot gain authority.',
    );
  }
  const concepts = bundle.need.concept_ids ?? [];
  requireEvidence(
    concepts.length <= 100 && concepts.every((id) => id.length <= 120),
    'Concept budget exceeded.',
  );
  if (options.conceptIds)
    requireEvidence(
      concepts.every((id) => options.conceptIds!.includes(id)),
      'Unknown consumer concept.',
    );
  requireEvidence(
    bundle.candidates.length || bundle.limitations.length,
    'Empty evidence requires a limitation.',
  );
  requireEvidence(
    Object.keys(bundle.extensions ?? {}).every((key) =>
      /^[a-z][a-z0-9-]*\.[a-z0-9._-]+$/.test(key),
    ),
    'Extensions require a namespace.',
  );
  for (const [key, extension] of Object.entries(bundle.extensions ?? {})) {
    requireEvidence(
      !/\.(?:policy_id|policy_ids)$/.test(key),
      'Unknown extension policy cannot gain authority.',
    );
    if (/\.(?:privacy|privacy_scope)$/.test(key))
      requireEvidence(
        typeof extension === 'string' &&
          ['public', 'public-only', 'public_sources_only'].includes(extension),
        'Inadmissible evidence privacy scope.',
      );
  }
  const acquisition = bundle.extensions?.['signals.acquisition'];
  if (bundle.extensions?.['signals-ai.query-assessment'])
    parseQueryAssessment(
      bundle.extensions['signals-ai.query-assessment'],
      bundle.sources,
      bundle.candidates,
    );
  requireEvidence(
    !acquisition ||
      typeof acquisition !== 'object' ||
      !('fixture' in acquisition) ||
      acquisition.fixture !== true ||
      options.allowFixture,
    'Fixture acquisition cannot be relabelled as real evidence.',
  );
  return bundle;
}

export function evidenceChange(previous: EvidenceBundle, next: EvidenceBundle): string[] {
  const changes: string[] = [];
  for (const field of ['need', 'claims', 'candidates'] as const) {
    if (JSON.stringify(previous[field]) !== JSON.stringify(next[field]))
      changes.push(`${field} changed; reconsider affected decisions.`);
  }
  if (
    JSON.stringify(previous.sources.map((s) => [s.id, s.uri, s.revision])) !==
    JSON.stringify(next.sources.map((s) => [s.id, s.uri, s.revision]))
  )
    changes.push('Source identity or revision changed; revalidate consumers.');
  return changes;
}
