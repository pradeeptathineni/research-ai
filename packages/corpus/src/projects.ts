import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readdir, writeFile, lstat, realpath } from 'node:fs/promises';
import { type Static } from 'typebox';
import { searchLibrary } from '../../domain/src/library-search.js';
import { loadLibrary } from './library.js';
import { readPrivateJson, atomicJson, withWriter, secureDirectory } from './search-store.js';
import { digest } from './search-fetch.js';
import {
  checked,
  projectStateSchema,
  projectIdSchema,
  projectHistorySchema,
  migrationSchema,
  attachSchema,
  updateOpportunitySchema,
  updateProjectSchema,
  setupRequestSchema,
  researchPreviewSchema,
  associateOpportunitySchema,
  type Project,
  type ProjectState,
  type Opportunity,
} from './project-contract.js';

export async function loadProjects(root: string): Promise<ProjectState> {
  return checked<ProjectState>(
    projectStateSchema,
    await readPrivateJson(
      root,
      'projects.json',
      { schemaVersion: 1, projects: [], opportunities: [] },
      8000000,
    ),
  );
}
async function change<T>(
  root: string,
  operation: (state: ProjectState) => Promise<T> | T,
): Promise<T> {
  return withWriter(root, async () => {
    const state = await loadProjects(root);
    const previous = structuredClone(state.projects);
    const result = await operation(state);
    checked(projectStateSchema, state);
    for (const project of previous) await retainProjectContext(root, project);
    for (const project of state.projects)
      if (project.connected) await retainProjectContext(root, project);
    await atomicJson(resolve(root, '.signals/projects.json'), state);
    return result;
  });
}
function projectIn(state: ProjectState, id: string, connected = true): Project {
  const project = state.projects.find((entry) => entry.id === id);
  if (!project || (connected && !project.connected))
    throw new Error('unknown_or_disconnected_project');
  return project;
}
export const projectContextFingerprint = (project: Project) =>
  digest(
    JSON.stringify({
      source: project.snapshot.digest,
      purpose: project.purpose,
      constraints: project.constraints,
    }),
  );
