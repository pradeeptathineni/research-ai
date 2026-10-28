import { it, expect, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { retainResearchAnswer } from './research-answer.js';
import { loadLibrary } from './library.js';
import { frozenLibraryMaterial, answerFromRetainedMaterial } from './search-followup.js';
import type * as RunnerModule from './search-runner.js';

vi.mock('./search-runner.js', async (original) => ({
  ...(await original<typeof RunnerModule>()),
  codexRunner: () => ({
    discover: async () => ({
      proposal: { answer: 'Unassessed prior synthesis only.', observations: [], gaps: [] },
      usage: null,
      searches: 0,
    }),
  }),
}));

it('retains kernel-owned whole-answer omission and Unknown scope warnings even when the model returns no gaps', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-discussion-scope-')));
  try {
    for (const name of ['one', 'two'])
      await retainResearchAnswer(
        root,
        {
          query: name,
          answer: name + ' retained material '.repeat(5000),
          observedAt: '2026-10-12T06:00:00Z',
          provenance: { receipt: 'public-fixture', requestedModel: null, servedModel: null },
        },
        [],
      );
    const frozen = frozenLibraryMaterial(await loadLibrary(root));
    expect(frozen.gaps.join(' ')).toContain('1 complete answers omitted');
    const response = await answerFromRetainedMaterial(frozen, 'What was retained?');
    expect(response.gaps).toEqual(frozen.gaps);
    expect(response.gaps.join(' ')).toContain('Confidence Unknown');
    expect(response.statements).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('insufficient-evidence returns preserve owned omission warnings without invoking a model', async () => {
  const response = await answerFromRetainedMaterial(
    {
      material: [],
      context: [],
      priorSynthesis: undefined,
      gaps: ['Complete answer omitted by the discussion budget. Confidence Unknown.'],
    },
    'What remains?',
  );
  expect(response.usage).toBeNull();
  expect(response.gaps).toContain(
    'Complete answer omitted by the discussion budget. Confidence Unknown.',
  );
});
