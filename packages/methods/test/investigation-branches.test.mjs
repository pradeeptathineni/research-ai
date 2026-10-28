// Independent branch context and explicit branch comparison. Offline: every native session is
// test/fake-codex.mjs replaying authored output, so these prove transport and binding rules,
// not research quality.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { readFile, writeFile, rename, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createInvestigation, reviseInvestigation, validateInvestigation, advanceInvestigation, compareInvestigation, validateComparison, comparisonCurrentness, renderComparison } from '../src/index.mjs';
import { fakeCodex, message } from './fake-codex.mjs';

const event = (value, extra = {}) => ({ events: [message(JSON.stringify(value)), { type: 'turn.completed' }], ...extra });
const execs = async (f) => (await f.probes()).filter((a) => a[0] === 'exec' && a[1] !== '--help').length;
const S1 = { uri: 'https://example.org/upfront', text: 'Lead-acid packs cost less to buy. They need replacing after about four years.', omissions: ['Prices were captured for one supplier only.'] };
const S2 = { uri: 'https://example.org/lifetime', text: 'Lithium packs cost more to buy but often last ten years.' };
const questions = [{ id: 'cost', parentId: null, question: 'What favours lower upfront cost?' }, { id: 'life', parentId: null, question: 'What favours lifetime durability?' }];
const A = event({ findings: ['MARKER-A-ONLY lead-acid costs less upfront'], gaps: ['Installation cost unknown.'], sources: [{ uri: S1.uri }], answer: 'Lead-acid is cheaper to buy.' });
const B = event({ findings: ['MARKER-B-ONLY lithium lasts longer'], gaps: [], sources: [{ uri: S2.uri }], answer: 'Lithium lasts longer overall.' });
const pos = (attemptId, branchQuote, sourceUri = null, sourceQuote = null) => ({ attemptId, stance: `Stance of ${attemptId}`, branchQuote, sourceUri, sourceQuote, sourceOccurrence: sourceUri ? 1 : null });
const comparisonOutput = (a = 'a1', b = 'a2') => ({
  summary: 'The branches weigh purchase price against lifetime.',
  agreements: [{ summary: 'Purchase prices differ by chemistry.', positions: [pos(a, 'Lead-acid is cheaper to buy.', S1.uri, 'cost less to buy'), pos(b, 'lithium lasts longer', S2.uri, 'cost more to buy')] }],
  disagreements: [{ summary: 'Which option is better value.', positions: [pos(a, 'Lead-acid is cheaper to buy.'), pos(b, 'Lithium lasts longer overall.', S2.uri, 'last ten years')] }],
  unknowns: [{ summary: 'Total cost of ownership was not captured.', attemptIds: [a, b] }],
});
const independent = (extra = {}) => createInvestigation('Battery packs for a small clinic', { questions, sources: [S1, S2], branchContext: 'independent', ...extra });

test('default shared mode keeps its identity formula and still shares sibling findings', async () => {
  const fixture = await fakeCodex({ sessions: [A, B] });
  try {
    const shared = createInvestigation('Battery packs for a small clinic', { questions, sources: [S1, S2] });
    const { revision, topic, goal, scope, sources, budget } = shared;
    assert.equal(shared.identity, createHash('sha256').update(JSON.stringify({ revision, topic, goal, scope, questions, sources, budget })).digest('hex'));
    assert.equal(Object.hasOwn(shared, 'branchContext'), false);
    assert.notEqual(independent().identity, shared.identity);
    const done = await advanceInvestigation(await advanceInvestigation(shared, { action: 'investigate', branchIds: ['cost'], lease: fixture.lease }), { action: 'investigate', branchIds: ['life'], lease: fixture.lease });
    assert.match((await fixture.session(1)).prompt, /MARKER-A-ONLY/);
    assert.doesNotMatch((await fixture.session(1)).prompt, /Branch context is independent/);
    await assert.rejects(compareInvestigation(done, { branchIds: ['cost', 'life'], lease: fixture.lease }), /requires an investigation with branchContext independent/);
    // Switching an answered shared state to independent makes its attempts historical, not independent.
    await assert.rejects(compareInvestigation(reviseInvestigation(done, { branchContext: 'independent' }), { branchIds: ['cost', 'life'], lease: fixture.lease }), /no current completed attempt/);
    assert.throws(() => createInvestigation('Topic', { questions, branchContext: 'independent' }), /require caller-supplied frozen sources/);
    assert.equal(await execs(fixture), 2);
  } finally { await fixture.cleanup(); }
});

