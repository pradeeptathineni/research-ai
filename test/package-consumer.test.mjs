import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { fakeCodex } from './fake-codex.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const packageName = '@pradeeptathineni/research-ai';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('an offline packed consumer qualifies CLI, ESM, types and ownership boundaries', { timeout: 90000 }, async () => {
  assert.match(process.versions.node, /^24\./, 'run with the declared Node major before any fixture');
  const keep = process.env.RESEARCH_AI_PACKAGE_EVIDENCE;
  const tooling = resolve(process.env.RESEARCH_AI_TYPECHECK_ROOT ?? join(source, 'node_modules'));
  const npm = await realpath(join(dirname(process.execPath), 'npm'));
  const root = keep ? resolve(keep) : await mkdtemp(join(tmpdir(), 'research-package-'));
  await mkdir(root, { recursive: true });
  const fixture = await fakeCodex();
  const consumer = join(root, 'consumer'), archiveDir = join(root, 'archive');
  const report = { node: process.version, npm, source, tooling, consumer, commands: [] };
  const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
  try {
    await Promise.all([mkdir(consumer), mkdir(archiveDir), mkdir(join(root, 'cache'))]);
    const codexHome = join(fixture.home, 'codex-home');
    await mkdir(codexHome);
    await symlink(process.execPath, join(fixture.env.PATH, 'node'));
    await Promise.all(['user.npmrc', 'global.npmrc'].map(name => writeFile(join(root, name), '')));
    const env = {
      PATH: fixture.env.PATH, HOME: fixture.home, TMPDIR: fixture.tmp, CODEX_HOME: codexHome,
      npm_config_userconfig: join(root, 'user.npmrc'), npm_config_globalconfig: join(root, 'global.npmrc'),
      npm_config_cache: join(root, 'cache'), npm_config_offline: 'true',
      npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
    };
    report.environment = env;
    const command = async (label, executable, args, cwd = consumer) => {
      const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 65000, maxBuffer: 4 * 1024 * 1024 });
      const output = { executable, args, cwd, status: result.status, signal: result.signal,
        error: result.error?.message ?? null, stdout: result.stdout, stderr: result.stderr };
      await json(join(root, `${label}.json`), output);
      report.commands.push({ label, status: result.status });
      return output;
    };
    const git = args => spawnSync('/usr/bin/git', args, { cwd: source, encoding: 'utf8' }).stdout.trim();
    report.sourceIdentity = { commit: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']), status: git(['status', '--porcelain']) };
    const packed = await command('pack', process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', archiveDir], source);
    assert.equal(packed.status, 0, packed.stderr);
    const packOutput = JSON.parse(packed.stdout);
    const [metadata] = Array.isArray(packOutput) ? packOutput : Object.values(packOutput);
    report.pack = metadata;
    const archive = join(archiveDir, metadata.filename);
    report.archive = { path: archive, sha256: digest(await readFile(archive)) };
    // GNU tar otherwise spawns gzip through PATH, which intentionally contains only
    // the fake provider and Node. Decompress with Node without widening that PATH.
    assert.equal(spawnSync('gzip', ['--version'], { env }).error?.code, 'ENOENT');
    const tarArchive = join(archiveDir, 'package.tar');
    await writeFile(tarArchive, gunzipSync(await readFile(archive)));
    report.archiveInspection = { path: tarArchive, decompressor: 'node:zlib gunzipSync', gzipOnPath: false };
    const listed = await command('tar-list', '/usr/bin/tar', ['-tf', tarArchive]);
    assert.equal(listed.status, 0, listed.stderr);
    const members = listed.stdout.trim().split('\n').sort();
    report.members = members;
    // First assertion deliberately catches the accepted base's broken documentation closure.
    assert.ok(members.includes('package/ARCHITECTURE.md'), 'packed README outcome link must resolve to ARCHITECTURE.md');
    const expected = ['ARCHITECTURE.md', 'LICENSE', 'README.md', 'bin/research-ai.mjs', 'docs/compatibility.md',
      'package.json', 'src/codex.mjs', 'src/index.d.ts', 'src/index.mjs', 'src/research.mjs', 'src/grounding.mjs', 'src/perspectives.mjs', 'src/outline.mjs', 'src/mindmap.mjs', 'docs/SurfSense-LICENSE.txt', 'src/evidence-table.mjs', 'src/report.mjs', 'src/report-export.mjs', 'src/report-export.d.ts', 'src/report-export-NOTICE.txt', 'bin/research-report-export.mjs', 'docs/report-export.md', 'src/investigation.mjs', 'THIRD-PARTY-NOTICES.md'];
    expected.push('bin/research-branches.mjs', 'src/branch-comparison.mjs',
      'src/independent-branches-NOTICE.txt', 'docs/independent-branches.md');
    expected.push('bin/research-bibliography.mjs', 'docs/bibliography.md', 'src/bibliography.mjs',
      'src/bibliography-MIT-LICENSE.txt', 'src/bibliography-NOTICE.txt');
    expected.push('bin/research-table-analysis.mjs', 'docs/table-analysis.md',
      'src/table-analysis.mjs', 'src/table-analysis-worker.mjs');
    expected.push('bin/research-table-csv.mjs', 'docs/table-csv.md', 'src/table-csv.mjs');
    expected.push('bin/research-documents.mjs', 'docs/document-research.md', 'src/document-research.mjs');
    assert.deepEqual(members, expected.map(name => `package/${name}`).sort());
    report.memberEvidence = [];
    for (const name of expected) {
      const file = metadata.files.find(file => file.path === name);
      assert.ok(file, name);
      assert.equal(file.mode & 0o777, name.startsWith('bin/') ? 0o755 : 0o644, name);
      const entry = await command(`member-${name.replaceAll('/', '-')}`, '/usr/bin/tar', ['-xOf', tarArchive, `package/${name}`]);
      assert.equal(entry.status, 0);
      assert.doesNotMatch(entry.stdout, /\/Users\/|\/home\/[a-zA-Z0-9_-]+\/|[A-Z]:\\Users\\|execution\/worktrees/);
      report.memberEvidence.push({ path: name, mode: file.mode, size: file.size, sha256: digest(entry.stdout) });
    }
    const verbose = await command('tar-modes', '/usr/bin/tar', ['-tvf', tarArchive]);
    assert.equal(verbose.status, 0);
    const modeLines = verbose.stdout.trim().split('\n');
    assert.equal(modeLines.every(line => line.startsWith('-')), true, 'archive contains only regular files, no links');
    for (const member of members) {
      const line = modeLines.find(line => line.endsWith(` ${member}`));
      assert.ok(line, member);
      assert.equal(line.slice(0, 10), member.startsWith('package/bin/') ? '-rwxr-xr-x' : '-rw-r--r--', member);
    }
    const manifest = JSON.parse((await command('manifest', '/usr/bin/tar', ['-xOf', tarArchive, 'package/package.json'])).stdout);
    assert.equal(manifest.version, '0.4.0-rc.1');
    assert.equal(manifest.engines.node, '>=24.19.0 <25');
    assert.deepEqual(manifest.dependencies ?? {}, {});
    assert.deepEqual(manifest.exports['.'], { types: './src/index.d.ts', default: './src/index.mjs' });
    assert.equal(Object.keys(manifest.scripts).some(key => /install|prepare|build/.test(key)), false);
    await json(join(consumer, 'package.json'), { private: true, type: 'module' });
    const installed = await command('install', process.execPath, [npm, 'install', archive, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false']);
    assert.equal(installed.status, 0, installed.stderr);
    const packageRoot = join(consumer, 'node_modules', ...packageName.split('/'));
    assert.equal((await lstat(packageRoot)).isSymbolicLink(), false, 'installed package is an extracted artifact, not a source link');
    assert.notEqual(await realpath(packageRoot), await realpath(source));
    const bin = join(consumer, 'node_modules/.bin/research-ai');
    assert.equal(await realpath(bin), join(await realpath(packageRoot), manifest.bin['research-ai']));
    assert.equal(await realpath(join(consumer, 'node_modules/.bin/research-report-export')), join(await realpath(packageRoot), manifest.bin['research-report-export']));
    assert.equal(await realpath(join(consumer, 'node_modules/.bin/research-branches')), join(await realpath(packageRoot), manifest.bin['research-branches']));
    assert.equal(await realpath(join(consumer, 'node_modules/.bin/research-bibliography')), join(await realpath(packageRoot), manifest.bin['research-bibliography']));
    assert.equal(await realpath(join(consumer, 'node_modules/.bin/research-table-analysis')), join(await realpath(packageRoot), manifest.bin['research-table-analysis']));
    assert.equal(await realpath(join(consumer, 'node_modules/.bin/research-table-csv')), join(await realpath(packageRoot), manifest.bin['research-table-csv']));
    assert.equal(await realpath(join(consumer, 'node_modules/.bin/research-documents')), join(await realpath(packageRoot), manifest.bin['research-documents']));
    assert.ok((await stat(bin)).mode & 0o111);
    report.installed = { packageRoot, bin, binRealpath: await realpath(bin) };
    await cp(join(source, 'test/fake-codex.mjs'), join(consumer, 'fake-codex.mjs'));
    report.fakeSha256 = digest(await readFile(join(consumer, 'fake-codex.mjs')));
    for (const [from, to] of [['package-consumer.mjs.txt', 'probe.mjs'], ['package-positive.mts.txt', 'positive.mts'], ['package-negative.mts.txt', 'negative.mts'], ['package-shape.mts.txt', 'shape.mts']])
      await cp(join(source, 'test/fixtures', from), join(consumer, to));
    const probe = await command('consumer', process.execPath, ['probe.mjs']);
    assert.equal(probe.status, 0, probe.stderr);
    report.consumerResults = JSON.parse(await readFile(join(consumer, 'consumer-results.json'), 'utf8'));
    assert.equal(report.consumerResults.resolved, join(await realpath(packageRoot), 'src/index.mjs'));
    const versions = { typescript: '6.0.3', '@types/node': '24.19.0', 'undici-types': '7.24.6' };
    report.toolchain = [];
    for (const [name, version] of Object.entries(versions)) {
      const path = join(tooling, name);
      const content = await readFile(join(path, 'package.json'));
      assert.equal(JSON.parse(content).version, version);
      report.toolchain.push({ name, version, path: await realpath(path), manifestSha256: digest(content) });
      if (name !== 'typescript') await cp(path, join(consumer, 'node_modules', name), { recursive: true, dereference: true });
    }
    const config = files => ({ compilerOptions: { strict: true, noEmit: true, module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2023', types: ['node'] }, files });
    await json(join(consumer, 'tsconfig.json'), config(['positive.mts']));
    await json(join(consumer, 'tsconfig-negative.json'), config(['negative.mts']));
    const tsc = join(tooling, 'typescript/bin/tsc');
    const positive = await command('types-positive', process.execPath, [tsc, '--project', join(consumer, 'tsconfig.json'), '--noEmit']);
    assert.equal(positive.status, 0, positive.stdout + positive.stderr);
    const negative = await command('types-negative', process.execPath, [tsc, '--project', join(consumer, 'tsconfig-negative.json'), '--noEmit']);
    assert.equal(negative.status, 2);
    assert.match(negative.stdout, /error TS2741: Property 'cleanup' is missing/);
    assert.equal((negative.stdout.match(/error TS/g) ?? []).length, 1, negative.stdout);
    report.qualified = true;
  } finally {
    await json(join(root, 'report.json'), report);
    await fixture.cleanup();
    if (!keep) await rm(root, { recursive: true, force: true });
  }
});
