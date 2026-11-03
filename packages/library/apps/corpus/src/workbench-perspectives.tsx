import { useEffect, useMemo, useRef, useState } from 'react';
import './workbench-perspectives.css';

type LocalApi = <T>(route: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
type RecordRef = {
  owner: 'signals-ai';
  kind: string;
  id: string;
  revision: string;
  digest: string;
};
type WorkflowRef = {
  schemaVersion: 1;
  workflowId: `workflow:${string}`;
  revision: number;
  sha256: string;
};
type FrozenSource = {
  uri: string;
  text: string;
  sha256: string;
  observedAt?: string;
  omissions?: string[];
};
type PerspectiveWorkflow = {
  version: 'research-perspective-workflow-v1';
  owner: 'research-ai';
  id: `workflow:${string}`;
  topic: string;
  revision: number;
  sources: FrozenSource[];
  lenses: { id: string; label: string; focus: string; origin: string }[];
  perspectiveResult: {
    status: 'complete' | 'partial' | 'failed' | 'cancelled';
    lenses: {
      lens: { id: string; label: string; focus: string; origin: string };
      status: 'complete' | 'failed' | 'cancelled' | 'not_run';
      questions?: {
        question: string;
        status: 'answered' | 'partial' | 'unanswered';
        answer: string;
        citations: {
          source: number;
          start: number;
          end: number;
          quote: string;
          occurrence: 'exact-retained-span';
        }[];
      }[];
      omissions?: string[];
      reason?: string;
    }[];
  } | null;
  comparisons: unknown[];
  outlines: unknown[];
  sha256: string;
};
type CaptureEntry = {
  ref: RecordRef;
  capture: {
    id: string;
    source_uri: string;
    captured_at: string;
    text_sha256: string;
    text: string;
    qualification: string[];
  };
};
type WorkflowSummary = {
  ref: WorkflowRef;
  topic: string;
  sourceRefs: RecordRef[];
  status: 'not_run' | 'complete' | 'partial' | 'failed' | 'cancelled';
};
type ContributionSpan = {
  source: number;
  sourceUri: string;
  sourceSha256: string;
  start: number;
  end: number;
  quote: string;
  citedBy?: string[];
};
type Contribution = {
  lensId: string;
  status: 'complete' | 'failed' | 'cancelled' | 'not_run';
  disposition: string;
  uniqueCitedSpans: ContributionSpan[];
  sharedCitedSpans: ContributionSpan[];
  conflictCitedSpans: ContributionSpan[];
  qualification: string;
  reason?: string;
};
type WorkflowRead = {
  ref: WorkflowRef;
  workflow: PerspectiveWorkflow;
  sourceRefs: RecordRef[];
  contributions: Contribution[] | null;
};
type LensChoice = { label: string; focus: string };
type AdditionPreview = {
  lens: { id: string; label: string; focus: string; origin: string };
  priorLensCount: number;
  totalLensCount: number;
  nativeSessionCount: number;
  retainedLensCount: number;
  staleComparisonIndexes: number[];
  staleOutlineRevisions: number[];
  remoderation: string;
};
type PreviewResponse = {
  ref: WorkflowRef;
  preview: AdditionPreview;
  previewDigest: string;
};
type WorkflowActionResponse = WorkflowRead & {
  operation: {
    requestId: string;
    action: 'run' | 'perspective-add';
    state: 'complete';
    replayed: boolean;
  };
};
type PendingAppend = {
  requestId: string;
  expectedRef: WorkflowRef;
  choice: LensChoice;
  previewDigest: string;
};
type PendingRun = { requestId: string; expectedRef: WorkflowRef };

const sameRef = (left: WorkflowRef, right: WorkflowRef) =>
  left.workflowId === right.workflowId &&
  left.revision === right.revision &&
  left.sha256 === right.sha256;
const workflowPath = (ref: WorkflowRef) => `perspective-workflows/${ref.workflowId}`;
const exactRefQuery = (ref: WorkflowRef) => new URLSearchParams({ ref: JSON.stringify(ref) });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function SpanList({ label, spans }: { label: string; spans: ContributionSpan[] }) {
  return (
    <section className="perspective-span-group" aria-label={label}>
      <h5>
        {label} <span>({spans.length})</span>
      </h5>
      {spans.length === 0 ? (
        <p>No exact cited spans in this category.</p>
      ) : (
        <ul>
          {spans.map((span, index) => (
            <li key={`${span.sourceSha256}:${span.start}:${span.end}:${index}`}>
              <blockquote>{span.quote}</blockquote>
              <p>
                Source {span.source + 1}: {span.sourceUri}
              </p>
              <details>
                <summary>Exact source reference</summary>
                <p>
                  SHA-256 <code>{span.sourceSha256}</code> · UTF-16 offsets {span.start}–{span.end}
                </p>
              </details>
              {span.citedBy && <p>Cited by: {span.citedBy.join(', ')}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ContributionView({ rows }: { rows: Contribution[] }) {
  return (
    <section className="perspective-contributions" aria-label="Perspective span contributions">
      <h3>Cited-span comparison</h3>
      <p>
        These categories compare exact cited spans among completed perspectives. They do not score
        answer quality, verify sources, or establish source independence.
      </p>
      {rows.map((row) => (
        <article className="perspective-contribution" key={row.lensId}>
          <h4>
            {row.lensId} · {row.status}
          </h4>
          {row.reason && <p>{row.reason}</p>}
          <details>
            <summary>How these counts are qualified</summary>
            <p>{row.qualification}</p>
          </details>
          <div className="perspective-span-columns">
            <SpanList label="Only this perspective cited" spans={row.uniqueCitedSpans} />
            <SpanList label="Shared cited spans" spans={row.sharedCitedSpans} />
            <SpanList label="Cited in recorded conflicts" spans={row.conflictCitedSpans} />
          </div>
        </article>
      ))}
    </section>
  );
}

export function PerspectiveWorkbench({ api, onBack }: { api: LocalApi; onBack: () => void }) {
  const [captures, setCaptures] = useState<CaptureEntry[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [selectedCaptureIds, setSelectedCaptureIds] = useState<string[]>([]);
  const [topic, setTopic] = useState('');
  const [active, setActive] = useState<WorkflowRead | null>(null);
  const [label, setLabel] = useState('');
  const [focus, setFocus] = useState('');
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [reviewedPreview, setReviewedPreview] = useState(false);
  const [pendingRun, setPendingRun] = useState<PendingRun | null>(null);
  const pendingRunRef = useRef<PendingRun | null>(null);
  const [pendingAppend, setPendingAppend] = useState<PendingAppend | null>(null);
  const pendingAppendRef = useRef<PendingAppend | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const selectedCaptures = useMemo(
    () => captures.filter((entry) => selectedCaptureIds.includes(entry.ref.id)),
    [captures, selectedCaptureIds],
  );

  async function reloadIndex() {
    const [captureList, workflowList] = await Promise.all([
      api<{ captures: CaptureEntry[]; qualification: string[] }>('source-captures'),
      api<{ workflows: WorkflowSummary[] }>('perspective-workflows'),
    ]);
    setCaptures(captureList.captures);
    setWorkflows(workflowList.workflows);
    return workflowList.workflows;
  }

  useEffect(() => {
    let current = true;
    void reloadIndex().catch((failure: unknown) => {
      if (current) setError(errorMessage(failure));
    });
    return () => {
      current = false;
    };
  }, [api]);

  function applyRead(response: WorkflowRead, preservePending = false) {
    setActive(response);
    setTopic(response.workflow.topic);
    setPreview(null);
    setReviewedPreview(false);
    if (!preservePending) {
      setPendingRun(null);
      pendingRunRef.current = null;
      setPendingAppend(null);
      pendingAppendRef.current = null;
    }
    setLabel('');
    setFocus('');
  }

  async function createWorkflow() {
    if (!topic.trim() || selectedCaptures.length === 0) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await api<WorkflowRead>('perspective-workflows', {
        topic: topic.trim(),
        sourceRefs: selectedCaptures.map((entry) => entry.ref),
        perspectives: [],
      });
      applyRead(response);
      setWorkflows((current) => [
        {
          ref: response.ref,
          topic: response.workflow.topic,
          sourceRefs: response.sourceRefs,
          status: 'not_run',
        },
        ...current.filter((row) => row.ref.workflowId !== response.ref.workflowId),
      ]);
      setMessage(
        'Saved a frozen workflow from the selected captures. No provider request has run.',
      );
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function reopenWorkflow(ref: WorkflowRef) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await api<WorkflowRead>(`${workflowPath(ref)}?${exactRefQuery(ref)}`);
      if (!sameRef(response.ref, ref)) throw new Error('The reopened workflow reference changed.');
      applyRead(response);
      setMessage(`Reopened workflow revision ${ref.revision} from its exact saved reference.`);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function reopenCurrentWorkflow(workflowId: WorkflowRef['workflowId']) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const currentRows = await reloadIndex();
      const latest = currentRows.find((row) => row.ref.workflowId === workflowId);
      if (!latest) throw new Error('No saved workflow with that identity is available.');
      const response = await api<WorkflowRead>(
        `${workflowPath(latest.ref)}?${exactRefQuery(latest.ref)}`,
      );
      if (!sameRef(response.ref, latest.ref))
        throw new Error(
          'The latest workflow reference changed while reopening it. Reload and try again.',
        );
      const pendingAdd = pendingAppendRef.current;
      const pendingLensId = preview?.preview.lens.id;
      const appendFound = Boolean(
        pendingAdd &&
        pendingLensId &&
        response.workflow.lenses.some((lens) => lens.id === pendingLensId),
      );
      const pendingBaseRun = pendingRunRef.current;
      const baseRunFound = Boolean(pendingBaseRun && response.workflow.perspectiveResult);
      const preservePending = Boolean(
        (pendingAdd && !appendFound) || (pendingBaseRun && !baseRunFound),
      );
      applyRead(response, preservePending);
      if (appendFound) {
        setMessage(
          'The latest workflow contains the appended lens. Its saved spans are shown below.',
        );
        setPendingAppend(null);
        pendingAppendRef.current = null;
      }
      if (baseRunFound) {
        setMessage('The latest workflow contains the saved Basic Facts run.');
        setPendingRun(null);
        pendingRunRef.current = null;
      }
      setMessage(`Reopened the latest saved workflow revision ${response.ref.revision}.`);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  function clearActive() {
    setActive(null);
    setSelectedCaptureIds([]);
    setTopic('');
    setLabel('');
    setFocus('');
    setPreview(null);
    setReviewedPreview(false);
    setPendingRun(null);
    pendingRunRef.current = null;
    setPendingAppend(null);
    pendingAppendRef.current = null;
  }

  async function runBasicFacts(retry = false) {
    if (!active || (active.workflow.perspectiveResult && !retry)) return;
    const pending = retry
      ? pendingRunRef.current
      : { requestId: crypto.randomUUID(), expectedRef: active.ref };
    if (!pending) return;
    pendingRunRef.current = pending;
    setPendingRun(pending);
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await api<WorkflowActionResponse>(
        `${workflowPath(pending.expectedRef)}/run`,
        { expectedRef: pending.expectedRef, requestId: pending.requestId },
      );
      if (
        response.ref.workflowId !== pending.expectedRef.workflowId ||
        response.ref.revision !== pending.expectedRef.revision + 1
      )
        throw new Error('The perspective run returned an unexpected workflow revision.');
      applyRead(response);
      setPendingRun(null);
      pendingRunRef.current = null;
      setWorkflows((current) =>
        current.map((row) =>
          row.ref.workflowId === response.ref.workflowId
            ? {
                ...row,
                ref: response.ref,
                status: response.workflow.perspectiveResult?.status ?? 'failed',
              }
            : row,
        ),
      );
      setMessage(
        response.operation.replayed
          ? 'Reopened the saved Basic Facts run; no second provider request was sent.'
          : 'Basic Facts run saved. Results are source-bound and may be incomplete.',
      );
    } catch (failure) {
      const reason = errorMessage(failure);
      setError(
        reason.includes('perspective_outcome_unknown')
          ? 'The run outcome is uncertain. Retry only with this same request ID, or reload the latest workflow state before starting another run.'
          : reason.includes('perspective_workflow_changed')
            ? 'The workflow changed. Reload the list and reopen its current revision before continuing.'
            : `The run response was not confirmed (${reason}). Keep the same request ID or reload the latest workflow before starting another run.`,
      );
    } finally {
      setBusy(false);
    }
  }

  const choice = { label: label.trim(), focus: focus.trim() };
  async function previewAddition() {
    if (!active || !active.workflow.perspectiveResult || !choice.label || !choice.focus) return;
    setBusy(true);
    setError('');
    setMessage('');
    setPreview(null);
    setReviewedPreview(false);
    try {
      const response = await api<PreviewResponse>(`${workflowPath(active.ref)}/preview`, {
        ref: active.ref,
        choice,
      });
      if (!sameRef(response.ref, active.ref))
        throw new Error('Preview belongs to another workflow revision.');
      setPreview(response);
      setMessage(
        'Review the exact new lens and any historical material the append would make stale.',
      );
    } catch (failure) {
      const reason = errorMessage(failure);
      setError(
        reason.includes('invalid_perspective_workflow')
          ? 'This lens does not add a distinct perspective. Change its label or focus and preview again.'
          : reason,
      );
    } finally {
      setBusy(false);
    }
  }

  async function appendPerspective(retry = false) {
    if (!active || busy) return;
    if (!retry && (!preview || !reviewedPreview)) return;
    const pending = retry
      ? pendingAppendRef.current
      : {
          requestId: crypto.randomUUID(),
          expectedRef: active.ref,
          choice,
          previewDigest: preview!.previewDigest,
        };
    if (!pending) return;
    pendingAppendRef.current = pending;
    setPendingAppend(pending);
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await api<WorkflowActionResponse>(
        `${workflowPath(pending.expectedRef)}/perspectives`,
        {
          expectedRef: pending.expectedRef,
          requestId: pending.requestId,
          choice: pending.choice,
          previewDigest: pending.previewDigest,
        },
      );
      if (response.operation.requestId !== pending.requestId)
        throw new Error('The saved append response has a different idempotency reference.');
      if (response.ref.revision !== pending.expectedRef.revision + 1)
        throw new Error('The perspective append returned an unexpected workflow revision.');
      applyRead(response);
      setPendingAppend(null);
      pendingAppendRef.current = null;
      setWorkflows((current) =>
        current.map((row) =>
          row.ref.workflowId === response.ref.workflowId
            ? {
                ...row,
                ref: response.ref,
                status: response.workflow.perspectiveResult?.status ?? 'failed',
              }
            : row,
        ),
      );
      setMessage(
        response.operation.replayed
          ? 'Reopened the saved append response; the perspective was not run again.'
          : 'The new perspective ran separately and was appended once. Previous lens results are retained.',
      );
    } catch (failure) {
      const reason = errorMessage(failure);
      setError(
        reason.includes('perspective_outcome_unknown')
          ? 'The append outcome is uncertain. Reopen the exact workflow before retrying; any retry keeps the same request ID.'
          : reason.includes('perspective_preview_changed')
            ? 'The preview is stale. Reopen the latest workflow and preview the lens again.'
            : reason.includes('perspective_workflow_changed')
              ? 'The workflow changed. Reload and reopen its current revision, then preview again.'
              : reason.includes('perspective_request_conflict')
                ? 'This request ID was already used for different input. Reopen the workflow before starting a new preview.'
                : reason,
      );
    } finally {
      setBusy(false);
    }
  }

  const contributions = active?.contributions ?? null;
  const canPreview = Boolean(active?.workflow.perspectiveResult && choice.label && choice.focus);

  return (
    <section className="perspective-workbench" aria-labelledby="perspective-workbench-title">
      <div className="perspective-heading">
        <div>
          <h1 id="perspective-workbench-title">Independent perspectives</h1>
          <p>
            Work only from retained source captures. A new perspective is previewed before it is
            requested and runs separately without receiving other lenses’ answers.
          </p>
        </div>
        <button type="button" onClick={onBack}>
          Back to Research
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}

      <section aria-labelledby="perspective-start-title">
        <h2 id="perspective-start-title">Start from retained captures</h2>
        <p>
          This list reads locally saved captures only. Creating a workflow freezes the selected text
          and does not fetch sources or start a provider request.
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => void reloadIndex().catch((e) => setError(errorMessage(e)))}
        >
          Reload retained captures and workflows
        </button>
        {captures.length === 0 ? (
          <p>No retained source captures are available in this workspace.</p>
        ) : (
          <label>
            Retained source captures (select 1–8)
            <select
              multiple
              size={Math.min(6, Math.max(3, captures.length))}
              value={selectedCaptureIds}
              disabled={busy || active !== null}
              onChange={(event) =>
                setSelectedCaptureIds(
                  [...event.currentTarget.selectedOptions].map((option) => option.value),
                )
              }
            >
              {captures.map(({ ref, capture }) => (
                <option
                  key={`${ref.id}:${ref.digest}`}
                  value={ref.id}
                  disabled={selectedCaptureIds.length >= 8 && !selectedCaptureIds.includes(ref.id)}
                >
                  {capture.source_uri} · {new Date(capture.captured_at).toLocaleDateString()} ·
                  SHA-256 {capture.text_sha256.slice(0, 12)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Research topic
          <input
            maxLength={2000}
            value={topic}
            disabled={busy || active !== null}
            onChange={(event) => setTopic(event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={busy || active !== null || !topic.trim() || selectedCaptures.length === 0}
          onClick={() => void createWorkflow()}
        >
          Save frozen workflow
        </button>
      </section>

      {workflows.length > 0 && (
        <section aria-labelledby="saved-perspectives-title">
          <h2 id="saved-perspectives-title">Saved perspective workflows</h2>
          <ul className="perspective-workflow-list" aria-label="Saved perspective workflows">
            {workflows.map((row) => (
              <li key={row.ref.workflowId}>
                <div>
                  <strong>{row.topic}</strong>
                  <p>
                    Revision {row.ref.revision} · {row.status} · {row.sourceRefs.length} retained
                    capture(s)
                  </p>
                  <details>
                    <summary>Exact saved reference</summary>
                    <code>{row.ref.sha256}</code>
                  </details>
                </div>
                <button
                  type="button"
                  disabled={busy || pendingAppend !== null || pendingRun !== null}
                  onClick={() => void reopenWorkflow(row.ref)}
                >
                  Reopen exact workflow
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {active && (
        <section className="perspective-active" aria-label="Selected perspective workflow">
          <div className="perspective-active-heading">
            <h2>{active.workflow.topic}</h2>
            <button
              type="button"
              disabled={busy || pendingAppend !== null || pendingRun !== null}
              onClick={clearActive}
            >
              Start another workflow
            </button>
          </div>
          <p>Workflow revision {active.ref.revision}</p>
          <details>
            <summary>Exact workflow digest</summary>
            <code>{active.ref.sha256}</code>
          </details>
          <p>
            Frozen source captures: {active.sourceRefs.length}. No source acquisition occurs in this
            workflow.
          </p>
          <ul>
            {active.workflow.sources.map((source, index) => (
              <li key={`${source.sha256}:${index}`}>
                Source {index + 1}: {source.uri} · {source.text.length.toLocaleString()} retained
                characters
                <details>
                  <summary>Exact source digest</summary>
                  <code>{source.sha256}</code>
                </details>
              </li>
            ))}
          </ul>
          {!active.workflow.perspectiveResult ? (
            <div className="perspective-run-start">
              <p>
                Only the Basic Facts lens is selected. Run it explicitly before previewing an
                additional lens.
              </p>
              <button
                type="button"
                disabled={
                  busy ||
                  (pendingRun !== null &&
                    pendingRunRef.current?.expectedRef.workflowId !== active.ref.workflowId)
                }
                onClick={() => void runBasicFacts(pendingRun !== null)}
              >
                {pendingRun ? 'Retry the same Basic Facts request' : 'Run Basic Facts'}
              </button>
              {pendingRun && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void reopenCurrentWorkflow(active.ref.workflowId)}
                >
                  Reload current workflow state
                </button>
              )}
            </div>
          ) : (
            <>
              <section aria-labelledby="base-lens-results-title">
                <h3 id="base-lens-results-title">Saved perspective answers</h3>
                {active.workflow.perspectiveResult.lenses.map((lens) => (
                  <article className="perspective-lens-result" key={lens.lens.id}>
                    <h4>
                      {lens.lens.label} · {lens.status}
                    </h4>
                    <p>{lens.lens.focus}</p>
                    {lens.reason && <p>{lens.reason}</p>}
                    {lens.questions?.map((question, index) => (
                      <section key={`${lens.lens.id}:${index}`}>
                        <h5>
                          {question.question} · {question.status}
                        </h5>
                        <p>{question.answer}</p>
                        {question.citations.map((citation, citationIndex) => (
                          <blockquote key={`${citation.source}:${citation.start}:${citationIndex}`}>
                            {citation.quote}{' '}
                            <small>
                              (source {citation.source + 1}, UTF-16 {citation.start}–{citation.end})
                            </small>
                          </blockquote>
                        ))}
                      </section>
                    ))}
                  </article>
                ))}
              </section>

              <section aria-labelledby="add-perspective-title">
                <h3 id="add-perspective-title">Preview one independent lens</h3>
                <p>
                  The new lens uses the same frozen source text and does not receive other
                  perspectives’ answers. Adding it preserves the earlier lens results.
                </p>
                <label>
                  Perspective label
                  <input
                    value={label}
                    disabled={busy || pendingAppend !== null}
                    onChange={(event) => {
                      setLabel(event.target.value);
                      setPreview(null);
                      setReviewedPreview(false);
                    }}
                  />
                </label>
                <label>
                  Perspective focus
                  <textarea
                    value={focus}
                    disabled={busy || pendingAppend !== null}
                    onChange={(event) => {
                      setFocus(event.target.value);
                      setPreview(null);
                      setReviewedPreview(false);
                    }}
                  />
                </label>
                <button
                  type="button"
                  disabled={!canPreview || busy || pendingAppend !== null}
                  onClick={() => void previewAddition()}
                >
                  Preview independent lens
                </button>
                {preview && (
                  <section
                    className="perspective-addition-preview"
                    aria-label="Perspective addition preview"
                  >
                    <h4>{preview.preview.lens.label}</h4>
                    <p>{preview.preview.lens.focus}</p>
                    <p>
                      Lens ID: <code>{preview.preview.lens.id}</code>
                    </p>
                    <p>
                      {preview.preview.priorLensCount} existing lens(es) remain retained; the append
                      would produce {preview.preview.totalLensCount} total. It requires{' '}
                      {preview.preview.nativeSessionCount} isolated native session(s).
                    </p>
                    <h5>Historical comparison qualification</h5>
                    <p>{preview.preview.remoderation}</p>
                    <p>
                      Comparisons marked stale:{' '}
                      {preview.preview.staleComparisonIndexes.length
                        ? preview.preview.staleComparisonIndexes
                            .map((index) => index + 1)
                            .join(', ')
                        : 'none'}
                      . Outline revisions marked stale:{' '}
                      {preview.preview.staleOutlineRevisions.length
                        ? preview.preview.staleOutlineRevisions.join(', ')
                        : 'none'}
                      .
                    </p>
                    <p>
                      Preview SHA-256 <code>{preview.previewDigest}</code>
                    </p>
                    <label className="perspective-review-confirmation">
                      <input
                        type="checkbox"
                        checked={reviewedPreview}
                        onChange={(event) => setReviewedPreview(event.target.checked)}
                      />
                      I reviewed this lens and the historical comparison qualification.
                    </label>
                    <button
                      type="button"
                      disabled={busy || !reviewedPreview || pendingAppend !== null}
                      onClick={() => void appendPerspective()}
                    >
                      Request this lens once
                    </button>
                  </section>
                )}
                {pendingAppend && (
                  <section aria-label="Uncertain perspective append">
                    <p>
                      Append request {pendingAppend.requestId} has an uncertain response. The same
                      request ID is retained so a retry cannot create a second append.
                    </p>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void appendPerspective(true)}
                    >
                      Retry the same append request
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void reopenCurrentWorkflow(pendingAppend.expectedRef.workflowId)
                      }
                    >
                      Reload current workflow state
                    </button>
                  </section>
                )}
              </section>
            </>
          )}
          {contributions && <ContributionView rows={contributions} />}
        </section>
      )}
    </section>
  );
}
