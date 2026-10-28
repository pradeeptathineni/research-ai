import { expect, it } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  realpath,
  rm,
  symlink,
  rename,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { previewProject, ignoredProjectFile } from './project-preview.js';
import {
  loadProjects,
  registerProject,
  importContextOpportunities,
  updateOpportunity,
  listOpportunities,
  associateOpportunity,
  projectAiSetup,
  disconnectProject,
  projectResearchPreview,
  updateProject,
  attachOpportunity,
  projectMatches,
  projectHistory,
} from './projects.js';
import { digest, type fetchEvidence } from './search-fetch.js';
import { searchApi } from './search-api.js';
import { loadEntities } from './search-store.js';
import { loadLibrary } from './library.js';
import { parseRequest } from '../../domain/src/search-contract.js';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-projects-')));
  const folder = join(root, 'selected');
  await mkdir(folder);
  await writeFile(
    join(folder, 'README.md'),
    '# Queue study\n\nStudy waiting time for one or two counters.\n',
  );
  return { root, folder };
}
function migration() {
  const record = (id: string, status: string) => ({
    profile: 'study',
    project: null,
    area: `Area ${id}`,
    opportunity: 'Investigate one observable scenario',
    option: 'unknown',
    why: 'No use result established',
    evidence: [] as string[],
    limitations: ['No repository or trial'],
    next_action: 'Ask a concrete question',
    status,
    checked_ref: 'unknown',
    date: '2026-10-08',
    id,
    source_id: null,
    aliases: [`old-${id}`],
    scope: 'private',
    note: 'Retained source annotation',
    origin: {
      owner: 'context-ai',
      source_commit: 'a'.repeat(40),
      source_profile: 'library/profiles/study.yaml',
      ordinal: 0,
      source_record_sha256: 'b'.repeat(64),
      identity_basis: 'Original ID',
      annotations_basis: 'Retained annotation',
    },
  });
  return {
    schema_version: 1,
    kind: 'context-opportunities-migration',
    source_owner: 'context-ai',
    destination_owner: 'signals-ai/project-opportunities',
    source_commit: 'a'.repeat(40),
    count: 2,
    source_files: [{ path: 'library/profiles/study.yaml', sha256: 'b'.repeat(64) }],
    records: [record('existing-declined', 'declined'), record('conditional-study', 'conditional')],
    authority: 'No apply',
    method: 'Frozen export',
  };
}
it('reads only bounded explicitly selected documents, withholds credentials, ignored files, symlinks and oversized documents', async () => {
  const { root, folder } = await fixture();
  try {
    await mkdir(join(folder, 'docs'));
    await writeFile(join(folder, '.gitignore'), 'docs/**\n/ARCHITECTURE.md\n');
    await writeFile(join(folder, 'docs/README.md'), 'ignored-private-canary');
    await writeFile(join(folder, 'ARCHITECTURE.md'), 'ignored-root-canary');
    await writeFile(
      join(folder, 'package.json'),
      JSON.stringify({ description: 'safe', ['api' + '_key']: 'fictional' + 'credentialcanary' }),
    );
    await writeFile(join(folder, 'Cargo.toml'), 'a'.repeat(16385));
    await writeFile(join(root, 'outside.txt'), 'outside-canary');
    await symlink(join(root, 'outside.txt'), join(folder, 'go.mod'));
    await writeFile(join(folder, '.env'), 'environment-canary');
    const preview = await previewProject(
      { kind: 'local', path: folder },
      resolve('/example/server'),
    );
    expect(preview.project.snapshot.files.map((file) => file.path)).toEqual(['README.md']);
    expect(preview.project.snapshot.basis).toBe('local-documents');
    expect(preview.project.snapshot.revision).toBeNull();
    expect(preview.project.snapshot.dirty).toBe('unknown');
    expect(preview.project.snapshot.gaps).toEqual(
      expect.arrayContaining([
        expect.stringContaining('sensitive content'),
        expect.stringContaining('symlink_withheld'),
        expect.stringContaining('oversize'),
        expect.stringContaining('ignored'),
      ]),
    );
    expect(JSON.stringify(preview.egress)).not.toContain(folder);
    for (const canary of [
      'ignored-private-canary',
      'credentialcanary',
      'outside-canary',
      'environment-canary',
    ])
      expect(JSON.stringify(preview)).not.toContain(canary);
    expect(await loadProjects(root)).toEqual({ schemaVersion: 1, projects: [], opportunities: [] });
    await expect(previewProject({ kind: 'local', path: homedir() }, root)).rejects.toThrow(
      'broad_or_ancestor',
    );
    await expect(previewProject({ kind: 'local', path: root }, folder)).rejects.toThrow(
      'broad_or_ancestor',
    );
    await expect(previewProject({ kind: 'local', path: 'relative' }, root)).rejects.toThrow(
      'explicit_absolute',
    );
    await symlink(folder, join(root, 'linked'));
    await expect(
      previewProject({ kind: 'local', path: join(root, 'linked') }, resolve('/example/server')),
    ).rejects.toThrow('symlink');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('supports ordinary ignore globs and ordered root negation; unsupported syntax withholds affected summaries with a gap', async () => {
  expect(ignoredProjectFile('README.md', '*.md\n!README.md')).toBe('allowed');
  expect(ignoredProjectFile('docs/README.md', 'docs/')).toBe('ignored');
  expect(ignoredProjectFile('docs/README.md', '**/READ?E.md')).toBe('ignored');
  expect(ignoredProjectFile('docs/README.md', '/README.md')).toBe('allowed');
  expect(ignoredProjectFile('README.md', '*.py[cod]')).toBe('allowed');
  expect(ignoredProjectFile('cache.pyc', '*.py[cod]')).toBe('ignored');
  expect(ignoredProjectFile('README.md', '[A-Z]*')).toBe('ignored');
  expect(ignoredProjectFile('README.md', '[!a-z]*')).toBe('ignored');
  expect(ignoredProjectFile('README.md', '[[:alpha:]]*')).toBe('unsupported');
  expect(ignoredProjectFile('README.md', '[z-a]*')).toBe('unsupported');
  const { root, folder } = await fixture();
  try {
    await writeFile(join(folder, '.gitignore'), '[[:alpha:]]*\n');
    const preview = await previewProject(
      { kind: 'local', path: folder },
      resolve('/example/server'),
    );
    expect(preview.project.snapshot.files).toHaveLength(0);
    expect(preview.project.snapshot.gaps.some((gap) => gap.includes('unsupported'))).toBe(true);
    await registerProject(root, preview.project);
    expect((await loadProjects(root)).projects).toHaveLength(1);
    await rm(join(folder, '.gitignore'));
    await writeFile(join(root, 'outside-ignore'), '!README.md\n');
    await symlink(join(root, 'outside-ignore'), join(folder, '.gitignore'));
    const unreadable = await previewProject({ kind: 'local', path: folder }, '/example');
    expect(unreadable.project.snapshot.files).toHaveLength(0);
    expect(
      unreadable.project.snapshot.gaps.some((gap) => gap.includes('ignore boundary unreadable')),
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('withholds a controlled ancestor swap between realpath and open without reading outside the approved folder', async () => {
  const { root, folder } = await fixture();
  try {
    await mkdir(join(folder, 'docs'));
    await writeFile(join(folder, 'docs/README.md'), 'Approved documentation');
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'README.md'), 'outside-ancestor-swap-canary');
    let swapped = false;
    const preview = await previewProject({ kind: 'local', path: folder }, '/example', undefined, {
      beforeOpen: async (path) => {
        if (path === join(folder, 'docs/README.md') && !swapped) {
          swapped = true;
          await rename(join(folder, 'docs'), join(folder, 'original-docs'));
          await symlink(outside, join(folder, 'docs'));
        }
      },
    });
    expect(swapped).toBe(true);
    expect(preview.project.snapshot.files.some((file) => file.path.startsWith('docs/'))).toBe(
      false,
    );
    expect(
      preview.project.snapshot.gaps.some((gap) => gap.includes('source_changed_during_preview')),
    ).toBe(true);
    expect(JSON.stringify(preview)).not.toContain('outside-ancestor-swap-canary');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('retains immutable original context bases through register, edit, source replacement and disconnect', async () => {
  const { root, folder } = await fixture();
  try {
    const original = await previewProject({ kind: 'local', path: folder }, '/example');
    await registerProject(root, original.project);
    await importContextOpportunities(root, migration());
    const association = await associateOpportunity(root, {
      id: 'conditional-study',
      projectId: original.project.id,
    });
    const first = await projectHistory(root, original.project.id);
    expect(first.history).toHaveLength(1);
    const originalBasis = first.history[0]!;
    expect(originalBasis.contextDigest).toBe(association.projectContextDigest);
    expect(originalBasis.project.snapshot).toEqual(original.project.snapshot);
    const historyPath = join(
      root,
      '.signals/project-history',
      original.project.id,
      originalBasis.contextDigest + '.json',
    );
    const originalBytes = await readFile(historyPath, 'utf8');
    await updateProject(root, {
      id: original.project.id,
      name: 'Renamed',
      purpose: 'Compare two counters',
      constraints: ['No installation'],
    });
    expect((await projectHistory(root, original.project.id)).history).toHaveLength(2);
    await writeFile(join(folder, 'README.md'), '# New study\n\nObserve queue cancellation.\n');
    const replacement = await previewProject({ kind: 'local', path: folder }, '/example');
    await registerProject(root, replacement.project);
    expect((await projectHistory(root, original.project.id)).history).toHaveLength(3);
    await disconnectProject(root, original.project.id);
    const history = await projectHistory(root, original.project.id);
    expect(history.history).toHaveLength(3);
    expect(
      history.history.find((entry) => entry.contextDigest === association.projectContextDigest)!
        .project.snapshot,
    ).toEqual(original.project.snapshot);
    expect(await readFile(historyPath, 'utf8')).toBe(originalBytes);
    expect(
      (await listOpportunities(root)).find((item) => item.id === association.id)!.needsReview,
    ).toBe(true);
    expect((await loadProjects(root)).projects[0]!.snapshot.files).toEqual([]);
    expect(await readFile(join(folder, 'README.md'), 'utf8')).toContain('Observe queue');
    expect(history.limit).toBe(64);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('refuses a new context basis at the append-only history limit while preserving the active project and original basis', async () => {
  const { root, folder } = await fixture();
  try {
    const preview = await previewProject({ kind: 'local', path: folder }, '/example');
    await registerProject(root, preview.project);
    for (let index = 1; index < 64; index++)
      await updateProject(root, {
        id: preview.project.id,
        name: 'Study',
        purpose: `Question ${index}`,
        constraints: [],
      });
    const before = await readFile(join(root, '.signals/projects.json'), 'utf8');
    await expect(
      updateProject(root, {
        id: preview.project.id,
        name: 'Study',
        purpose: 'Question beyond retention limit',
        constraints: [],
      }),
    ).rejects.toThrow('project_history_limit_reached');
    expect(await readFile(join(root, '.signals/projects.json'), 'utf8')).toBe(before);
    const history = await projectHistory(root, preview.project.id);
    expect(history.history).toHaveLength(64);
    expect(
      history.history.some(
        (entry) =>
          entry.project.snapshot.digest === preview.project.snapshot.digest &&
          entry.project.purpose === preview.project.purpose,
      ),
    ).toBe(true);
    await disconnectProject(root, preview.project.id);
    expect((await projectHistory(root, preview.project.id)).history).toHaveLength(64);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('pins GitHub documents to resolved identity/revision without executing manifests or trusting symlink content', async () => {
  const calls: string[] = [];
  const revision = 'c'.repeat(40);
  const fake: typeof fetchEvidence = async (uri) => {
    calls.push(uri);
    let value: unknown;
    if (uri.endsWith('/owner/project'))
      value = { full_name: 'owner/project', default_branch: 'main' };
    else if (uri.includes('/commits/')) value = { sha: revision };
    else {
      const path = uri.split('/contents/')[1]!.split('?')[0]!;
      if (path === '.gitignore') {
        const content = '*.py[cod]\n';
        value = {
          type: 'file',
          path,
          size: Buffer.byteLength(content),
          encoding: 'base64',
          content: Buffer.from(content).toString('base64'),
        };
      } else if (path === 'README.md') {
        const content = '# Public study';
        value = {
          type: 'file',
          path,
          size: Buffer.byteLength(content),
          encoding: 'base64',
          content: Buffer.from(content).toString('base64'),
        };
      } else if (path === 'go.mod') value = { type: 'symlink', path };
      else throw new Error('source_http_404');
    }
    return {
      uri,
      text: JSON.stringify(value),
      digest: digest(JSON.stringify(value)),
      response: { status: 200 },
      normalizer: 'text-v2',
    };
  };
  const preview = await previewProject(
    { kind: 'github', uri: 'https://github.com/owner/project' },
    '/example',
    fake,
  );
  expect(preview.project.snapshot.revision).toBe(revision);
  expect(preview.project.snapshot.files).toHaveLength(1);
  expect(
    calls
      .filter((uri) => uri.includes('/contents/'))
      .every((uri) => uri.endsWith(`?ref=${revision}`)),
  ).toBe(true);
  expect(calls).toHaveLength(12);
  await expect(
    previewProject(
      { kind: 'github', uri: 'https://github.com/owner/project/tree/main' },
      '/example',
      fake,
    ),
  ).rejects.toThrow('github_repository_url');
});
it('imports original IDs/status/provenance without fabricating evidence, remains idempotent after annotation, and rejects conflicting identities atomically', async () => {
  const { root, folder } = await fixture();
  try {
    const artifact = migration();
    expect((await importContextOpportunities(root, artifact)).imported).toBe(2);
    await updateOpportunity(root, {
      id: 'conditional-study',
      status: 'saved',
      note: 'A later private note',
    });
    expect((await importContextOpportunities(root, artifact)).unchanged).toBe(2);
    const [declined, conditional] = await listOpportunities(root);
    expect(declined!.status).toBe('declined');
    expect(conditional!.status).toBe('saved');
    expect(conditional!.note).toBe('A later private note');
    expect(conditional!.importedSource).toEqual(artifact.records[1]);
    expect(conditional!.evidenceRefs).toEqual([]);
    const before = await readFile(join(root, '.signals/projects.json'), 'utf8');
    const changed = structuredClone(artifact);
    changed.records[1]!.why = 'changed claim';
    await expect(importContextOpportunities(root, changed)).rejects.toThrow(
      'migration_identity_conflict',
    );
    expect(await readFile(join(root, '.signals/projects.json'), 'utf8')).toBe(before);
    const bad = structuredClone(artifact);
    bad.count = 3;
    await expect(importContextOpportunities(root, bad)).rejects.toThrow(
      'invalid_migration_identity',
    );
    const ambiguous = structuredClone(artifact);
    ambiguous.records[1]!.aliases.push(ambiguous.records[0]!.id);
    await expect(importContextOpportunities(root, ambiguous)).rejects.toThrow(
      'migration_alias_conflict',
    );
    const preview = await previewProject({ kind: 'local', path: folder }, '/example');
    await registerProject(root, preview.project);
    await associateOpportunity(root, { id: 'conditional-study', projectId: preview.project.id });
    const setup = await projectAiSetup(root, {
      projectId: preview.project.id,
      opportunityId: 'conditional-study',
      need: 'Choose instruction resources',
      targetProfile: 'study',
    });
    expect(setup.authority).toBe('plan-only');
    expect(JSON.stringify(setup)).not.toContain(folder);
    expect(Object.keys(setup.context_request).sort()).toEqual(
      [
        'schema_version',
        'request_id',
        'method',
        'profile_id',
        'project_ref',
        'constraints',
        'findings',
      ].sort(),
    );
    expect(setup.context_request.project_ref).toEqual({
      id: preview.project.id,
      source_ref: `interest:${preview.project.id}`,
    });
    expect(setup.context_request.method).toBe('plan');
    expect(setup.context_request.findings[0]!.evidence_refs).toEqual([]);
    await expect(
      projectAiSetup(root, {
        projectId: preview.project.id,
        opportunityId: 'conditional-study',
        need: 'Choose resources',
        targetProfile: '../outside',
      }),
    ).rejects.toThrow('invalid_project_request');
    await associateOpportunity(root, { id: 'existing-declined', projectId: preview.project.id });
    await expect(
      projectAiSetup(root, {
        projectId: preview.project.id,
        opportunityId: 'existing-declined',
        need: 'Anything',
        targetProfile: 'study',
      }),
    ).rejects.toThrow('declined');
    await updateProject(root, {
      id: preview.project.id,
      name: 'Revised',
      purpose: 'Changed purpose',
      constraints: [],
    });
    expect((await listOpportunities(root)).every((item) => item.needsReview)).toBe(true);
    await expect(
      projectAiSetup(root, {
        projectId: preview.project.id,
        opportunityId: 'conditional-study',
        need: 'Anything',
        targetProfile: 'study',
      }),
    ).rejects.toThrow('stale');
    await disconnectProject(root, preview.project.id);
    expect((await loadProjects(root)).projects[0]!.snapshot.files).toEqual([]);
    expect(await readFile(join(folder, 'README.md'), 'utf8')).toContain('Queue study');
    expect(await listOpportunities(root)).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('matches actual retained corpus and stores explicit associations only; bounds the exact research payload and rejects unknown finding authority', async () => {
  const { root, folder } = await fixture();
  try {
    const [record] = await loadEntities(resolve('signals/entities'));
    if (!record) throw new Error('missing_native_fixture');
    await mkdir(join(root, 'signals/entities'), { recursive: true });
    await writeFile(
      join(root, 'signals/entities', record.entity.id + '.json'),
      JSON.stringify(record),
    );
    const preview = await previewProject({ kind: 'local', path: folder }, '/example');
    preview.project.purpose = record.entity.name;
    await registerProject(root, preview.project);
    const matches = await projectMatches(root, preview.project.id);
    const library = await loadLibrary(root);
    expect(matches.matches[0]!.findingKey).toBe(library[0]!.key);
    expect((await loadProjects(root)).opportunities).toHaveLength(0);
    await expect(
      attachOpportunity(root, {
        projectId: preview.project.id,
        findingKey: 'invented',
        need: 'Need',
        reason: 'Reason',
        nextAction: 'explore',
      }),
    ).rejects.toThrow('unknown_library');
    const item = await attachOpportunity(root, {
      projectId: preview.project.id,
      findingKey: library[0]!.key,
      need: 'Learn',
      reason: 'Explicitly selected',
      nextAction: 'learn',
    });
    expect(item.findingKey).toBe(library[0]!.key);
    const research = await projectResearchPreview(root, {
      id: preview.project.id,
      question: 'What next?',
    });
    expect(research.request.query).toBe('What next?');
    expect(research.request.context.length).toBeLessThanOrEqual(4000);
    expect(parseRequest(research.request).profile).toBe('quick');
    expect(JSON.stringify(research.request)).not.toContain(folder);
    expect(research.automatic).toBe(false);
    await symlink(join(root, '.signals/projects.json'), join(root, 'outside-registry'));
    await rm(join(root, '.signals/projects.json'));
    await symlink(join(root, 'outside-registry'), join(root, '.signals/projects.json'));
    await expect(loadProjects(root)).rejects.toThrow('unsafe_private_state');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('exports migrated colon identities through the exact bounded Context contract while preserving originals and denying nonportable prose', async () => {
  const { root, folder } = await fixture();
  try {
    const artifact = migration();
    const originalId = 'context-opportunity:labs:f7284b54996228a9';
    artifact.records[1]!.id = originalId;
    artifact.records[1]!.evidence = [
      ...Array.from({ length: 20 }, (_, index) => `https://example.com/evidence/${index}`),
      '/private/local-document',
      'C:\\private\\document',
      'file:private-document',
      'r'.repeat(1025),
    ];
    await importContextOpportunities(root, artifact);
    const preview = await previewProject({ kind: 'local', path: folder }, '/example');
    preview.project.constraints = [
      'Preserve project instructions',
      'Plan only; no installation or trial',
      'Keep evidence and rollback history',
    ];
    await registerProject(root, preview.project);
    await associateOpportunity(root, { id: originalId, projectId: preview.project.id });
    const input = {
      projectId: preview.project.id,
      opportunityId: originalId,
      need: 'Preview approved AI guidance',
      targetProfile: 'labs',
    };
    const first = await projectAiSetup(root, input);
    const second = await projectAiSetup(root, input);
    const exportedId = first.context_request.findings[0]!.id;
    expect(exportedId).toBe(originalId);
    expect(second.context_request.findings[0]!.id).toBe(exportedId);
    expect(first.opportunity.id).toBe(originalId);
    expect(first.context_request.constraints).toEqual(preview.project.constraints);
    expect(first.context_request.findings[0]!.evidence_refs).toHaveLength(16);
    expect(first.omitted_evidence_ref_count).toBe(8);
    expect(JSON.stringify(first.context_request)).not.toContain('/private/local-document');
    expect(
      Buffer.byteLength(JSON.stringify(first.context_request, null, 2) + '\n'),
    ).toBeLessThanOrEqual(32768);
    const before = await readFile(join(root, '.signals/projects.json'), 'utf8');
    for (const need of [
      'Read /private/document',
      'Read ~/document',
      'Read C:\\private\\document',
      'Read file:document',
      'Line one\nLine two',
      'x'.repeat(513),
      '\ud800',
    ]) {
      await expect(projectAiSetup(root, { ...input, need })).rejects.toThrow();
    }
    await expect(projectAiSetup(root, { ...input, targetProfile: 'a'.repeat(65) })).rejects.toThrow(
      'invalid_project_request',
    );
    expect(await readFile(join(root, '.signals/projects.json'), 'utf8')).toBe(before);
    await updateProject(root, {
      id: preview.project.id,
      name: preview.project.name,
      purpose: preview.project.purpose,
      constraints: Array.from({ length: 17 }, (_, index) => `Requirement ${index}`),
    });
    await expect(projectAiSetup(root, input)).rejects.toThrow('context_constraints_limit');
    await updateProject(root, {
      id: preview.project.id,
      name: preview.project.name,
      purpose: preview.project.purpose,
      constraints: ['Read /private/document'],
    });
    await expect(projectAiSetup(root, input)).rejects.toThrow('context_constraint_not_portable');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('keeps local folder previews behind loopback and token guards and registers only server-held previews without invoking research', async () => {
  const { root, folder } = await fixture();
  const api = searchApi(root, async () => {
    throw new Error('research_must_not_run');
  });
  const server = createServer((request, response) => {
    void api(request, response);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no_port');
  const base = `http://127.0.0.1:${address.port}/signals-ai/__signals/api/`;
  try {
    const { token } = (await (await fetch(base + 'session')).json()) as { token: string };
    const post = (route: string, value: unknown, authorized = true) =>
      fetch(base + route, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authorized ? { 'x-signals-token': token } : {}),
        },
        body: JSON.stringify(value),
      });
    expect(
      (await post('projects/preview', { source: { kind: 'local', path: folder } }, false)).status,
    ).toBe(403);
    expect(
      (
        await post('projects/register', {
          previewId: '11111111-1111-4111-8111-111111111111',
          name: 'X',
          purpose: 'Y',
          constraints: [],
        })
      ).status,
    ).toBe(400);
    const preview = (await (
      await post('projects/preview', { source: { kind: 'local', path: folder } })
    ).json()) as { id: string };
    expect((await loadProjects(root)).projects).toHaveLength(0);
    const response = await post('projects/register', {
      previewId: preview.id,
      name: 'Study',
      purpose: 'Observe waiting time',
      constraints: ['No execution'],
    });
    expect(response.status).toBe(200);
    expect(
      ((await (await fetch(base + 'projects')).json()) as { projects: unknown[] }).projects,
    ).toHaveLength(1);
    expect(
      (
        await post('projects/register', {
          previewId: preview.id,
          name: 'Study',
          purpose: 'Observe waiting time',
          constraints: [],
        })
      ).status,
    ).toBe(400);
  } finally {
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    await rm(root, { recursive: true, force: true });
  }
});
