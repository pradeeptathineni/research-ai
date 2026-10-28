import { expect, it } from 'vitest';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { acceptDiscovery } from './signal-search.js';
import { contextualize } from '../../domain/src/search-priority.js';
import {
  scanSources,
  scanSourcesForResearch,
  recordSourceResultExposures,
} from './search-sources.js';
import { withWriter, atomicJson, retainRun, loadRun } from './search-store.js';
import { defaultSettings } from './search-settings.js';
import { saveSettings } from './search-settings.js';
import { updatePersonal } from './search-personal.js';
import type { Proposal } from '../../domain/src/search-contract.js';
import { budgets, type SearchResult } from '../../domain/src/search-contract.js';
import { searchEvidenceBundle } from './search-exchange.js';
import { randomUUID } from 'node:crypto';

const proposal: Proposal = {
  sources: [
    {
      uri: 'https://example.org/tool',
      title: 'Original tool',
      publisher: 'Author',
      family: 'primary',
      publishedAt: null,
      origin: 'original',
    },
  ],
  candidates: [
    {
      uri: 'https://example.org/tool',
      name: 'Example Tool',
      kind: 'software',
      identity: 'resolved',
      aliases: [],
      description: 'Generic reviewed candidate',
      facets: {
        domains: [],
        capabilities: ['source tracing'],
        interfaces: [],
        deliveryForms: [],
        platforms: [],
        licenses: [],
        tags: [],
      },
      observations: [],
      match: { level: 'direct', reason: 'Fits the question', sources: [0] },
      limits: [],
      priority: {
        applicability: 'direct',
        value: 'high',
        action: 'use',
        reason: 'Inspect source tracing',
        constraints: [],
        sources: [0],
      },
      discovery: { introducedBy: 'unseeded-query', query: 'portable source tracing' },
    },
  ],
  coverage: [],
  gaps: [],
};
const fetch = async (uri: string) => ({
  uri,
  text: 'Provides source tracing. Release 2026-07-01.',
  digest: 'a'.repeat(64),
});

