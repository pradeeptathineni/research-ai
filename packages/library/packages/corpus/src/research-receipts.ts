import { readdir, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { SearchResult } from '../../domain/src/search-contract.js';
import { budgets } from '../../domain/src/search-contract.js';
import type { LibraryFinding } from '../../domain/src/library-search.js';
import { readPrivateJson, loadRun } from './search-store.js';
import { planResearchRetention, type ResearchAnswer } from './research-answer.js';

async function entries(root: string, store: 'queries' | 'runs') {
  const directory = resolve(root, '.signals', store);
  const stat = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!stat) return [];
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(directory)) !== directory)
    throw new Error('unsafe_answer_store');
  return (await readdir(directory)).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name));
}

/** Read legacy answer imports in place; no migration, rewriting or evidence promotion. */
export async function importedAnswers(root: string): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  for (const name of await entries(root, 'queries')) {
    const record = (await readPrivateJson(root, `queries/${name}`, null)) as {
      recordVersion?: number;
      savedAt?: string;
      result?: { input?: ResearchAnswer; answerSha256?: string; runId?: string };
    } | null;
    if (!record?.result?.input?.answer) continue; // Other query record formats keep their owners.
    const { input, runId } = record.result;
    if (
      record.recordVersion !== 1 ||
      !runId ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(runId)
    )
      throw new Error('invalid_answer_receipt');
    const plan = planResearchRetention(input);
    if (record.result.answerSha256 !== plan.answerSha256) throw new Error('answer_digest_mismatch');
    results.push({
      schemaVersion: 2,
      runId,
      query: input.query,
      status: 'completed',
      brief: { format: 'markdown', text: input.answer },
      ...(input.grounding ? { grounding: input.grounding } : {}),
      answerReceipt: {
        observedAt: input.observedAt,
        sha256: plan.answerSha256,
        state: 'unassessed',
        confidence: 'unknown',
        provenance: input.provenance,
      },
      provisionalLeads: plan.citations.slice(0, 60).map((citation) => ({
        uri: citation.uri,
        name: citation.label,
        description: citation.context,
        limits: plan.limits,
      })),
      items: [],
      sources: [],
      coverage: [],
      gaps: plan.limits,
      counts: {
        leads: plan.citations.length,
        distinct: 0,
        duplicates: 0,
        omitted: Math.max(0, plan.citations.length - 60),
      },
      usage: {
        searches: 0,
        documents: 0,
        modelCalls: 0,
        elapsedMs: 0,
        cost: null,
        providerUsage: null,
      },
      limits: budgets.wide,
    });
  }
  return results;
}

