import { useEffect, useMemo, useState, type FormEvent } from 'react';

type DatasetVersionRef = {
  schemaVersion: 1;
  datasetId: string;
  version: number;
  sha256: string;
  name: string;
};
type DatasetMetadata = {
  assertions: 'caller-provided';
  source: { label: string; uri?: string };
  license: { status: 'user-provided' | 'known' | 'unknown'; name?: string; uri?: string };
  authorization: { status: 'user-confirmed'; recordedAt: string };
};
type DatasetWriteMetadata = Omit<DatasetMetadata, 'assertions'>;
type DatasetResponse = { ref: DatasetVersionRef; metadata: DatasetMetadata };
type DatasetListResponse = { datasets: DatasetVersionRef[] };
type DatasetReadResponse = DatasetResponse & { bytesBase64: string };
type LocalApi = <T>(route: string, body?: unknown) => Promise<T>;
type PreparedFile = { file: File; bytes: Uint8Array; sha256: string };
type RegisteredTable = {
  version: 'research-table-v1';
  id: string;
  columns: { id: string; label: string; type: 'text' | 'number' | 'boolean' }[];
  rows: (string | number | boolean | null)[][];
  origin: { type: 'caller-authored' | 'caller-supplied'; label: string };
  sha256: string;
};
type CsvImportReceipt = {
  version: 'research-table-csv-v1';
  csv_sha256: string;
  table_sha256: string;
  parser: { name: 'csv-parse'; version: '7.0.3' };
  headers: 'first-row';
  values: 'text';
};
type ParsedDataset = {
  datasetRef: DatasetVersionRef;
  table: RegisteredTable;
  import: CsvImportReceipt;
};
type AnalysisChart = {
  mark: 'bar' | 'line' | 'scatter';
  step: `s${number}`;
  x: string;
  y: string | null;
  aggregate: 'none' | 'count' | 'sum' | 'avg' | 'min' | 'max';
  series: string | null;
  order: 'x' | 'y-desc';
};
type Analysis = {
  version: 'research-table-analysis-v1';
  id: string;
  revision: number;
  parent_digest: string | null;
  title: string;
  tables: { name: string; id: string; sha256: string }[];
  steps: { name: `s${number}`; sql: string; note?: string }[];
  chart: AnalysisChart | null;
  analysis_digest: string;
};
type AnalysisRef = {
  schemaVersion: 1;
  analysisId: string;
  revision: number;
  analysisDigest: string;
  datasetRef: DatasetVersionRef;
  tableId: string;
  tableSha256: string;
};
type RunRef = {
  schemaVersion: 1;
  runId: string;
  analysisRef: AnalysisRef;
  runDigest: string;
};
type AnalysisEntry = {
  target: { kind: 'step' | 'chart'; step?: string; mode?: 'rows' | 'profile' };
  state: 'complete' | 'failed' | 'unknown' | 'not_started';
  query_digest: string;
  input_digest?: string;
  result_sha256?: string;
  artifact?: {
    query_digest: string;
    input_digest: string;
    result_sha256: string;
    columns: { id: string; label: string; sql_type: string; representation: string }[];
    rows: (string | number | boolean | null)[][];
    qualifications: string[];
  };
  error?: string;
  reason?: string;
};
type AnalysisRun = { state: string; entries: AnalysisEntry[]; run_digest: string };
type ChartResult = {
  points: { x: string | null; series?: string | null; y: string | null }[];
  caption: string;
  disclosures: string[];
};
type Capabilities = {
  csvParser: { available: boolean; reason: 'not_configured' | 'configured_unverified' | null };
  tableEngine: { available: boolean; reason: 'not_configured' | 'configured_unverified' | null };
};
type TableQueryPreview = {
  query: { sql: string; parameters: unknown[] };
  query_digest: string;
  input_digest: string;
  inputs: { name: string; id: string; sha256: string }[];
};
type TableQueryColumn = {
  id: string;
  label: string;
  sql_type: string;
  representation: 'text';
};
type AnalysisResponse = { ref: AnalysisRef; analysis: Analysis };
type AnalysisOpenResponse = AnalysisResponse & {
  dataset: {
    ref: DatasetVersionRef;
    table: RegisteredTable;
    import: CsvImportReceipt;
    metadata: DatasetMetadata;
  };
};
type RunResponse = {
  runRef: RunRef;
  analysisRef: AnalysisRef;
  run: AnalysisRun;
  chart: ChartResult | null;
};

