import { test, expect } from '@playwright/test';
import { expectAccessibleViewport } from './accessibility.js';
import { selectEvidenceResearch } from './research.js';
import { createHash } from 'node:crypto';
import { acceptDiscovery } from '../../packages/corpus/src/signal-search.js';
import { validateEntity } from '../../packages/corpus/src/search-store.js';
import type { SignalJudgment } from '../../packages/domain/src/search-assessment.js';
import type { SearchResult } from '../../packages/domain/src/search-contract.js';

async function explanationFixture(kind: 'held' | 'copies' | 'unmatched') {
  const asOf = '2026-10-12T00:00:00.000Z';
  const claims = [
    'Record Reader parses JSON documents into memory.',
    'Record Reader supports Python 3.11 under MIT terms.',
    'The external laboratory repeated parsing with identical output.',
  ];
  const origins = [
    'The Record Reader team created this resource and documentation.',
    'The external laboratory conducted its own separate parsing experiment.',
  ];
  const judgment: SignalJudgment = {
    rubric: 'software-v1',
    rubricReason: 'Synthetic attribution fixture, not semantic validation.',
    dimensions: {
      basis: { level: 4, reason: 'Resource identity.', observations: [0] },
      work: { level: 4, reason: 'External operation.', observations: [2] },
      scrutiny: { level: 4, reason: 'External experiment.', observations: [2] },
      applicability: { level: 4, reason: 'Version and access.', observations: [1] },
    },
    contrary: 'inspected',
    status: 'inspected',
    gaps: [],
    originInspections: origins.map((quote, source) => ({
      source,
      quote,
      relationship: source ? 'independent' : 'resource-own',
      reason: source ? 'A separate originating laboratory effort.' : 'The resource authors.',
    })),
  };
  const sources = origins.map((_, index) => ({
    uri: `https://reader-${index}.example.org/report`,
    title: `Inspected report ${index}`,
    publisher: `Publisher ${index}`,
    origin: `reader-effort-${index}`,
    family: 'primary',
    publishedAt: asOf,
  }));
  const observations = claims.map((statement, index) => ({
    source: index === 2 ? 1 : 0,
    signal: ['defining/defines', 'currentness/current', 'verification/replicated'][index]!,
    statement,
    quote: statement,
    independent: index === 2,
    origin: `reader-effort-${index === 2 ? 1 : 0}`,
    status: 'supported',
  }));
  const documents = new Map([
    [sources[0]!.uri, [claims[0], claims[1], origins[0]].join('\n')],
    [sources[1]!.uri, [claims[2], origins[1]].join('\n')],
  ]);
  if (kind === 'held') delete judgment.originInspections;
  if (kind === 'unmatched')
    judgment.originInspections![1]!.quote =
      'This claimed attribution is absent from the acquired source.';
  if (kind === 'copies') {
    const copyUri = 'https://reader-copy.example.org/report';
    sources.push({ ...sources[1]!, uri: copyUri, title: 'Copied report', origin: 'renamed-copy' });
    observations.push({ ...observations[2]!, source: 2, origin: 'renamed-copy' });
    judgment.dimensions.work.observations.push(3);
    judgment.dimensions.scrutiny.observations.push(3);
    judgment.originInspections!.push({ ...judgment.originInspections![1]!, source: 2 });
    documents.set(copyUri, documents.get(sources[1]!.uri)!);
  }
  const result = await acceptDiscovery(
    {
      version: 7,
      answer: 'Synthetic explanation boundary.',
      interpretation: {
        policy: 'query-relevance-v1',
        need: 'Inspect parser evidence.',
        constraints: [],
        resourceTypes: ['software'],
        timeWindow: null,
      },
      sources,
      candidates: [
        {
          uri: 'https://reader-0.example.org/software',
          name: 'Record Reader',
          kind: 'software',
          identity: 'resolved',
          description: 'Synthetic parser evidence.',
          capabilities: ['parsing'],
          observations,
          signalJudgment: judgment,
          match: { level: 'direct', reason: 'Synthetic direct fit.', sources: [0] },
          relevance: { value: 100, reason: 'Synthetic fit.', sources: [0], constraints: [] },
          limits: [],
        },
      ],
      coverage: [],
      gaps: [],
    },
    { query: 'Inspect parser evidence.', route: 'native', profile: 'wide' },
    {
      asOf,
      evidenceClass: 'fixture',
      fetch: (uri) => {
        const text = documents.get(uri);
        if (text === undefined) throw new Error('fixture_source_missing');
        return Promise.resolve({
          uri,
          text,
          digest: createHash('sha256').update(text).digest('hex'),
        });
      },
    },
  );
  const item = result.items[0]!;
  validateEntity(item.entity);
  if (item.entity.observations.length !== observations.length)
    throw new Error('fixture_observations_rejected');
  return item;
}

