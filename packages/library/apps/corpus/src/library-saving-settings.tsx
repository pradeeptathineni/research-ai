import { useCallback, useEffect, useRef, useState } from 'react';
import type { LibrarySettings } from '../../../packages/corpus/src/library-settings.js';

type Client = <T>(route: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
type Values = Record<string, boolean | number>;
const values = (view: LibrarySettings, defaults = false): Values =>
  Object.fromEntries(
    view.settings.map((setting) => [setting.id, defaults ? setting.default : setting.effective]),
  );
const display = (value: boolean | number) =>
  typeof value === 'boolean' ? (value ? 'On' : 'Off') : String(value);

export function LibrarySavingSettings({ api }: { api: Client }) {
  const client = useRef(api);
  client.current = api;
  const [view, setView] = useState<LibrarySettings | null>(null);
  const [draft, setDraft] = useState<Values>({});
  const [query, setQuery] = useState('');
  const [reset, setReset] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState('Loading personal-saving defaults…');
  const reload = useCallback(async () => {
    setBusy(true);
    try {
      const current = await client.current<LibrarySettings>('library-settings');
      setView(current);
      setDraft(values(current));
      setReset(false);
      setReviewed(false);
      setUncertain(false);
      setMessage('Personal saving settings loaded.');
    } catch {
      setUncertain(true);
      setMessage('Personal preferences are unavailable. Reload before editing.');
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  async function submit(action: 'preview' | 'save') {
    if (!view) return;
    setBusy(true);
    try {
      const result = await client.current<LibrarySettings>('library-settings', {
        action,
        expectedRevision: view.revision,
        updates: reset ? {} : draft,
        resets: reset ? view.settings.map((setting) => setting.id) : [],
      });
      if (action === 'preview') {
        setReviewed(true);
        setMessage('Personal preferences validated. Review the values, then save.');
      } else {
        setView(result);
        setDraft(values(result));
        setReset(false);
        setReviewed(false);
        setMessage('Personal preferences saved. Applies to the next automatic-saving decision.');
      }
    } catch (failure) {
      setReviewed(false);
      if (action === 'save') {
        setUncertain(true);
        setMessage('Save was not confirmed. Reload personal preferences before another edit.');
      } else
        setMessage(
          failure instanceof Error && failure.message === 'settings_changed'
            ? 'Personal preferences changed. Reload and review again.'
            : 'Invalid personal preferences. Signal must be 0–100; relevance must be 75 or 100.',
        );
    } finally {
      setBusy(false);
    }
  }
  const changed = view && (reset || JSON.stringify(draft) !== JSON.stringify(values(view)));
  return (
    <section className="desk-personal-preferences" aria-label="Personal Library preferences">
      <h2>Personal Library</h2>
      <p>
        Automatic saving is off by default. It saves qualifying workbench research privately and
        never publishes to the public Corpus.
      </p>
      <p role="status" aria-live="polite">
        {message}
      </p>
      <button onClick={() => void reload()} disabled={busy}>
        Reload personal preferences
      </button>
      {view && (
        <>
          <label>
            Find personal-saving settings
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <p>Personal saving · Scope: {view.scope} · No restart required.</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit('preview');
            }}
          >
            {view.settings
              .filter((setting) =>
                `${setting.id} ${setting.label} ${setting.description}`
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              )
              .map((setting) => {
                const constraints = setting.constraints as {
                  type?: string;
                  enum?: number[];
                  minimum?: number;
                  maximum?: number;
                };
                return (
                  <div key={setting.id}>
                    <label>
                      {setting.label}
                      {constraints.type === 'boolean' ? (
                        <input
                          type="checkbox"
                          checked={draft[setting.id] === true}
                          disabled={busy || uncertain}
                          onChange={(event) => {
                            setDraft({ ...draft, [setting.id]: event.target.checked });
                            setReset(false);
                            setReviewed(false);
                          }}
                        />
                      ) : constraints.enum ? (
                        <select
                          value={Number(draft[setting.id])}
                          disabled={busy || uncertain}
                          onChange={(event) => {
                            setDraft({ ...draft, [setting.id]: Number(event.target.value) });
                            setReset(false);
                            setReviewed(false);
                          }}
                        >
                          {constraints.enum.map((value) => (
                            <option key={value} value={value}>
                              {value}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="number"
                          value={Number.isNaN(draft[setting.id]) ? '' : Number(draft[setting.id])}
                          min={constraints.minimum}
                          max={constraints.maximum}
                          step={1}
                          required
                          disabled={busy || uncertain}
                          onChange={(event) => {
                            setDraft({ ...draft, [setting.id]: event.target.valueAsNumber });
                            setReset(false);
                            setReviewed(false);
                          }}
                        />
                      )}
                    </label>
                    <p>{setting.description}</p>
                    <p className="desk-meta">
                      Saved: {display(setting.effective)} · Default: {display(setting.default)} ·
                      Source: {setting.source} · Scope: {setting.scope}
                    </p>
                  </div>
                );
              })}
            <button
              type="button"
              disabled={busy || uncertain}
              onClick={() => {
                setDraft(values(view, true));
                setReset(true);
                setReviewed(false);
              }}
            >
              Use default saving preferences
            </button>
            <p>
              Draft:{' '}
              {view.settings
                .map(
                  (setting) => `${setting.label} ${display(draft[setting.id] ?? setting.default)}`,
                )
                .join(', ')}
              .
            </p>
            <button disabled={busy || uncertain || !changed}>Preview personal preferences</button>
            <button
              type="button"
              disabled={busy || uncertain || !reviewed}
              onClick={() => void submit('save')}
            >
              Save personal preferences
            </button>
          </form>
          <details>
            <summary>Scope and limitations</summary>
            <ul>
              {view.limitations.map((limit) => (
                <li key={limit}>{limit}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}