const maxBytes = 1_000_000;

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
  const [reopened, setReopened] = useState<{
    ref: DatasetVersionRef;
    metadata: DatasetMetadata;
    byteLength: number;
  } | null>(null);
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
      const metadata: DatasetWriteMetadata = {
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
      setReopened({ ref: response.ref, metadata: response.metadata, byteLength: bytes.byteLength });
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
          Save exact CSV bytes by version, reopen them with a digest check, and inspect a parsed
          table or saved analysis when the required local tools are configured.
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
                <button
                  type="button"
                  disabled={busy}
                  aria-pressed={
                    reopened?.ref.datasetId === ref.datasetId &&
                    reopened.ref.version === ref.version
                  }
                  onClick={() => void reopen(ref)}
                >
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
          <dl className="dataset-preview">
            <div>
              <dt>Source assertion</dt>
              <dd>{reopened.metadata.source.label}</dd>
            </div>
            {reopened.metadata.source.uri && (
              <div>
                <dt>Source URI</dt>
                <dd>{reopened.metadata.source.uri}</dd>
              </div>
            )}
            <div>
              <dt>License assertion</dt>
              <dd>
                {reopened.metadata.license.status}
                {reopened.metadata.license.name ? ` · ${reopened.metadata.license.name}` : ''}
              </dd>
            </div>
            <div>
              <dt>Authorization</dt>
              <dd>
                {reopened.metadata.authorization.status} ·{' '}
                {new Date(reopened.metadata.authorization.recordedAt).toLocaleString()}
              </dd>
            </div>
          </dl>
          <DatasetAnalysisPanel
            key={`${reopened.ref.datasetId}:${reopened.ref.version}:${reopened.ref.sha256}`}
            api={api}
            datasetRef={reopened.ref}
            metadata={reopened.metadata}
          />
        </section>
      )}
    </section>
  );
}

function sameDataset(left: DatasetVersionRef, right: DatasetVersionRef): boolean {
  return (
    left.datasetId === right.datasetId &&
    left.version === right.version &&
    left.sha256 === right.sha256 &&
    left.name === right.name
  );
}

function analysisRefUrl(ref: AnalysisRef): string {
  return `analyses/${ref.analysisId}?${new URLSearchParams({ ref: JSON.stringify(ref) })}`;
}

function runRefUrl(ref: RunRef): string {
  return `analyses/${ref.analysisRef.analysisId}/runs/${ref.runId}?${new URLSearchParams({ ref: JSON.stringify(ref) })}`;
}

