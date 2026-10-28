import { useState } from 'react';
import type { SearchSettings } from '../../../packages/corpus/src/search-settings.js';
import type { scanSources } from '../../../packages/corpus/src/search-sources.js';
export function SourceManager({
  settings,
  onChange,
  scan,
}: {
  settings: SearchSettings;
  onChange: (settings: SearchSettings) => void;
  scan: () => Promise<Awaited<ReturnType<typeof scanSources>>>;
}) {
  const [uri, setUri] = useState(''),
    [label, setLabel] = useState(''),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<Awaited<ReturnType<typeof scanSources>> | null>(null),
    [error, setError] = useState('');
  return (
    <section aria-label="Followed sources">
      <h2>Followed sources</h2>
      <p>
        Follow feeds, communities and curated pages while keeping broad discovery available. Save
        Settings before scanning.
      </p>
      <label>
        Source URL
        <input type="url" value={uri} onChange={(event) => setUri(event.target.value)} />
      </label>
      <label>
        Source name
        <input maxLength={200} value={label} onChange={(event) => setLabel(event.target.value)} />
      </label>
      <button
        type="button"
        disabled={!uri || !label}
        onClick={() => {
          onChange({
            ...settings,
            followedSources: [
              ...(settings.followedSources ?? []),
              { uri, label, enabled: true, interests: [] },
            ],
          });
          setUri('');
          setLabel('');
        }}
      >
        Add followed source
      </button>
      {(settings.followedSources ?? []).map((source, index) => (
        <fieldset key={source.uri}>
          <legend>{source.label}</legend>
          <a href={source.uri} rel="noreferrer">
            {source.uri}
          </a>
          <label className="check">
            <input
              type="checkbox"
              checked={source.enabled}
              onChange={(event) =>
                onChange({
                  ...settings,
                  followedSources: settings.followedSources!.map((s, i) =>
                    i === index ? { ...s, enabled: event.target.checked } : s,
                  ),
                })
              }
            />
            Follow
          </label>
          <label>
            Interest IDs (blank follows globally)
            <input
              defaultValue={source.interests.join(', ')}
              onBlur={(event) =>
                onChange({
                  ...settings,
                  followedSources: settings.followedSources!.map((s, i) =>
                    i === index
                      ? { ...s, interests: event.target.value.split(/[\s,]+/).filter(Boolean) }
                      : s,
                  ),
                })
              }
            />
          </label>
          <button
            onClick={() =>
              onChange({
                ...settings,
                followedSources: settings.followedSources!.filter((_, i) => i !== index),
              })
            }
          >
            Remove source
          </button>
        </fieldset>
      ))}
      <button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError('');
          void scan()
            .then(setResult)
            .catch((e) => setError(String(e)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? 'Scanning sources…' : 'Scan followed sources without AI'}
      </button>
      {error && <p role="alert">{error}</p>}
      {result && (
        <ul>
          {result.sources.map((source) => (
            <li key={source.uri}>
              <strong>{source.label}</strong>: {source.state} · {source.delta ?? source.reason}
              <p>
                {source.health?.scans ?? 'unknown'} scans;{' '}
                {source.health?.resultExposures ?? source.health?.exposures ?? 'unknown'} result
                exposures; {source.health?.opportunities ?? 0} new-link opportunities; feedback{' '}
                {source.health?.feedback ?? 'unknown'}. Historical denominators may be unknown.
                These counts do not establish usefulness.
              </p>
              <ul>
                {source.newLinks.map((link) => (
                  <li key={link.uri}>
                    <a href={link.uri} rel="noreferrer">
                      {link.title || link.uri}
                    </a>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
