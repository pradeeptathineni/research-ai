import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLibrary, setLibrarySaved } from '../../packages/corpus/src/library.js';
import { atomicJson } from '../../packages/corpus/src/search-store.js';
import { saveLibraryLead } from '../../packages/corpus/src/library-leads.js';
import { searchLibrary } from '../../packages/domain/src/library-search.js';
import {
  planResearchRetention,
  retainResearchAnswer,
  rediscoverResearch,
  compareResearchAnswers,
  type ResearchAnswer,
} from '../../packages/corpus/src/research-answer.js';

const input = (
  answer = 'Inspect [Example](https://example.com/tool?utm_source=test#features) for portable records.',
): ResearchAnswer => ({
  query: 'portable records',
  answer,
  observedAt: '2026-10-12T06:45:00Z',
  provenance: { receipt: 'public-development-fixture', requestedModel: null, servedModel: null },
});

void test('references have normalized identity and exact unverified provenance, not inferred truth or dates', () => {
  const raw = input(
    'See [first](https://example.com/tool#one) and [second](https://example.com/tool?utm_source=x#one).',
  );
  const plan = planResearchRetention(raw);
  assert.equal(plan.citations.length, 1);
  assert.equal(plan.citations[0]!.assertions.length, 2);
  for (const assertion of plan.citations[0]!.assertions) {
    assert.equal(raw.answer.slice(assertion.start, assertion.end), assertion.literal);
    assert.equal(assertion.truth, 'unverified');
    assert.equal(assertion.sourcePublishedAt, null);
  }
  assert.equal(plan.input.answer, raw.answer);
});

