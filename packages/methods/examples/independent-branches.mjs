// Demonstration of the standalone branch CLI in fresh processes:
// create -> branch A -> branch B -> compare -> export -> edit -> reopen as stale.
// Native sessions are test/fake-codex.mjs replaying authored output over synthetic frozen
// documents. No model, provider or real Codex CLI runs, so this shows behaviour, not quality.
// Usage: node examples/independent-branches.mjs --out DIR  (writes a fresh run-* subdirectory)
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fakeCodex, message } from '../test/fake-codex.mjs';

const outFlag = process.argv.indexOf('--out');
if (outFlag < 0 || !process.argv[outFlag + 1]) throw new Error('usage: node examples/independent-branches.mjs --out DIR');
const base = resolve(process.argv[outFlag + 1]);
await mkdir(base, { recursive: true });
const dir = await mkdtemp(join(base, 'run-'));
const cli = join(import.meta.dirname, '..', 'bin', 'research-branches.mjs');

const sources = [
  { uri: 'https://example.org/clinic-note', text: 'Synthetic note: lead-acid packs cost less to buy. They need replacing after about four years.', omissions: ['Authored synthetic sources and fake-provider output; no real model or source-quality result.', 'Prices came from one supplier only.'] },
  { uri: 'https://example.org/vendor-sheet', text: 'Synthetic sheet: lithium packs cost more to buy but often last ten years.' },
];
const spec = { topic: 'Battery packs for a small rural clinic', goal: 'Compare cost and durability positions', questions: [
  { id: 'cost', parentId: null, question: 'What favours lower upfront cost?' },
  { id: 'life', parentId: null, question: 'What favours lifetime durability?' }], sources, budget: { searches: 0, documents: 8, seconds: 120, calls: 4 } };
const event = (value) => ({ events: [message(JSON.stringify(value)), { type: 'turn.completed' }] });
const pos = (attemptId, stance, branchQuote, sourceUri = null, sourceQuote = null) => ({ attemptId, stance, branchQuote, sourceUri, sourceQuote, sourceOccurrence: sourceUri ? 1 : null });
const fixture = await fakeCodex({ sessions: [
  event({ findings: ['BRANCH-A-ONLY: lead-acid has the lower purchase price'], gaps: ['Installation labour was not captured.'], sources: [{ uri: sources[0].uri }], answer: 'Lead-acid is cheaper to buy.' }),
  event({ findings: ['BRANCH-B-ONLY: lithium outlasts lead-acid'], gaps: [], sources: [{ uri: sources[1].uri }], answer: 'Lithium lasts longer overall.' }),
  event({ summary: 'The branches trade purchase price against service life.',
    agreements: [{ summary: 'Both report that purchase price differs by chemistry.', positions: [pos('a1', 'Lead-acid costs less up front.', 'Lead-acid is cheaper to buy.', sources[0].uri, 'cost less to buy'), pos('a2', 'Lithium costs more up front.', 'lithium outlasts lead-acid', sources[1].uri, 'cost more to buy')] }],
    disagreements: [{ summary: 'Which option is the better buy.', positions: [pos('a1', 'Lower price makes lead-acid the better buy.', 'Lead-acid is cheaper to buy.'), pos('a2', 'Longer life makes lithium the better buy.', 'Lithium lasts longer overall.', sources[1].uri, 'last ten years')] }],
    unknowns: [{ summary: 'Total cost of ownership over ten years is not in the material.', attemptIds: ['a1', 'a2'] }] }),
] });

const at = (name) => join(dir, name);
async function step(...args) {
  const r = await promisify(execFile)(process.execPath, [cli, ...args], { env: process.env }).then((x) => ({ code: 0, ...x }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
  process.stdout.write(`$ research-branches ${args.map((a) => a.startsWith(dir) ? a.slice(dir.length + 1) : a).filter((a) => a !== fixture.lease).join(' ')}\n${r.stdout}${r.stderr}[exit ${r.code}]\n\n`);
  return r;
}
try {
  await writeFile(at('spec.json'), JSON.stringify(spec, null, 2));
  await writeFile(at('edit.json'), JSON.stringify({ questions: [spec.questions[0], { ...spec.questions[1], question: 'What limits lifetime in hot storage?' }] }));
  await step('create', '--spec', at('spec.json'), '--out', at('state-0.json'));
  await step('run', '--in', at('state-0.json'), '--branch', 'cost', '--out', at('state-1.json'), '--lease', fixture.lease);
  await step('run', '--in', at('state-1.json'), '--branch', 'life', '--out', at('state-2.json'), '--lease', fixture.lease);
  const bPrompt = (await fixture.session(1)).prompt;
  process.stdout.write(`Branch B prompt contains branch A finding: ${bPrompt.includes('BRANCH-A-ONLY')}\n\n`);
  await step('compare', '--in', at('state-2.json'), '--branch', 'cost', '--branch', 'life', '--out', at('state-3.json'), '--comparison', at('comparison.json'), '--lease', fixture.lease);
  const cPrompt = (await fixture.session(2)).prompt;
  process.stdout.write(`Comparison prompt contains both branch findings: ${cPrompt.includes('BRANCH-A-ONLY') && cPrompt.includes('BRANCH-B-ONLY')}\n\n`);
  await step('export', '--comparison', at('comparison.json'), '--in', at('state-3.json'), '--out', at('comparison.md'));
  await step('edit', '--in', at('state-3.json'), '--edit', at('edit.json'), '--out', at('state-4.json'));
  await step('export', '--comparison', at('comparison.json'), '--in', at('state-4.json'), '--out', at('comparison-reopened.md'));
  await step('compare', '--in', at('state-4.json'), '--branch', 'cost', '--branch', 'life', '--out', at('state-5.json'), '--comparison', at('comparison-2.json'), '--lease', fixture.lease);
  process.stdout.write(`--- comparison.md ---\n${await readFile(at('comparison.md'), 'utf8')}\nFiles: ${dir}\n`);
} finally { await fixture.cleanup(); }