test('independent branches withhold siblings until an explicit, provenance-checked comparison', async () => {
  const fixture = await fakeCodex({ sessions: [A, B, event(comparisonOutput()), A] });
  try {
    let s = await advanceInvestigation(independent(), { action: 'investigate', branchIds: ['cost'], lease: fixture.lease });
    s = await advanceInvestigation(s, { action: 'investigate', branchIds: ['life'], lease: fixture.lease });
    const bPrompt = (await fixture.session(1)).prompt;
    assert.doesNotMatch(bPrompt, /MARKER-A-ONLY|Lead-acid is cheaper/);
    assert.match(bPrompt, /sibling branch findings are deliberately withheld/);
    const { investigation, comparison } = await compareInvestigation(s, { branchIds: ['cost', 'life'], lease: fixture.lease });
    const cPrompt = (await fixture.session(2)).prompt;
    assert.match(cPrompt, /MARKER-A-ONLY/); assert.match(cPrompt, /MARKER-B-ONLY/);
    assert.equal(comparison.status, 'complete');
    const rehash = (artifact) => { const { digest, ...body } = artifact; return { ...body, digest: createHash('sha256').update(JSON.stringify(body)).digest('hex') }; };
    for (const mutate of [
      (c) => { c.receipt = null; },
      (c) => { c.receipt.cleanup.complete = false; },
      (c) => { const native = JSON.parse(c.receipt.final); native.summary = 'Changed after delivery'; c.receipt.final = JSON.stringify(native); },
    ]) {
      const changed = structuredClone(comparison); mutate(changed);
      assert.throws(() => validateComparison(rehash(changed)), /successful native receipt and matching output/);
    }
    assert.deepEqual(comparison.selection.map((a) => [a.branchId, a.id, a.pinned]), [['cost', 'a1', false], ['life', 'a2', false]]);
    const [p1, p2] = comparison.result.disagreements[0].positions;
    assert.equal(p1.source, null);
    assert.deepEqual(p2.source, { uri: S2.uri, sha256: investigation.sources[1].sha256, quote: 'last ten years', occurrence: 1, start: S2.text.indexOf('last ten years'), end: S2.text.indexOf('last ten years') + 14 });
    assert.equal(comparison.result.agreements[0].positions[1].branchField, 'findings[0]');
    assert.deepEqual(comparison.preserved, { gaps: [{ attemptId: 'a1', gap: 'Installation cost unknown.' }], omissions: [{ uri: S1.uri, omission: 'Prices were captured for one supplier only.' }] });
    assert.equal(investigation.history.at(-1).action, 'compare');
    assert.equal(investigation.used.calls, 3);
    assert.deepEqual(comparisonCurrentness(comparison, investigation), { current: true, reasons: [] });
    const md = renderComparison(comparison, { investigation });
    assert.match(md, /## Claimed disagreements[\s\S]*No source quote: branch claim only, not source evidence\./);
    assert.match(md, /Currentness: current/);

    // Tampered bytes refuse on replay.
    const tamper = (edit) => { const c = structuredClone(comparison); edit(c); return () => validateComparison(c); };
    assert.throws(tamper((c) => { c.sources[1].text = c.sources[1].text.replace('ten', 'two'); }), /invalid_comparison/);
    assert.throws(tamper((c) => { c.result.disagreements[0].positions[1].source.quote = 'last two years'; }), /invalid_comparison/);
    assert.throws(tamper((c) => { c.selection[0].answer = 'Lead-acid is best.'; }), /invalid_comparison/);
    for (const c of [tamper((c) => { c.result.disagreements[0].positions[1].source.start += 1; }), tamper((c) => { c.selection[0].id = 'a9'; })]) assert.throws(c, /invalid_comparison/);

    // Revisiting a branch sees only its own history and makes the comparison stale; history stays.
    const revisited = await advanceInvestigation(investigation, { action: 'investigate', branchIds: ['cost'], lease: fixture.lease });
    const again = (await fixture.session(3)).prompt;
    assert.match(again, /MARKER-A-ONLY/); assert.doesNotMatch(again, /MARKER-B-ONLY/);
    assert.deepEqual(comparisonCurrentness(comparison, revisited).reasons, ['branch cost has a newer completed attempt']);
    const pinned = await compareInvestigation(revisited, { branchIds: ['cost', 'life'], attempts: { cost: 'a1' }, signal: AbortSignal.abort() });
    assert.equal(pinned.comparison.selection[0].pinned, true);
    assert.equal(pinned.comparison.status, 'not_run');

    // Editing a branch question invalidates the comparison but keeps old attempts and artifact valid.
    const edited = reviseInvestigation(revisited, { questions: [questions[0], { ...questions[1], question: 'What limits lifetime?' }] });
    assert.deepEqual(comparisonCurrentness(comparison, edited).reasons, ['branch cost has a newer completed attempt', 'branch life question was edited or removed']);
    assert.equal(edited.history[1].question, 'What favours lifetime durability?');
    assert.match(renderComparison(validateComparison(JSON.parse(JSON.stringify(comparison))), { investigation: edited }), /stale \(.*branch life question was edited/);
    await assert.rejects(compareInvestigation(edited, { branchIds: ['cost', 'life'], lease: fixture.lease }), /branch life has no current completed attempt/);
    assert.equal(await execs(fixture), 4);
  } finally { await fixture.cleanup(); }
});

test('CLI refuses invalid output pairs before dispatch and preserves a result when its admitted path changes', async () => {
  const fixture = await fakeCodex({ sessions: [A, B, { ...A, lineDelayMs: 150 }] });
  const cli = join(import.meta.dirname, '..', 'bin', 'research-branches.mjs');
  const at = (name) => join(fixture.root, name);
  const run = (...args) => promisify(execFile)(process.execPath, [cli, ...args], { env: process.env, timeout: 2000 }).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, ...e }));
  try {
    let state = await advanceInvestigation(independent(), { action: 'investigate', branchIds: ['cost', 'life'], lease: fixture.lease });
    await writeFile(at('state.json'), JSON.stringify(state));
    let refused = await run('compare', '--in', at('state.json'), '--branch', 'cost', '--branch', 'life', '--out', at('same.json'), '--comparison', at('same.json'), '--lease', fixture.lease);
    assert.equal(refused.code, 2); assert.match(refused.stderr, /distinct/);
    const fifo = at('input.fifo'); execFileSync('/usr/bin/mkfifo', [fifo]);
    refused = await run('edit', '--in', fifo, '--edit', at('state.json'), '--out', at('unused.json'));
    assert.equal(refused.code, 2); assert.match(refused.stderr, /regular/);
    assert.equal(await execs(fixture), 2);

    const out = at('drift.json');
    const child = spawn(process.execPath, [cli, 'run', '--in', at('state.json'), '--branch', 'cost', '--out', out, '--lease', fixture.lease], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', (part) => { stderr += part; }); child.stdout.resume();
    const exited = new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit); });
    let marker;
    for (let i = 0; !marker && i < 500; i++) { await new Promise((resolveDelay) => setTimeout(resolveDelay, 10)); marker = await readFile(out, 'utf8').then(JSON.parse).catch(() => null); }
    assert.ok(marker, 'intent was saved before the slow fixture completed');
    await rename(out, at('original-intent.json'));
    await writeFile(out, 'Unrelated replacement, keep this.');
    assert.equal(await exited, 2); assert.match(stderr, /output changed after admission/);
    assert.equal(await readFile(out, 'utf8'), 'Unrelated replacement, keep this.');
    const [recovery] = (await readdir(fixture.root)).filter((name) => name.startsWith('drift.json.result-'));
    assert.ok(recovery);
    const completed = validateInvestigation(JSON.parse(await readFile(at(recovery), 'utf8')));
    assert.equal(completed.history.at(-1).status, 'complete');
    assert.equal((await stat(at(recovery))).mode & 0o777, 0o400);
    assert.equal(await execs(fixture), 3);
  } finally { await fixture.cleanup(); }
});

