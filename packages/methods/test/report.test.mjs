import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEvidenceTable, reviseEvidenceTable } from '../src/index.mjs';
import { validateOutline } from '../src/index.mjs';
import { createReport, draftReportSection, projectReportClaimRegister, renderReport, reviseReport, validateReport } from '../src/index.mjs';
import { fakeCodex, message } from './fake-codex.mjs';

const a = 'The service retains logs for 7 days.';
const b = 'The service retains logs for 30 days. Backups are weekly.';
const sources = [
  { uri: 'https://example.org/a', text: a, observedAt: 'caller observation', omissions: ['Scope is not specified.'] },
  { uri: 'https://example.org/b', text: b, observedAt: 'second capture' },
];
const columns = [
  { id: 'retention', title: 'Retention', question: 'How long are logs retained?' },
  { id: 'backups', title: 'Backups', question: 'How often are backups made?' },
];
const span = (text, source, phrase) => {
  const start = text.indexOf(phrase);
  return { source, start, end: start + phrase.length };
};
const quote = (phrase) => span(a, 0, phrase);
const source1Quote = (phrase) => span(b, 1, phrase);
const table = () => reviseEvidenceTable(createEvidenceTable('Compare retention and backups', { sources, columns }), {
  rows: [
    { source: 0, cells: [
      { columnId: 'retention', text: '7 days', citations: [{ ...quote('7 days'), quote: '7 days' }], gap: '' },
      { columnId: 'backups', text: '', citations: [], gap: 'The capture does not describe backups.' },
    ] },
    { source: 1, cells: [
      { columnId: 'retention', text: '30 days', citations: [{ ...source1Quote('30 days'), quote: '30 days' }], gap: '' },
      { columnId: 'backups', text: 'Weekly', citations: [{ ...source1Quote('weekly'), quote: 'weekly' }], gap: '' },
    ] },
  ],
});
const makeOutput = (source, text, phrase, gaps = []) => ({ paragraphs: [{ text, citations: [{ ...source(phrase) }] }], gaps });
const events = (output) => [message(JSON.stringify(output)), { type: 'turn.completed' }];

