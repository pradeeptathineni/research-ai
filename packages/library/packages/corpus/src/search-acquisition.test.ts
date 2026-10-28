import { expect, it } from 'vitest';
import {
  acquireConfigured,
  normalizeAcquisition,
  acquisitionReadiness,
  loadAcquisitionConfig,
} from './search-acquisition.js';
import { mkdtemp, realpath, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
it('isolates schema drift and unsafe items without dropping valid provider candidates', () => {
  const result = normalizeAcquisition(
    {
      schema_version: '1.3',
      source_status: { reddit: 'denied' },
      results: [
        {
          url: 'https://example.com/tool',
          title: 'Tool',
          relevance_score: 1,
          engagement: { points: 500 },
        },
        { url: 'https://127.0.0.1/private', title: 'Private' },
        { title: 'Missing' },
      ],
    },
    'last30days',
  );
  expect(result.hits).toHaveLength(1);
  expect(result.hits[0]).not.toHaveProperty('relevance_score');
  expect(result.gaps).toHaveLength(3);
  expect(() => normalizeAcquisition({ schema_version: '2.0', results: [] }, 'last30days')).toThrow(
    'unsupported_last30days_schema',
  );
});
it('keeps engine failures visible even when an HTTP200 search has no hits', () => {
  const result = normalizeAcquisition(
    { results: [], unresponsive_engines: [['engine-a', 'timeout']] },
    'searxng',
  );
  expect(result.hits).toEqual([]);
  expect(result.gaps).toEqual(['searxng/engine-a: timeout']);
  expect(acquisitionReadiness({}).find((x) => x.provider === 'searxng')?.state).toBe(
    'unconfigured',
  );
  expect(
    acquisitionReadiness({
      gptResearcher: {
        python: '/usr/bin/python3',
        configPath: '/unused',
        billingAuthorized: false,
        keyEnv: [],
      },
    }).at(-1)?.state,
  ).toBe('blocked-api-budget');
});
it('isolates malformed or private search configuration before attempting transport', async () => {
  let calls = 0;
  for (const searxng of ['not a URL', 'https://127.0.0.1/search']) {
    const result = await acquireConfigured(
      { query: 'ordinary research' },
      { searxng },
      undefined,
      async () => {
        calls++;
        throw new Error('transport should not run');
      },
    );
    expect(result.searches).toBe(0);
    expect(result.gaps).toHaveLength(1);
  }
  expect(calls).toBe(0);
});
it('allows only an explicit bounded public CA file without accepting secrets or symlinks', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'provider-ca-')));
  try {
    await mkdir(join(root, '.signals'));
    const caFile = join(root, 'public.pem');
    await writeFile(caFile, rootCertificates[0]!);
    const last30days = { checkout: '/missing', python: '/usr/bin/python3', caFile };
    await writeFile(join(root, '.signals/providers.json'), JSON.stringify({ last30days }));
    expect((await loadAcquisitionConfig(root)).last30days?.caFile).toBe(caFile);
    const valid = await acquireConfigured({ query: 'ordinary research' }, { last30days });
    expect(valid.gaps.join()).not.toContain('invalid_last30days_ca_file');
    const privateMarker = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    await writeFile(caFile, rootCertificates[0]! + `\n${privateMarker}\nnot permitted`);
    expect((await acquireConfigured({ query: 'ordinary research' }, { last30days })).gaps).toEqual([
      'last30days: invalid_last30days_ca_file',
    ]);
    await writeFile(caFile, 'not a certificate');
    expect((await acquireConfigured({ query: 'ordinary research' }, { last30days })).searches).toBe(
      0,
    );
    await rm(caFile);
    await symlink(join(root, '.signals/providers.json'), caFile);
    expect((await acquireConfigured({ query: 'ordinary research' }, { last30days })).gaps).toEqual([
      'last30days: invalid_last30days_ca_file',
    ]);
    await writeFile(
      join(root, '.signals/providers.json'),
      JSON.stringify({ last30days: { ...last30days, caFile: 'relative.pem' } }),
    );
    await expect(loadAcquisitionConfig(root)).rejects.toThrow('invalid_acquisition_config');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('uses configured JSON search without treating engine multiplicity as independent support', async () => {
  const result = await acquireConfigured(
    { query: 'portable source traces' },
    { searxng: 'https://search.example.com/search' },
    undefined,
    async (uri) => ({
      uri,
      text: '',
      digest: 'a'.repeat(64),
      json: { results: [{ url: 'https://example.com/tool', title: 'Tool', engines: ['a', 'b'] }] },
    }),
  );
  expect(result.hits).toHaveLength(1);
  expect(result.searches).toBe(1);
  expect(result.modelCalls).toBe(0);
  const failure = await acquireConfigured(
    { query: 'query' },
    { searxng: 'https://example.com' },
    undefined,
    async () => {
      throw new Error('source_denied_403');
    },
  );
  expect(failure.gaps).toEqual(['searxng: source_denied_403']);
});
