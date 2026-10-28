import { useEffect, useState } from 'react';
import type { PersonalState } from '../../../packages/domain/src/search-priority.js';

export function PersonalEditor({
  name,
  value,
  onSave,
}: {
  name: string;
  value?: PersonalState;
  onSave: (value: PersonalState) => Promise<void>;
}) {
  const [note, setNote] = useState(value?.note ?? ''),
    [feedback, setFeedback] = useState<PersonalState['feedback']>(value?.feedback ?? 'none'),
    [novelty, setNovelty] = useState<PersonalState['novelty']>(value?.novelty ?? 'unknown'),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    setNote(value?.note ?? '');
    setFeedback(value?.feedback ?? 'none');
    setNovelty(value?.novelty ?? 'unknown');
  }, [value]);
  return (
    <details>
      <summary>Private note and feedback</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          void onSave({ note, feedback, novelty, seenAt: new Date().toISOString() }).finally(() =>
            setBusy(false),
          );
        }}
      >
        <label>
          Note for {name}
          <textarea
            maxLength={5000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        <label>
          Feedback for {name}
          <select
            value={feedback}
            onChange={(event) => setFeedback(event.target.value as PersonalState['feedback'])}
          >
            <option value="none">No feedback</option>
            <option value="useful">Useful</option>
            <option value="skip">Skip for now</option>
            <option value="mute">Mute</option>
          </select>
        </label>
        <label>
          Personal novelty for {name}
          <select
            value={novelty}
            onChange={(event) => setNovelty(event.target.value as PersonalState['novelty'])}
          >
            <option value="unknown">Unknown</option>
            <option value="confirmed-new">New to me</option>
            <option value="known">Already known to me</option>
          </select>
        </label>
        <button disabled={busy}>{busy ? 'Saving note…' : 'Save private note'}</button>
        <p>Private annotations do not add evidence strength or appear in Pages.</p>
      </form>
    </details>
  );
}
