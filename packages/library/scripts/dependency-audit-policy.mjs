import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

const expectedLockPath = {
  'node_modules/repomix': { version: '1.18.1', dev: true },
  'node_modules/globby': { version: '16.2.4', dev: true },
  'node_modules/fast-glob': { version: '3.3.3', dev: true },
  'node_modules/micromatch': { version: '4.0.8', dev: true },
  'node_modules/braces': { version: '3.0.3', dev: true },
};

export function assessDependencyAudit(report, manifest, lockfile) {
  const errors = [];
  if (
    report?.auditReportVersion !== 2 ||
    !report.vulnerabilities ||
    typeof report.vulnerabilities !== 'object' ||
    Array.isArray(report.vulnerabilities)
  ) {
    return {
      accepted: false,
      waived: false,
      errors: ['npm audit returned an unsupported or malformed report'],
    };
  }

  const vulnerabilities = report.vulnerabilities;
  const counts = report?.metadata?.vulnerabilities;
  const validSeverities = ['info', 'low', 'moderate', 'high', 'critical'];
  if (
    Object.values(vulnerabilities).some(
      (entry) =>
        !validSeverities.includes(entry?.severity) ||
        !Array.isArray(entry?.via) ||
        entry.via.some(
          (cause) => typeof cause !== 'string' && !validSeverities.includes(cause?.severity),
        ),
    )
  ) {
    errors.push('npm audit vulnerability severity or cause metadata is malformed');
  }
  if (
    !counts ||
    !validSeverities.every((severity) => Number.isInteger(counts[severity])) ||
    !Number.isInteger(counts.total)
  ) {
    errors.push('npm audit vulnerability counts are missing or malformed');
  } else {
    for (const severity of validSeverities) {
      const actual = Object.values(vulnerabilities).filter(
        (entry) => entry?.severity === severity,
      ).length;
      if (counts[severity] !== actual) {
        errors.push(`npm audit ${severity} count does not match the vulnerability entries`);
      }
    }
    if (counts.total !== Object.keys(vulnerabilities).length) {
      errors.push('npm audit total count does not match the vulnerability entries');
    }
  }

  const blocking = Object.fromEntries(
    Object.entries(vulnerabilities).filter(([, entry]) => {
      if (['high', 'critical'].includes(entry?.severity)) return true;
      return Array.isArray(entry?.via)
        ? entry.via.some(
            (cause) =>
              cause && typeof cause === 'object' && ['high', 'critical'].includes(cause.severity),
          )
        : false;
    }),
  );

  if (manifest?.dependencies?.repomix !== undefined) {
    errors.push('repomix must not be a runtime dependency');
  }
  if (manifest?.devDependencies?.repomix !== '1.18.1') {
    errors.push('repomix must remain exact-pinned at the reviewed development-only version 1.18.1');
  }
  if (manifest?.scripts?.['context:pack'] !== 'node scripts/run-context-pack.mjs') {
    errors.push('context:pack must use the reviewed no-arguments wrapper');
  }

  for (const [path, expected] of Object.entries(expectedLockPath)) {
    const installed = lockfile?.packages?.[path];
    if (installed?.version !== expected.version || installed?.dev !== expected.dev) {
      errors.push(`${path}: expected development-only ${expected.version}`);
    }
  }

  if (Object.keys(blocking).length > 0) {
    errors.push(
      `high/critical advisories require review: ${Object.keys(blocking).sort().join(', ')}`,
    );
  }

  return { accepted: errors.length === 0, waived: false, errors };
}

function run() {
  const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lockfile = JSON.parse(
    readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'),
  );
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmCommand, ['audit', '--json', '--audit-level=high'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });

  if (![0, 1].includes(result.status)) {
    process.stderr.write(
      result.stderr || `npm audit failed with status ${String(result.status)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    process.stderr.write(`Could not parse npm audit JSON: ${String(error)}\n${result.stderr}`);
    process.exitCode = 1;
    return;
  }

  const assessment = assessDependencyAudit(report, manifest, lockfile);
  if (!assessment.accepted) {
    process.stderr.write(`Dependency audit policy failed:\n${assessment.errors.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write('Dependency audit passed with no high or critical advisories.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
