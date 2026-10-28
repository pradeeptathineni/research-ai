import type { SearchItem } from './search-contract.js';
import { activeObservations } from './search-score.js';

/** A fetched locator alone cannot substantiate a contextual recommendation. */
export function priorityGrounded(item: SearchItem) {
  const supported = activeObservations(item.entity, item.entity.assessment.policy).filter(
    (observation) =>
      observation.verified &&
      observation.status === 'supported' &&
      item.entity.evidence.some(
        (source) =>
          source.id === observation.evidenceId &&
          source.state === 'fetched' &&
          source.reason !== 'provider_final_identity_unverified',
      ),
  );
  return (
    item.entity.identity === 'resolved' &&
    supported.some((observation) => observation.feature === 'defining') &&
    supported.some(
      (observation) =>
        item.priority?.evidenceIds.includes(observation.evidenceId) &&
        item.entity.evidence.some(
          (source) =>
            source.id === observation.evidenceId &&
            source.state === 'fetched' &&
            source.reason !== 'provider_final_identity_unverified',
        ),
    )
  );
}
export interface PersonalState {
  note: string;
  feedback: 'none' | 'skip' | 'mute' | 'useful';
  novelty: 'confirmed-new' | 'known' | 'unknown';
  seenAt: string;
}

/** Ordinal policy, not probability: supplied fit/value judgments plus actual Corpus membership. */
export function contextualize(
  items: SearchItem[],
  saved: Set<string>,
  personal: Record<string, PersonalState> = {},
) {
  return items.map((item) => {
    if (!item.priority) return item;
    const known = saved.has(item.entity.id),
      feedback = personal[item.entity.id]?.feedback ?? 'none';
    const fit = { direct: 60, partial: 30, incompatible: 0, unknown: 0 }[
      item.priority.applicability
    ];
    const value = { high: 30, medium: 20, low: 10, unknown: 0 }[item.priority.value];
    const inspected = priorityGrounded(item);
    const score =
      !inspected || item.priority.applicability === 'unknown'
        ? null
        : Math.max(
            0,
            fit +
              value +
              (known ? 0 : 10) -
              (feedback === 'mute' ? 100 : feedback === 'skip' ? 20 : 0),
          );
    return {
      ...item,
      priority: {
        ...item.priority,
        policy: 'contextual-priority-v2' as const,
        proposedAction: item.priority.proposedAction ?? item.priority.action,
        action:
          !inspected && ['use', 'wrap', 'adapt'].includes(item.priority.action)
            ? ('study' as const)
            : item.priority.action,
        score,
        novelty: known ? ('known-in-corpus' as const) : ('new-to-corpus' as const),
        personalNovelty: personal[item.entity.id]?.novelty ?? 'unknown',
        feedback,
      },
    };
  });
}
export function entityDelta(before: SearchItem['entity'], after: SearchItem['entity']) {
  const project = (entity: SearchItem['entity']) =>
    JSON.stringify({
      kind: entity.kind,
      uri: entity.uri,
      licenses: [...entity.facets.licenses].sort(),
      claims: entity.observations
        .filter(
          (o) => o.verified && !entity.observations.some((next) => next.supersedes.includes(o.id)),
        )
        .map((o) => `${o.feature}:${o.indicator}:${o.status}:${o.statement}`)
        .sort(),
    });
  return project(before) === project(after)
    ? 'unchanged'
    : 'supported-description-or-status-changed';
}
