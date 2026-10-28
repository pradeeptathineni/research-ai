import { useEffect, useRef, type ReactNode } from 'react';
import type { LibraryFinding } from '../../../packages/domain/src/library-search.js';
import type { Entity } from '../../../packages/domain/src/search-contract.js';
import {
  assessmentHolds,
  originInspectionBinding,
} from '../../../packages/domain/src/search-assessment.js';

const date = (value: string | null) =>
  value
    ? new Date(value).toLocaleString('en-US', {
        timeZone: 'UTC',
        dateStyle: 'medium',
        timeStyle: 'short',
      }) + ' UTC'
    : 'Unknown';

export function ScoreView({ score, label }: { score: number | null; label: string }) {
  return (
    <span className="desk-score">
      <strong>{score ?? '—'}</strong>
      <span>{label}</span>
    </span>
  );
}

export function AssessmentConfidence() {
  return (
    <p className="desk-limit">
      Confidence in this assessment: Unknown. Signal is an evidence policy index, not a probability
      of correctness.
    </p>
  );
}

export function ComparisonBasis({
  rows,
}: {
  rows: { key: string; title: string; policy: string; rubric: string; state: string }[];
}) {
  return (
    <section aria-label="Comparison score basis">
      <p>Different policies and type rubrics are not directly comparable.</p>
      <AssessmentConfidence />
      {rows.map((row) => (
        <p key={row.key}>
          {row.title}: {row.policy} · {row.rubric} · {row.state}
        </p>
      ))}
    </section>
  );
}

