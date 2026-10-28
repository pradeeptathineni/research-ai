import { randomUUID } from 'node:crypto';
import type { SearchResult } from '../../domain/src/search-contract.js';
import { requestStore } from './search-request-store.js';

export interface ObservedRun {
  requestEpoch?: string;
  events: string[];
  result?: SearchResult;
  error?: string;
  batch?: unknown;
  due?: unknown;
  startedAt: string;
  lastEvidenceAt: string;
  settled: boolean;
  settledAt?: string;
  cancelRequestedAt?: string;
  reopened?: boolean;
}

const ref = (kind: string, id: string, revision: string | null = null) => ({
  owner: 'signals-ai',
  kind,
  id,
  revision,
  digest: null,
});

/** A read-only projection of owner state. Its clock never acts as a worker heartbeat. */
export function processObservation(root: string, runs: Map<string, ObservedRun>) {
  const requests = requestStore(root);
  const storeEpoch = randomUUID();
  let sequence = 0;
  let lastChecksum: string | null = null;
  const changed = () => {
    sequence++;
  };

  async function snapshot() {
    // The ledger is the authority for durable states. In-process jobs are only
    // living evidence in this owner instance, never recovered from a receipt.
    const ledger = await requests.observe();
    if (lastChecksum !== ledger.checksum) {
      lastChecksum = ledger.checksum;
      changed();
    }
    const asOf = new Date().toISOString();
    const durable = new Set(ledger.requests.map((row) => row.id));
    const processes = ledger.requests.map((row) => {
      const run = runs.get(row.id);
      const receipt = row.receipt;
      const terminal = ['complete', 'partial', 'failed', 'cancelled'].includes(receipt.state);
      const lifecycle =
        receipt.state === 'admitted'
          ? 'queued'
          : receipt.state === 'complete' || receipt.state === 'partial'
            ? 'succeeded'
            : receipt.state === 'failed'
              ? 'failed'
              : receipt.state === 'cancelled'
                ? 'cancelled'
                : run && !run.settled
                  ? 'running'
                  : 'unknown';
      return project(row.id, run, {
        title: `Research request ${row.requestId}`,
        taskRef: ref('research_request', row.requestId),
        lifecycle,
        reason: receipt.reason,
        observedAt: terminal ? receipt.observed_at : (run?.lastEvidenceAt ?? receipt.observed_at),
        cancelEnabled: Boolean(run && !run.settled && !run.cancelRequestedAt && !terminal),
        reconcileEnabled: true,
        reconcileKey: receipt.idempotency_key,
        resultAvailable: Boolean(run?.result),
      });
    });
    for (const [id, run] of runs) {
      if (durable.has(id) || run.reopened) continue;
      const lifecycle = !run.settled
        ? 'running'
        : run.error || run.result?.status === 'failed' || run.result?.status === 'not_configured'
          ? 'failed'
          : run.result?.status === 'cancelled'
            ? 'cancelled'
            : run.result || run.batch || run.due
              ? 'succeeded'
              : 'unknown';
      processes.push(
        project(id, run, {
          title: 'Direct Signals job',
          taskRef: null,
          lifecycle,
          reason: run.error ?? (run.result?.status === 'partial' ? 'research_partial' : null),
          observedAt: run.settled ? (run.settledAt ?? run.lastEvidenceAt) : run.lastEvidenceAt,
          cancelEnabled: !run.settled && !run.cancelRequestedAt,
          reconcileEnabled: false,
          reconcileKey: null,
          resultAvailable: Boolean(run.result || run.batch || run.due),
        }),
      );
    }
    const observation = {
      schema_version: '1.0',
      snapshot_revision: `${storeEpoch}:${sequence}`,
      as_of: asOf,
      cursor: null,
      full_snapshot: true,
      owner_coverage: [
        {
          owner: 'signals-ai',
          instance_id: ledger.scope.identity,
          state: 'connected',
          observed_at: asOf,
          reason:
            'Known durable requests and current in-process jobs; direct jobs disappear on restart.',
        },
      ],
      processes,
      decisions: [],
      pending_commands: [],
      store_epoch: storeEpoch,
      sequence,
      complete_coverage: true,
    };
    // Never silently truncate while claiming complete coverage.
    if (Buffer.byteLength(JSON.stringify(observation)) > 2_000_000)
      throw new Error('process_snapshot_too_large');
    return observation;
  }
  return { snapshot, changed, storeEpoch };
}

function project(
  id: string,
  run: ObservedRun | undefined,
  state: {
    title: string;
    taskRef: ReturnType<typeof ref> | null;
    lifecycle: string;
    reason: string | null;
    observedAt: string;
    cancelEnabled: boolean;
    reconcileEnabled: boolean;
    reconcileKey: string | null;
    resultAvailable: boolean;
  },
) {
  const target = ref('research_job', id);
  const last = run?.events.at(-1);
  const availability = state.resultAvailable
    ? `Result available at runs/${id}.`
    : state.lifecycle === 'running'
      ? 'Result pending.'
      : 'Result unavailable in this owner instance.';
  return {
    schema_version: '1.0',
    ref: target,
    task_ref: state.taskRef,
    title: state.title,
    scope: 'unknown',
    parent: null,
    execution_scope: 'direct_owner',
    actor_role: 'researcher',
    agent: null,
    model: null,
    lifecycle: state.lifecycle,
    wait_reason:
      run?.cancelRequestedAt && !run.settled
        ? 'Cancellation requested; worker outcome pending.'
        : state.reason,
    effect_state: state.lifecycle === 'running' ? 'pending' : 'unknown',
    acceptance: 'not_evaluated',
    observed_at: state.observedAt,
    heartbeat_at: run?.lastEvidenceAt ?? null,
    stale_after_seconds: 30,
    progress: {
      label: [last, availability].filter(Boolean).join(' '),
      done: null,
      total: null,
      unit: null,
      evidence: last && run ? [{ label: last, ref: target, observed_at: run.lastEvidenceAt }] : [],
    },
    dependencies: [],
    usage: [],
    artifacts: state.resultAvailable ? [ref('in_memory_result', id)] : [],
    actions: [
      {
        kind: 'cancel',
        enabled: state.cancelEnabled,
        reason: state.cancelEnabled
          ? 'POST cancel/<exact job id> with session token; request is not yet confirmed cancelled.'
          : 'No live cancellable job in this owner instance.',
        target,
        expected_revision: null,
      },
      ...(state.reconcileEnabled
        ? [
            {
              kind: 'reconcile',
              enabled: true,
              reason:
                'Read the durable request receipt using its original idempotency key and owner epoch.',
              target: ref('research_request', state.reconcileKey!),
              expected_revision: null,
            },
          ]
        : []),
    ],
    event_cursor: null,
  };
}
