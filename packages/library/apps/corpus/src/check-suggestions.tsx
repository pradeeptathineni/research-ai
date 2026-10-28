import { useState } from 'react';
import type { CheckSuggestions as Suggestions } from '../../../packages/domain/src/search-suggestions.js';

function OfferedCheck({
  offered,
  index,
  busy,
  retained,
  onCheck,
}: {
  offered: Suggestions['offered'][number];
  index: number;
  busy: boolean;
  retained: boolean;
  onCheck: (index: number, claim: string, urls: string[]) => void;
}) {
  const [claim, setClaim] = useState(offered.claim);
  return (
    <li>
      <p>Unverified suggestion {index + 1}</p>
      <label>
        Suggested proposition {index + 1}
        <textarea
          maxLength={1600}
          value={claim}
          onChange={(event) => setClaim(event.target.value)}
        />
      </label>
      <p>Unverified basis: {offered.basis}</p>
      <p>Why check: {offered.why}</p>
      <ul>
        {offered.urls.map((uri) => (
          <li key={uri}>
            <a href={uri} target="_blank" rel="noreferrer">
              {uri}
            </a>
          </li>
        ))}
      </ul>
      <button
        disabled={busy || !retained || !claim.trim()}
        onClick={() => onCheck(index, claim, offered.urls)}
      >
        Check selected suggestion {index + 1}
      </button>
    </li>
  );
}

export function CheckSuggestions({
  suggestions,
  busy,
  retained,
  onCheck,
}: {
  suggestions: Suggestions;
  busy: boolean;
  retained: boolean;
  onCheck: (index: number, claim: string, urls: string[]) => void;
}) {
  return (
    <section className="desk-check-suggestions" aria-label="Suggested checks">
      <h2>Suggested checks · Unverified</h2>
      <p>
        These editable hypotheses have not been checked. Their rationale and citations do not
        establish support or source independence. Checking a proposition leaves the original answer
        and whole-item Signal unassessed; confidence stays Unknown.
      </p>
      {!suggestions.offered.length && (
        <p>No eligible suggestion was offered. Manual citation checks remain available.</p>
      )}
      {!retained && (
        <p>
          Linked checks require an already retained private answer. This memory-only answer has not
          been saved automatically.
        </p>
      )}
      <ol>
        {suggestions.offered.map((offered, index) => (
          <OfferedCheck
            key={index}
            offered={offered}
            index={index}
            busy={busy}
            retained={retained}
            onCheck={onCheck}
          />
        ))}
      </ol>
    </section>
  );
}