/** Render the retained derivation; this view never recomputes or changes the assessment. */
export function AssessmentDerivation({ entity }: { entity: Entity }) {
  const bound = new Set(
    Object.values(entity.assessment.features).flatMap((feature) => feature.observations),
  );
  const sourceTitle = (id: string) =>
    entity.evidence.find((source) => source.id === id)?.title ?? 'Unavailable source';
  const readableReason = (reason: string) =>
    entity.evidence.reduce((text, source) => text.replaceAll(source.id, source.title), reason);
  const currentHolds = assessmentHolds(entity, entity.assessment.asOf).filter(
    (hold) => !entity.assessment.reasons?.includes(hold.reason),
  );
  return (
    <section aria-label="Signal derivation">
      <p>
        {entity.assessment.policy} · assessed {date(entity.assessment.asOf)} ·{' '}
        {entity.assessment.disposition ?? entity.assessment.state}
      </p>
      <p>
        Evidence-policy contributions are summed before the final score is rounded. Points below are
        approximate policy credit; they do not measure assessment accuracy.
      </p>
      {Object.entries(entity.assessment.features).map(([dimension, feature]) => (
        <details key={dimension}>
          <summary>
            {dimension} · approximately {Math.round(feature.contribution)} points · {feature.state}
          </summary>
          {entity.signalBasis && dimension in entity.signalBasis.dimensions && (
            <p>{entity.signalBasis.dimensions[dimension as 'basis'].reason}</p>
          )}
          <p>Bound support and limitations:</p>
          <ul>
            {feature.observations.map((id) => {
              const observation = entity.observations.find((item) => item.id === id);
              return observation ? (
                <li key={id}>
                  {observation.statement} — {sourceTitle(observation.evidenceId)} ·{' '}
                  {observation.feature}/{observation.indicator} · {observation.status}
                </li>
              ) : (
                <li key={id}>Bound observation unavailable.</li>
              );
            })}
          </ul>
          {!feature.observations.length && (
            <p>No supporting observation bound. Unknown is not a verdict of poor quality.</p>
          )}
        </details>
      ))}
      {entity.assessment.reasons?.map((reason) => (
        <p key={reason}>{readableReason(reason)}</p>
      ))}
      {!!currentHolds.length && (
        <section aria-label="Current admission holds">
          <p>
            Current automatic admission is held. The historical numerical assessment keeps its
            original policy.
          </p>
          {currentHolds.map((hold) => (
            <div key={hold.reason}>
              <p>{readableReason(hold.reason)}</p>
              <p>Next verification: {hold.nextVerification}</p>
            </div>
          ))}
        </section>
      )}
      {/^signal-strength-v[0-6]$/.test(entity.assessment.policy) && (
        <p>Historical risk adjustment: −{entity.assessment.risk}.</p>
      )}
      {entity.assessment.nextVerification && (
        <p>Next verification: {entity.assessment.nextVerification}</p>
      )}
      {!!entity.signalBasis?.originInspections?.length && (
        <details>
          <summary>Origin attribution and relationships</summary>
          <p>
            Returned attribution judgments need a matched passage and meaningful reason.
            Native-reviewed interpretation is not proven independence.
          </p>
          {entity.signalBasis.originInspections.map((inspection, index) => {
            const binding = originInspectionBinding(entity, inspection, entity.assessment.asOf);
            return (
              <div key={`${inspection.source}:${index}`}>
                <p>
                  {sourceTitle(inspection.source)} ·{' '}
                  {binding.state === 'native-reviewed'
                    ? 'Native-reviewed attribution'
                    : 'Attribution Unknown'}{' '}
                  · reported relationship: {inspection.relationship} · originating effort:{' '}
                  {entity.evidence.find((source) => source.id === inspection.source)?.origin ??
                    'Unknown'}
                </p>
                <p>{inspection.reason}</p>
                <p>{binding.reason}</p>
                {binding.state === 'native-reviewed' ? (
                  <blockquote>{inspection.quote}</blockquote>
                ) : (
                  <p>Reported attribution, not an accepted source passage: {inspection.quote}</p>
                )}
              </div>
            );
          })}
        </details>
      )}
      {!!entity.observations.filter((observation) => !bound.has(observation.id)).length && (
        <details>
          <summary>Other retained findings</summary>
          <p>
            These records are outside the displayed contributing bindings. Decisive adverse findings
            can still hold an assessment; the reasons and next check above explain those holds.
          </p>
          <ul>
            {entity.observations
              .filter((observation) => !bound.has(observation.id))
              .map((observation) => (
                <li key={observation.id}>
                  {observation.statement} — {sourceTitle(observation.evidenceId)} ·{' '}
                  {observation.status} ·{' '}
                  {observation.verified ? 'Matched passage' : 'Unmatched passage'}
                </li>
              ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/** Presentation only: intrinsic assessment remains distinct from retrieval and contextual fit. */
export function CandidateSummary({ finding }: { finding: LibraryFinding }) {
  return (
    <>
      <div className="desk-finding-head">
        <h3>{finding.title}</h3>
        <span className="desk-kind">{finding.kind.replaceAll('_', ' ')}</span>
      </div>
      <p className="desk-summary">{finding.description}</p>
      <div className="desk-scoreline">
        <ScoreView
          score={finding.intrinsicStrength.score}
          label={finding.origin.format === 'legacy' ? 'Review' : 'Signal'}
        />
        {finding.intrinsicStrength.score === null && (
          <span className="desk-assessment-state">Not scored</span>
        )}
        {finding.native?.assessment.disposition === 'provisional' && (
          <span className="desk-assessment-state">Provisional</span>
        )}
        <span className="desk-origin">
          {finding.origin.destination === 'private' ? 'Private finding' : 'Public finding'}
        </span>
      </div>
    </>
  );
}

export function ComparisonView({
  findings,
  onClear,
  children,
}: {
  findings: LibraryFinding[];
  onClear: () => void;
  children?: ReactNode;
}) {
  return (
    <section className="desk-comparison" aria-label="Compare selected findings">
      <div className="desk-section-line">
        <h2>Compare</h2>
        <button onClick={onClear}>Clear comparison</button>
      </div>
      <div>
        {findings.map((finding) => (
          <article key={finding.key}>
            <h3>{finding.title}</h3>
            <p className="desk-summary">{finding.description}</p>
            <ScoreView
              score={finding.intrinsicStrength.score}
              label={finding.origin.format === 'legacy' ? 'Review' : 'Signal'}
            />
            <p className="desk-limit">
              {finding.native?.limits[0] ?? finding.lead?.limits[0] ?? 'Limits not recorded.'}
            </p>
          </article>
        ))}
      </div>
      <details>
        <summary>Score basis</summary>
        <ComparisonBasis
          rows={findings.map((finding) => ({
            key: finding.key,
            title: finding.title,
            policy: finding.intrinsicStrength.policy,
            rubric: finding.native?.assessment.rubric ?? finding.kind,
            state:
              finding.native?.assessment.disposition ??
              finding.native?.assessment.state ??
              (finding.origin.format === 'legacy' ? 'Historical review' : 'Unassessed lead'),
          }))}
        />
      </details>
      {children}
    </section>
  );
}

export type FrozenAnswer = {
  answer: string;
  gaps?: string[];
  statements: {
    statement: string;
    quote: string;
    entityId: string;
    evidenceId: string;
    observationId: string;
  }[];
};
export function DiscussionScope({ gaps }: { gaps?: string[] }) {
  return gaps?.length ? (
    <section aria-label="Discussion scope and gaps">
      <h4>Scope and limits</h4>
      <ul>
        {gaps.map((gap, index) => (
          <li key={index}>{gap}</li>
        ))}
      </ul>
    </section>
  ) : null;
}
export function FrozenDiscussion({
  question,
  busy,
  answer,
  onQuestion,
  onSubmit,
}: {
  question: string;
  busy: boolean;
  answer: FrozenAnswer | null;
  onQuestion: (question: string) => void;
  onSubmit: () => void;
}) {
  return (
    <details
      aria-label="Selected evidence discussion"
      open={busy || Boolean(answer) || Boolean(question)}
    >
      <summary>Ask about these items</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <label>
          Ask selected retained evidence
          <input required value={question} onChange={(event) => onQuestion(event.target.value)} />
        </label>
        <button disabled={busy}>
          {busy ? 'Reading retained evidence…' : 'Explain from retained evidence'}
        </button>
        <small>
          AI reads selected retained material, including complete answers, through your configured
          provider. No new web research.
        </small>
      </form>
      {answer && (
        <section aria-label="Retained evidence answer">
          <p>{answer.answer}</p>
          <DiscussionScope gaps={answer.gaps} />
          {answer.statements.map((statement) => (
            <details key={statement.entityId + ':' + statement.observationId}>
              <summary>{statement.statement}</summary>
              <blockquote>{statement.quote}</blockquote>
              <p className="desk-meta">
                Record: {statement.entityId} · evidence: {statement.evidenceId} · observation:{' '}
                {statement.observationId}
              </p>
            </details>
          ))}
        </section>
      )}
    </details>
  );
}

/** A nonmodal evidence region keeps the result list and selection in place. */
export function EvidencePanel({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [title]);
  return (
    <section
      className="desk-evidence-panel"
      aria-label="Evidence panel"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header>
        <h2 ref={heading} tabIndex={-1}>
          {title}
        </h2>
        <button type="button" aria-label="Close evidence" onClick={onClose}>
          Close
        </button>
      </header>
      {children}
    </section>
  );
}

type Recent = { runId: string; query: string; status: string; candidates: number };
type Interest = { id: string; query: string; enabled: boolean };
type Selection = {
  query: string;
  queryId?: string;
  at: string;
  selected: string[];
  destination?: string;
};

/** Home uses actual retained provenance. Opening it never starts acquisition or recurrence. */
export function HomeOverview({
  records,
  interests,
  recent,
  selections,
  openLibrary,
  openFollowing,
  inspect,
  reopen,
}: {
  records: LibraryFinding[];
  interests: Interest[];
  recent: Recent[];
  selections: Selection[];
  openLibrary: () => void;
  openFollowing: () => void;
  inspect: (key: string) => void;
  reopen: (run: Recent) => void;
}) {
  const followed = selections.filter((selection) =>
    interests.some(
      (interest) => selection.queryId === interest.id || selection.query === interest.query,
    ),
  );
  const discoveries = records
    .flatMap((finding) => {
      const selection = followed.find(
        (selection) =>
          selection.selected.includes(finding.id) &&
          selection.destination === finding.origin.destination,
      );
      return selection ? [{ finding, selection }] : [];
    })
    .slice(0, 6);
  return (
    <div className="desk-home">
      <section aria-label="Followed interest discoveries">
        <div className="desk-section-line">
          <h2>From your interests</h2>
          <button onClick={openFollowing}>Following</button>
        </div>
        {discoveries.map(({ finding, selection }) => (
          <article className="desk-finding" key={finding.key}>
            <CandidateSummary finding={finding} />
            <p className="desk-meta">
              Source observed{' '}
              {date(
                finding.native?.evidence
                  .filter((source) => source.state === 'fetched')
                  .map((source) => source.fetchedAt)
                  .sort()
                  .at(-1) ?? null,
              )}{' '}
              ·{' '}
              {[...(finding.native?.evidence ?? [])]
                .filter((source) => source.state === 'fetched')
                .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt))[0]?.publisher ??
                'No retained source observation'}
            </p>
            <div className="desk-actions">
              <button onClick={() => inspect(finding.key)}>Evidence</button>
              <details>
                <summary>Saved context</summary>
                <p>
                  Retained from “{selection.query}” · saved {date(selection.at)}
                </p>
              </details>
            </div>
          </article>
        ))}
        {!discoveries.length && (
          <div className="desk-home-empty">
            <h3>{interests.length ? 'No discoveries saved yet.' : 'Follow what interests you.'}</h3>
            <p>
              {interests.length
                ? 'Search a topic to get started.'
                : 'Choose a topic. Discover something new.'}
            </p>
            <button onClick={openFollowing}>
              {interests.length ? 'View followed interests' : 'Choose an interest'}
            </button>
          </div>
        )}
      </section>
      <div className="desk-home-secondary">
        <section aria-label="Library shortcut">
          <h2>Your Library</h2>
          <p>{records.filter((finding) => finding.saved).length} saved findings</p>
          <button onClick={openLibrary}>Browse Library</button>
        </section>
        <section aria-label="Recent searches">
          <h2>Recent searches</h2>
          {recent.slice(0, 5).map((run) => (
            <button className="desk-recent" key={run.runId} onClick={() => reopen(run)}>
              <strong>{run.query}</strong>
              <span>
                {run.candidates} candidates · {run.status} · retained
              </span>
            </button>
          ))}
          {!recent.length && <p>No saved searches yet.</p>}
        </section>
      </div>
    </div>
  );
}