test('table converts to a report, selected sections draft in sequence, edits retain versions and assembled state reopens', async () => {
  const baseTable = table();
  const initial = createReport(baseTable);
  assert.equal(initial.sections.length, 2);
  assert.deepEqual(initial.sections.map((section) => section.title), ['Retention', 'Backups']);
  assert.equal(initial.basis.sections[1].gaps[0], 'The capture does not describe backups.');
  const fixture = await fakeCodex({ sessions: [
    { events: events(makeOutput(quote, 'The first capture states a seven-day log retention period.', '7 days')) },
    { events: events(makeOutput(source1Quote, 'The second capture states that backups are weekly.', 'weekly', ['Backup retention is not stated.'])) },
  ] });
  try {
    let report = await draftReportSection(initial, { sectionId: 'retention', lease: fixture.lease, model: 'fixture' });
    assert.equal(report.attempts[0].status, 'complete');
    assert.equal(report.sections[0].versions[0].paragraphs[0].citations[0].quote, '7 days');
    const beforeEditHash = report.parentHash;
    report = reviseReport(report, { sectionId: 'retention', paragraphs: [{
      text: 'Edited: the first capture states seven days.', citations: report.sections[0].versions[0].paragraphs[0].citations,
    }] });
    assert.equal(report.sections[0].versions.length, 2);
    assert.equal(report.sections[0].versions[0].origin, 'model-generated');
    assert.equal(report.sections[0].versions[1].origin, 'user-modified');
    assert.notEqual(report.parentHash, beforeEditHash);
    report = await draftReportSection(report, { sectionId: 'backups', lease: fixture.lease, model: 'fixture' });
    assert.equal(report.sections[1].versions[0].paragraphs[0].citations[0].quote, 'weekly');
    assert.equal(report.usage.calls, 2);
    assert.equal(report.usage.nativeSessions, 2);
    const first = await fixture.session(0);
    assert.ok(first.prompt.includes(a));
    assert.ok(first.prompt.includes(sources[0].text));
    assert.ok(first.prompt.includes(createHash('sha256').update(a).digest('hex')));
    assert.ok(first.prompt.includes('Scope is not specified.'));
    const second = await fixture.session(1);
    assert.ok(second.prompt.includes('Edited: the first capture states seven days.'));
    assert.ok(second.prompt.includes('The service retains logs for 30 days. Backups are weekly.'));
    const reopened = validateReport(JSON.parse(JSON.stringify(report)));
    const register = projectReportClaimRegister(reopened);
    assert.equal(register.schema, 'research-report-claim-register.v1');
    assert.equal(register.revision, reopened.revision);
    assert.equal(register.citedClaims[0].review, 'exact-span-matched; entailment-and-truth-unassessed');
    assert.deepEqual(register.unresolvedClaims.map((item) => item.text), ['Backup retention is not stated.']);
    assert.match(renderReport(reopened), /Review register/);
    assert.match(renderReport(reopened), /Edited: the first capture states seven days\./);
    assert.match(renderReport(reopened), /The second capture states that backups are weekly\./);
    assert.match(renderReport(reopened), /Scope is not specified\./);
    assert.match(renderReport(reopened), /SHA-256/);
    assert.deepEqual(JSON.parse(renderReport(reopened, { format: 'json' })).sections, report.sections);
    const wrongQuote = structuredClone(report);
    wrongQuote.sections[1].versions[0].paragraphs[0].citations[0].quote = 'backups every day';
    assert.throws(() => validateReport(wrongQuote), /invalid_outline/);
    const directEdit = structuredClone(report);
    directEdit.sections[1].versions[0].paragraphs[0].text = 'Direct unmarked rewrite.';
    assert.throws(() => validateReport(directEdit), /changed; append a new version/);
    const changedQualifier = structuredClone(report);
    changedQualifier.basis.sources[0].omissions[0] = 'Qualifier was changed.';
    assert.throws(() => validateReport(changedQualifier), /outline or qualifiers changed/);
  } finally { await fixture.cleanup(); }
});

test('failed malformed and cancelled sessions keep receipts and prior section prose without promotion', async () => {
  const fixture = await fakeCodex({ sessions: [
    { events: events(makeOutput(quote, 'The first capture states a seven-day log retention period.', '7 days')) },
    { events: events({ paragraphs: [{ text: 'Malformed later claim.', citations: [{ source: 0, start: 0, end: 4000 }] }], gaps: [] }) },
  ] });
  try {
    const initial = createReport(table());
    const drafted = await draftReportSection(initial, { sectionId: 'retention', lease: fixture.lease });
    const result = await draftReportSection(drafted, { sectionId: 'retention', lease: fixture.lease });
    assert.equal(result.attempts[1].status, 'failed');
    assert.equal(result.attempts[1].reason, 'invalid_report_section_output');
    assert.equal(result.attempts[1].receipt.cleanup.complete, true);
    assert.equal(result.sections[0].versions.length, 1);
    assert.match(renderReport(result), /seven-day log retention period/);
  } finally { await fixture.cleanup(); }

  const cancelledFixture = await fakeCodex({ hang: true });
  const controller = new AbortController();
  try {
    setTimeout(() => controller.abort(), 100);
    const initial = createReport(table());
    const cancelled = await draftReportSection(initial, { sectionId: 'retention', lease: cancelledFixture.lease, signal: controller.signal });
    assert.equal(cancelled.attempts[0].status, 'cancelled');
    assert.equal(cancelled.sections[0].versions.length, 0);
    assert.equal(cancelled.attempts[0].receipt.cleanup.complete, true);
    const unknown = structuredClone(cancelled);
    unknown.attempts[0].receipt.cleanup.complete = false;
    unknown.attempts[0].receipt.cleanup.error = 'process_group_cleanup_failed';
    const before = await cancelledFixture.probes();
    const blocked = await draftReportSection(unknown, { sectionId: 'backups', lease: `${cancelledFixture.lease}-different` });
    assert.equal(blocked.attempts[1].status, 'not_run');
    assert.equal(blocked.attempts[1].reason, 'prior_cleanup_unconfirmed');
    assert.deepEqual(await cancelledFixture.probes(), before);
  } finally { await cancelledFixture.cleanup(); }
});

