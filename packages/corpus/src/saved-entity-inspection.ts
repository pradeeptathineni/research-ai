import { selectSavedEntity } from './search-selection.js';
import { selectionHistory } from './search-store.js';

/** Read-only view joining a canonical saved record to the receipt that introduced it. */
export async function inspectSavedEntity(
  id: string,
  root: string,
  destination?: 'public' | 'private',
) {
  const selected = await selectSavedEntity(id, root, destination);
  const receipts = (await selectionHistory(root))
    .filter(
      (receipt) => receipt.destination === selected.destination && receipt.selected.includes(id),
    )
    .sort((a, b) => a.at.localeCompare(b.at));
  const assessment = selected.record.entity.assessment;
  return {
    schema: 'signals.saved-entity-inspection.v1' as const,
    id,
    destination: selected.destination,
    savedState: selected.record.state,
    assessmentState:
      assessment.state === 'unassessed'
        ? 'unassessed-lead'
        : assessment.state === 'provisional'
          ? 'provisional-assessment'
          : 'assessed-finding',
    confidence: 'Unknown' as const,
    assessment: structuredClone(assessment),
    receipts: receipts.map((receipt) => ({
      id: receipt.id,
      at: receipt.at,
      mode: receipt.mode,
      runId: receipt.runId,
      query: receipt.query,
      kind: receipt.kind,
      ...(receipt.queryId ? { queryId: receipt.queryId } : {}),
    })),
    // Keep the stored bytes' parsed value unchanged: evidence and provenance remain inspectable.
    record: structuredClone(selected.record),
    historicalRead: 'Use each receipt runId with history/open to reopen the frozen research run.',
  };
}