it('binds normalized introducing parents to actual outlinks and source exposures', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'source-parent-review-')));
  try {
    const reportedParent = 'https://EXAMPLE.org/feed/?utm_source=follow';
    const parent = 'https://example.org/feed';
    const settings = await saveSettings(
      {
        ...defaultSettings,
        followedSources: [{ uri: parent, label: 'Scout', enabled: true, interests: [] }],
      },
      root,
    );
    const sourceFetch = async (uri: string) => ({
      ...(await fetch(uri)),
      material: {
        text: 'Scout',
        title: 'Scout',
        author: null,
        publishedAt: null,
        sections: [],
        extractor: 'fixture',
        links: [{ uri: 'https://example.org/tool', title: 'Tool' }],
      },
    });
    await scanSources(settings, root, { persist: true, recordExposure: false, fetch: sourceFetch });
    const linked = structuredClone(proposal);
    linked.sources.push({ ...linked.sources[0]!, uri: reportedParent, title: 'Scout' });
    linked.candidates[0]!.discovery = {
      introducedBy: 'followed-source',
      parentUri: reportedParent,
    };
    const accepted = await acceptDiscovery(
      linked,
      { query: 'portable tracing' },
      { fetch: sourceFetch, followedSources: [parent] },
    );
    expect(accepted.items[0]!.discovery).toMatchObject({
      parentUri: parent,
      linkVerified: true,
      provenanceBasis: 'configured-source',
    });
    expect(accepted.gaps).not.toContain(
      'Example Tool: introducing parent link not verified in fetched material',
    );
    await recordSourceResultExposures(root, accepted.items);
    const state = JSON.parse(await readFile(resolve(root, '.signals/source-state.json'), 'utf8'));
    expect(state[parent].resultExposures).toBe(1);
    expect(state[reportedParent]).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('credits explicit feedback once to the configured source without counting background scans as exposures', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'source-feedback-review-')));
  try {
    const uri = 'https://example.org/feed';
    const settings = {
      ...defaultSettings,
      followedSources: [{ uri, label: 'Scout', enabled: true, interests: [] }],
    };
    await saveSettings(settings, root);
    const sourceFetch = async (url: string) => ({
      ...(await fetch(url)),
      material: {
        text: 'Scout',
        title: 'Scout',
        author: null,
        publishedAt: null,
        sections: [],
        extractor: 'fixture',
        links: [{ uri: 'https://example.org/tool', title: 'Tool' }],
      },
    });
    await scanSources(settings, root, { persist: true, recordExposure: false, fetch: sourceFetch });
    const id = 'entity-aaaaaaaaaaaaaaaaaaaaaaaa';
    const value = {
      note: 'Private note',
      feedback: 'useful' as const,
      novelty: 'unknown' as const,
      seenAt: new Date().toISOString(),
    };
    await updatePersonal(root, id, value, uri);
    await updatePersonal(root, id, value, uri);
    const state = JSON.parse(await readFile(resolve(root, '.signals/source-state.json'), 'utf8'))[
      uri
    ];
    expect(state.exposures).toBe(0);
    expect(state.feedback).toBe(1);
    const linked = structuredClone(proposal);
    linked.sources.push({ ...linked.sources[0]!, uri, title: 'Scout' });
    linked.candidates[0]!.discovery = { introducedBy: 'followed-source', parentUri: uri };
    const accepted = await acceptDiscovery(
      linked,
      { query: 'portable tracing' },
      { fetch: sourceFetch, followedSources: [uri] },
    );
    expect(accepted.items[0]!.discovery!.provenanceBasis).toBe('configured-source');
    expect(accepted.items[0]!.discovery!.linkVerified).toBe(true);
    await recordSourceResultExposures(root, accepted.items);
    expect(
      JSON.parse(await readFile(resolve(root, '.signals/source-state.json'), 'utf8'))[uri]
        .resultExposures,
    ).toBe(1);
    await updatePersonal(root, id, { ...value, feedback: 'skip' }, uri);
    expect(
      JSON.parse(await readFile(resolve(root, '.signals/source-state.json'), 'utf8'))[uri].feedback,
    ).toBe(-1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('does not turn an unbound lead into an evidence-backed use recommendation', async () => {
  const accepted = await acceptDiscovery(proposal, { query: 'portable tracing' }, { fetch });
  const [item] = contextualize(accepted.items, new Set());
  expect(item!.priority!.score).toBeNull();
  expect(item!.priority!.action).toBe('study');
  expect(item!.priority!.proposedAction).toBe('use');
  expect(item!.entity.observations).toEqual([]);
  const bundle = searchEvidenceBundle(
    {
      schemaVersion: 2,
      runId: randomUUID(),
      query: 'portable tracing',
      status: 'completed',
      items: [item!],
      sources: accepted.sources,
      coverage: [],
      gaps: [],
      counts: accepted.counts,
      limits: budgets.quick,
      usage: {
        searches: 0,
        documents: 1,
        elapsedMs: 0,
        modelCalls: 0,
        providerUsage: null,
        cost: null,
      },
    } satisfies SearchResult,
    'a'.repeat(40),
  );
  expect(bundle.candidates).toHaveLength(1);
  expect((bundle.extensions!['signals.recommendations'] as { items: unknown[] }).items).toEqual([]);
});

it('replays historical priority and provenance conservatively without rewriting retained bytes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'retained-review-')));
  try {
    const accepted = await acceptDiscovery(proposal, { query: 'portable tracing' }, { fetch });
    const items = contextualize(accepted.items, new Set());
    items[0]!.priority = {
      ...items[0]!.priority!,
      policy: 'contextual-priority-v1',
      score: 100,
      action: 'use',
    };
    items[0]!.discovery = {
      introducedBy: 'followed-source',
      parentUri: 'https://example.org/feed',
      linkVerified: false,
    };
    const result: SearchResult = {
      schemaVersion: 2,
      runId: randomUUID(),
      query: 'portable tracing',
      status: 'completed',
      items,
      sources: accepted.sources,
      coverage: [],
      gaps: [],
      counts: accepted.counts,
      limits: budgets.quick,
      usage: {
        searches: 0,
        documents: 1,
        elapsedMs: 0,
        modelCalls: 0,
        providerUsage: null,
        cost: null,
      },
    };
    await retainRun(result, root);
    const path = resolve(root, '.signals/runs', `${result.runId}.json`);
    const before = await readFile(path, 'utf8');
    await saveSettings(
      {
        ...defaultSettings,
        followedSources: [
          {
            uri: 'https://example.org/feed',
            label: 'Later configuration',
            enabled: true,
            interests: [],
          },
        ],
      },
      root,
    );
    const replay = await loadRun(result.runId, root);
    expect(replay.items[0]!.priority!.score).toBeNull();
    expect(replay.items[0]!.priority!.action).toBe('study');
    expect(replay.items[0]!.priority!.proposedAction).toBe('use');
    expect(replay.items[0]!.discovery!.introducedBy).toBe('model-nominated');
    expect(replay.items[0]!.discovery!.provenanceBasis).toBe('model-report');
    expect(await readFile(path, 'utf8')).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('binds capture seeding and refuses fabricated followed-source or candidate-named discovery', async () => {
  const seeded = await acceptDiscovery(
    proposal,
    { query: 'portable tracing', captureUrls: ['https://example.org/tool'] },
    { fetch },
  );
  expect(seeded.items[0]!.discovery!.introducedBy).toBe('user-seeded');
  const followed = structuredClone(proposal);
  followed.candidates[0]!.discovery = {
    introducedBy: 'followed-source',
    parentUri: 'https://example.org/hub',
  };
  const unconfigured = await acceptDiscovery(followed, { query: 'portable tracing' }, { fetch });
  expect(unconfigured.items[0]!.discovery!.introducedBy).toBe('model-nominated');
  const named = structuredClone(proposal);
  named.candidates[0]!.discovery!.query = 'Example Tool source tracing';
  const nominated = await acceptDiscovery(named, { query: 'portable tracing' }, { fetch });
  expect(nominated.items[0]!.discovery!.introducedBy).toBe('model-nominated');
});

it('shows a successful kernel fetch conflicting with an earlier model access failure without rescoring', async () => {
  const stale = structuredClone(proposal);
  stale.sources[0]!.title = 'Original tool changelog — retrieval failed';
  stale.gaps = ['Example Tool changelog returned retrieval errors; maintenance remains unknown.'];
  const accepted = await acceptDiscovery(stale, { query: 'portable tracing' }, { fetch });
  expect(accepted.sources[0]!.reason).toContain('kernel_fetched_model_assessment_stale');
  expect(accepted.gaps).toContain(stale.gaps[0]);
  expect(accepted.items[0]!.entity.assessment.score).toBeNull();
});

it('does not hold the writer lock across source network I/O or acquire it for an empty scan', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'source-lock-review-')));
  try {
    await withWriter(root, async () => {
      expect((await scanSources(defaultSettings, root, { persist: true })).sources).toEqual([]);
    });
    const settings = {
      ...defaultSettings,
      followedSources: [
        { uri: 'https://example.org/feed', label: 'Scout', enabled: true, interests: [] },
      ],
    };
    const result = await scanSources(settings, root, {
      persist: true,
      fetch: async (uri) => {
        await withWriter(root, async () => {});
        return fetch(uri);
      },
    });
    expect(result.sources[0]!.state).toBe('fetched');
    expect(
      JSON.parse(await readFile(resolve(root, '.signals/source-state.json'), 'utf8'))[
        'https://example.org/feed'
      ].state,
    ).toBe('fetched');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps supplemental lock/corrupt-state failures as gaps without requiring an AI lease', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'source-gap-review-')));
  const settings = {
    ...defaultSettings,
    followedSources: [
      { uri: 'https://example.org/feed', label: 'Scout', enabled: true, interests: [] },
    ],
  };
  let acquisitions = 0;
  const sourceFetch = async (uri: string) => {
    acquisitions++;
    return fetch(uri);
  };
  try {
    await withWriter(root, async () => {
      const partial = await scanSourcesForResearch(settings, root, {
        persist: true,
        fetch: sourceFetch,
      });
      expect(partial.gaps[0]).toContain('writer_busy');
      expect(partial.modelCalls).toBe(0);
    });
    await atomicJson(resolve(root, '.signals/source-state.json'), []);
    const partial = await scanSourcesForResearch(settings, root, {
      persist: true,
      fetch: sourceFetch,
    });
    expect(partial.gaps[0]).toContain('invalid_source_state');
    expect(acquisitions).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
