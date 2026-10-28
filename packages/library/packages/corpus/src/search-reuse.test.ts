import { expect, it } from 'vitest';
import { mkdtemp, realpath, rm, readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { acceptDiscovery } from './signal-search.js';
import { digest } from './search-fetch.js';
import { saveEntities, loadEntities } from './search-store.js';
import { researchCorpusSlice, checkPrimaryMaterial } from './search-reuse.js';
import type { Proposal } from '../../domain/src/search-contract.js';

it('conditionally checks unchanged primary material without renewing any claim', async () => {
  const { entity } = await acquired(0, undefined, 0, { normalizer: 'text-v3' });
  const before = JSON.stringify(entity);
  entity.evidence[0]!.transport = { etag: '"retained-v1"' };
  const retained = JSON.stringify(entity);
  const check = await checkPrimaryMaterial(entity, {
    fetch: async (uri, _signal, _redirects, _pdf, options) => {
      expect(options).toEqual({ conditional: { etag: '"retained-v1"' }, allowNotModified: true });
      return { uri, text: '', digest: digest(''), response: { status: 304 } };
    },
  });
  expect(check.status).toBe('unchanged');
  expect(check.claimsRenewed).toBe(false);
  expect(check.independentChangesChecked).toBe(false);
  expect(JSON.stringify(entity)).toBe(retained);
  expect(JSON.parse(before).evidence[0].fetchedAt).toBe(entity.evidence[0]!.fetchedAt);
});

const text = 'Drains wet soil in gardens. Tested drainage systems can have maintenance failures.';
const date = '2026-10-01T00:00:00.000Z';
async function acquired(
  index = 0,
  statement = 'Drains wet soil in gardens.',
  extraFacts = 0,
  options: {
    counterevidence?: boolean;
    identityUnverified?: boolean;
    normalizer?: 'text-v2' | 'text-v3';
    document?: string;
    asOf?: string;
    legacy?: boolean;
  } = {},
) {
  const uri = `https://example.org/drainage-${index}`;
  const observations: Proposal['candidates'][number]['observations'] = [
    {
      source: 0,
      feature: 'defining',
      indicator: 'defines',
      statement,
      quote: 'Drains wet soil in gardens.',
      independent: false,
      origin: 'original',
      status: 'supported',
    },
  ];
  if (options.counterevidence)
    observations.push({
      source: 0,
      feature: 'verification',
      indicator: 'inspectable',
      statement: 'Drainage systems never fail.',
      quote: 'can have maintenance failures.',
      independent: false,
      origin: 'original',
      status: 'contradicted',
    });
  for (let count = 0; count < extraFacts; count++)
    observations.push({
      source: 0,
      feature: 'verification',
      indicator: 'inspectable',
      statement: `Inspect drainage ${count}: ${'detail '.repeat(200)}`,
      quote: 'Drains wet soil in gardens.',
      independent: false,
      origin: 'original',
      status: 'supported',
    });
  const proposal: Proposal = {
    sources: [
      {
        uri,
        title: 'Drainage guidance',
        publisher: 'Issuer',
        family: 'primary',
        publishedAt: '2020-01-01',
        origin: 'original',
      },
    ],
    candidates: [
      {
        uri,
        name: `Garden Resource ${index}`,
        kind: 'learning-resource',
        identity: 'resolved',
        aliases: [],
        description: 'DESCRIPTION_SENTINEL',
        facets: {
          domains: [],
          capabilities: [],
          interfaces: [],
          deliveryForms: [],
          platforms: [],
          licenses: [],
          tags: ['METADATA_SENTINEL'],
        },
        observations,
        match: { level: 'direct', reason: 'Fits drainage', sources: [0] },
        limits: [],
      },
    ],
    coverage: [],
    gaps: [],
  };
  return (
    await acceptDiscovery(
      proposal,
      { query: 'wet soil' },
      {
        asOf: options.asOf ?? date,
        fetch: async () => ({
          uri,
          text: options.document ?? text,
          digest: digest(options.document ?? text),
          normalizer: options.legacy ? undefined : (options.normalizer ?? 'text-v2'),
          identityUnverified: options.identityUnverified,
        }),
      },
    )
  ).items[0]!;
}
it.each([
  [false, false],
  [true, false],
  [true, true],
])(
  'preserves history and advances only changed supported bodies after v3 (changed=%s, legacy=%s)',
  async (changed, legacy) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'signals-representation-transition-')),
    );
    try {
      const older = await acquired(0, undefined, 0, {
        normalizer: 'text-v3',
        asOf: '2026-10-10T00:00:00Z',
      });
      const newer = await acquired(0, undefined, 0, {
        normalizer: 'text-v2',
        asOf: '2026-10-11T00:00:00Z',
        document: changed ? `${text} A newly published plain-text appendix.` : text,
        legacy,
      });
      const before = JSON.stringify(older);
      await saveEntities([older], 'manual', root, 'private', 75, true);
      await saveEntities([newer], 'refresh', root, 'private', 75, true);
      const stored = (await loadEntities(join(root, '.signals/corpus/entities')))[0]!.entity;
      expect(stored.evidence).toHaveLength(2);
      const current = changed && !legacy ? newer : older;
      expect(stored.currentEvidence).toContain(current.entity.evidence[0]!.id);
      expect(stored.currentChecks?.[older.entity.uri]).toBe(current.entity.evidence[0]!.fetchedAt);
      expect(JSON.stringify(older)).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
async function snapshot(root: string) {
  const files: [string, string][] = [];
  async function visit(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const target = join(path, entry.name);
      if (entry.isDirectory()) await visit(target);
      else files.push([target.slice(root.length), digest(await readFile(target, 'utf8'))]);
    }
  }
  await visit(root);
  return files.sort();
}

