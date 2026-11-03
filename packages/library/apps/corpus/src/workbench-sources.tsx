import { useState } from 'react';
import type { SearchSettings } from '../../../packages/corpus/src/search-settings.js';
import type { scanSources } from '../../../packages/corpus/src/search-sources.js';

type OpmlPreview = {
  inputDigest: string;
  settingsDigest: string;
  previewDigest: string;
  currentCount: number;
  resultingCount: number;
  acquisition: 'not_started';
  sources: { url: string; label: string; status: 'add' | 'update' | 'unchanged' }[];
};
type SourceApi = <T>(route: string, body?: unknown) => Promise<T>;
const pendingOpmlKey = 'research.pending-opml-import';

export function SourceManager({
  settings,
  onChange,
  scan,
  api,
}: {
  settings: SearchSettings;
  onChange: (settings: SearchSettings) => void;
  scan: () => Promise<Awaited<ReturnType<typeof scanSources>>>;
  api: SourceApi;
}) {
  const [uri, setUri] = useState(''),
    [label, setLabel] = useState(''),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<Awaited<ReturnType<typeof scanSources>> | null>(null),
    [error, setError] = useState('');
  const [opml, setOpml] = useState(''),
    [opmlName, setOpmlName] = useState(''),
    [preview, setPreview] = useState<OpmlPreview | null>(null),
    [reviewed, setReviewed] = useState(false),
    [importRequestId, setImportRequestId] = useState(() =>
      typeof window === 'undefined' ? '' : (window.sessionStorage.getItem(pendingOpmlKey) ?? ''),
    ),
    [opmlMessage, setOpmlMessage] = useState('');
  function rememberImport(requestId: string) {
    window.sessionStorage.setItem(pendingOpmlKey, requestId);
    setImportRequestId(requestId);
  }
  async function requireSavedSettings() {
    const saved = await api<SearchSettings>('settings');
    if (JSON.stringify(saved) !== JSON.stringify(settings))
      throw new Error('Save or discard your other settings edits before importing sources.');
  }
  async function recoverImport(requestId: string) {
    const status = await api<{ found: boolean; receipt?: { configured: number } }>(
      `briefing/opml/import-status?requestId=${encodeURIComponent(requestId)}`,
    );
    if (!status.found) {
      setOpmlMessage(
        'Import outcome is unknown. Check this request before starting another import.',
      );
      return;
    }
    onChange(await api<SearchSettings>('settings'));
    setPreview(null);
    setReviewed(false);
    window.sessionStorage.removeItem(pendingOpmlKey);
    setImportRequestId('');
    setOpmlMessage(
      `Import saved. ${status.receipt?.configured ?? 0} sources are configured. No sources were fetched.`,
    );
  }
  return (
    <section aria-label="Followed sources">
      <h2>Followed sources</h2>
      <p>
        Follow feeds, communities and curated pages while keeping broad discovery available. Save
        Settings before scanning.
      </p>
      <details>
        <summary>Import or export OPML sources</summary>
        <p>
          Import adds or updates source names after review. It does not fetch feeds or change saved
          stories.
        </p>
        <label>
          OPML file (up to 1 MB)
          <input
            type="file"
            accept=".opml,text/xml,application/xml"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              setPreview(null);
              setReviewed(false);
              setOpml('');
              setOpmlName(file?.name ?? '');
              setOpmlMessage('');
              if (!file) return;
              if (file.size > 1_000_000) {
                setOpmlMessage('The OPML file exceeds 1 MB.');
                return;
              }
              void file
                .text()
                .then(setOpml)
                .catch((failure: unknown) => setOpmlMessage(String(failure)));
            }}
          />
        </label>
        <div className="actions">
          <button
            type="button"
            disabled={!opml || busy}
            onClick={() => {
              setBusy(true);
              setOpmlMessage('');
              void requireSavedSettings()
                .then(() => api<OpmlPreview>('briefing/opml/preview', { opml }))
                .then((value) => {
                  setPreview(value);
                  setReviewed(false);
                })
                .catch((failure: unknown) => setOpmlMessage(String(failure)))
                .finally(() => setBusy(false));
            }}
          >
            Preview OPML import
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setOpmlMessage('');
              void api<{ opml: string; sourceCount: number }>('briefing/opml/export')
                .then(({ opml: exported, sourceCount }) => {
                  const url = URL.createObjectURL(
                    new Blob([exported], { type: 'text/xml;charset=utf-8' }),
                  );
                  const anchor = document.createElement('a');
                  anchor.href = url;
                  anchor.download = 'research-following.opml';
                  anchor.click();
                  URL.revokeObjectURL(url);
                  setOpmlMessage(
                    `Exported ${sourceCount} retained sources. Unsaved edits are not included.`,
                  );
                })
                .catch((failure: unknown) => setOpmlMessage(String(failure)))
                .finally(() => setBusy(false));
            }}
          >
            Export saved sources
          </button>
        </div>
        {preview && (
          <section aria-label="OPML import preview">
            <p>
              {opmlName}: {preview.sources.length} entries · {preview.currentCount} current ·{' '}
              {preview.resultingCount} after import. Acquisition: not started.
            </p>
            <ul>
              {preview.sources.map((source) => (
                <li key={source.url}>
                  {source.status}: {source.label} · {source.url}
                </li>
              ))}
            </ul>
            <label className="check">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(event) => setReviewed(event.target.checked)}
              />
              I reviewed these source changes.
            </label>
            <button
              type="button"
              disabled={!reviewed || busy || Boolean(importRequestId)}
              onClick={() => {
                setBusy(true);
                setOpmlMessage('');
                void requireSavedSettings()
                  .then(async () => {
                    const requestId = crypto.randomUUID();
                    rememberImport(requestId);
                    try {
                      await api('briefing/opml/import', {
                        opml,
                        requestId,
                        inputDigest: preview.inputDigest,
                        settingsDigest: preview.settingsDigest,
                        previewDigest: preview.previewDigest,
                      });
                      await recoverImport(requestId);
                    } catch (failure) {
                      setOpmlMessage(`Import response was not confirmed: ${String(failure)}`);
                      try {
                        await recoverImport(requestId);
                      } catch {
                        /* Keep the request for explicit recovery. */
                      }
                    }
                  })
                  .catch((failure: unknown) => setOpmlMessage(String(failure)))
                  .finally(() => setBusy(false));
              }}
            >
              Import reviewed sources
            </button>
          </section>
        )}
        {importRequestId && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void recoverImport(importRequestId)
                .catch((failure: unknown) => setOpmlMessage(String(failure)))
                .finally(() => setBusy(false));
            }}
          >
            Check import status
          </button>
        )}
        {opmlMessage && <p role="status">{opmlMessage}</p>}
      </details>
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