void test('private, credential-bearing and executable locators remain rejected references and are never selected', async () => {
  const raw = input(
    '[private](https://127.0.0.1/a) [credential](https://user:secret@example.com/a) [code](javascript:run)',
  );
  const plan = planResearchRetention(raw);
  assert.equal(plan.citations.length, 0);
  assert.equal(plan.rejectedReferences.length, 3);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'research-first-reject-')));
  try {
    await assert.rejects(
      () => retainResearchAnswer(root, raw, ['https://example.com/uncited']),
      /not_cited/,
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('save, rediscover and reuse preserve the answer, merge only locator identity and retain unknowns', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'research-first-e2e-')));
  const raw = input();
  try {
    const first = await retainResearchAnswer(root, raw, ['https://example.com/tool#features']);
    const saved = JSON.parse(await readFile(first.answerPath, 'utf8'));
    assert.equal(saved.result.input.answer, raw.answer);
    assert.equal(saved.result.input.provenance.servedModel, null);
    await retainResearchAnswer(
      root,
      input(
        'Recheck [Example](https://example.com/tool#features) and [other](https://example.org/tool).',
      ),
      ['https://example.com/tool#features'],
    );
    const library = (await loadLibrary(root)).filter((item) => item.lead);
    assert.equal(library.length, 1);
    assert.equal(library[0]!.lead!.history.length, 2);
    assert.equal(library[0]!.intrinsicStrength.score, null);
    assert.equal(library[0]!.license.openSource, null);
    assert.equal(library[0]!.access.freeToUse, null);
    assert.equal(library[0]!.observedAt, null);
    assert.equal((await rediscoverResearch(root, 'Example')).length, 1);
    assert.equal(searchLibrary(library, 'Example', { acquisition: 'free-to-use' }).length, 0);
    assert.equal(first.modelCalls, 0);
    assert.equal(first.publicWrites, 0);
    assert.ok(!(await readdir(root)).includes('signals'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('comparison reports changed citations without converting them to factual or quality gains', () => {
  const diff = compareResearchAnswers(
    input('[a](https://example.com/a) [b](https://example.com/b)'),
    input('[a](https://example.com/a) [c](https://example.com/c)'),
  );
  assert.deepEqual(diff.sharedCitations, ['https://example.com/a']);
  assert.deepEqual(diff.newlyCited, ['https://example.com/c']);
  assert.deepEqual(diff.noLongerCited, ['https://example.com/b']);
});
void test('balanced URLs are complete while inline/fenced code examples are excluded', () => {
  const raw = input(
    'Read [Math](https://example.com/Function_(mathematics)). `Use [fake](https://example.com/fake)`\n```md\n[fake](https://example.com/fenced)\n```\n    [fake](https://example.com/indented)\n[Real](https://example.com/real)',
  );
  const plan = planResearchRetention(raw);
  assert.deepEqual(
    plan.citations.map((item) => item.uri),
    ['https://example.com/Function_(mathematics)', 'https://example.com/real'],
  );
  assert.equal(
    raw.answer.slice(
      plan.citations[0]!.assertions[0]!.start,
      plan.citations[0]!.assertions[0]!.end,
    ),
    '[Math](https://example.com/Function_(mathematics))',
  );
});
void test('distinct hash-route destinations remain distinct saved and retrieved locators', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'research-first-fragments-')));
  try {
    const raw = input(
      '[Docs](https://example.com/#/docs) [Projects](https://example.com/#/projects)',
    );
    const plan = planResearchRetention(raw);
    assert.equal(plan.citations.length, 2);
    assert.equal(plan.citations[0]!.identityBase, plan.citations[1]!.identityBase);
    const result = await retainResearchAnswer(
      root,
      raw,
      plan.citations.map((item) => item.uri),
    );
    assert.equal(result.status, 'complete');
    assert.deepEqual(
      (await loadLibrary(root))
        .filter((item) => item.lead)
        .map((item) => item.uri)
        .sort(),
      ['https://example.com/#/docs', 'https://example.com/#/projects'],
    );
    assert.equal(
      (await rediscoverResearch(root, 'Docs'))[0]!.finding.uri,
      'https://example.com/#/docs',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
void test('a later batch limit failure retains an answer-only receipt without committing earlier selected leads', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'research-first-batch-')));
  try {
    await saveLibraryLead(
      root,
      { uri: 'https://example.com/full', name: 'Full', description: 'existing', limits: [] },
      randomUUID(),
      'prior',
    );
    const path = join(root, '.signals/library-leads.json');
    const records = JSON.parse(await readFile(path, 'utf8')) as {
      id: string;
      uri: string;
      snapshots: {
        runId: string;
        query: string;
        savedAt: string;
        name: string;
        description: string;
        limits: string[];
      }[];
    }[];
    records[0]!.snapshots = Array.from({ length: 128 }, (_, i) => ({
      ...records[0]!.snapshots[0]!,
      runId: randomUUID(),
      query: 'prior-' + i,
    }));
    await atomicJson(path, records);
    const raw = input('[First](https://example.com/first) [Full](https://example.com/full)');
    for (let i = 0; i < 2; i++) {
      const result = await retainResearchAnswer(root, raw, [
        'https://example.com/first',
        'https://example.com/full',
      ]);
      assert.equal(result.status, 'answer-only');
      assert.equal(result.leads.length, 0);
      assert.match(result.failure!, /retention_limit/);
      assert.equal(
        JSON.parse(await readFile(result.receiptPath!, 'utf8')).leadCommitState,
        'confirmed',
      );
      const library = (await loadLibrary(root)).filter((item) => item.lead);
      assert.equal(library.length, 1);
      assert.equal(library[0]!.lead!.history.length, 128);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
void test('empty selection retains only the answer; explicit subset and unsave/reload preserve user annotations', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'research-first-selection-')));
  try {
    const raw = input('[One](https://example.com/one) [Two](https://example.com/two)');
    const empty = await retainResearchAnswer(root, raw, []);
    assert.equal(empty.status, 'complete');
    assert.equal((await loadLibrary(root)).filter((item) => item.lead).length, 0);
    assert.equal((await loadLibrary(root)).filter((item) => item.answer).length, 1);
    const saved = await retainResearchAnswer(root, raw, ['https://example.com/one']);
    assert.equal(saved.leads.length, 1);
    const finding = (await loadLibrary(root))[0]!;
    await setLibrarySaved(root, finding.key, false, {
      note: 'User annotation',
      feedback: 'useful',
      novelty: 'known',
    });
    const reloaded = (await loadLibrary(root))[0]!;
    assert.equal(reloaded.saved, false);
    assert.equal(reloaded.notes, 'User annotation');
    assert.equal(reloaded.feedback, 'useful');
    assert.equal(reloaded.novelty, 'known');
    const common = dirname(fileURLToPath(import.meta.url));
    const module = join(common, '../../packages/corpus/src/library.ts');
    const child = await promisify(execFile)(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        'import {loadLibrary} from ' +
          JSON.stringify(module) +
          ';console.log(JSON.stringify(await loadLibrary(' +
          JSON.stringify(root) +
          ')));',
      ],
      { cwd: common, timeout: 5000 },
    );
    const restarted = JSON.parse(child.stdout)[0];
    assert.equal(restarted.saved, false);
    assert.equal(restarted.notes, 'User annotation');
    assert.equal(restarted.feedback, 'useful');
    assert.equal(restarted.novelty, 'known');
    assert.equal((await rediscoverResearch(root, 'One')).length, 0);
    await setLibrarySaved(root, finding.key, true);
    assert.equal((await rediscoverResearch(root, 'One'))[0]!.finding.notes, 'User annotation');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
