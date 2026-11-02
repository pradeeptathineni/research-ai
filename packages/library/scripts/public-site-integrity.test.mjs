import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { verifyPublicSiteArtifactBytes } from '../packages/corpus/src/public-site-integrity.ts';

const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');

test(
  'verified static public site matches the preview and refuses direct-build drift or extra bundles',
  async () => {
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
      const previewSha256 = digest(
        JSON.stringify(artifacts.map(({ path, sha256 }) => ({ path, sha256 }))),
      );
      assert.equal(
        (await verifyPublicSiteArtifactBytes(artifacts, previewSha256, site)).verified,
        true,
      );

      await writeFile(join(site, 'entities.json'), '[{"id":"direct legacy build"}]\n');
      await assert.rejects(
        verifyPublicSiteArtifactBytes(artifacts, previewSha256, site),
        /bytes differ from the reviewed preview/,
      );
      await writeFile(join(site, 'entities.json'), artifacts[1].bytes);
      await writeFile(join(site, 'bundles/unreviewed.json'), '{}\n');
      await assert.rejects(
        verifyPublicSiteArtifactBytes(artifacts, previewSha256, site),
        /paths differ from the reviewed preview/,
      );
      await assert.rejects(
        verifyPublicSiteArtifactBytes(
          [{ ...artifacts[0], path: '../outside.json' }],
          previewSha256,
          site,
        ),
        /Invalid or duplicate public artifact/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
