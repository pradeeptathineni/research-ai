import { selectSavedEntity } from './search-selection.js';
import { loadRun, selectionHistory } from './search-store.js';

export type SavedEntityReceipt = {
  id: string;
  at: string;
  mode: string;
  destination: 'public' | 'private';
  selectionEffect: 'changed' | 'skipped' | 'selected';
  runId: string;
  query: string;
  kind: string;
  queryId?: string;
  reopenStatus: 'available' | 'unavailable' | 'conflict';
  reopenReason?: string;
};

export function projectAssessmentState(state: unknown) {
  if (state === 'unassessed') return 'unassessed-lead' as const;
  if (state === 'provisional') return 'provisional-assessment' as const;
  if (state === 'assessed') return 'assessed-finding' as const;
  throw new Error('unsupported_assessment_state');
}

const canonicalRunId = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

/** Read-only view joining a canonical saved record to its exact selection receipts. */
export async function inspectSavedEntity(
  id: string,
  root: string,
  destination?: 'public' | 'private',
) {
  const selected = await selectSavedEntity(id, root, destination);
  const matches = (await selectionHistory(root)).filter(
    (receipt) =>
      receipt !== null &&
      typeof receipt === 'object' &&
      receipt.destination === selected.destination &&
      Array.isArray(receipt.selected) &&
      receipt.selected.includes(id),
  );
  const receipts: SavedEntityReceipt[] = await Promise.all(
    matches.map(async (receipt, index) => {
      const projected = {
        id: typeof receipt.id === 'string' ? receipt.id : `invalid-selection-${index}`,
        at: typeof receipt.at === 'string' ? receipt.at : '',
        mode: typeof receipt.mode === 'string' ? receipt.mode : 'unknown',
        destination: selected.destination,
        selectionEffect:
          Array.isArray(receipt.changed) && receipt.changed.includes(id)
            ? ('changed' as const)
            : Array.isArray(receipt.skipped) && receipt.skipped.includes(id)
              ? ('skipped' as const)
              : ('selected' as const),
        runId: typeof receipt.runId === 'string' ? receipt.runId : '',
        query: typeof receipt.query === 'string' ? receipt.query : '',
        kind: typeof receipt.kind === 'string' ? receipt.kind : 'unknown',
        ...(typeof receipt.queryId === 'string' && receipt.queryId
          ? { queryId: receipt.queryId }
          : {}),
      };
      if (typeof receipt.runId !== 'string' || !canonicalRunId.test(receipt.runId))
        return {
          ...projected,
          reopenStatus: 'conflict',
          reopenReason: 'The recorded selection run ID is invalid.',
        };
      try {
        const run = await loadRun(receipt.runId, root);
        if (run.query !== receipt.query || !run.items.some((item) => item.entity.id === id))
          return {
            ...projected,
            reopenStatus: 'conflict',
            reopenReason: 'The frozen run does not match this receipt and saved entity.',
          };
        return { ...projected, reopenStatus: 'available' };
      } catch (error) {
        return {
          ...projected,
          reopenStatus: 'unavailable',
          reopenReason:
            error instanceof Error && error.message === 'unknown_retained_run'
              ? 'The frozen selection run is no longer retained.'
              : 'The recorded frozen run cannot be validated or reopened.',
        };
      }
    }),
  );
  receipts.sort((a, b) => a.at.localeCompare(b.at));
  const assessment = selected.record.entity.assessment;
  return {
    schema: 'signals.saved-entity-inspection.v1' as const,
    id,
    destination: selected.destination,
    savedState: selected.record.state,
    assessmentState: projectAssessmentState(assessment?.state),
    confidence: 'Unknown' as const,
    assessment: structuredClone(assessment),
    receipts,
    // Keep the stored bytes' parsed value unchanged: evidence and provenance remain inspectable.
    record: structuredClone(selected.record),
    historicalRead:
      'Only receipts with reopenStatus available may be reopened through history/open; unavailable or conflicting receipts stay visible without substituting another run.',
  };
}
