import type { ClaimReceipt } from '../../../packages/domain/src/claim-check.js';

export function ClaimCheck({ receipt }: { receipt: ClaimReceipt }) {
  return (
    <section aria-label="Selected proposition check" style={{ overflowWrap: 'anywhere' }}>
      <h2>Selected proposition</h2>
      <p>
        {receipt.version === 4
          ? 'Explicit check of selected PDF text-layer windows from a newly registered source. This is not whole-source coverage or a historical answer citation.'
          : receipt.version === 3
            ? 'Explicit check from retained incomplete notes. The original prose remains unassessed; this is not a completed-answer assessment.'
            : receipt.version === 2
              ? 'User-specified proposition and primary sources, without an original research answer.'
              : 'User-specified proposition; it need not be asserted by the original answer.'}
      </p>
      <p>
        The snapshot preserves supplied normalized text. Extraction may omit original structure,
        terms or conditions; complete normalization does not mean complete source coverage.
      </p>
      <p>{receipt.claimText}</p>
      <p>
        Review: {receipt.reviewState}. Verdict: {receipt.verdict ?? 'Not available'}. Confidence
        Unknown. No numeric Signal.
      </p>
      <p>
        {receipt.historySaved
          ? receipt.version === 4
            ? 'Saved privately with a separate full normalized extraction copy for replay. The native reviewer received only the selected windows. Raw PDF bytes were not copied.'
            : receipt.version === 3
              ? 'Saved privately with a copy of the incomplete notes and primary snapshots. Original-run expiry or deletion does not delete this separate copy.'
              : receipt.version === 2
                ? 'Saved privately with the original request and primary snapshots.'
                : 'Saved privately with the original answer link.'
          : 'Not saved to history.'}
      </p>
      <p>{receipt.reason}</p>
      <p>Next check: {receipt.nextCheck}</p>
      {receipt.reviewState === 'not-reviewed' &&
        !receipt.selectedMaterial.some((source) => source.state === 'usable') && (
          <section aria-label="Blocked source check">
            <h3>This check could not proceed</h3>
            <p>Proposition: {receipt.claimText}</p>
            <ul>
              {receipt.selectedMaterial.map((source) => (
                <li key={source.sourceIndex}>
                  Selected source {source.sourceIndex + 1}: {source.requestedUri} — {source.state}
                  {source.state !== 'usable' && (
                    <>
                      : <code>{source.reason}</code>
                    </>
                  )}
                </li>
              ))}
            </ul>
            <p>
              No source was reviewed, so there is no verdict or inference. Reopening this saved
              result does not fetch, resume a session, add context or change the source.
            </p>
            {receipt.selectedMaterial.some(
              (source) => source.state === 'denied' || source.state === 'cancelled',
            ) && (
              <p>
                Denied access is not a prompt to work around it; cancellation does not resubmit
                itself. Start a new check deliberately if you want one.
              </p>
            )}
            {receipt.selectedMaterial.some(
              (source) => source.state === 'failed' && source.reason === 'unsupported_content',
            ) && (
              <p>
                unsupported_content: this host cannot read that source shape. A .pdf suffix does not
                prove PDF identity, parser execution or extraction readiness. Other shapes have no
                converter here. Follow the{' '}
                <a href="https://github.com/pradeeptathineni/signals-ai#when-a-selected-source-is-refused">
                  source recovery steps
                </a>{' '}
                to inspect an explicitly supplied supported snapshot or approved PDF extraction.
                Inspection does not create a new check; a selected-primary review requires a trusted
                registered PDF producer and a deliberate storage choice.
              </p>
            )}
          </section>
        )}
      <details>
        <summary>Original need and context</summary>
        <p>{receipt.originalNeed}</p>
        <p>{receipt.originalContext}</p>
        {receipt.additionalContext && <p>Additional context: {receipt.additionalContext}</p>}
      </details>
      {receipt.version === 3 && (
        <details>
          <summary>Copied incomplete notes</summary>
          <p>
            Unassessed original prose. Original context was not retained. This copy does not restore
            its original run or renew source dates.
          </p>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {receipt.origin.fullBrief}
          </pre>
        </details>
      )}
      <ol>
        {receipt.selectedMaterial.map((source) => (
          <li key={source.sourceIndex}>
            <a href={source.requestedUri} target="_blank" rel="noreferrer">
              Selected source {source.sourceIndex + 1}
            </a>
            : {source.state}.
            {source.state === 'usable' ? (
              <>
                <p>
                  Scope: {source.scope}. Acquired {source.fetchedAt}; publication{' '}
                  {source.publishedAt ?? 'Unknown'}. Final identity: {source.finalUri}
                </p>
                <ul>
                  {source.omissions.map((omission, index) => (
                    <li key={index}>{omission}</li>
                  ))}
                </ul>
                {source.scope === 'selected-page-windows' && (
                  <p>
                    Selected pages:{' '}
                    {source.packet.selectedPages.map((page) => page.page).join(', ')}. Unread pages:{' '}
                    {source.packet.unreadPages.join(', ') || 'None in the text-layer ledger'}. Full
                    normalized digest: {source.packet.fullTextDigest}. Coordinates: original global
                    UTF16.
                    {source.capture.followedFrom &&
                      ` Contextual outlink from ${source.capture.followedFrom.uri}; this is not a claim parent.`}
                  </p>
                )}
              </>
            ) : (
              <p>{source.reason}</p>
            )}
          </li>
        ))}
      </ol>
      {receipt.findings.map((finding, index) => {
        const source = receipt.selectedMaterial[finding.sourceIndex];
        const selected = source?.state === 'usable' && source.scope === 'selected-page-windows';
        const text =
          source?.state === 'usable'
            ? selected
              ? (source.packet.windows.find((window) => window.text.includes(finding.quote))
                  ?.text ?? '')
              : source.text.replace(/\s+/g, ' ').trim()
            : '';
        const quote = selected ? finding.quote : finding.quote.replace(/\s+/g, ' ').trim();
        const position = text.indexOf(quote);
        return (
          <article key={index}>
            <p>
              {receipt.reviewState === 'completed' ? 'Native finding' : 'Unaccepted native finding'}
              : {finding.status}; source {finding.sourceIndex + 1}.
            </p>
            <blockquote>{finding.quote}</blockquote>
            <p>{finding.reason}</p>
            {receipt.version === 4 && (
              <p>
                Original UTF16/page bindings:{' '}
                {receipt.findingSpans
                  .find((span) => span.findingIndex === index)
                  ?.occurrences.map(
                    (span) => `${span.start}–${span.end}, pages ${span.startPage}–${span.endPage}`,
                  )
                  .join('; ')}
              </p>
            )}
            {position >= 0 && (
              <details>
                <summary>Primary passage context</summary>
                <p>{text.slice(Math.max(0, position - 160), position + quote.length + 160)}</p>
              </details>
            )}
          </article>
        );
      })}
      <ul>
        {receipt.gaps.map((gap, index) => (
          <li key={index}>
            {gap.decisive ? 'Decisive gap: ' : ''}
            {gap.reason}
          </li>
        ))}
      </ul>
      {receipt.rejectedOutput && (
        <p>
          Native output was rejected;{' '}
          {receipt.rejectedOutput.captureScope === 'runner-stdout'
            ? 'received stdout byte counts and a digest remain, with unclassified text omitted.'
            : 'a bounded private reply diagnostic remains.'}{' '}
          {receipt.rejectedOutput.omittedBytes} captured bytes omitted. Capture{' '}
          {receipt.rejectedOutput.captureComplete ? 'complete' : 'incomplete'}.
        </p>
      )}
      <p>
        Matching primary text establishes occurrence; entailment, completeness and independence
        remain fallible judgments.
      </p>
    </section>
  );
}