const contextDigest = projectContextFingerprint;
const historyLimit = 64;
async function historyNames(root: string, id: string) {
  checked(projectIdSchema, { id });
  const directory = resolve(root, '.signals/project-history', id);
  const stat = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return [];
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(directory)) !== directory)
    throw new Error('unsafe_project_history');
  const names = await readdir(directory);
  if (names.length > historyLimit || names.some((name) => !/^[a-f0-9]{64}\.json$/.test(name)))
    throw new Error('invalid_project_history');
  return names;
}
async function retainProjectContext(root: string, project: Project) {
  // Disconnected records have intentionally discarded the active index. Their complete basis was retained before disconnect.
  if (!project.connected) return;
  const key = contextDigest(project);
  const names = await historyNames(root, project.id);
  const name = `${key}.json`;
  if (names.includes(name)) {
    const existing = checked<Static<typeof projectHistorySchema>>(
      projectHistorySchema,
      await readPrivateJson(root, `project-history/${project.id}/${name}`, null),
    );
    if (
      existing.contextDigest !== key ||
      existing.project.id !== project.id ||
      contextDigest(existing.project) !== key
    )
      throw new Error('project_history_integrity');
    return;
  }
  if (names.length >= historyLimit) throw new Error('project_history_limit_reached');
  const directory = resolve(root, '.signals/project-history', project.id);
  await secureDirectory(directory);
  const entry = {
    schemaVersion: 1,
    contextDigest: key,
    retainedAt: new Date().toISOString(),
    project,
  };
  checked(projectHistorySchema, entry);
  await writeFile(resolve(directory, name), JSON.stringify(entry, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
}
export async function projectHistory(root: string, id: string) {
  projectIn(await loadProjects(root), id, false);
  const entries = await Promise.all(
    (await historyNames(root, id)).map(async (name) => {
      const entry = checked<Static<typeof projectHistorySchema>>(
        projectHistorySchema,
        await readPrivateJson(root, `project-history/${id}/${name}`, null),
      );
      if (
        `${entry.contextDigest}.json` !== name ||
        contextDigest(entry.project) !== entry.contextDigest ||
        entry.project.id !== id
      )
        throw new Error('project_history_integrity');
      return entry;
    }),
  );
  return {
    projectId: id,
    limit: historyLimit,
    history: entries.sort((a, b) => a.retainedAt.localeCompare(b.retainedAt)),
  };
}
export async function registerProject(root: string, project: Project): Promise<Project> {
  return change(root, (state) => {
    const previous = state.projects.findIndex((entry) => entry.id === project.id);
    if (previous < 0) state.projects.push(project);
    else state.projects[previous] = project;
    // Existing status and notes survive changed material. Consumers can see needsReview.
    return project;
  });
}
export async function updateProject(root: string, input: unknown) {
  const request = checked<Static<typeof updateProjectSchema>>(updateProjectSchema, input);
  return change(root, (state) =>
    Object.assign(projectIn(state, request.id), {
      name: request.name,
      purpose: request.purpose,
      constraints: request.constraints,
    }),
  );
}
export async function disconnectProject(root: string, id: string) {
  return change(root, (state) => {
    const project = projectIn(state, id, false);
    project.connected = false;
    project.snapshot.files = [];
    return project;
  });
}
export async function listOpportunities(root: string) {
  const state = await loadProjects(root);
  return state.opportunities.map((item) => {
    const project = state.projects.find((entry) => entry.id === item.projectId);
    return {
      ...item,
      needsReview:
        !!item.projectId &&
        (!project?.connected ||
          project.snapshot.digest !== item.projectSnapshotDigest ||
          contextDigest(project) !== item.projectContextDigest),
    };
  });
}
export async function attachOpportunity(root: string, input: unknown) {
  const request = checked<Static<typeof attachSchema>>(attachSchema, input);
  const finding = (await loadLibrary(root)).find((entry) => entry.key === request.findingKey);
  if (!finding) throw new Error('unknown_library_identity');
  return change(root, (state) => {
    const project = projectIn(state, request.projectId);
    const id = `opportunity-${digest(`${project.id}\n${finding.key}\n${request.need}`).slice(0, 24)}`;
    const previous = state.opportunities.find((entry) => entry.id === id);
    if (previous) return previous;
    const opportunity: Opportunity = {
      id,
      title: finding.title,
      need: request.need,
      reason: request.reason,
      nextAction: request.nextAction,
      status: 'open',
      note: '',
      scope: 'private',
      findingKey: finding.key,
      projectId: project.id,
      projectSnapshotDigest: project.snapshot.digest,
      projectContextDigest: contextDigest(project),
      provenance: {
        owner: 'signals',
        method: 'manual',
        sourceId: finding.key,
        sourceRevision: project.snapshot.revision ?? project.snapshot.digest,
        sourceDigest: digest(JSON.stringify(request)),
        importedAt: new Date().toISOString(),
      },
    };
    state.opportunities.push(opportunity);
    return opportunity;
  });
}
export async function associateOpportunity(root: string, input: unknown) {
  const request = checked<Static<typeof associateOpportunitySchema>>(
    associateOpportunitySchema,
    input,
  );
  return change(root, (state) => {
    const project = projectIn(state, request.projectId);
    const item = state.opportunities.find((entry) => entry.id === request.id);
    if (!item) throw new Error('unknown_opportunity');
    item.projectId = project.id;
    item.projectSnapshotDigest = project.snapshot.digest;
    item.projectContextDigest = contextDigest(project);
    return item;
  });
}
export async function updateOpportunity(root: string, input: unknown) {
  const request = checked<Static<typeof updateOpportunitySchema>>(updateOpportunitySchema, input);
  return change(root, (state) => {
    const item = state.opportunities.find((entry) => entry.id === request.id);
    if (!item) throw new Error('unknown_opportunity');
    item.status = request.status;
    item.note = request.note;
    return item;
  });
}
/** The imported observation is retained unchanged; personal status is a separate annotation. */
export async function importContextOpportunities(root: string, input: unknown) {
  const artifact = checked<Static<typeof migrationSchema>>(migrationSchema, input);
  if (
    artifact.count !== artifact.records.length ||
    new Set(artifact.records.map((record) => record.id)).size !== artifact.count
  )
    throw new Error('invalid_migration_identity_or_count');
  const identities = new Set<string>();
  for (const record of artifact.records) {
    for (const identity of new Set([record.id, ...record.aliases])) {
      if (identities.has(identity)) throw new Error('migration_alias_conflict');
      identities.add(identity);
    }
  }
  for (const record of artifact.records)
    if (record.origin.source_commit !== artifact.source_commit)
      throw new Error('migration_revision_mismatch');
  return change(root, (state) => {
    let imported = 0;
    for (const record of artifact.records) {
      const sourceDigest = digest(JSON.stringify(record));
      const previous = state.opportunities.find((entry) =>
        [entry.id, ...(entry.aliases ?? [])].some(
          (identity) => identity === record.id || record.aliases.includes(identity),
        ),
      );
      if (previous) {
        if (
          previous.id !== record.id ||
          previous.provenance.owner !== 'context-ai' ||
          previous.provenance.sourceDigest !== sourceDigest
        )
          throw new Error('migration_identity_conflict');
        continue;
      }
      state.opportunities.push({
        id: record.id,
        title: record.area,
        need: record.opportunity,
        reason: record.why,
        nextAction: 'explore',
        status:
          record.status === 'declined'
            ? 'declined'
            : record.status === 'done'
              ? 'done'
              : record.status === 'saved'
                ? 'saved'
                : 'open',
        note: record.note ?? '',
        scope: record.scope,
        aliases: record.aliases,
        ...(record.project ? { projectRef: record.project } : {}),
        evidenceRefs: record.evidence.map((uri) => ({ uri })),
        importedSource: record,
        provenance: {
          owner: 'context-ai',
          method: 'migrated',
          sourceId: record.source_id ?? record.id,
          sourceRevision: artifact.source_commit,
          sourceDigest,
          importedAt: new Date().toISOString(),
        },
      });
      imported++;
    }
    return {
      imported,
      unchanged: artifact.count - imported,
      count: artifact.count,
      sourceRevision: artifact.source_commit,
      sourceDigest: digest(JSON.stringify(artifact)),
      mappings: artifact.records.map((record) => ({ sourceId: record.id, id: record.id })),
    };
  });
}
export async function projectMatches(root: string, id: string) {
  const project = projectIn(await loadProjects(root), id);
  // Constraints govern review/research; generic constraint prose is not a retrieval need.
  const query = project.purpose;
  const hits = searchLibrary(await loadLibrary(root), query).slice(0, 10);
  return {
    projectId: id,
    query,
    matches: hits.map((hit) => ({
      findingKey: hit.finding.key,
      need: project.purpose,
      reason:
        'Literal terms in the project brief match retained corpus metadata. Suitability has not been assessed.',
      nextAction: 'explore',
      method: 'lexical',
      score: hit.retrievalScore,
      matchedTerms: hit.matchedTerms,
      matchedFields: hit.matchedFields,
    })),
  };
}
export async function projectResearchPreview(root: string, input: unknown) {
  const request = checked<Static<typeof researchPreviewSchema>>(researchPreviewSchema, input);
  const project = projectIn(await loadProjects(root), request.id);
  const payload = {
    projectId: project.id,
    name: project.name,
    purpose: project.purpose,
    constraints: project.constraints,
    snapshotDigest: project.snapshot.digest,
    files: [] as Project['snapshot']['files'],
    omittedFileCount: project.snapshot.files.length,
  };
  if (JSON.stringify(payload).length > 4000)
    throw new Error('project_brief_exceeds_research_context_limit');
  for (const file of project.snapshot.files) {
    const next = {
      ...payload,
      files: [...payload.files, file],
      omittedFileCount: payload.omittedFileCount - 1,
    };
    if (JSON.stringify(next).length <= 4000) {
      payload.files = next.files;
      payload.omittedFileCount--;
    }
  }
  const context = JSON.stringify(payload);
  return {
    projectId: project.id,
    question: request.question,
    context,
    automatic: false,
    request: { query: request.question, context, save: 'never', profile: 'quick' },
    warning:
      'Confirm this exact context before starting research. Research may use public search and your configured authenticated model.',
  };
}
// Matches the frozen Context handoff prose boundary, including its URL exception.
function portableText(value: string, limit = 512) {
  if (
    !value ||
    [...value].length > limit ||
    [...value].some((char) => {
      const code = char.codePointAt(0)!;
      return code < 32 || (code >= 0xd800 && code <= 0xdfff);
    })
  )
    return false;
  const withoutUrls = value.replace(/https:\/\/[^\s]+/g, '');
  return !/(?<![A-Za-z0-9_.-])\/(?!\/)|~[/\\]|[A-Za-z]:[/\\]|file:/.test(withoutUrls);
}
export async function projectAiSetup(root: string, input: unknown) {
  const request = checked<Static<typeof setupRequestSchema>>(setupRequestSchema, input);
  if (!portableText(request.need)) throw new Error('context_outcome_not_portable');
  const state = await loadProjects(root);
  const project = projectIn(state, request.projectId);
  if (project.constraints.length > 16) throw new Error('context_constraints_limit');
  if (project.constraints.some((constraint) => !portableText(constraint)))
    throw new Error('context_constraint_not_portable');
  const opportunity = state.opportunities.find((item) => item.id === request.opportunityId);
  if (!opportunity || opportunity.projectId !== project.id)
    throw new Error('opportunity_project_mismatch');
  if (opportunity.status === 'declined') throw new Error('declined_opportunity');
  if (
    opportunity.projectSnapshotDigest !== project.snapshot.digest ||
    opportunity.projectContextDigest !== contextDigest(project)
  )
    throw new Error('stale_project_opportunity');
  const finding = opportunity.findingKey
    ? (await loadLibrary(root)).find((entry) => entry.key === opportunity.findingKey)
    : undefined;
  if (opportunity.findingKey && !finding) throw new Error('unknown_library_identity');
  const evidenceRefs =
    opportunity.evidenceRefs?.map((entry) => entry.uri) ??
    finding?.native?.evidence.map((entry) => entry.uri) ??
    (finding ? [finding.uri] : []);
  const requestId = randomUUID();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/.test(opportunity.id))
    throw new Error('context_finding_identity_not_portable');
  const portableRefs = [...new Set(evidenceRefs)]
    .filter((ref) => portableText(ref, 1024))
    .slice(0, 16);
  const contextRequest = {
    schema_version: 1,
    request_id: requestId,
    method: 'plan',
    profile_id: request.targetProfile,
    project_ref: {
      id: project.id,
      source_ref: project.source.kind === 'github' ? project.source.uri : `interest:${project.id}`,
    },
    constraints: project.constraints,
    findings: [
      {
        id: opportunity.id,
        outcome: request.need,
        evidence_refs: portableRefs,
      },
    ],
  };
  if (Buffer.byteLength(JSON.stringify(contextRequest, null, 2) + '\n') > 32768)
    throw new Error('context_request_too_large');
  return {
    schema_version: 1,
    kind: 'context-project-ai-setup-request',
    request_id: requestId,
    authority: 'plan-only',
    owner: 'context-ai',
    need: request.need,
    target_profile: request.targetProfile,
    context_request: contextRequest,
    omitted_evidence_ref_count: [...new Set(evidenceRefs)].length - portableRefs.length,
    project: {
      id: project.id,
      name: project.name,
      purpose: project.purpose,
      constraints: project.constraints,
      snapshot_digest: project.snapshot.digest,
      source:
        project.source.kind === 'github'
          ? { kind: 'github', uri: project.source.uri, revision: project.snapshot.revision }
          : { kind: 'local-documents' },
    },
    opportunity: {
      id: opportunity.id,
      finding_key: opportunity.findingKey ?? null,
      reason: opportunity.reason,
    },
    boundary:
      'Portable request only. Context selects equipment and previews permissions, pins, conflicts and rollback. No installation or file-writing authority.',
  };
}
