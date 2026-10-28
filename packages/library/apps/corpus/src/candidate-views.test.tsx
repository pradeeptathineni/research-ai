import { it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { ComparisonView, AssessmentDerivation, FrozenDiscussion } from './candidate-views.js';
import { loadEntities } from '../../../packages/corpus/src/search-store.js';
import { assessEntity } from '../../../packages/domain/src/search-score.js';
import { saveLibraryLead } from '../../../packages/corpus/src/library-leads.js';
import { loadLibrary } from '../../../packages/corpus/src/library.js';
import { loadPublicCorpus } from '../../../packages/corpus/src/public-corpus.js';
import { projectLegacyLibrary } from '../../../packages/domain/src/library-search.js';

it('renders deterministic discussion omissions and Unknown confidence when model prose omits them', () => {
  const markup = renderToStaticMarkup(
    <FrozenDiscussion
      question="What remains supported?"
      busy={false}
      answer={{
        answer: 'Retained partial answer.',
        statements: [],
        gaps: [
          '1 complete answers omitted by the discussion budget; reopen them individually.',
          'Selected complete answers are unassessed prior synthesis. Confidence Unknown.',
        ],
      }}
      onQuestion={() => {}}
      onSubmit={() => {}}
    />,
  );
  expect(markup).toContain('Discussion scope and gaps');
  expect(markup).toContain('1 complete answers omitted');
  expect(markup).toContain('Confidence Unknown');
});

it('does not imply a historical review for an actually saved unassessed lead', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-lead-comparison-')));
  try {
    await saveLibraryLead(
      root,
      {
        uri: 'https://example.org/reference',
        name: 'Selected reference',
        description: 'An unassessed saved citation.',
        limits: ['Source claim not verified.'],
      },
      randomUUID(),
      'Remember this reference',
    );
    const findings = await loadLibrary(root);
    const markup = renderToStaticMarkup(<ComparisonView findings={findings} onClear={() => {}} />);
    expect(findings[0]?.intrinsicStrength.score).toBeNull();
    expect(markup).toContain('Unassessed lead');
    expect(markup).not.toContain('Historical review');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('preserves the historical-review label for a canonical legacy record', async () => {
  const option = (await loadPublicCorpus()).options[0]!;
  const markup = renderToStaticMarkup(
    <ComparisonView findings={[projectLegacyLibrary(option)]} onClear={() => {}} />,
  );
  expect(markup).toContain('Historical review');
  expect(markup).not.toContain('Unassessed lead');
  expect(markup).toContain('Confidence in this assessment: Unknown');
  expect(markup).toContain('not a probability of correctness');
});

it('renders a canonical retained derivation without changing its score or bindings', async () => {
  const entity = (await loadEntities(resolve('signals/entities')))[0]!.entity;
  const before = structuredClone(entity);
  const markup = renderToStaticMarkup(<AssessmentDerivation entity={entity} />);
  expect(markup).toContain(entity.assessment.policy);
  expect(markup).toContain('Evidence-policy contributions are summed');
  for (const [dimension, feature] of Object.entries(entity.assessment.features)) {
    expect(markup).toContain(
      `${dimension} · approximately ${Math.round(feature.contribution)} points`,
    );
    for (const id of feature.observations) {
      const observation = entity.observations.find((item) => item.id === id)!;
      expect(markup).toContain(observation.status);
    }
  }
  expect(entity).toEqual(before);
  expect(assessEntity(entity, entity.assessment.asOf, entity.assessment.policy)).toEqual(
    entity.assessment,
  );
});