test('near-limit retained history refuses before native dispatch and preserves state for malformed or valid outcomes', async () => {
  const text = 'x'.repeat(48000);
  const basis = validateOutline({
    version: 'research-outline-v1', topic: 'Near-limit retained report',
    sources: [{ uri: 'https://example.org/large', text, sha256: createHash('sha256').update(text).digest('hex') }],
    sections: Array.from({ length: 8 }, (_, index) => ({ id: `s${index + 1}`, title: `Section ${index + 1}`, points: [], gaps: [] })),
    origin: { type: 'caller-authored' }, limits: [],
  });
  const para = (length, count = 4) => ({
    text: 'Retained human note.',
    citations: Array.from({ length: count }, () => ({ source: 0, start: 0, end: length, quote: text.slice(0, length) })),
  });
  const edit = (sectionId, length, count = 4) => ({ sectionId, paragraphs: [para(length, count)] });
  const stateBytes = (value) => Buffer.byteLength(JSON.stringify(value));
  let report = createReport(basis);
  const target = 1_020_000;
  let tuneSection = null;
  for (let sectionIndex = 0; sectionIndex < 7 && !tuneSection; sectionIndex++) {
    const sectionId = `s${sectionIndex + 1}`;
    for (let version = 0; version < 14; version++) {
      const candidate = reviseReport(report, edit(sectionId, 4000));
      if (stateBytes(candidate) >= target - 500) { tuneSection = sectionId; break; }
      report = candidate;
    }
    if (!tuneSection) report = reviseReport(report, edit(sectionId, 1, 1));
  }
  assert.ok(tuneSection, 'large retained history reached the tuning range');
  while (stateBytes(report) < target - 500) {
    const currentSize = stateBytes(report);
    const oneChar = reviseReport(report, edit(tuneSection, 1));
    const overhead = stateBytes(oneChar) - currentSize - 4;
    const length = Math.min(4000, Math.max(1, Math.floor((target - currentSize - overhead) / 4)));
    const candidate = reviseReport(report, edit(tuneSection, length));
    if (stateBytes(candidate) >= target - 500) { report = candidate; break; }
    report = candidate;
  }
  const beforeBytes = stateBytes(report);
  assert.ok(beforeBytes >= target - 500, `expected state within 500 bytes of the target, got ${beforeBytes}`);
  assert.ok(beforeBytes > 1_000_000 && beforeBytes < 1_048_576, `expected a near-limit state, got ${beforeBytes}`);

  for (const eventsForProvider of [events('malformed '.repeat(17000)), events(makeOutput(quote, 'A valid short cited paragraph.', '7 days'))]) {
    const fixture = await fakeCodex({ events: eventsForProvider });
    try {
      const result = await draftReportSection(report, { sectionId: 's8', lease: fixture.lease });
      assert.equal(result.attempts.length, report.attempts.length + 1);
      assert.equal(result.attempts.at(-1).status, 'not_run');
      assert.equal(result.attempts.at(-1).reason, 'state_capacity');
      assert.equal(result.usage.calls, report.usage.calls);
      assert.equal(result.usage.nativeSessions, report.usage.nativeSessions);
      assert.equal(result.sections[7].versions.length, 0);
      assert.equal(result.basis.sources[0].text, text);
      assert.equal(result.sections[0].versions.length, report.sections[0].versions.length);
      assert.ok(stateBytes(result) <= 1_048_576);
      assert.deepEqual(await fixture.probes(), []);
      assert.equal(await fixture.launched(), false);
    } finally { await fixture.cleanup(); }
  }
});

