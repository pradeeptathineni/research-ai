import { it, expect } from 'vitest';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planResearchRetention, retainResearchAnswer } from './research-answer.js';
import { importedAnswers, loadAnswerLibrary } from './research-receipts.js';
import { groundedFixture } from '../../../tests/fixtures/grounded-answer.js';
import { exactOwnerRecord } from './provider-capabilities.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

it('imports complete grounded CLI output and refuses a failed structured result', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'grounded-cli-')));
  const root = join(directory, 'workspace');
  const path = join(directory, 'grounded.json');
  const invoke = () =>
    promisify(execFile)(process.execPath, [
      '--import',
      'tsx',
      resolve('scripts/research-answer.ts'),
      '--query',
      'grounded CLI import',
      '--grounded-file',
      path,
      '--observed-at',
      '2026-10-22T12:00:00Z',
      '--retain',
      '--root',
      root,
    ]);
  try {
    await writeFile(path, JSON.stringify({ status: 'failed', ...groundedFixture() }));
    await expect(invoke()).rejects.toThrow('complete_grounded_result_required');
    await writeFile(path, JSON.stringify({ status: 'complete', ...groundedFixture() }));
    const { stdout } = await invoke();
    expect(JSON.parse(stdout).result.status).toBe('complete');
    expect((await importedAnswers(root))[0]!.grounding?.owner).toBe('research-ai');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('retains and reopens the self-contained closure through the existing exact imported-answer owner', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'grounded-retention-')));
  try {
    const result = groundedFixture();
    const input = {
      query: 'grounded export options',
      answer: result.answer,
      grounding: result.grounding,
      observedAt: '2026-10-22T12:00:00Z',
      provenance: { receipt: 'synthetic-grounded', requestedModel: null, servedModel: null },
    };
    const saved = await retainResearchAnswer(root, input, []);
    const before = await readFile(saved.answerPath, 'utf8');
    const replay = (await importedAnswers(root))[0]!;
    expect(replay.grounding).toEqual(input.grounding);
    expect(replay.answerReceipt?.confidence).toBe('unknown');
    expect((await loadAnswerLibrary(root))[0]!.answerText).toBe(input.answer);
    const ref = {
      owner: 'signals-ai' as const,
      kind: 'imported_answer' as const,
      id: saved.runId,
      revision: null,
      digest: null,
    };
    const exact = await exactOwnerRecord(root, ref);
    expect(exact.bytes.toString('utf8')).toBe(before);
    expect((await exactOwnerRecord(root, exact.ref)).ref).toEqual(exact.ref);
    const changed = JSON.parse(before);
    changed.result.input.grounding.claims[0].citations[0].quote = 'Invented text';
    await writeFile(saved.answerPath, JSON.stringify(changed));
    await expect(importedAnswers(root)).rejects.toThrow('invalid_grounding');
    await expect(exactOwnerRecord(root, exact.ref)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects invalid source bindings before saving and keeps historical absence unassessed', () => {
  const result = groundedFixture();
  const base = {
    query: 'export options',
    answer: result.answer,
    observedAt: '2026-10-22T12:00:00Z',
    provenance: { receipt: 'synthetic', requestedModel: null, servedModel: null },
  };
  expect(planResearchRetention(base).input.grounding).toBeUndefined();
  const invalid = structuredClone(result.grounding);
  invalid.sources[0]!.text = 'Changed capture';
  expect(() => planResearchRetention({ ...base, grounding: invalid })).toThrow('invalid_grounding');
});
