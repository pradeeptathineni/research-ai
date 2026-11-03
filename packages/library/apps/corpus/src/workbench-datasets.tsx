import { useEffect, useMemo, useState, type FormEvent } from 'react';

type DatasetVersionRef = {
  schemaVersion: 1;
  datasetId: string;
  version: number;
  sha256: string;
  name: string;
};
type DatasetMetadata = {
  source: { label: string; uri?: string };
  license: { status: 'user-provided' | 'known' | 'unknown'; name?: string; uri?: string };
  authorization: { status: 'user-confirmed'; recordedAt: string };
};
type DatasetResponse = { ref: DatasetVersionRef; metadata: DatasetMetadata };
type DatasetListResponse = { datasets: DatasetVersionRef[] };
type DatasetReadResponse = DatasetResponse & { bytesBase64: string };
type LocalApi = <T>(route: string, body?: unknown) => Promise<T>;
type PreparedFile = { file: File; bytes: Uint8Array; sha256: string };

const maxBytes = 1024 * 1024;

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function digest(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const hash = await crypto.subtle.digest('SHA-256', copy.buffer);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function latestByDataset(refs: DatasetVersionRef[]): DatasetVersionRef[] {
  const latest = new Map<string, DatasetVersionRef>();
  for (const ref of refs) {
    const current = latest.get(ref.datasetId);
    if (!current || ref.version > current.version) latest.set(ref.datasetId, ref);
  }
  return [...latest.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function DatasetWorkbench({ api }: { api: LocalApi }) {
  const [datasets, setDatasets] = useState<DatasetVersionRef[]>([]);
  const [file, setFile] = useState<PreparedFile | null>(null);
  const [sourceLabel, setSourceLabel] = useState('');
  const [sourceUri, setSourceUri] = useState('');
  const [licenseStatus, setLicenseStatus] =
    useState<DatasetMetadata['license']['status']>('unknown');
  const [licenseName, setLicenseName] = useState('');
  const [licenseUri, setLicenseUri] = useState('');
  const [authorizationConfirmed, setAuthorizationConfirmed] = useState(false);
  const [updateDatasetId, setUpdateDatasetId] = useState('');
  const [reopened, setReopened] = useState<{ ref: DatasetVersionRef; byteLength: number } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const latest = useMemo(() => latestByDataset(datasets), [datasets]);

  async function reload() {
    const response = await api<DatasetListResponse>('datasets');
    setDatasets(response.datasets);
  }

  useEffect(() => {
    void reload().catch((failure: unknown) =>
      setError(failure instanceof Error ? failure.message : String(failure)),
    );
  }, []);

  async function chooseFile(selected: File | undefined) {
    setError('');
    setMessage('');
    setReopened(null);
    if (!selected) {
      setFile(null);
      return;
    }
    if (!selected.name.toLowerCase().endsWith('.csv')) {
      setFile(null);
      setError('Choose a CSV file.');
      return;
    }
    if (selected.size > maxBytes) {
      setFile(null);
      setError('This file exceeds the 1 MB import limit.');
      return;
    }
    const bytes = new Uint8Array(await selected.arrayBuffer());
    setFile({ file: selected, bytes, sha256: await digest(bytes) });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || !authorizationConfirmed) return;
    setBusy(true);
    setError('');
    setMessage('');
    setReopened(null);
    try {
      const metadata: DatasetMetadata = {
        source: {
          label: sourceLabel.trim(),
          ...(sourceUri.trim() ? { uri: sourceUri.trim() } : {}),
        },
        license: {
          status: licenseStatus,
          ...(licenseStatus !== 'unknown' && licenseName.trim()
            ? { name: licenseName.trim() }
            : {}),
          ...(licenseStatus !== 'unknown' && licenseUri.trim() ? { uri: licenseUri.trim() } : {}),
        },
        authorization: { status: 'user-confirmed', recordedAt: new Date().toISOString() },
      };
      const body = { name: file.file.name, bytesBase64: encodeBase64(file.bytes), ...metadata };
      const target = latest.find((ref) => ref.datasetId === updateDatasetId);
      const response = target
        ? await api<DatasetResponse>(`datasets/${target.datasetId}/versions`, {
            ...body,
            expectedHead: target,
          })
        : await api<DatasetResponse>('datasets', body);
      await reload();
      setMessage(`Saved version ${response.ref.version} (${response.ref.sha256}).`);
      setFile(null);
      setUpdateDatasetId('');
      setAuthorizationConfirmed(false);
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message : String(failure);
      setError(
        reason.includes('409') ||
          reason.includes('dataset_head_changed') ||
          reason.toLowerCase().includes('conflict')
          ? 'The dataset changed since you reviewed it. Reload the list and review the new head before saving this version.'
          : reason,
      );
    } finally {
      setBusy(false);
    }
  }

  async function reopen(ref: DatasetVersionRef) {
    setBusy(true);
    setError('');
    setMessage('');
    setReopened(null);
    try {
      const query = new URLSearchParams({ ref: JSON.stringify(ref) });
      const response = await api<DatasetReadResponse>(`datasets/${ref.datasetId}?${query}`);
      const bytes = decodeBase64(response.bytesBase64);
      const actual = await digest(bytes);
      if (
        actual !== ref.sha256 ||
        response.ref.datasetId !== ref.datasetId ||
        response.ref.version !== ref.version ||
        response.ref.sha256 !== ref.sha256 ||
        response.ref.name !== ref.name
      )
        throw new Error('The reopened bytes do not match the selected dataset digest.');
      setReopened({ ref: response.ref, byteLength: bytes.byteLength });
      setMessage(`Reopened version ${ref.version}; the exact bytes match SHA-256 ${actual}.`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="dataset-workbench" aria-labelledby="datasets-title">
      <div className="intro">
        <h1 id="datasets-title">Datasets</h1>
        <p>
          Store exact CSV bytes by immutable version and reopen them with a digest check. CSV
          parsing and analysis are not enabled in this slice.
        </p>
      </div>
      <form onSubmit={(event) => void submit(event)}>
        <h2>Review a CSV import</h2>
        <label>
          CSV file (up to 1 MB)
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => void chooseFile(event.currentTarget.files?.[0])}
          />
        </label>
        {file && (
          <dl className="dataset-preview">
            <div>
              <dt>File</dt>
              <dd>{file.file.name}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{file.bytes.byteLength.toLocaleString()} bytes</dd>
            </div>
            <div>
              <dt>SHA-256</dt>
              <dd>
                <code>{file.sha256}</code>
              </dd>
            </div>
          </dl>
        )}
        <label>
          Source description (your assertion)
          <input
            required
            maxLength={300}
            value={sourceLabel}
            onChange={(event) => setSourceLabel(event.target.value)}
          />
        </label>
        <label>
          Source URI (optional)
          <input
            type="url"
            value={sourceUri}
            onChange={(event) => setSourceUri(event.target.value)}
            placeholder="https://…"
          />
        </label>
        <label>
          License status (your assertion)
          <select
            value={licenseStatus}
            onChange={(event) =>
              setLicenseStatus(event.target.value as DatasetMetadata['license']['status'])
            }
          >
            <option value="unknown">Unknown</option>
            <option value="user-provided">User provided</option>
            <option value="known">Known</option>
          </select>
        </label>
        {licenseStatus !== 'unknown' && (
          <>
            <label>
              License name
              <input
                required
                value={licenseName}
                onChange={(event) => setLicenseName(event.target.value)}
              />
            </label>
            <label>
              License URI (optional)
              <input
                type="url"
                value={licenseUri}
                onChange={(event) => setLicenseUri(event.target.value)}
                placeholder="https://…"
              />
            </label>
          </>
        )}
        {latest.length > 0 && (
          <label>
            Save as a new version (optional)
            <select
              value={updateDatasetId}
              onChange={(event) => setUpdateDatasetId(event.target.value)}
            >
              <option value="">Create a new dataset</option>
              {latest.map((ref) => (
                <option key={ref.datasetId} value={ref.datasetId}>
                  {ref.name} · current version {ref.version}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="dataset-confirmation">
          <input
            type="checkbox"
            checked={authorizationConfirmed}
            onChange={(event) => setAuthorizationConfirmed(event.target.checked)}
          />
          I confirm I am authorized to retain these bytes. Source and license details are my
          assertions and are not independently verified.
        </label>
        <button disabled={busy || !file || !sourceLabel.trim() || !authorizationConfirmed}>
          Save dataset version
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <section aria-labelledby="saved-datasets-title">
        <h2 id="saved-datasets-title">Saved versions</h2>
        <button type="button" disabled={busy} onClick={() => void reload()}>
          Reload saved versions
        </button>
        {datasets.length === 0 ? (
          <p>No datasets saved yet.</p>
        ) : (
          <ul className="dataset-version-list">
            {datasets.map((ref) => (
              <li key={`${ref.datasetId}:${ref.version}`}>
                <div>
                  <strong>{ref.name}</strong>
                  <p>
                    Version {ref.version} · SHA-256 <code>{ref.sha256}</code>
                  </p>
                </div>
                <button type="button" disabled={busy} onClick={() => void reopen(ref)}>
                  Reopen exact version
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {reopened && (
        <section aria-label="Cold reopen result">
          <h2>Version reopened</h2>
          <p>
            {reopened.ref.name} · version {reopened.ref.version} ·{' '}
            {reopened.byteLength.toLocaleString()} bytes.
          </p>
          <p>
            The exact bytes passed the SHA-256 check. Source and license metadata remain caller
            assertions.
          </p>
          <p>
            Table analysis is unavailable until the accepted CSV and analysis methods are installed.
          </p>
        </section>
      )}
    </section>
  );
}
