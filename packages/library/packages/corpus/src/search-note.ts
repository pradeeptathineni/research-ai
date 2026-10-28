import type { ClaimReceipt, PartialNoteSelection } from '../../domain/src/claim-check.js';
import type { SearchResult, SearchRequest } from '../../domain/src/search-contract.js';
import { digest } from './search-fetch.js';
import { retainedPartialCitationsV1 } from './research-answer.js';

type NoteReceipt = Extract<ClaimReceipt, { version: 3 }>;
type Note = Pick<
  NoteReceipt['origin'],
  'parentRunId' | 'parentStatus' | 'fullBrief' | 'contextState'
> &
  Pick<NoteReceipt, 'originalNeed' | 'originalContext'>;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const bounded = (value: string, limit: number) =>
  typeof value === 'string' && value.isWellFormed() && value.length <= limit;

/** Compatibility-pinned existing lexer; code, images and URL substrings give no authority. */
function ledger(note: Note) {
  if (
    !uuid.test(note.parentRunId) ||
    !['cancelled', 'failed'].includes(note.parentStatus) ||
    !bounded(note.fullBrief, 24000) ||
    !note.fullBrief.trim() ||
    !bounded(note.originalNeed, 2000) ||
    !note.originalNeed.trim() ||
    note.contextState !== 'missing' ||
    note.originalContext !== ''
  )
    throw new Error('invalid_partial_note_snapshot');
  const groups = retainedPartialCitationsV1(note.fullBrief).citations;
  if (
    !groups.length ||
    groups.length > 60 ||
    groups.some(
      (group) =>
        !bounded(group.uri, 2048) || group.assertions.some((ref) => !bounded(ref.literal, 4300)),
    )
  )
    throw new Error('partial_citation_selection_unavailable');
  return groups.map((group, groupIndex) => ({
    groupIndex,
    uri: group.uri,
    label: group.label,
    occurrences: group.assertions.map((ref, occurrenceIndex) => ({
      occurrenceIndex,
      start: ref.start,
      end: ref.end,
      literal: ref.literal,
    })),
  }));
}
function parentDigest(note: Note, groups = ledger(note)) {
  const safeLedger = groups.map((group) => [
    group.groupIndex,
    group.uri,
    group.occurrences.map((ref) => [ref.start, ref.end, ref.literal, group.uri]),
  ]);
  return digest(
    JSON.stringify([
      'retained-partial-parent-v1',
      note.parentRunId,
      note.parentStatus,
      note.originalNeed,
      note.contextState,
      note.originalContext,
      note.fullBrief,
      safeLedger,
    ]),
  );
}
/** Only a stopped leaf grants creation authority; original context was not persisted. */
function noteSnapshot(parent: SearchResult): Note {
  if (
    !['cancelled', 'failed'].includes(parent.status) ||
    parent.answerReceipt ||
    parent.claimCheck ||
    parent.assessmentOf ||
    !parent.brief ||
    parent.brief.format !== 'markdown'
  )
    throw new Error('ineligible_partial_parent');
  const note: Note = {
    parentRunId: parent.runId,
    parentStatus: parent.status as 'cancelled' | 'failed',
    fullBrief: parent.brief.text,
    contextState: 'missing',
    originalNeed: parent.query,
    originalContext: '',
  };
  ledger(note);
  return note;
}
export function partialNoteSelection(parent: SearchResult): PartialNoteSelection {
  const note = noteSnapshot(parent),
    groups = ledger(note);
  return {
    parentRunId: note.parentRunId,
    status: note.parentStatus,
    parentSnapshotDigest: parentDigest(note, groups),
    citations: groups.map((group) => ({
      groupIndex: group.groupIndex,
      uri: group.uri,
      label: group.label,
      ...group.occurrences[0]!,
    })),
  };
}
/** Resolve the original occurrence, including later references within the same group. */
function resolveCitations(
  note: Note,
  refs: NonNullable<SearchRequest['claimCitations']>,
  targets: string[],
) {
  const groups = ledger(note);
  if (
    !refs.length ||
    refs.length > 2 ||
    refs.length !== targets.length ||
    new Set(targets).size !== targets.length
  )
    throw new Error('invalid_partial_citation_selection');
  return refs.map((ref, sourceIndex) => {
    const group = groups[ref.groupIndex],
      occurrence = group?.occurrences[ref.occurrenceIndex];
    if (
      !Number.isInteger(ref.groupIndex) ||
      !Number.isInteger(ref.occurrenceIndex) ||
      !group ||
      !occurrence ||
      group.uri !== targets[sourceIndex]
    )
      throw new Error('partial_selection_not_cited');
    return {
      sourceIndex,
      groupIndex: ref.groupIndex,
      occurrenceIndex: ref.occurrenceIndex,
      start: occurrence.start,
      end: occurrence.end,
      literal: occurrence.literal,
      uri: group.uri,
    };
  });
}
const citationTuple = (ref: NoteReceipt['origin']['selectedCitations'][number]) => [
  ref.sourceIndex,
  ref.groupIndex,
  ref.occurrenceIndex,
  ref.start,
  ref.end,
  ref.literal,
  ref.uri,
];
function childDigest(
  parentSnapshotDigest: string,
  selected: NoteReceipt['origin']['selectedCitations'],
  claim: string,
  targets: string[],
) {
  return digest(
    JSON.stringify([
      'retained-partial-check-v1',
      parentSnapshotDigest,
      selected.map(citationTuple),
      claim,
      targets,
    ]),
  );
}
export function partialOrigin(parent: SearchResult, request: SearchRequest): NoteReceipt['origin'] {
  const note = noteSnapshot(parent),
    parentSnapshotDigest = parentDigest(note);
  if (request.parentSnapshotDigest !== parentSnapshotDigest)
    throw new Error('stale_partial_parent');
  const selectedCitations = resolveCitations(note, request.claimCitations!, request.captureUrls!);
  return {
    kind: 'retained-partial',
    parentRunId: note.parentRunId,
    parentStatus: note.parentStatus,
    fullBrief: note.fullBrief,
    contextState: note.contextState,
    citationDecoder: 'retained-partial-citations-v1',
    parentSnapshotDigest,
    selectedCitations,
    lineageDigest: childDigest(
      parentSnapshotDigest,
      selectedCitations,
      request.claimText!,
      request.captureUrls!,
    ),
  };
}
/** Copies survive expiry; replay rechecks safe Markdown citations instead of URI inclusion. */
export function validatePartialClosure(receipt: NoteReceipt, targets: string[]) {
  const note: Note = {
    ...receipt.origin,
    originalNeed: receipt.originalNeed,
    originalContext: receipt.originalContext,
  };
  if (
    receipt.origin.citationDecoder !== 'retained-partial-citations-v1' ||
    !bounded(receipt.claimText, 1600) ||
    !receipt.claimText.trim() ||
    receipt.additionalContext !== undefined
  )
    throw new Error('invalid_partial_claim_closure');
  const parentSnapshotDigest = parentDigest(note);
  const selected = resolveCitations(note, receipt.origin.selectedCitations, targets);
  if (
    parentSnapshotDigest !== receipt.origin.parentSnapshotDigest ||
    JSON.stringify(selected.map(citationTuple)) !==
      JSON.stringify(receipt.origin.selectedCitations.map(citationTuple)) ||
    receipt.origin.lineageDigest !==
      childDigest(parentSnapshotDigest, selected, receipt.claimText, targets)
  )
    throw new Error('invalid_partial_claim_closure');
}
