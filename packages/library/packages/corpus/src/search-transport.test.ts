import { expect, it } from 'vitest';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acceptDiscovery } from './signal-search.js';
import { privateCacheFetch } from './search-cache.js';
import { digest } from './search-fetch.js';
import {
  atomicJson,
  retainRun,
  loadRun,
  saveEntities,
  loadEntities,
  validateEntity,
} from './search-store.js';
import { checkPrimaryMaterial } from './search-reuse.js';
import { budgets, type Proposal, type SearchResult } from '../../domain/src/search-contract.js';

const uri = 'https://example.org/tool';
const text = 'Provides source tracing for resources.';
const transport = { etag: '"fixture-v1"', lastModified: 'Wed, 07 Oct 2026 12:00:00 GMT' };
const proposal: Proposal = {
  sources: [
    {
      uri,
      title: 'Primary',
      publisher: 'Author',
      family: 'primary',
      publishedAt: null,
      origin: 'original',
    },
  ],
  candidates: [
    {
      uri,
      name: 'Example Tool',
      kind: 'software',
      identity: 'resolved',
      aliases: [],
      description: 'Source tracing',
      facets: {
        domains: [],
        capabilities: [],
        interfaces: [],
        deliveryForms: [],
        platforms: [],
        licenses: [],
        tags: [],
      },
      limits: [],
      match: { level: 'direct', reason: 'Fits tracing', sources: [0] },
      observations: [
        {
          source: 0,
          feature: 'defining',
          indicator: 'defines',
          statement: 'Provides source tracing.',
          quote: 'Provides source tracing',
          independent: false,
          origin: 'original',
          status: 'supported',
        },
      ],
    },
  ],
  coverage: [],
  gaps: [],
};
function run(accepted: Awaited<ReturnType<typeof acceptDiscovery>>): SearchResult {
  return {
    schemaVersion: 2,
    runId: randomUUID(),
    query: 'source tracing',
    status: 'completed',
    ...accepted,
    usage: {
      searches: 0,
      documents: 1,
      elapsedMs: 0,
      modelCalls: 0,
      providerUsage: null,
      cost: null,
    },
    limits: budgets.quick,
  };
}

it('retains, reopens and manually saves acquired transport metadata for conditional primary checks', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-transport-')));
  try {
    let calls = 0;
    const fetch = privateCacheFetch(root, undefined, async (url) => {
      calls++;
      return {
        uri: url,
        text,
        digest: digest(text),
        normalizer: 'text-v2',
        response: { status: 200, ...transport },
      };
    });
    const first = run(
      await acceptDiscovery(proposal, { query: 'source tracing', route: 'native' }, { fetch }),
    );
    expect(first.items[0]!.entity.evidence[0]!.transport).toEqual(transport);
    await retainRun(first, root);
    const bytes = await readFile(resolve(root, '.signals/runs', `${first.runId}.json`), 'utf8');
    const reopened = await loadRun(first.runId, root);
    expect(reopened.items[0]!.entity.evidence[0]!.transport).toEqual(transport);
    expect(
      (await saveEntities(reopened.items, 'manual', root, 'private', 75, true)).changed,
    ).toHaveLength(1);
    const stored = (await loadEntities(resolve(root, '.signals/corpus/entities')))[0]!;
    const checked = await checkPrimaryMaterial(stored.entity, {
      fetch: async (url, _signal, _redirects, _pdf, options) => {
        expect(options?.conditional).toBeUndefined();
        expect(options?.allowNotModified).toBe(false);
        return { uri: url, text: '', digest: digest(''), response: { status: 304 } };
      },
    });
    expect(checked.status).toBe('changed');
    expect(checked.reason).toContain('representation is not current');
    expect(checked.claimsRenewed).toBe(false);
    expect(await readFile(resolve(root, '.signals/runs', `${first.runId}.json`), 'utf8')).toBe(
      bytes,
    );
    expect(calls).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('preserves transport validators on source-cache replay without a second fetch', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-transport-cache-')));
  try {
    let calls = 0;
    const fetch = privateCacheFetch(root, undefined, async (url) => {
      calls++;
      return { uri: url, text, digest: digest(text), response: { status: 200, ...transport } };
    });
    await fetch(uri);
    const cached = await fetch(uri);
    expect(cached.cached).toBe(true);
    expect(cached.response).toEqual({ status: 200, ...transport });
    const accepted = await acceptDiscovery(
      proposal,
      { query: 'source tracing', route: 'native' },
      { fetch },
    );
    expect(accepted.items[0]!.entity.evidence[0]!.transport).toEqual(transport);
    expect(
      (await saveEntities(accepted.items, 'manual', root, 'private', 75, true)).changed,
    ).toHaveLength(1);
    expect(calls).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects unsafe or unrelated persisted transport fields', async () => {
  const accepted = await acceptDiscovery(
    proposal,
    { query: 'source tracing' },
    {
      fetch: async () => ({ uri, text, digest: digest(text) }),
    },
  );
  for (const invalid of [
    { etag: 'value\r\nAuthorization: injected' },
    { etag: 'x'.repeat(4097) },
    { etag: 'safe', authorization: 'unrelated' },
    {},
  ]) {
    const entity = structuredClone(accepted.items[0]!.entity);
    Object.assign(entity.evidence[0]!, { transport: invalid });
    expect(() => validateEntity(entity)).toThrow('invalid_entity_schema');
  }
});

it('rejects injected conditional headers in a cached response before reuse', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-transport-injected-')));
  try {
    await atomicJson(resolve(root, '.signals/source-cache', `${digest(uri)}.json`), {
      uri,
      text,
      digest: digest(text),
      normalizer: 'text-v2',
      response: { status: 200, etag: 'value\r\nInjected: header' },
    });
    const fetch = privateCacheFetch(root, undefined, async () => {
      throw new Error('must_not_fetch');
    });
    await expect(fetch(uri)).rejects.toThrow('invalid_source_cache');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