test('unbound comparison output fails with its receipt and is never promoted', async () => {
  const badQuote = comparisonOutput(); badQuote.disagreements[0].positions[1].sourceQuote = 'last twenty years';
  const unselected = comparisonOutput('a1', 'a9');
  const oneSided = comparisonOutput(); oneSided.agreements[0].positions[1].attemptId = 'a1'; oneSided.agreements[0].positions[1].branchQuote = 'Lead-acid is cheaper to buy.';
  const uncitedBranch = comparisonOutput(); uncitedBranch.disagreements[0].positions[0].branchQuote = 'Lead-acid always wins.';
  const fixture = await fakeCodex({ sessions: [A, B, event(badQuote), event(unselected), event(oneSided), event(uncitedBranch)] });
  try {
    let s = await advanceInvestigation(independent(), { action: 'investigate', branchIds: ['cost', 'life'], lease: fixture.lease });
    for (let i = 0; i < 4; i++) {
      const out = await compareInvestigation(s, { branchIds: ['cost', 'life'], lease: fixture.lease });
      assert.equal(out.comparison.status, 'failed'); assert.equal(out.comparison.reason, 'invalid_comparison_output');
      assert.equal(out.comparison.result, null); assert.ok(out.comparison.receipt);
      assert.equal(out.investigation.history.at(-1).receipt.nativeSessions, 1);
      assert.match(renderComparison(out.comparison), /## No validated comparison/);
      s = out.investigation;
    }
    assert.equal(s.used.calls, 6);
  } finally { await fixture.cleanup(); }
});

test('shared budget, cancellation and uncertain cleanup stop native comparison work', async () => {
  const fixture = await fakeCodex({ sessions: [A, B, event(comparisonOutput())] });
  try {
    let s = await advanceInvestigation(independent({ budget: { searches: 0, documents: 4, seconds: 60, calls: 3 } }), { action: 'investigate', branchIds: ['cost', 'life'], lease: fixture.lease });
    const cancelled = await compareInvestigation(s, { branchIds: ['cost', 'life'], lease: fixture.lease, signal: AbortSignal.abort() });
    assert.equal(cancelled.comparison.reason, 'cancelled'); assert.equal(cancelled.investigation.used.calls, 2);
    const first = await compareInvestigation(s, { branchIds: ['cost', 'life'], lease: fixture.lease });
    assert.equal(first.comparison.status, 'complete');
    const capped = await compareInvestigation(first.investigation, { branchIds: ['cost', 'life'], lease: fixture.lease });
    assert.equal(capped.comparison.status, 'not_run'); assert.equal(capped.comparison.reason, 'budget_exhausted');
    const uncertain = structuredClone(first.investigation);
    uncertain.history.at(-1).receipt.cleanup = { complete: false, error: 'process_group_cleanup_failed' };
    const blocked = await compareInvestigation(validateInvestigation(uncertain), { branchIds: ['cost', 'life'], lease: fixture.lease });
    assert.equal(blocked.comparison.reason, 'prior_cleanup_unconfirmed');
    const run = await advanceInvestigation(uncertain, { action: 'investigate', branchIds: ['cost'], lease: fixture.lease });
    assert.equal(run.history.at(-1).reason, 'prior_cleanup_unconfirmed');
    assert.equal(await execs(fixture), 3);
  } finally { await fixture.cleanup(); }
});

test('CLI runs create, branch A, branch B, compare and export in fresh processes; an interrupted run never replays', async () => {
  const slowA = { ...A, lineDelayMs: 1500 };
  const fixture = await fakeCodex({ sessions: [A, B, event(comparisonOutput()), slowA] });
  const cli = join(import.meta.dirname, '..', 'bin', 'research-branches.mjs');
  const at = (name) => join(fixture.root, name);
  const run = (...args) => promisify(execFile)(process.execPath, [cli, ...args], { env: process.env }).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
  try {
    await (await import('node:fs/promises')).writeFile(at('spec.json'), JSON.stringify({ topic: 'Battery packs for a small clinic', questions, sources: [S1, S2] }));
    assert.equal((await run('create', '--spec', at('spec.json'), '--out', at('s0.json'))).code, 0);
    assert.match((await run('run', '--in', at('s0.json'), '--branch', 'cost', '--out', at('s1.json'), '--lease', fixture.lease)).stdout, /a1 investigate cost: complete/);
    assert.equal((await run('run', '--in', at('s1.json'), '--branch', 'life', '--out', at('s2.json'), '--lease', fixture.lease)).code, 0);
    assert.doesNotMatch((await fixture.session(1)).prompt, /MARKER-A-ONLY/);
    assert.match((await run('compare', '--in', at('s2.json'), '--branch', 'cost', '--branch', 'life', '--out', at('s3.json'), '--comparison', at('c.json'), '--lease', fixture.lease)).stdout, /a3 compare -: complete/);
    assert.match((await run('export', '--comparison', at('c.json'), '--in', at('s3.json'), '--out', at('c.md'))).stdout, /comparison complete; current/);
    assert.match(await readFile(at('c.md'), 'utf8'), /## Claimed agreements/);
    assert.equal((await run('export', '--comparison', at('c.json'), '--out', at('c.md'))).code, 2, 'outputs are never overwritten');

    // Kill the CLI mid-dispatch: the saved output blocks further native work instead of replaying.
    const child = spawn(process.execPath, [cli, 'run', '--in', at('s3.json'), '--branch', 'cost', '--out', at('s4.json'), '--lease', fixture.lease], { env: process.env, stdio: 'ignore' });
    let marker;
    for (let i = 0; !marker && i < 500; i++) { await new Promise((r) => setTimeout(r, 20)); marker = await readFile(at('s4.json'), 'utf8').then(JSON.parse).catch(() => null); }
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    assert.equal(validateInvestigation(marker).history.at(-1).reason, 'dispatch_outcome_unknown');
    await new Promise((r) => setTimeout(r, 3500)); // let any orphaned fake session finish its paced lines
    const before = await execs(fixture);
    const resumed = await run('run', '--in', at('s4.json'), '--branch', 'cost', '--out', at('s5.json'), '--lease', `${fixture.lease}-other`);
    assert.equal(resumed.code, 1); assert.match(resumed.stdout, /not_run \(prior_cleanup_unconfirmed\)/);
    assert.equal(await execs(fixture), before);
  } finally { await fixture.cleanup(); }
});