function DatasetAnalysisPanel({
  api,
  datasetRef,
  metadata,
}: {
  api: LocalApi;
  datasetRef: DatasetVersionRef;
  metadata: DatasetMetadata;
}) {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [analysisRefs, setAnalysisRefs] = useState<AnalysisRef[]>([]);
  const [parsed, setParsed] = useState<ParsedDataset | null>(null);
  const [analysisRef, setAnalysisRef] = useState<AnalysisRef | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [runRefs, setRunRefs] = useState<RunRef[]>([]);
  const [runResult, setRunResult] = useState<RunResponse | null>(null);
  const [title, setTitle] = useState(`${datasetRef.name} analysis`);
  const [tableName, setTableName] = useState('sample');
  const [chartX, setChartX] = useState('');
  const [preview, setPreview] = useState<TableQueryPreview | null>(null);
  const [chartPreview, setChartPreview] = useState<TableQueryPreview | null>(null);
  const [reviewedPreview, setReviewedPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const applicableAnalyses = useMemo(
    () => analysisRefs.filter((ref) => sameDataset(ref.datasetRef, datasetRef)),
    [analysisRefs, datasetRef],
  );
  const supportsSingleStepEditor =
    analysis === null ||
    (analysis.steps.length === 1 && analysis.steps[0]?.sql === `SELECT * FROM ${tableName}`);
  const supportsRunPreview =
    analysis === null ||
    (supportsSingleStepEditor &&
      analysis.chart?.mark === 'bar' &&
      analysis.chart.step === 's1' &&
      analysis.chart.aggregate === 'count' &&
      analysis.chart.y === null &&
      analysis.chart.series === null);
  const canSaveAnalysis = Boolean(
    parsed && title.trim() && /^[a-z][a-z0-9_]{0,31}$/u.test(tableName) && chartX,
  );
  const canRun = Boolean(
    analysisRef &&
    preview &&
    chartPreview &&
    reviewedPreview &&
    capabilities?.tableEngine.available &&
    supportsRunPreview &&
    !busy,
  );

  async function reloadLists() {
    const [analysisList, capabilityStatus] = await Promise.allSettled([
      api<{ analyses: AnalysisRef[] }>('analyses'),
      api<Capabilities>('datasets/capabilities'),
    ]);
    if (analysisList.status === 'fulfilled') setAnalysisRefs(analysisList.value.analyses);
    if (capabilityStatus.status === 'fulfilled') setCapabilities(capabilityStatus.value);
    const failure = [analysisList, capabilityStatus].find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  async function reloadRuns(ref: AnalysisRef) {
    const response = await api<{ analysisRef: AnalysisRef; runs: RunRef[] }>(
      `analyses/${ref.analysisId}/runs?${new URLSearchParams({ ref: JSON.stringify(ref) })}`,
    );
    if (response.analysisRef.analysisDigest !== ref.analysisDigest)
      throw new Error('Saved run references belong to a different analysis revision.');
    setRunRefs(response.runs);
  }

  useEffect(() => {
    let current = true;
    void reloadLists().catch((failure: unknown) => {
      if (current) setError(failure instanceof Error ? failure.message : String(failure));
    });
    return () => {
      current = false;
    };
  }, [api, datasetRef.datasetId, datasetRef.version, datasetRef.sha256]);

  function acceptParsedTable(response: ParsedDataset) {
    if (
      !sameDataset(response.datasetRef, datasetRef) ||
      response.import.csv_sha256 !== datasetRef.sha256 ||
      response.import.table_sha256 !== response.table.sha256
    ) {
      throw new Error('The parsed table does not match the selected source version.');
    }
    setParsed(response);
    setTableName('sample');
    setChartX(response.table.columns.length ? 'q0' : '');
    setMessage(
      `Parsed ${response.table.rows.length} rows. All ${response.table.columns.length} columns and cell values remain text.`,
    );
  }

  async function openSavedTable() {
    setBusy(true);
    setError('');
    setMessage('');
    setParsed(null);
    try {
      const query = new URLSearchParams({ ref: JSON.stringify(datasetRef) });
      const response = await api<ParsedDataset>(`datasets/${datasetRef.datasetId}/table?${query}`);
      acceptParsedTable(response);
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message : String(failure);
      setError(
        reason.includes('dataset_table_not_parsed')
          ? 'No parsed table is saved for this version yet. Parse it when the host CSV parser is available.'
          : reason,
      );
    } finally {
      setBusy(false);
    }
  }

  async function parseSelectedDataset() {
    setBusy(true);
    setError('');
    setMessage('');
    setParsed(null);
    setAnalysisRef(null);
    setAnalysis(null);
    setRunRefs([]);
    setRunResult(null);
    setPreview(null);
    setChartPreview(null);
    setReviewedPreview(false);
    try {
      const response = await api<ParsedDataset>(`datasets/${datasetRef.datasetId}/parse`, {
        ref: datasetRef,
      });
      acceptParsedTable(response);
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message : String(failure);
      setError(
        reason.includes('csv_parser_unavailable')
          ? 'The host CSV parser is unavailable or does not match the required csv-parse 7.0.3 package.'
          : reason,
      );
    } finally {
      setBusy(false);
    }
  }

  async function openAnalysis(ref: AnalysisRef) {
    setBusy(true);
    setError('');
    setMessage('');
    setPreview(null);
    setChartPreview(null);
    setReviewedPreview(false);
    setRunResult(null);
    try {
      const response = await api<AnalysisOpenResponse>(analysisRefUrl(ref));
      if (
        response.ref.analysisDigest !== ref.analysisDigest ||
        !sameDataset(response.dataset.ref, datasetRef) ||
        response.dataset.table.id !== ref.tableId ||
        response.dataset.table.sha256 !== ref.tableSha256
      ) {
        throw new Error('The saved analysis does not match this exact dataset version.');
      }
      setAnalysisRef(response.ref);
      setAnalysis(response.analysis);
      setParsed({
        datasetRef: response.dataset.ref,
        table: response.dataset.table,
        import: response.dataset.import,
      });
      setTitle(response.analysis.title);
      setTableName(response.analysis.tables[0]?.name ?? 'sample');
      setChartX(response.analysis.chart?.x ?? (response.dataset.table.columns.length ? 'q0' : ''));
      await reloadRuns(response.ref);
      setMessage(`Reopened analysis revision ${response.ref.revision}.`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  async function saveAnalysis() {
    if (!parsed || !canSaveAnalysis) return;
    setBusy(true);
    setError('');
    setMessage('');
    setPreview(null);
    setChartPreview(null);
    setReviewedPreview(false);
    setRunResult(null);
    try {
      const chart: AnalysisChart = {
        mark: 'bar',
        step: 's1',
        x: chartX,
        y: null,
        aggregate: 'count',
        series: null,
        order: 'x',
      };
      const body = {
        datasetRef,
        tableSha256: parsed.table.sha256,
        tableName: tableName.trim(),
        title: title.trim(),
        steps: [{ name: 's1' as const, sql: `SELECT * FROM ${tableName.trim()}` }],
        chart,
      };
      const response = analysisRef
        ? await api<AnalysisResponse>(`analyses/${analysisRef.analysisId}/revisions`, {
            ...body,
            expectedHead: analysisRef,
          })
        : await api<AnalysisResponse>('analyses', body);
      setAnalysisRef(response.ref);
      setAnalysis(response.analysis);
      setAnalysisRefs((current) => [...current, response.ref]);
      setRunRefs([]);
      setMessage(
        `Saved analysis revision ${response.ref.revision}. Review its compiled query before running.`,
      );
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message : String(failure);
      if (reason.includes('analysis_head_changed')) {
        setError(
          'A newer analysis revision exists. Reload saved analyses before saving another revision.',
        );
      } else {
        setError(reason);
      }
    } finally {
      setBusy(false);
    }
  }

  async function previewAnalysis() {
    if (!analysisRef || !parsed || !supportsRunPreview) return;
    setBusy(true);
    setError('');
    setMessage('');
    setPreview(null);
    setChartPreview(null);
    setReviewedPreview(false);
    setRunResult(null);
    try {
      const response = await api<{ ref: AnalysisRef; preview: TableQueryPreview }>(
        `analyses/${analysisRef.analysisId}/preview`,
        { ref: analysisRef, target: { kind: 'step', step: 's1', mode: 'rows' } },
      );
      if (response.ref.analysisDigest !== analysisRef.analysisDigest)
        throw new Error('The preview belongs to a different analysis revision.');
      setPreview(response.preview);
      const chartColumns: TableQueryColumn[] = parsed!.table.columns.map((column, index) => ({
        id: `q${index}`,
        label: column.label,
        sql_type: 'VARCHAR',
        representation: 'text',
      }));
      const chartResponse = await api<{ ref: AnalysisRef; preview: TableQueryPreview }>(
        `analyses/${analysisRef.analysisId}/preview`,
        { ref: analysisRef, target: { kind: 'chart', columns: chartColumns } },
      );
      if (chartResponse.ref.analysisDigest !== analysisRef.analysisDigest)
        throw new Error('The chart preview belongs to a different analysis revision.');
      setChartPreview(chartResponse.preview);
      setMessage(
        'Review both compiled queries and their exact input digests before running this saved analysis.',
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  async function runAnalysis() {
    if (!analysisRef || !canRun) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await api<RunResponse>(`analyses/${analysisRef.analysisId}/run`, {
        ref: analysisRef,
      });
      if (
        response.analysisRef.analysisDigest !== analysisRef.analysisDigest ||
        response.runRef.runDigest !== response.run.run_digest
      ) {
        throw new Error('The saved run does not match the selected analysis digest.');
      }
      setRunResult(response);
      setRunRefs((current) => [
        response.runRef,
        ...current.filter((ref) => ref.runId !== response.runRef.runId),
      ]);
      setMessage(`Saved run ${response.runRef.runId} (${response.run.state}).`);
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message : String(failure);
      await reloadRuns(analysisRef).catch(() => undefined);
      setError(
        reason.includes('table_engine_unavailable')
          ? 'The host DuckDB runtime is unavailable. Running stays disabled until its configured package is available.'
          : `${reason} Check saved runs before trying again; the previous run may have been saved.`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function reopenRun(ref: RunRef) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await api<RunResponse>(runRefUrl(ref));
      if (
        response.runRef.runDigest !== ref.runDigest ||
        response.run.run_digest !== ref.runDigest ||
        response.analysisRef.analysisDigest !== ref.analysisRef.analysisDigest
      ) {
        throw new Error('The cold-opened run does not match its saved digest.');
      }
      setRunResult(response);
      setMessage(`Reopened saved run ${ref.runId}; no query was rerun.`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="dataset-analysis-panel" aria-labelledby="analysis-ready-title">
      <h3 id="analysis-ready-title">Table analysis</h3>
      <dl className="dataset-preview">
        <div>
          <dt>Source assertion</dt>
          <dd>{metadata.source.label}</dd>
        </div>
        <div>
          <dt>License assertion</dt>
          <dd>
            {metadata.license.status}
            {metadata.license.name ? ` · ${metadata.license.name}` : ''}
          </dd>
        </div>
        <div>
          <dt>Source version</dt>
          <dd>
            v{datasetRef.version} · SHA-256 <code>{datasetRef.sha256}</code>
          </dd>
        </div>
      </dl>
      <div className="dataset-capabilities" aria-label="Local analysis capabilities">
        <span>
          CSV parser:{' '}
          {capabilities
            ? capabilities.csvParser.available
              ? 'configured, pending Methods verification'
              : 'not configured'
            : 'checking'}
        </span>
        <span>
          DuckDB:{' '}
          {capabilities
            ? capabilities.tableEngine.available
              ? 'configured, pending Methods verification'
              : 'not configured'
            : 'checking'}
        </span>
      </div>
      {applicableAnalyses.length > 0 && (
        <label>
          Reopen saved analysis revision for this source version
          <select
            value=""
            disabled={busy}
            onChange={(event) => {
              const ref = applicableAnalyses.find(
                (candidate) =>
                  `${candidate.analysisId}:${candidate.revision}` === event.target.value,
              );
              if (ref) void openAnalysis(ref);
            }}
          >
            <option value="">Choose a saved revision</option>
            {applicableAnalyses.map((ref) => (
              <option
                key={`${ref.analysisId}:${ref.revision}`}
                value={`${ref.analysisId}:${ref.revision}`}
              >
                Revision {ref.revision} · {ref.analysisDigest.slice(0, 12)}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <button
        type="button"
        disabled={busy}
        onClick={() => void reloadLists().catch((failure: unknown) => setError(String(failure)))}
      >
        Reload analyses and readiness
      </button>
      {!parsed && (
        <div className="dataset-analysis-actions">
          <button type="button" disabled={busy} onClick={() => void openSavedTable()}>
            Reopen saved parsed table
          </button>
          <button
            type="button"
            disabled={busy || !capabilities?.csvParser.available}
            onClick={() => void parseSelectedDataset()}
          >
            Parse and inspect this exact version
          </button>
        </div>
      )}
      {!parsed ? (
        <p>
          A saved analysis or parsed table can reopen without reparsing. New CSV parsing requires a
          host-configured parser.
        </p>
      ) : (
        <>
          <section aria-labelledby="parsed-table-title">
            <h4 id="parsed-table-title">Parsed table</h4>
            <p>
              {parsed.table.rows.length} rows · {parsed.table.columns.length} columns · table
              SHA-256 <code>{parsed.table.sha256}</code>
            </p>
            <p>
              CSV SHA-256 <code>{parsed.import.csv_sha256}</code> · parser{' '}
              {parsed.import.parser.name} {parsed.import.parser.version} · first-row headers · all
              values retained as text.
            </p>
            <div className="dataset-table-scroll">
              <table>
                <thead>
                  <tr>
                    {parsed.table.columns.map((column) => (
                      <th key={column.id} scope="col">
                        {column.label}
                        <small>
                          {column.id} · {column.type}
                        </small>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {parsed.table.rows.slice(0, 40).map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, columnIndex) => (
                        <td key={parsed.table.columns[columnIndex]?.id ?? columnIndex}>
                          {cell === null ? '∅' : String(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {parsed.table.rows.length > 40 && (
              <p>Showing first 40 of {parsed.table.rows.length} rows.</p>
            )}
          </section>
          <section aria-labelledby="analysis-editor-title">
            <h4 id="analysis-editor-title">Reproducible analysis</h4>
            {!supportsSingleStepEditor && (
              <p role="status">
                This saved analysis uses a query shape this editor cannot revise. It can still be
                reopened, but preview and run are disabled for it.
              </p>
            )}
            <label>
              Analysis title
              <input
                disabled={!supportsSingleStepEditor || busy}
                maxLength={120}
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  setPreview(null);
                  setChartPreview(null);
                  setReviewedPreview(false);
                }}
              />
            </label>
            <label>
              SQL table name
              <input
                disabled={!supportsSingleStepEditor || busy}
                pattern="[a-z][a-z0-9_]{0,31}"
                value={tableName}
                onChange={(event) => {
                  setTableName(event.target.value);
                  setPreview(null);
                  setChartPreview(null);
                  setReviewedPreview(false);
                }}
              />
            </label>
            <p>
              Step s1 uses <code>SELECT * FROM {tableName || 'sample'}</code> over this exact table.
              The alias is validated before Methods compiles the query.
            </p>
            <label>
              Bar chart category (counts rows per category)
              <select
                disabled={!supportsSingleStepEditor || busy}
                value={chartX}
                onChange={(event) => {
                  setChartX(event.target.value);
                  setPreview(null);
                  setChartPreview(null);
                  setReviewedPreview(false);
                }}
              >
                {parsed.table.columns.map((column, index) => (
                  <option key={column.id} value={`q${index}`}>
                    {column.label}
                  </option>
                ))}
              </select>
            </label>
            <p>
              The chart uses the saved s1 results and counts each category. No source values are
              converted into numbers.
            </p>
            <button
              type="button"
              disabled={busy || !canSaveAnalysis || !supportsSingleStepEditor}
              onClick={() => void saveAnalysis()}
            >
              {analysisRef ? 'Save a new analysis revision' : 'Save analysis and chart definition'}
            </button>
            {analysisRef && (
              <>
                <p>
                  Saved analysis revision {analysisRef.revision} · digest{' '}
                  <code>{analysisRef.analysisDigest}</code>.
                </p>
                <button
                  type="button"
                  disabled={busy || !supportsRunPreview}
                  onClick={() => void previewAnalysis()}
                >
                  Preview compiled SQL
                </button>
                {!supportsRunPreview && (
                  <p role="status">
                    Preview and run are available here only for a single-step SELECT-all analysis
                    with a bar count chart.
                  </p>
                )}
              </>
            )}
            {preview && chartPreview && (
              <section aria-label="Compiled query review">
                <h5>Review before running</h5>
                <h6>Step query</h6>
                <p>
                  Query digest <code>{preview.query_digest}</code> · input digest{' '}
                  <code>{preview.input_digest}</code>.
                </p>
                <pre>{preview.query.sql}</pre>
                <h6>Bar chart query</h6>
                <p>
                  Query digest <code>{chartPreview.query_digest}</code> · input digest{' '}
                  <code>{chartPreview.input_digest}</code>.
                </p>
                <pre>{chartPreview.query.sql}</pre>
                <label className="dataset-confirmation">
                  <input
                    type="checkbox"
                    checked={reviewedPreview}
                    onChange={(event) => setReviewedPreview(event.target.checked)}
                  />
                  I reviewed both compiled queries and their exact input digests.
                </label>
              </section>
            )}
            <button
              type="button"
              disabled={!canRun}
              onClick={() => void runAnalysis()}
              title={
                !capabilities?.tableEngine.available
                  ? 'The configured DuckDB runtime is unavailable'
                  : undefined
              }
            >
              Run and save result
            </button>
            {!capabilities?.tableEngine.available && (
              <p>Running is unavailable until a host-configured DuckDB package is available.</p>
            )}
            {runRefs.length > 0 && (
              <label>
                Reopen saved result
                <select
                  value=""
                  onChange={(event) => {
                    const ref = runRefs.find((candidate) => candidate.runId === event.target.value);
                    if (ref) void reopenRun(ref);
                  }}
                >
                  <option value="">Choose a saved run</option>
                  {runRefs.map((ref) => (
                    <option key={ref.runId} value={ref.runId}>
                      Run {ref.runId.slice(0, 12)} · {ref.runDigest.slice(0, 12)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </section>
          {runResult && <AnalysisResultView response={runResult} />}
        </>
      )}
    </section>
  );
}

function AnalysisResultView({ response }: { response: RunResponse }) {
  const rowsEntry = response.run.entries.find(
    (entry) => entry.target.kind === 'step' && entry.state === 'complete' && entry.artifact,
  );
  const chartValues =
    response.chart?.points.map((point) => Number(point.y)).filter(Number.isFinite) ?? [];
  const chartMaximum = Math.max(0, ...chartValues);
  return (
    <section aria-labelledby="analysis-run-title">
      <h4 id="analysis-run-title">Saved analysis result</h4>
      <p>
        Run state: {response.run.state} · run digest <code>{response.run.run_digest}</code>
      </p>
      {rowsEntry?.artifact && (
        <>
          <p>
            Query digest <code>{rowsEntry.query_digest}</code> · input digest{' '}
            <code>{rowsEntry.input_digest}</code> · result digest{' '}
            <code>{rowsEntry.result_sha256 ?? rowsEntry.artifact.result_sha256}</code>
          </p>
          <div className="dataset-table-scroll">
            <table>
              <thead>
                <tr>
                  {rowsEntry.artifact.columns.map((column) => (
                    <th key={column.id} scope="col">
                      {column.label}
                      <small>{column.representation}</small>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rowsEntry.artifact.rows.slice(0, 40).map((row, index) => (
                  <tr key={index}>
                    {row.map((cell, columnIndex) => (
                      <td key={columnIndex}>{cell === null ? '∅' : String(cell)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rowsEntry.artifact.qualifications.map((item) => (
            <p key={item}>{item}</p>
          ))}
        </>
      )}
      {response.chart ? (
        <section aria-label="Saved chart data">
          <h5>{response.chart.caption}</h5>
          <ul className="dataset-chart-points">
            {response.chart.points.map((point, index) => (
              <li key={`${point.x ?? 'null'}:${point.series ?? ''}:${index}`}>
                <span>{point.x ?? 'Null'}</span>
                <div className="dataset-chart-bar" aria-hidden="true">
                  <span
                    style={{
                      width:
                        chartMaximum > 0 && Number.isFinite(Number(point.y))
                          ? `${Math.max(0, (Number(point.y) / chartMaximum) * 100)}%`
                          : '0%',
                    }}
                  />
                </div>
                <strong>{point.y ?? 'Null'}</strong>
              </li>
            ))}
          </ul>
          {response.chart.disclosures.map((disclosure) => (
            <p key={disclosure}>{disclosure}</p>
          ))}
        </section>
      ) : (
        <p>No completed chart result is stored in this run.</p>
      )}
    </section>
  );
}