for (const kind of ['held', 'copies', 'unmatched'] as const) {
  test(`fresh v10 result explains ${kind} evidence and attribution`, async ({ page }) => {
    const item = await explanationFixture(kind);
    await page.route('**/__signals/api/runs/*', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { result?: SearchResult };
      if (body.result) {
        body.result.items = [item];
        body.result.sources = item.entity.evidence;
      }
      await route.fulfill({ json: body });
    });
    await page.goto('?view=Search&mode=research&q=explanation+fixture');
    await selectEvidenceResearch(page);
    await page.getByRole('button', { name: 'Start online research', exact: true }).click();
    const card = page.locator('.entity-card');
    await expect(card).toHaveCount(1);
    await card.getByText('Assessment basis', { exact: true }).click();
    await card.getByText('Score, limits and sources', { exact: true }).click();
    await expect(card).toContainText('Confidence in this assessment: Unknown');
    const derivation = card.getByRole('region', { name: 'Signal derivation' });
    await expect(derivation).toContainText('signal-strength-v10');
    await expect(derivation).not.toContainText('risk adjustment');
    for (const reason of item.entity.assessment.reasons ?? []) {
      const readable = item.entity.evidence.reduce(
        (text, source) => text.replaceAll(source.id, source.title),
        reason,
      );
      await expect(derivation).toContainText(readable);
    }
    if (kind === 'held') {
      expect(item.entity.assessment.score).toBeNull();
      await expect(derivation).toContainText(
        'asserted independence earns no origin-dependent credit',
      );
    } else {
      await derivation.getByText('Origin attribution and relationships', { exact: true }).click();
      if (kind === 'copies') {
        await expect(derivation).toContainText('Duplicated acquired material counts once');
        await expect(derivation).toContainText('Native-reviewed attribution');
        await expectAccessibleViewport(page, 320);
      } else {
        await expect(derivation).toContainText('Attribution Unknown');
        await expect(derivation).toContainText(
          'Reported attribution, not an accepted source passage',
        );
        await expect(derivation.locator('blockquote')).toHaveCount(1);
        await expect(derivation.locator('blockquote')).not.toContainText(
          'absent from the acquired source',
        );
      }
    }
  });
}

test('fresh online comparison explains mixed historical score policies', async ({ page }) => {
  await page.goto('?view=Search&mode=research&q=approved+public+replay');
  await selectEvidenceResearch(page);
  await page.getByRole('button', { name: 'Start online research', exact: true }).click();
  await expect(page.locator('.entity-card')).toHaveCount(2);
  for (const card of await page.locator('.entity-card').all())
    await card.getByRole('checkbox').check();
  const comparison = page.getByRole('region', { name: 'Compare entities' });
  await expect(comparison).toContainText('Signal 75');
  await expect(comparison).toContainText('Signal 80');
  await expect(comparison).toContainText('signal-strength-v1');
  await expect(comparison).toContainText('signal-strength-v6');
  await expect(comparison).toContainText('not directly comparable');
  await expect(comparison).toContainText('Confidence in this assessment: Unknown');
});