test('large malformed provider final is compacted while its native accounting and digest remain', async () => {
  const hugeFinal = 'malformed '.repeat(17000);
  const fixture = await fakeCodex({ events: events(hugeFinal) });
  try {
    const result = await draftReportSection(createReport(table()), { sectionId: 'retention', lease: fixture.lease });
    const attempt = result.attempts[0];
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.reason, 'invalid_report_section_output');
    assert.equal(attempt.receipt.cleanup.complete, true);
    assert.ok(attempt.receipt.reportPayloads.final.utf8Bytes >= Buffer.byteLength(hugeFinal));
    assert.match(attempt.receipt.reportPayloads.final.sha256, /^[a-f0-9]{64}$/);
    assert.equal(result.usage.calls, 1);
    assert.equal(result.usage.nativeSessions, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 100_000);
  } finally { await fixture.cleanup(); }
});

test('outline input stays reusable; edits are copy-on-write and table conversion refuses lossy bounds', () => {
  const originalTable = table();
  const initial = createReport(originalTable);
  const next = reviseReport(initial, { sectionId: 'retention', paragraphs: [{ text: 'Seven days is stated.', citations: [{ ...quote('7 days'), quote: '7 days' }] }] });
  assert.equal(initial.sections[0].versions.length, 0);
  assert.equal(next.sections[0].versions.length, 1);
  assert.throws(() => reviseReport(next, { sectionId: 'retention', paragraphs: [{ text: 'Altered quote.', citations: [{ ...quote('7 days'), quote: 'other' }] }] }), /invalid_outline/);
  const manySources = Array.from({ length: 6 }, (_, index) => ({ uri: `https://example.org/${index}`, text: `Source ${index} capture.` }));
  const tooMany = reviseEvidenceTable(createEvidenceTable('Many coverage gaps', { sources: manySources, columns }), {
    rows: manySources.map((_, index) => ({ source: index, cells: columns.map((column) => ({ columnId: column.id, text: '', citations: [], gap: `Distinct unanswered coverage gap ${index}.` })) })),
  });
  assert.throws(() => createReport(tooMany), /exceeds outline section bounds/);
});

test('report CLI creates, edits, drafts one section and exports without implicit sessions', async () => {
  const fixture = await fakeCodex({ events: events(makeOutput(quote, 'The first capture states a seven-day log retention period.', '7 days')) });
  const bin = fileURLToPath(new URL('../bin/research-ai.mjs', import.meta.url));
  const basisFile = join(fixture.root, 'basis.json');
  const reportFile = join(fixture.root, 'report.json');
  const editFile = join(fixture.root, 'edit.json');
  await writeFile(basisFile, JSON.stringify(table()));
  const cli = (...args) => new Promise((resolve) => execFile(process.execPath, [bin, ...args], { env: fixture.env }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })));
  try {
    const created = await cli('--report-create', '--report-input', basisFile);
    assert.equal(created.code, 0, created.stderr);
    await writeFile(reportFile, created.stdout);
    const markdown = await cli('--report-input', reportFile, '--report-format', 'markdown');
    assert.match(markdown.stdout, /^# Compare retention and backups/);
    assert.deepEqual(await fixture.probes(), []);
    await writeFile(editFile, JSON.stringify({ sectionId: 'retention', paragraphs: [{ text: 'Human review says seven days.', citations: [{ ...quote('7 days'), quote: '7 days' }] }] }));
    const revised = await cli('--report-input', reportFile, '--report-edit', editFile);
    assert.equal(revised.code, 0, revised.stderr);
    assert.equal(JSON.parse(revised.stdout).sections[0].versions[0].origin, 'user-modified');
    await writeFile(reportFile, revised.stdout);
    const drafted = await cli('--report-input', reportFile, '--report-draft', 'retention', '--model', 'fixture');
    assert.equal(drafted.code, 0, drafted.stderr);
    assert.equal(JSON.parse(drafted.stdout).attempts.at(-1).status, 'complete');
    assert.equal((await fixture.probes()).filter((args) => args[0] === 'exec' && args[1] !== '--help').length, 1);
  } finally { await fixture.cleanup(); }
});