it('reuses a bounded relevant slice without private notes, runtime data or file writes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-reuse-')));
  try {
    const items = await Promise.all(Array.from({ length: 7 }, (_, index) => acquired(index)));
    await saveEntities(items, 'manual', root, 'private', 75, true);
    await writeFile(resolve(root, '.signals/personal.json'), 'NOTE_SENTINEL');
    await writeFile(resolve(root, '.signals/settings.json'), 'SETTINGS_SENTINEL');
    await writeFile(resolve(root, '.signals/source-state.json'), 'RUNTIME_SENTINEL');
    const before = await snapshot(root);
    const slice = await researchCorpusSlice({ query: 'wet soil drainage' }, root);
    expect(slice.records).toHaveLength(5);
    expect(JSON.stringify(slice).length).toBeLessThanOrEqual(12000);
    expect(JSON.stringify(slice)).not.toMatch(
      /NOTE_SENTINEL|SETTINGS_SENTINEL|RUNTIME_SENTINEL|DESCRIPTION_SENTINEL|METADATA_SENTINEL/,
    );
    expect(slice.records[0]!.assessmentAsOf).toBe(date);
    expect(slice.records[0]!.facts[0]!.source.publishedAt).toBe('2020-01-01');
    expect(slice.records[0]!.facts[0]!.source.fetchedAt).toBe(date);
    expect(await snapshot(root)).toEqual(before);
    expect((await researchCorpusSlice({ query: 'quantum metallurgy' }, root)).records).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('selects retained facts with the Library lexical rules and states bounded absence', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-reuse-lexical-')));
  try {
    await saveEntities([await acquired(0)], 'manual', root, 'private', 75, true);
    // Function words alone ("what", "is", "in", "the") no longer select a record.
    const absent = await researchCorpusSlice({ query: 'What is in the orchard?' }, root);
    expect(absent.records).toEqual([]);
    expect(absent.gaps).toEqual([
      'No record with eligible retained facts lexically matched the request among 1 searched; absence here is not evidence that none exists.',
    ]);
    // Inflected words reach the same retained statement the Library would show.
    const inflected = await researchCorpusSlice({ query: 'draining' }, root);
    expect(inflected.records.map((record) => record.name)).toEqual(['Garden Resource 0']);
    expect(inflected.records[0]!.facts[0]!.statement).toBe('Drains wet soil in gardens.');
    expect(inflected.gaps).toEqual([]);
    // Unmatched quoted phrases still exclude; description metadata is not searched.
    expect((await researchCorpusSlice({ query: '"gardens drain wet"' }, root)).records).toEqual([]);
    expect((await researchCorpusSlice({ query: 'DESCRIPTION_SENTINEL' }, root)).records).toEqual(
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('does not create storage for empty reuse and limits large records without truncating facts', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-reuse-budget-')));
  try {
    expect((await researchCorpusSlice({ query: 'gardens' }, root)).records).toEqual([]);
    expect(await readdir(root)).toEqual([]);
    const item = await acquired(1, 'Drains wet soil in gardens.', 40);
    await saveEntities([item], 'manual', root, 'private', 75, true);
    const slice = await researchCorpusSlice({ query: 'drainage' }, root);
    expect(JSON.stringify(slice).length).toBeLessThanOrEqual(12000);
    expect(slice.records[0]!.omittedFacts).toBeGreaterThan(0);
    for (const fact of slice.records[0]!.facts)
      expect(
        item.entity.observations.find((observation) => observation.id === fact.observationId)
          ?.statement,
      ).toBe(fact.statement);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('discloses invalid saved records without losing valid retained evidence', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-reuse-invalid-')));
  try {
    await saveEntities([await acquired()], 'manual', root, 'private', 75, true);
    await mkdir(resolve(root, 'signals/entities'), { recursive: true });
    await writeFile(resolve(root, 'signals/entities/entity-aaaaaaaaaaaaaaaaaaaaaaaa.json'), '{}');
    const slice = await researchCorpusSlice({ query: 'wet soil' }, root);
    expect(slice.records).toHaveLength(1);
    expect(slice.gaps).toContain(
      'Some saved Corpus records could not be validated; native research remains available.',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('retains matched contradictions while excluding observations with unverified source identity', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-reuse-uncertainty-')));
  try {
    const item = await acquired(0, 'Drains wet soil in gardens.', 0, { counterevidence: true });
    await saveEntities([item], 'manual', root, 'private', 75, true);
    const slice = await researchCorpusSlice({ query: 'wet soil' }, root);
    expect(slice.records[0]!.facts.some((fact) => fact.status === 'contradicted')).toBe(true);
    const unverified = await acquired(3, 'Drains wet soil in gardens.', 0, {
      identityUnverified: true,
    });
    await saveEntities([unverified], 'manual', root, 'private', 75, true);
    expect((await researchCorpusSlice({ query: 'wet soil' }, root)).records).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('checks unchanged primary hashes without renewing claims, dates or retained files', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-primary-check-')));
  try {
    const item = await acquired();
    await saveEntities([item], 'manual', root, 'private', 75, true);
    const before = await snapshot(root);
    const entityBytes = JSON.stringify(item.entity);
    let calls = 0;
    const checked = await checkPrimaryMaterial(item.entity, {
      fetch: async (uri) => {
        calls++;
        return { uri, text, digest: digest(text), normalizer: 'text-v2' };
      },
    });
    expect(checked.status).toBe('unchanged');
    expect(checked.source!.fetchedAt).toBe(date);
    expect(checked.claimsRenewed).toBe(false);
    expect(checked.independentChangesChecked).toBe(false);
    expect(checked.modelCalls).toBe(0);
    expect(calls).toBe(1);
    expect(JSON.stringify(item.entity)).toBe(entityBytes);
    expect(await snapshot(root)).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps changed material, identity changes and failures distinct from unchanged', async () => {
  const { entity } = await acquired();
  const changed = await checkPrimaryMaterial(entity, {
    fetch: async (uri) => ({
      uri,
      text: 'Changed drainage',
      digest: digest('Changed drainage'),
      normalizer: 'text-v2',
    }),
  });
  expect(changed.status).toBe('changed');
  expect(changed.material!.text).toBe('Changed drainage');
  const redirected = await checkPrimaryMaterial(entity, {
    fetch: async () => ({
      uri: 'https://example.org/another',
      text,
      digest: digest(text),
      normalizer: 'text-v2',
    }),
  });
  expect(redirected.status).toBe('identity-changed');
  const failed = await checkPrimaryMaterial(entity, {
    fetch: async () => {
      throw new Error('source_denied_429');
    },
  });
  expect(failed.status).toBe('failed');
  expect(failed.reason).toBe('source_denied_429');
  expect(failed.claimsRenewed).toBe(false);
});

it('does not fetch private or unbound sources and preserves cancellation', async () => {
  const { entity } = await acquired();
  let calls = 0;
  const fetch = async (uri: string) => {
    calls++;
    return { uri, text, digest: digest(text) };
  };
  const unbound = structuredClone(entity);
  unbound.observations = [];
  expect((await checkPrimaryMaterial(unbound, { fetch })).status).toBe('not-checkable');
  const privateSource = structuredClone(entity);
  privateSource.evidence[0]!.uri = 'https://127.0.0.1/private';
  expect((await checkPrimaryMaterial(privateSource, { fetch })).status).toBe('failed');
  expect(calls).toBe(0);
  const controller = new AbortController();
  controller.abort();
  await expect(
    checkPrimaryMaterial(entity, { fetch, signal: controller.signal }),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});
