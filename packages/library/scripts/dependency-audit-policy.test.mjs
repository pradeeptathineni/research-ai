import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assessDependencyAudit } from './dependency-audit-policy.mjs';

const advisory = {
  source: 1240992,
  name: 'braces',
  dependency: 'braces',
  title: 'braces vulnerable to stack-exhaustion denial of service through deeply nested patterns',
  url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
  severity: 'high',
  cwe: ['CWE-674'],
  cvss: { score: 7.5, vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H' },
  range: '<=3.0.3',
};
const fixAvailable = { name: 'repomix', version: '1.18.0', isSemVerMajor: true };
const report = {
  auditReportVersion: 2,
  vulnerabilities: {
    braces: {
      name: 'braces',
      severity: 'high',
      isDirect: false,
      via: [advisory],
      effects: ['micromatch'],
      range: '*',
      nodes: ['node_modules/braces'],
      fixAvailable,
    },
    'fast-glob': {
      name: 'fast-glob',
      severity: 'high',
      isDirect: false,
      via: ['micromatch'],
      effects: ['globby'],
      range: '*',
      nodes: ['node_modules/fast-glob'],
      fixAvailable,
    },
    globby: {
      name: 'globby',
      severity: 'high',
      isDirect: false,
      via: ['fast-glob', 'micromatch'],
      effects: ['repomix'],
      range: '>=8.0.0',
      nodes: ['node_modules/globby'],
      fixAvailable,
    },
    micromatch: {
      name: 'micromatch',
      severity: 'high',
      isDirect: false,
      via: ['braces'],
      effects: ['fast-glob', 'globby'],
      range: '>=0.2.0',
      nodes: ['node_modules/micromatch'],
      fixAvailable,
    },
    repomix: {
      name: 'repomix',
      severity: 'high',
      isDirect: true,
      via: ['globby'],
      effects: [],
      range: '>=1.18.1',
      nodes: ['node_modules/repomix'],
      fixAvailable,
    },
  },
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 5, critical: 0, total: 5 },
  },
};
const manifest = {
  dependencies: {},
  devDependencies: { repomix: '1.18.1' },
  scripts: { 'context:pack': 'node scripts/run-context-pack.mjs' },
};
const lockfile = {
  packages: {
    'node_modules/repomix': { version: '1.18.1', dev: true },
    'node_modules/globby': { version: '16.2.4', dev: true },
    'node_modules/fast-glob': { version: '3.3.3', dev: true },
    'node_modules/micromatch': { version: '4.0.8', dev: true },
    'node_modules/braces': { version: '3.0.3', dev: true },
  },
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const clean = {
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
  },
};

test('rejects the formerly waived advisory after its reviewed withdrawal', () => {
  assert.equal(assessDependencyAudit(report, manifest, lockfile).accepted, false);
  assert.equal(assessDependencyAudit(report, manifest, lockfile).waived, false);
});

test('accepts a clean report for the exact reviewed development-only path without a waiver', () => {
  assert.deepEqual(assessDependencyAudit(clean, manifest, lockfile), {
    accepted: true,
    waived: false,
    errors: [],
  });
});

test('rejects critical findings even without the withdrawn chain', () => {
  const changed = clone(clean);
  changed.vulnerabilities.critical = { severity: 'critical', via: [] };
  changed.metadata.vulnerabilities.critical = 1;
  changed.metadata.vulnerabilities.total = 1;
  assert.equal(assessDependencyAudit(changed, manifest, lockfile).accepted, false);
});

test('fails closed on malformed audit output', () => {
  assert.equal(assessDependencyAudit({}, manifest, lockfile).accepted, false);
  const unknown = clone(clean);
  unknown.vulnerabilities.unknown = { via: [] };
  unknown.metadata.vulnerabilities.total = 1;
  assert.equal(assessDependencyAudit(unknown, manifest, lockfile).accepted, false);
  const invalidCause = clone(clean);
  invalidCause.vulnerabilities.wrapper = { severity: 'moderate', via: [{}] };
  invalidCause.metadata.vulnerabilities.moderate = 1;
  invalidCause.metadata.vulnerabilities.total = 1;
  assert.equal(assessDependencyAudit(invalidCause, manifest, lockfile).accepted, false);
});

test('rejects an additional high advisory', () => {
  const changed = clone(clean);
  changed.vulnerabilities.unexpected = {
    severity: 'high',
    isDirect: true,
    via: [],
    effects: [],
    nodes: ['node_modules/unexpected'],
  };
  changed.metadata.vulnerabilities.high = 1;
  changed.metadata.vulnerabilities.total = 1;
  assert.equal(assessDependencyAudit(changed, manifest, lockfile).accepted, false);
});

test('rejects runtime reachability or dependency-tree drift', () => {
  const runtimeManifest = clone(manifest);
  runtimeManifest.dependencies.repomix = '1.18.1';
  assert.equal(assessDependencyAudit(clean, runtimeManifest, lockfile).accepted, false);

  const changedLock = clone(lockfile);
  changedLock.packages['node_modules/braces'].version = '3.0.4';
  assert.equal(assessDependencyAudit(clean, manifest, changedLock).accepted, false);
});

test('rejects returned high advisories even if fix metadata changes', () => {
  const changed = clone(report);
  changed.vulnerabilities.braces.fixAvailable = true;
  assert.equal(assessDependencyAudit(changed, manifest, lockfile).accepted, false);
});

test('rejects metadata that reports a high advisory missing from the entries', () => {
  const malformed = {
    auditReportVersion: 2,
    vulnerabilities: {
      unknown: { name: 'unknown', via: [], effects: [], nodes: ['node_modules/unknown'] },
    },
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 },
    },
  };
  assert.equal(assessDependencyAudit(malformed, manifest, lockfile).accepted, false);
});

test('rejects a lower-severity wrapper around a high-severity advisory', () => {
  const nested = clone(clean);
  nested.vulnerabilities.wrapper = {
    name: 'wrapper',
    severity: 'moderate',
    isDirect: false,
    via: [advisory],
    effects: [],
    range: '*',
    nodes: ['node_modules/wrapper'],
    fixAvailable: false,
  };
  nested.metadata.vulnerabilities.moderate = 1;
  nested.metadata.vulnerabilities.total = 1;
  assert.equal(assessDependencyAudit(nested, manifest, lockfile).accepted, false);
});

test('preserves the high/critical threshold for an otherwise valid moderate-only report', () => {
  const moderate = clone(clean);
  moderate.vulnerabilities.wrapper = { severity: 'moderate', via: [] };
  moderate.metadata.vulnerabilities.moderate = 1;
  moderate.metadata.vulnerabilities.total = 1;
  assert.deepEqual(assessDependencyAudit(moderate, manifest, lockfile), {
    accepted: true,
    waived: false,
    errors: [],
  });
});

test('rejects runtime and invocation drift even when the report is empty', () => {
  const clean = {
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
    },
  };
  const changedManifest = clone(manifest);
  changedManifest.dependencies.repomix = '1.18.1';
  changedManifest.scripts['context:pack'] = 'repomix --config alternate.json';
  const assessment = assessDependencyAudit(clean, changedManifest, lockfile);
  assert.equal(assessment.accepted, false);
  assert.match(assessment.errors.join('\n'), /runtime dependency/u);
  assert.match(assessment.errors.join('\n'), /no-arguments wrapper/u);
});