export async function loadAnswerLibrary(
  root: string,
  coverage: string[] = [],
): Promise<LibraryFinding[]> {
  const imported = await importedAnswers(root).catch((error: unknown) => {
    if (
      error instanceof Error &&
      /^(?:unsafe_|symlink_|invalid_private_state_path)/.test(error.message)
    )
      throw error;
    coverage.push('Imported answer store could not be fully validated; its records are excluded.');
    return [];
  });
  const runs: SearchResult[] = [];
  for (const name of await entries(root, 'runs')) {
    try {
      const raw = (await readPrivateJson(root, `runs/${name}`, null)) as SearchResult | null;
      if (raw?.answerReceipt) {
        if (!['completed', 'partial', 'failed', 'cancelled', 'not_configured'].includes(raw.status))
          throw new Error('unsupported_retained_status');
        runs.push(await loadRun(name.slice(0, -5), root));
      }
    } catch (error) {
      if (
        error instanceof Error &&
        /^(?:unsafe_|symlink_|invalid_private_state_path)/.test(error.message)
      )
        throw error;
      coverage.push(
        `Retained run ${name} is unavailable or invalid; other records remain readable.`,
      );
    }
  }
  const identities = new Map<string, SearchResult>();
  for (const run of [...imported, ...runs]) {
    if (identities.has(run.runId)) throw new Error('duplicate_answer_receipt');
    identities.set(run.runId, run);
  }
  return [...identities.values()].map((run) => {
    const usage = run.usage.providerUsage;
    const cleanup = usage && typeof usage === 'object' && 'cleanup' in usage && usage.cleanup;
    const confirmed =
      cleanup && typeof cleanup === 'object' && 'complete' in cleanup && cleanup.complete === true;
    const cleanupLimit = confirmed
      ? []
      : [
          'Execution cleanup is unconfirmed for this retained answer; its historical status and bytes are unchanged.',
        ];
    return {
      key: `answer:private:${run.runId}`,
      id: run.runId,
      title: run.query,
      uri: '#',
      description: run.followupOf
        ? `Follow-up about saved research: ${(run.followupOf.version === 1 ? run.followupOf.parentQuery : run.followupOf.parents.map((parent) => parent.query).join(' / ')).slice(0, 200)}. Saved context only; no new search or verification. Unassessed; confidence Unknown.`
        : `${run.status === 'completed' ? 'Retained research answer' : 'Incomplete retained research answer'}. Unassessed; confidence Unknown.${confirmed ? '' : ' Execution cleanup unconfirmed.'}`,
      kind: 'research-answer',
      aliases: [],
      domains: [],
      capabilities: [],
      useCases: [],
      technologies: [],
      tags: [],
      sourceNames: (run.provisionalLeads ?? []).slice(0, 40).map((lead) => lead.name),
      intrinsicStrength: { policy: 'unassessed-answer', score: null },
      license: { state: 'unknown', values: [], openSource: null },
      access: { state: 'unknown', freeToUse: null },
      origin: { format: 'answer', destination: 'private', recordId: run.runId },
      saved: true,
      observedAt: run.answerReceipt!.observedAt,
      answerText: run.brief!.text,
      answer: {
        runId: run.runId,
        sha256: run.answerReceipt!.sha256,
        provenance: run.answerReceipt!.provenance,
        limits: [...run.gaps, ...cleanupLimit],
      },
    };
  });
}

/** Bookmark projection never upgrades an incomplete run to an answer receipt. */
export async function loadRetainedNotes(root: string, ids: string[]): Promise<LibraryFinding[]> {
  const findings: LibraryFinding[] = [];
  for (const id of ids) {
    let run: SearchResult | null;
    let unavailableReason: string | null = null;
    try {
      if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id))
        throw new Error('invalid_run_identity');
      const path = resolve(root, '.signals/runs', `${id}.json`);
      if (!(await lstat(path)).isFile()) throw new Error('missing_original');
      run = await loadRun(id, root);
      if (
        !['partial', 'failed', 'cancelled'].includes(run.status) ||
        run.answerReceipt ||
        !run.brief?.text.trim()
      )
        throw new Error('unsupported_incomplete_original');
    } catch (error) {
      run = null;
      unavailableReason = error instanceof Error ? error.message : 'unavailable_original';
    }
    const status =
      run?.status === 'partial' || run?.status === 'cancelled' || run?.status === 'failed'
        ? run.status
        : 'unknown';
    findings.push({
      key: `note:private:${id}`,
      id,
      title: run?.query ?? 'Unavailable retained note',
      uri: '#',
      description: run
        ? `${status} research note; original evidence and cleanup remain as recorded.`
        : 'Original retained note is unavailable; no research was restarted.',
      kind: 'research-note',
      aliases: [],
      domains: [],
      capabilities: [],
      useCases: [],
      technologies: [],
      tags: [],
      sourceNames: [],
      intrinsicStrength: { policy: 'incomplete-note', score: null },
      license: { state: 'unknown', values: [], openSource: null },
      access: { state: 'unknown', freeToUse: null },
      origin: { format: 'note', destination: 'private', recordId: id },
      saved: true,
      observedAt: null,
      ...(run ? { answerText: run.brief!.text } : {}),
      partialNote: {
        runId: id,
        sha256: run ? createHash('sha256').update(run.brief!.text).digest('hex') : null,
        status,
        unavailableReason,
        limits: run?.gaps ?? ['Original missing or invalid; inspect owner history.'],
      },
    });
  }
  return findings;
}
