import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReport, reviseReport, validateReport } from '../src/report.mjs';
import { exportReportHtml } from '../src/report-export.mjs';

const text = 'The policy is <script>alert("x")</script> and keeps logs for 7 days.';
const sources = [
  { uri: 'https://example.org/a?x=<img>', text, observedAt: 'capture date supplied by caller', omissions: ['No independent audit.'] },
  { uri: 'https://example.org/b', text: 'The policy is different and keeps logs for 7 days.' },
];
const quote = (source, phrase) => {
  const start = sources[source].text.indexOf(phrase);
  return { source, start, end: start + phrase.length, quote: phrase };
};
const basis = {
  version: 'research-outline-v1', topic: 'Retention <review>',
  sources: sources.map((source) => ({ ...source, sha256: createHash('sha256').update(source.text).digest('hex') })),
  sections: [
    { id: 'retention', title: 'Current retention', points: [], gaps: ['Review date is not stated.'] },
    { id: 'coverage', title: 'Open coverage', points: [], gaps: ['The source set does not describe backup retention.'] },
  ], origin: { type: 'caller-authored' }, limits: ['Source truth and support are not verified.'],
};
const report = () => reviseReport(createReport(basis), {
  sectionId: 'retention', paragraphs: [{
    text: 'A human-edited statement: 7 days <script>no-run</script>.',
    citations: [quote(0, '7 days'), quote(1, '7 days')],
  }],
});

test('exports validated current text with exact distinct source spans and explicit gaps', () => {
  const state = report();
  const html = exportReportHtml(JSON.parse(JSON.stringify(state)));
  assert.equal(exportReportHtml(state), html);
  assert.match(html, /User-edited current v1/);
  assert.match(html, /human-edited statement: 7 days/i);
  assert.match(html, /No paragraph draft yet\./);
  assert.match(html, /The source set does not describe backup retention\./);
  assert.equal((html.match(/class="source" id=/g) ?? []).length, 2);
  assert.match(html, /href="#source-1"/);
  assert.match(html, /href="#source-2"/);
  assert.match(html, /UTF-16 span:/);
  assert.match(html, /SHA-256:/);
  assert.match(html, /capture date supplied by caller/);
  assert.match(html, /No independent audit\./);
  assert.match(html, /research-report-sha256/);
  assert.match(html, /<details><summary>Report details/);
  assert.equal((html.match(/<details><summary>Source details/g) ?? []).length, 2);
  assert.match(html, /<blockquote>7 days<\/blockquote>/);
  assert.match(html, /support and currentness are unverified/i);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;no-run&lt;\/script&gt;/);
  assert.match(html, /&lt;img&gt;/);
  assert.match(html, /default-src 'none'/);
  assert.deepEqual([...html.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map((match) => match[1]).filter((href) => !href.startsWith('#')), []);
  assert.doesNotMatch(html, /<img\b|<script\b|<iframe\b|<link\b|@import|https?:\/\/[^<]+\.(?:css|js|png|jpg)/i);
});

test('rejects changed source hashes and malformed source qualifications', () => {
  const damaged = report();
  damaged.basis.sources[0].text += 'tamper';
  assert.throws(() => exportReportHtml(damaged), /invalid_report|outline|digest/i);
  const huge = report();
  huge.basis.sources[0].omissions = ['x'.repeat(9000)];
  assert.throws(() => exportReportHtml(huge), /invalid_sources/);
});

test('standalone CLI writes create-only output and rejects duplicate-key, invalid and symlink inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'report-export-'));
  const cliPath = fileURLToPath(new URL('../bin/research-report-export.mjs', import.meta.url));
  const valid = join(root, 'report.json');
  const output = join(root, 'report.html');
  const call = (...args) => new Promise((resolve) => execFile(process.execPath, [cliPath, ...args], (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
  try {
    await writeFile(valid, JSON.stringify(report()));
    let result = await call('--input', valid, '--output', output);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(output, 'utf8'), exportReportHtml(report()));
    result = await call('--input', valid, '--output', output);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /EEXIST/);

    const duplicate = join(root, 'duplicate.json');
    await writeFile(duplicate, '{"version":"wrong","version":"research-report-v1"}');
    result = await call('--input', duplicate);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /duplicate JSON key/);

    const bad = join(root, 'bad.json');
    await writeFile(bad, '{');
    result = await call('--input', bad);
    assert.equal(result.code, 1);

    const oversized = join(root, 'oversized.json');
    await writeFile(oversized, ' '.repeat(1024 * 1024 + 1));
    result = await call('--input', oversized);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no larger than 1 MiB/);

    const link = join(root, 'report-link.json');
    await symlink(valid, link);
    result = await call('--input', link);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /regular non-symlink/);
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  }
});
