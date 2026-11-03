import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { verifyPublicSiteArtifactBytes } from '../packages/corpus/src/public-site-integrity.ts';

const digest = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

test('verified static public site matches the preview and refuses direct-build drift or extra bundles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'signals-reviewed-site-'));
  try {
    const artifacts = [
      ['corpus.json', '[{"id":"synthetic"}]\n'],
      ['entities.json', '[]\n'],
      ['library.json', '[]\n'],
      ['bundles/synthetic.json', '{"bundle_id":"synthetic"}\n'],
      ['bundles/synthetic.json.sha256', `${digest('{"bundle_id":"synthetic"}\n')}\n`],
    ].map(([path, bytes]) => ({
      path,
      bytes,
      sha256: digest(bytes),
      byteLength: Buffer.byteLength(bytes),
    }));
    const site = join(root, 'site');
    const copyPreviewBytes = async (target, values) => {
      for (const artifact of values) {
        const path = join(target, artifact.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, artifact.bytes);
      }
    };
    await mkdir(site);
    await copyPreviewBytes(site, artifacts);
    await writeFile(
      join(site, 'index.html'),
      '<!doctype html><script src="/assets/index-abc12345.js"></script>',
    );
    await mkdir(join(site, 'assets'));
    await writeFile(join(site, 'assets/index-abc12345.js'), 'synthetic app shell');
    await writeFile(join(site, 'assets/index-abc12345.css'), 'synthetic styles');
    const verify = () => verifyPublicSiteArtifactBytes(artifacts, site);
    assert.equal((await verify()).verified, true);

    await writeFile(join(site, 'private-notes.txt'), 'must not publish');
    await assert.rejects(verify(), /unreviewed file: private-notes\.txt/);
    await rm(join(site, 'private-notes.txt'));

    await mkdir(join(site, 'data'));
    await writeFile(join(site, 'data/x.json'), '{}\n');
    await assert.rejects(verify(), /unreviewed directory: data/);
    await rm(join(site, 'data'), { recursive: true });

    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'outside target');
    await symlink(outside, join(site, 'outside-link.txt'));
    await assert.rejects(verify(), /contains a symlink: outside-link\.txt/);
    await rm(join(site, 'outside-link.txt'));

    await writeFile(join(site, 'entities.json'), '[{"id":"direct legacy build"}]\n');
    await assert.rejects(verify(), /bytes differ from the reviewed preview/);
    await writeFile(join(site, 'entities.json'), artifacts[1].bytes);
    await writeFile(join(site, 'bundles/unreviewed.json'), '{}\n');
    await assert.rejects(verify(), /unreviewed file: bundles\/unreviewed\.json/);
    await rm(join(site, 'bundles/unreviewed.json'));
    await assert.rejects(
      verifyPublicSiteArtifactBytes([{ ...artifacts[0], path: '../outside.json' }], site),
      /Invalid or duplicate public artifact/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
