import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AssessmentConfidence,
  AssessmentDerivation,
  CandidateSummary,
  EvidencePanel,
  HomeOverview,
  ComparisonView,
  FrozenDiscussion,
  SavedEntityReview,
  type SavedEntityInspection,
  type FrozenAnswer,
} from './candidate-views.js';
import {
  createLibraryIndex,
  type LibraryFinding,
  type LibraryFilters,
  type LibraryHit,
} from '../../../packages/domain/src/library-search.js';
import { Workbench, Brief } from './workbench.js';
import './experience.css';
import {
  ProjectDesk,
  type ResearchPreview,
  type DisplayOpportunity,
} from './experience-projects.js';
import type { Project } from '../../../packages/corpus/src/project-contract.js';
import BriefingPage from './briefing/BriefingPage.js';
import { LibrarySavingSettings } from './library-saving-settings.js';

const base = import.meta.env.BASE_URL;
const local = (window as Window & { __SIGNALS_LOCAL__?: boolean }).__SIGNALS_LOCAL__ === true;
const primaryViews = [
  'Home',
  'Search',
  'Projects',
  'Library',
  'Following',
  'Briefing',
  'Data',
] as const;
type View = (typeof primaryViews)[number] | 'Activity' | 'Settings';
type LocationState = {
  view: View;
  query: string;
  mode: 'library' | 'research' | 'combined';
  kind: string;
  acquisition: LibraryFilters['acquisition'];
  destination: '' | 'public' | 'private';
  sort: string;
  project: string;
  detail: string;
  panel: string;
  run: string;
  compare: string;
};
type ApprovedResearchPreview = ResearchPreview & { basis: string; approvalId: string };
function projectBasis(project: Project) {
  return JSON.stringify([project.snapshot.digest, project.purpose, project.constraints]);
}
function previewLocationMatches(preview: ApprovedResearchPreview | null, state: LocationState) {
  return Boolean(
    preview &&
    preview.projectId === state.project &&
    preview.request.query === state.query &&
    state.view === 'Search' &&
    state.mode === 'research' &&
    !state.panel,
  );
}
function previewMatches(
  preview: ApprovedResearchPreview | null,
  state: LocationState,
  projects: Project[],
) {
  const project = projects.find((project) => project.id === preview?.projectId);
  return Boolean(
    previewLocationMatches(preview, state) &&
    preview &&
    project?.connected &&
    preview.basis === projectBasis(project),
  );
}
function strengthLabel(finding: LibraryFinding) {
  const strength = finding.intrinsicStrength;
  const source =
    finding.origin.format === 'legacy'
      ? 'Legacy review'
      : finding.origin.format === 'lead'
        ? 'Unassessed lead'
        : finding.origin.format === 'note'
          ? 'Incomplete research note'
          : finding.origin.format === 'answer'
            ? 'Unassessed research answer'
            : 'Native intrinsic signal';
  return `${source} (${strength.policy}): ${strength.score ?? 'unknown'}${strength.legacyLevel ? ` · review gate: ${strength.legacyLevel}` : ''}`;
}
function locationState(): LocationState {
  const params = new URLSearchParams(window.location.search);
  const view =
    params.get('view') ?? (local && !params.has('mode') && !params.has('q') ? 'Home' : 'Search');
  return {
    view: (local ? [...primaryViews, 'Activity', 'Settings'] : ['Search', 'Library']).includes(view)
      ? (view as View)
      : 'Search',
    query: params.get('q') ?? '',
    mode:
      local && ['research', 'combined'].includes(params.get('mode') ?? '')
        ? (params.get('mode') as LocationState['mode'])
        : 'library',
    kind: params.get('kind') ?? '',
    acquisition: ['open-source', 'free-to-use'].includes(params.get('access') ?? '')
      ? (params.get('access') as LibraryFilters['acquisition'])
      : 'all',
    sort: params.get('sort') ?? 'relevance',
    destination:
      local && ['public', 'private'].includes(params.get('destination') ?? '')
        ? (params.get('destination') as LocationState['destination'])
        : '',
    project: local ? (params.get('project') ?? '') : '',
    detail: params.get('detail') ?? '',
    panel: local ? (params.get('panel') ?? '') : '',
    run: local ? (params.get('run') ?? '') : '',
    compare: params.get('compare') ?? '',
  };
}
function writeLocation(state: LocationState, replace: boolean) {
  const params = new URLSearchParams();
  const values = {
    view: state.view,
    q: state.query,
    mode: state.mode,
    kind: state.kind,
    access: state.acquisition,
    sort: state.sort,
    destination: state.destination,
    project: state.project,
    detail: state.detail,
    panel: state.panel,
    run: state.run,
    compare: state.compare,
  };
  for (const [key, value] of Object.entries(values))
    if (value && value !== 'all' && value !== 'relevance' && value !== 'library')
      params.set(key, value);
  window.history[replace ? 'replaceState' : 'pushState'](
    null,
    '',
    `${window.location.pathname}?${params.toString()}`,
  );
}
function automaticReopen(state: LocationState) {
  return state.view === 'Search' && state.mode === 'research' ? state.run : '';
}
function date(value: string | null) {
  return value
    ? new Date(value).toLocaleDateString('en-US', { timeZone: 'UTC', dateStyle: 'medium' })
    : 'Not recorded';
}
export function Experience() {
  const [state, setState] = useState(locationState);
  const currentState = useRef(state);
  currentState.current = state;
  const activeReopen = useRef(automaticReopen(state));
  const [records, setRecords] = useState<LibraryFinding[]>([]);
  const [entityInspection, setEntityInspection] = useState<{
    key: string;
    loading: boolean;
    data?: SavedEntityInspection;
    error?: string;
  } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [token, setToken] = useState('');
  const selected = state.compare.split(',').filter(Boolean).slice(0, 3);
  const [projects, setProjects] = useState<Project[]>([]);
  const [opportunities, setOpportunities] = useState<DisplayOpportunity[]>([]);
  const [pending, setPending] = useState<string[]>([]);
  const [reopenRun, setReopenRun] = useState(() => automaticReopen(state));
  const [workbenchStarted, setWorkbenchStarted] = useState(local && state.mode === 'research');
  const [visibleCount, setVisibleCount] = useState(40);
  const [projectResearch, setProjectResearch] = useState<ApprovedResearchPreview | null>(null);
  const [monitorRun, setMonitorRun] = useState('');
  const [followup, setFollowup] = useState('');
  const [answer, setAnswer] = useState<FrozenAnswer | null>(null);
  const [answerBusy, setAnswerBusy] = useState(false);
  const [recent, setRecent] = useState<
    { runId: string; query: string; status: string; candidates: number }[]
  >([]);
  const [interests, setInterests] = useState<{ id: string; query: string; enabled: boolean }[]>([]);
  const [selections, setSelections] = useState<
    { query: string; queryId?: string; at: string; selected: string[] }[]
  >([]);
  const [meaningAllowed, setMeaningAllowed] = useState(false);
  const [meaningBusy, setMeaningBusy] = useState(false);
  const [meaningResult, setMeaningResult] = useState<{
    query: string;
    hits: LibraryHit[];
    reason: string;
    state: string;
    omitted: number;
  } | null>(null);
  const [meaningController, setMeaningController] = useState<AbortController | null>(null);
  const evidenceOpener = useRef<HTMLElement | null>(null);
  const detailed = records.find((record) => record.key === state.detail);
  function closeEvidence() {
    navigate({ detail: '' });
    evidenceOpener.current?.focus();
  }
  const api = useCallback(
    async <T,>(route: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
      let authorization = token;
      if (body !== undefined && !authorization) {
        const response = await fetch(`${base}__signals/api/session`);
        if (!response.ok)
          throw new Error('The local session is unavailable. Browsing remains available.');
        authorization = ((await response.json()) as { token: string }).token;
        setToken(authorization);
      }
      const response = await fetch(
        `${base}__signals/api/${route}`,
        body === undefined
          ? { signal }
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-signals-token': authorization },
              body: JSON.stringify(body),
              signal,
            },
      );
      const value: unknown = await response.json();
      if (!response.ok)
        throw new Error(
          value && typeof value === 'object' && 'code' in value
            ? String(value.code)
            : 'Operation failed. Your input is retained.',
        );
      return value as T;
    },
    [token],
  );
  useEffect(() => {
    if (!local || !detailed?.native) {
      setEntityInspection(null);
      return;
    }
    let current = true;
    const key = detailed.key;
    setEntityInspection({ key, loading: true });
    const route = `saved-entity?id=${encodeURIComponent(detailed.id)}&destination=${detailed.origin.destination}`;
    void api<SavedEntityInspection>(route)
      .then((data) => {
        if (current) setEntityInspection({ key, loading: false, data });
      })
      .catch((failure: unknown) => {
        if (current)
          setEntityInspection({
            key,
            loading: false,
            error: failure instanceof Error ? failure.message : String(failure),
          });
      });
    return () => {
      current = false;
    };
  }, [api, detailed, local]);
  async function reopenFrozenResearch(runId: string) {
    const opened = await api<{ id: string }>('history/open', { runId });
    setProjectResearch(null);
    setWorkbenchStarted(true);
    setReopenRun(opened.id);
    activeReopen.current = opened.id;
    navigate({ view: 'Search', mode: 'research', panel: '', run: opened.id });
  }
  async function action(operation: () => Promise<void> | void) {
    setError('');
    try {
      await operation();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }
  async function reloadLibrary() {
    const response = local
      ? (await api<{ findings: LibraryFinding[] }>('library')).findings
      : await fetch(`${base}library.json`).then(async (response) => {
          if (!response.ok) throw new Error('The public library could not be loaded.');
          return response.json() as Promise<LibraryFinding[]>;
        });
    if (
      !Array.isArray(response) ||
      response.some(
        (finding) =>
          !finding ||
          typeof finding !== 'object' ||
          typeof finding.key !== 'string' ||
          typeof finding.title !== 'string' ||
          typeof finding.uri !== 'string' ||
          typeof finding.description !== 'string' ||
          typeof finding.kind !== 'string' ||
          !finding.license ||
          !Array.isArray(finding.license.values) ||
          !finding.access ||
          !finding.origin ||
          !finding.intrinsicStrength ||
          ![
            'aliases',
            'domains',
            'capabilities',
            'useCases',
            'technologies',
            'tags',
            'sourceNames',
          ].every((field) => Array.isArray(finding[field as keyof LibraryFinding])),
      )
    )
      throw new Error(
        'The library response is incomplete. Reload to retry; research has not started.',
      );
    setRecords(response);
    setLoaded(true);
  }
  async function reloadProjects() {
    const [result, retained] = await Promise.all([
      api<{ projects: Project[] }>('projects'),
      api<{ opportunities: DisplayOpportunity[] }>('opportunities'),
    ]);
    setProjects(result.projects);
    setOpportunities(retained.opportunities);
  }
  async function reloadHome() {
    const [history, settings, preferences] = await Promise.all([
      api<{ runs: typeof recent; selections: typeof selections }>('history'),
      api<{ queries: typeof interests }>('settings'),
      api<{ meaningMatching: boolean }>('library-preferences'),
    ]);
    setRecent(history.runs);
    setSelections(history.selections);
    setInterests(settings.queries);
    setMeaningAllowed(preferences.meaningMatching);
  }
  async function searchLibrary() {
    if (!local || !state.query.trim()) return;
    meaningController?.abort();
    const controller = new AbortController();
    setMeaningController(controller);
    setMeaningBusy(true);
    setMeaningResult(null);
    try {
      const result = await api<Omit<NonNullable<typeof meaningResult>, 'query'>>(
        'library-search',
        {
          query: state.query,
          scope: state.destination === 'public' ? 'public' : 'local',
          filters,
        },
        controller.signal,
      );
      if (!controller.signal.aborted) setMeaningResult({ ...result, query: state.query });
    } catch (failure) {
      if (!controller.signal.aborted) throw failure;
    } finally {
      if (!controller.signal.aborted) setMeaningBusy(false);
    }
  }
  useEffect(() => {
    void action(reloadLibrary);
    if (local) void reloadProjects().catch((failure: unknown) => setError(String(failure)));
    if (local) void reloadHome().catch((failure: unknown) => setError(String(failure)));
    const back = () => {
      const next = locationState();
      setProjectResearch((current) => (previewLocationMatches(current, next) ? current : null));
      setState(next);
      activeReopen.current = automaticReopen(next);
      setReopenRun(activeReopen.current);
    };
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, []);
  function navigate(change: Partial<LocationState>, replace = false) {
    if (
      (change.view && change.view !== 'Search') ||
      change.mode === 'library' ||
      change.mode === 'combined'
    ) {
      activeReopen.current = '';
      setReopenRun('');
    }
    const next = { ...state, ...change };
    setProjectResearch((current) => (previewMatches(current, next, projects) ? current : null));
    setState(next);
    writeLocation(next, replace);
    setMessage('');
    if (change.query !== undefined && change.query !== state.query) {
      meaningController?.abort();
      setMeaningBusy(false);
      setMeaningResult(null);
    }
    if (
      change.kind !== undefined ||
      change.acquisition !== undefined ||
      change.destination !== undefined ||
      change.view !== undefined ||
      change.mode !== undefined
    ) {
      meaningController?.abort();
      setMeaningBusy(false);
      setMeaningResult(null);
    }
  }
  function selectFinding(key: string) {
    setAnswer(null);
    const next = selected.includes(key)
      ? selected.filter((value) => value !== key)
      : selected.length < 3
        ? [...selected, key]
        : selected;
    navigate({ compare: next.join(',') });
  }
  const index = useMemo(() => createLibraryIndex(records), [records]);
  const approvedResearch = previewMatches(projectResearch, state, projects)
    ? projectResearch
    : null;
  useEffect(() => {
    if (projectResearch && !approvedResearch) setProjectResearch(null);
  }, [projectResearch, approvedResearch]);
  const filters: LibraryFilters = {
    kind: state.kind || undefined,
    acquisition: state.acquisition,
    destination: state.destination || undefined,
    ...(local && state.view === 'Library' ? { saved: true } : {}),
  };
  const hits = useMemo(() => {
    const values =
      meaningResult?.query === state.query && ['completed', 'partial'].includes(meaningResult.state)
        ? meaningResult.hits.flatMap((hit) => {
            const finding = records.find((record) => record.key === hit.finding.key);
            return finding ? [{ ...hit, finding }] : [];
          })
        : index.search(state.query, filters);
    if (state.sort === 'title')
      values.sort((a, b) => a.finding.title.localeCompare(b.finding.title));
    if (state.sort === 'strength')
      values.sort(
        (a, b) =>
          a.finding.intrinsicStrength.policy.localeCompare(b.finding.intrinsicStrength.policy) ||
          a.finding.kind.localeCompare(b.finding.kind) ||
          (a.finding.native?.assessment.rubric ?? '').localeCompare(
            b.finding.native?.assessment.rubric ?? '',
          ) ||
          (b.finding.intrinsicStrength.score ?? -1) - (a.finding.intrinsicStrength.score ?? -1) ||
          a.finding.key.localeCompare(b.finding.key),
      );
    if (state.sort === 'observed')
      values.sort((a, b) => (b.finding.observedAt ?? '').localeCompare(a.finding.observedAt ?? ''));
    return values;
  }, [
    index,
    state.query,
    state.kind,
    state.acquisition,
    state.destination,
    state.sort,
    state.view,
    meaningResult,
  ]);
  const kinds = [...new Set(records.map((record) => record.kind))].sort();
  const compared = records.filter((finding) => selected.includes(finding.key));
  const powered =
    state.view === 'Activity'
      ? 'Jobs'
      : state.view === 'Settings'
        ? 'Settings'
        : state.view === 'Following'
          ? state.panel === 'sources'
            ? 'Sources'
            : 'Interests'
          : state.view === 'Library' && state.panel === 'inbox'
            ? 'Inbox'
            : state.view === 'Data'
              ? 'Datasets'
              : state.view === 'Search' && state.mode !== 'library'
                ? 'Search'
                : null;
  useEffect(() => {
    if (powered && local) setWorkbenchStarted(true);
  }, [powered]);
  useEffect(() => setVisibleCount(40), [state.query, state.kind, state.acquisition, state.view]);
  async function save(finding: LibraryFinding) {
    setPending((current) => [...current, finding.key]);
    try {
      await api('library-saved', { key: finding.key, saved: !finding.saved });
      await reloadLibrary();
      setMessage(
        finding.saved
          ? `${finding.title} removed from your saved collection. Evidence remains searchable.`
          : `${finding.title} saved locally. Publication is separate.`,
      );
    } finally {
      setPending((current) => current.filter((key) => key !== finding.key));
    }
  }
  return (
    <div className="desk-shell">
      <a href="#desk-content" className="skip-link">
        Skip to findings
      </a>
      <aside className="desk-rail">
        <a className="desk-brand" href={base}>
          Research<span>Library</span>
        </a>
        <nav aria-label="Research destinations">
          {(local ? primaryViews : (['Search', 'Library'] as const)).map((view) => (
            <button
              key={view}
              aria-current={state.view === view ? 'page' : undefined}
              onClick={() => navigate({ view, mode: 'library', panel: '' })}
            >
              {view}
            </button>
          ))}
        </nav>
        {local && (
          <nav className="desk-utilities" aria-label="Workbench utilities">
            {(['Activity', 'Settings'] as const).map((view) => (
              <button
                key={view}
                aria-current={state.view === view ? 'page' : undefined}
                onClick={() => navigate({ view, panel: '' })}
              >
                {view}
              </button>
            ))}
          </nav>
        )}
        <div className="desk-rail-note">
          <strong>{local ? 'Your local workspace' : 'Public library · read only'}</strong>
        </div>
      </aside>
      <main className="desk-main" id="desk-content" tabIndex={-1}>
        <header className="desk-topline">
          <p>
            {state.view}
            {state.project
              ? ` / ${projects.find((project) => project.id === state.project)?.name ?? 'Selected project'}`
              : ''}
          </p>
          {local && (
            <button onClick={() => navigate({ view: 'Library', mode: 'library', panel: 'inbox' })}>
              Add a link
            </button>
          )}
        </header>
        {error && (
          <p className="desk-error" role="alert">
            {error} <button onClick={() => void action(reloadLibrary)}>Reload library</button>
          </p>
        )}
        {message && (
          <p role="status" className="desk-feedback">
            {message}
          </p>
        )}
        {(state.view === 'Home' || state.view === 'Search' || state.view === 'Library') && (
          <>
            <div className="desk-heading">
              <h1>
                {state.view === 'Library'
                  ? 'Your library'
                  : state.view === 'Home'
                    ? 'Worth knowing. Worth keeping.'
                    : 'Find something useful.'}
              </h1>
            </div>
            {state.view === 'Library' && local && (
              <nav className="desk-tabs" aria-label="Library views">
                <button
                  aria-pressed={state.panel !== 'inbox'}
                  onClick={() => navigate({ panel: '' })}
                >
                  Saved
                </button>
                <button
                  aria-pressed={state.panel === 'inbox'}
                  onClick={() => navigate({ panel: 'inbox' })}
                >
                  Inbox & capture
                </button>
              </nav>
            )}
            {state.panel !== 'inbox' && (
              <form
                className="desk-search"
                aria-label="Finding search"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (state.view === 'Home') navigate({ view: 'Search' });
                  if (state.mode === 'library' || state.mode === 'combined')
                    void action(searchLibrary);
                }}
              >
                <label className="desk-query-label" htmlFor="desk-query">
                  Search records and sources
                </label>
                <input
                  id="desk-query"
                  type="search"
                  value={state.query}
                  onChange={(event) => navigate({ query: event.target.value }, true)}
                  placeholder="Search by question, name or topic"
                />
                <div className="desk-search-options">
                  <nav className="desk-tabs" aria-label="Search scope">
                    <button
                      type="button"
                      aria-pressed={state.mode === 'library'}
                      onClick={() => navigate({ mode: 'library' })}
                    >
                      Library
                    </button>
                    {local && (
                      <button
                        type="button"
                        aria-label="Research online"
                        aria-pressed={state.mode === 'research'}
                        onClick={() => navigate({ view: 'Search', mode: 'research', panel: '' })}
                      >
                        Online
                      </button>
                    )}
                    {local && (
                      <button
                        type="button"
                        aria-pressed={state.mode === 'combined'}
                        onClick={() => navigate({ view: 'Search', mode: 'combined', panel: '' })}
                      >
                        Combined
                      </button>
                    )}
                  </nav>
                  <span>
                    {state.mode === 'library'
                      ? 'Search saved knowledge.'
                      : state.mode === 'combined'
                        ? 'Saved knowledge + new research.'
                        : 'Find something new.'}
                  </span>
                  {state.mode !== 'research' && (
                    <button disabled={!state.query.trim() || meaningBusy}>
                      {meaningBusy ? 'Matching meaning…' : 'Search Library'}
                    </button>
                  )}
                  {meaningBusy && (
                    <button
                      type="button"
                      onClick={() => {
                        meaningController?.abort();
                        setMeaningBusy(false);
                        setMeaningResult({
                          query: state.query,
                          hits: [],
                          state: 'cancelled',
                          omitted: 0,
                          reason: 'Meaning matching cancelled. Literal matches remain available.',
                        });
                      }}
                    >
                      Cancel meaning matching
                    </button>
                  )}
                </div>
                {local && state.mode !== 'research' && (
                  <details className="desk-privacy">
                    <summary>AI matching {meaningAllowed ? 'on' : 'off'}</summary>
                    <p>
                      One bounded no-web operation on submission. Your question and up to 200
                      retained record IDs, titles, descriptions, kinds, capabilities and tags may
                      leave this machine for your authenticated AI provider. Private notes and
                      original evidence are excluded. Literal search remains available.
                    </p>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={meaningAllowed}
                        onChange={(event) => {
                          const allowed = event.target.checked;
                          void action(async () => {
                            await api('library-preferences', { meaningMatching: allowed });
                            setMeaningAllowed(allowed);
                          });
                        }}
                      />
                      Permit meaning matching with my AI host
                    </label>
                  </details>
                )}
                {meaningResult?.query === state.query && (
                  <section role="status" className="desk-meta">
                    <details>
                      <summary>
                        {['completed', 'partial'].includes(meaningResult.state)
                          ? 'Matches updated'
                          : 'Literal matches available'}
                      </summary>
                      <p>
                        {meaningResult.reason}
                        {meaningResult.omitted
                          ? ` ${meaningResult.omitted} records were outside the bounded AI scope.`
                          : ''}{' '}
                        Retrieval matching is separate from query relevance and Signal.
                      </p>
                    </details>
                  </section>
                )}
                {local && state.view !== 'Home' && (
                  <details className="desk-search-more" open={Boolean(state.project)}>
                    <summary>Search options</summary>
                    <label className="desk-project-scope">
                      For:
                      <select
                        aria-label="Project scope"
                        value={state.project}
                        onChange={(event) => navigate({ project: event.target.value })}
                      >
                        <option value="">Everything</option>
                        {projects.map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {state.mode === 'library' && (
                      <details>
                        <summary>Save this question</summary>
                        <p>Save this question privately for later.</p>
                        <button
                          type="button"
                          disabled={!state.query.trim()}
                          onClick={() =>
                            void action(async () => {
                              const saved = await api<{ id: string }>('question', {
                                question: state.query,
                              });
                              setMessage(`Question saved privately: ${saved.id}`);
                            })
                          }
                        >
                          Save question locally
                        </button>
                      </details>
                    )}
                  </details>
                )}
              </form>
            )}
            {state.view === 'Home' && (
              <HomeOverview
                records={records}
                interests={interests}
                recent={recent}
                selections={selections}
                openLibrary={() => navigate({ view: 'Library' })}
                openFollowing={() => navigate({ view: 'Following' })}
                inspect={(key) => navigate({ view: 'Search', detail: key })}
                reopen={(run) => {
                  setReopenRun(run.runId);
                  navigate({ view: 'Search', mode: 'research', query: run.query, run: run.runId });
                }}
              />
            )}
            {state.view !== 'Home' && (!powered || state.mode === 'combined') && (
              <>
                <div className="desk-filters">
                  {local && (
                    <label>
                      Visibility scope
                      <select
                        aria-label="Visibility scope"
                        value={state.destination}
                        onChange={(event) =>
                          navigate({
                            destination: event.target.value as LocationState['destination'],
                          })
                        }
                      >
                        <option value="">All local knowledge</option>
                        <option value="public">Public Corpus</option>
                        <option value="private">Private Library</option>
                      </select>
                    </label>
                  )}
                  <label>
                    Resource kind
                    <select
                      aria-label="Resource kind"
                      value={state.kind}
                      onChange={(event) => navigate({ kind: event.target.value })}
                    >
                      <option value="">All kinds</option>
                      {kinds.map((kind) => (
                        <option key={kind}>{kind}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Access & license
                    <select
                      aria-label="Access & license"
                      value={state.acquisition}
                      onChange={(event) =>
                        navigate({
                          acquisition: event.target.value as LibraryFilters['acquisition'],
                        })
                      }
                    >
                      <option value="all">All resources</option>
                      <option value="open-source">Open source software</option>
                      <option value="free-to-use">Free-to-use resources</option>
                    </select>
                  </label>
                  <label>
                    Sort
                    <select
                      aria-label="Sort"
                      value={state.sort}
                      onChange={(event) => navigate({ sort: event.target.value })}
                    >
                      <option value="relevance">Retrieval match</option>
                      <option value="title">Name</option>
                      <option value="strength">Score within policy and type groups</option>
                      <option value="observed">Last observed</option>
                    </select>
                  </label>
                  <button
                    onClick={() =>
                      navigate({
                        query: '',
                        kind: '',
                        acquisition: 'all',
                        destination: '',
                        sort: 'relevance',
                      })
                    }
                  >
                    Reset filters
                  </button>
                </div>
                <div className="desk-section-line">
                  <h2>{state.view === 'Library' ? 'Saved findings' : 'Library results'}</h2>
                  <p aria-live="polite">
                    {loaded
                      ? `${hits.length} ${hits.length === 1 ? 'finding' : 'findings'}`
                      : 'Loading retained records…'}
                  </p>
                </div>
                {compared.length > 0 && (
                  <ComparisonView findings={compared} onClear={() => navigate({ compare: '' })}>
                    {local && (
                      <FrozenDiscussion
                        question={followup}
                        busy={answerBusy}
                        answer={answer}
                        onQuestion={setFollowup}
                        onSubmit={() => {
                          void action(async () => {
                            const basis = state.compare;
                            setAnswerBusy(true);
                            try {
                              const response = await api<NonNullable<typeof answer>>(
                                'library-discussion',
                                {
                                  keys: compared.map((finding) => finding.key),
                                  question: followup,
                                },
                              );
                              if (currentState.current.compare === basis) setAnswer(response);
                            } finally {
                              setAnswerBusy(false);
                            }
                          });
                        }}
                      />
                    )}
                  </ComparisonView>
                )}
                <section className="desk-results" aria-label="Finding results">
                  {hits.slice(0, visibleCount).map(({ finding, meaningReason }) => (
                    <article
                      className="desk-finding"
                      key={finding.key}
                      data-finding-key={finding.key}
                    >
                      <CandidateSummary finding={finding} />
                      {meaningReason && <p className="desk-fit">{meaningReason}</p>}
                      {state.project && (
                        <ProjectFit
                          projectId={state.project}
                          findingKey={finding.key}
                          opportunities={opportunities}
                        />
                      )}
                      <p className="desk-meta" title={strengthLabel(finding)}>
                        {finding.native?.evidence[0]?.publisher ??
                          (finding.lead
                            ? 'Saved link'
                            : finding.partialNote
                              ? 'Incomplete research'
                              : finding.answer
                                ? 'Retained research'
                                : 'Historical review')}{' '}
                        · {date(finding.native?.evidence[0]?.fetchedAt ?? finding.observedAt)}
                      </p>
                      {(finding.native?.limits[0] ?? finding.lead?.limits[0]) && (
                        <p className="desk-limit">
                          {finding.native?.limits[0] ?? finding.lead?.limits[0]}
                        </p>
                      )}
                      <div className="desk-actions">
                        {finding.answer || finding.partialNote ? (
                          <>
                            <button onClick={() => navigate({ detail: finding.key })}>
                              {finding.partialNote
                                ? 'Reopen incomplete note'
                                : 'Reopen complete answer'}
                            </button>
                            <button
                              onClick={() =>
                                navigate({
                                  view: 'Search',
                                  mode: 'research',
                                  run: (finding.answer ?? finding.partialNote)!.runId,
                                  query: finding.title,
                                  detail: '',
                                })
                              }
                            >
                              {finding.partialNote ? 'Review original run' : 'Review citations'}
                            </button>
                          </>
                        ) : (
                          <a href={finding.uri} target="_blank" rel="noreferrer">
                            Open original ↗
                          </a>
                        )}
                        {local && (
                          <button
                            aria-pressed={finding.saved}
                            disabled={pending.includes(finding.key)}
                            onClick={() => void action(() => save(finding))}
                          >
                            {pending.includes(finding.key)
                              ? 'Saving…'
                              : finding.saved
                                ? 'Unsave'
                                : 'Save'}
                          </button>
                        )}
                        <button
                          aria-pressed={selected.includes(finding.key)}
                          onClick={() => selectFinding(finding.key)}
                        >
                          {selected.includes(finding.key) ? 'Selected' : 'Compare'}
                        </button>
                      </div>
                      <details open={state.detail === finding.key}>
                        <summary
                          onClick={(event) => {
                            event.preventDefault();
                            evidenceOpener.current = event.currentTarget;
                            navigate({ detail: state.detail === finding.key ? '' : finding.key });
                          }}
                        >
                          Evidence & details
                        </summary>
                        <span className="desk-visually-hidden">{strengthLabel(finding)}</span>
                        {state.detail === finding.key && (
                          <span className="desk-visually-hidden">
                            Evidence opened beside your results.
                          </span>
                        )}
                      </details>
                      {local && finding.native && state.detail === finding.key && (
                        <div className="desk-actions">
                          <button
                            onClick={() =>
                              void action(async () => {
                                const check = await api<{ status: string; reason: string }>(
                                  'primary-check',
                                  { id: finding.id, destination: finding.origin.destination },
                                );
                                setMessage(`${finding.title}: ${check.status}. ${check.reason}`);
                              })
                            }
                          >
                            Check primary source without AI
                          </button>
                          <button
                            onClick={() =>
                              void action(async () => {
                                const started = await api<{ id: string }>('refresh', {
                                  id: finding.id,
                                  destination: finding.origin.destination,
                                });
                                setMonitorRun(started.id);
                                navigate({ view: 'Search', mode: 'research' });
                              })
                            }
                          >
                            Research changes and independent evidence
                          </button>
                        </div>
                      )}
                      {local && (
                        <details>
                          <summary>Private note and feedback</summary>
                          <LibraryAnnotation
                            finding={finding}
                            save={(patch) =>
                              action(async () => {
                                await api('library-saved', {
                                  key: finding.key,
                                  saved: finding.saved,
                                  ...patch,
                                });
                                await reloadLibrary();
                                setMessage(
                                  'Private note and feedback saved. Evidence strength is unchanged.',
                                );
                              })
                            }
                          />
                        </details>
                      )}
                      {local &&
                        state.project &&
                        projects.find((project) => project.id === state.project)?.connected && (
                          <details>
                            <summary>Connect to selected project</summary>
                            <ProjectAssociation
                              key={`${finding.key}:${state.project}`}
                              finding={finding}
                              project={projects.find((project) => project.id === state.project)!}
                              save={(need, reason, nextAction) =>
                                action(async () => {
                                  await api('opportunities/attach', {
                                    projectId: state.project,
                                    findingKey: finding.key,
                                    need,
                                    reason,
                                    nextAction,
                                  });
                                  await reloadProjects();
                                  setMessage(
                                    'Finding attached to the project with your stated reason.',
                                  );
                                })
                              }
                            />
                          </details>
                        )}
                    </article>
                  ))}
                </section>
                {hits.length > visibleCount && (
                  <button onClick={() => setVisibleCount((count) => count + 40)}>
                    Show more findings ({hits.length - visibleCount} remaining)
                  </button>
                )}
                {loaded && !hits.length && (
                  <section className="desk-empty">
                    <h2>
                      {records.length
                        ? 'No matching findings in this view.'
                        : 'Your corpus is empty.'}
                    </h2>
                    <p>
                      {records.length
                        ? 'Try another phrase or reset filters. Missing corpus coverage does not mean an option does not exist.'
                        : 'Add a resource you know or research an interest to begin.'}
                    </p>
                    <div className="desk-actions">
                      <button onClick={() => navigate({ query: '', kind: '', acquisition: 'all' })}>
                        Clear filters
                      </button>
                      {local && (
                        <>
                          <button onClick={() => navigate({ view: 'Library', panel: 'inbox' })}>
                            Add a link
                          </button>
                          <button onClick={() => navigate({ view: 'Search', mode: 'research' })}>
                            Research an interest
                          </button>
                        </>
                      )}
                    </div>
                  </section>
                )}
              </>
            )}
          </>
        )}
        {local && state.view === 'Projects' && (
          <ProjectDesk
            projects={projects}
            findings={records}
            selected={state.project}
            openAnswer={(finding) => navigate({ detail: finding.key })}
            api={api}
            reload={reloadProjects}
            onOpportunitiesChange={setOpportunities}
            select={(id) => navigate({ project: id })}
            explore={(project) =>
              navigate({ view: 'Search', project: project.id, query: project.purpose })
            }
            research={(preview) => {
              void action(() => {
                const project = projects.find((project) => project.id === preview.projectId);
                const payload = preview.request.context
                  ? (JSON.parse(preview.request.context) as Record<string, unknown>)
                  : null;
                if (
                  !project?.connected ||
                  !payload ||
                  payload.projectId !== project.id ||
                  payload.snapshotDigest !== project.snapshot.digest ||
                  payload.purpose !== project.purpose ||
                  JSON.stringify(payload.constraints) !== JSON.stringify(project.constraints) ||
                  preview.question !== preview.request.query
                ) {
                  setError(
                    'The project research preview is out of date. Preview the current project question again.',
                  );
                  return;
                }
                navigate({
                  view: 'Search',
                  mode: 'research',
                  query: preview.request.query,
                  project: preview.projectId,
                });
                setProjectResearch({
                  ...preview,
                  basis: projectBasis(project),
                  approvalId: crypto.randomUUID(),
                });
              });
            }}
          />
        )}
        {state.view === 'Following' && (
          <>
            <h1>Following</h1>
            <p>
              Manage followed interests and sources. Repeated research uses only your configured schedule.
            </p>
            <nav className="desk-tabs" aria-label="Following views">
              <button
                aria-pressed={state.panel !== 'sources'}
                onClick={() => navigate({ panel: 'interests' })}
              >
                Interests
              </button>
              <button
                aria-pressed={state.panel === 'sources'}
                onClick={() => navigate({ panel: 'sources' })}
              >
                Sources
              </button>
            </nav>
          </>
        )}
        {local && state.view === 'Settings' && <LibrarySavingSettings api={api} />}
        {local && state.view === 'Briefing' && (
          <BriefingPage
            api={api}
            onFollowThrough={(intent) => {
              if (intent.action !== 'investigate') return false;
              navigate({
                view: 'Search',
                mode: 'research',
                query: intent.title,
                run: '',
                detail: '',
              });
              setMessage(
                'Research preparation opened. Exact Briefing item and source references are pending qualification against the existing Research context contract; no research run was started.',
              );
              return true;
            }}
          />
        )}
        {local && workbenchStarted && (
          <div hidden={!powered} className="desk-powered">
            <Workbench
              api={api}
              sessionReady={Boolean(token)}
              requestedTab={powered ?? 'Search'}
              question={state.query}
              reopenRun={reopenRun}
              providedContext={approvedResearch?.request.context}
              providedContextKey={approvedResearch?.approvalId}
              providedContextLabel={
                approvedResearch
                  ? `${projects.find((project) => project.id === approvedResearch.projectId)?.name ?? 'Selected project'}: ${approvedResearch.question}`
                  : undefined
              }
              providedProfile={approvedResearch?.request.profile}
              monitorRun={monitorRun}
              onOpenResult={(runId, restoredQuery) => {
                if (restoredQuery !== undefined && activeReopen.current !== runId) return;
                if (restoredQuery === undefined) activeReopen.current = runId;
                setProjectResearch(null);
                if (restoredQuery !== undefined)
                  navigate(
                    {
                      view: 'Search',
                      mode: 'research',
                      panel: '',
                      run: runId,
                      query: restoredQuery,
                    },
                    true,
                  );
                else if (
                  state.view !== 'Search' ||
                  state.mode !== 'research' ||
                  state.run !== runId
                )
                  navigate({ view: 'Search', mode: 'research', panel: '', run: runId });
              }}
              onCompleted={(runId) => {
                const next = { ...currentState.current, run: runId };
                setState(next);
                writeLocation(next, true);
                void action(reloadLibrary);
              }}
            />
          </div>
        )}
        {detailed && (
          <EvidencePanel title={detailed.title} onClose={closeEvidence}>
            <FindingDetail
              finding={detailed}
              inspection={entityInspection?.key === detailed.key ? entityInspection : null}
              onReopenResearch={(runId) => void action(() => reopenFrozenResearch(runId))}
              matchedFields={
                hits.find((hit) => hit.finding.key === detailed.key)?.matchedFields ?? []
              }
            />
          </EvidencePanel>
        )}
        <footer className="desk-footer">
          <a href={`${base}library.json`} download="signals-library.json">
            Export public Library
          </a>
        </footer>
      </main>
    </div>
  );
}

function ProjectFit({
  projectId,
  findingKey,
  opportunities,
}: {
  projectId: string;
  findingKey: string;
  opportunities: DisplayOpportunity[];
}) {
  const retained = opportunities.filter(
    (opportunity) => opportunity.projectId === projectId && opportunity.findingKey === findingKey,
  );
  if (!retained.length)
    return (
      <p className="desk-fit">
        General use shown above. Project suitability has not been assessed for this finding.
      </p>
    );
  return (
    <section className="desk-fit" aria-label="Retained project fit">
      {retained.map((opportunity) => (
        <div key={opportunity.id}>
          <p>
            <strong>Project need:</strong> {opportunity.need}
          </p>
          <p>{opportunity.reason}</p>
          <p className="desk-meta">
            Retained association · next action: {opportunity.nextAction} · personal decision:{' '}
            {opportunity.status}
            {opportunity.importedSource
              ? ` · original Context status: ${opportunity.importedSource.status}`
              : ''}
          </p>
          {opportunity.needsReview && (
            <p className="desk-error">
              The project basis changed or disconnected. Reconsider this retained association before
              acting.
            </p>
          )}
        </div>
      ))}
    </section>
  );
}

function FindingDetail({
  finding,
  matchedFields,
  inspection,
  onReopenResearch,
}: {
  finding: LibraryFinding;
  matchedFields: string[];
  inspection: {
    loading: boolean;
    data?: SavedEntityInspection;
    error?: string;
  } | null;
  onReopenResearch: (runId: string) => void;
}) {
  return (
    <div className="desk-detail">
      <p className="desk-detail-description">{finding.description}</p>
      {finding.native && (
        <SavedEntityReview
          finding={finding}
          inspection={inspection}
          onReopenResearch={onReopenResearch}
        />
      )}
      {finding.answer && (
        <section aria-label="Complete retained answer">
          <h4>Complete answer · Unassessed · Confidence Unknown</h4>
          <Brief text={finding.answerText!} />
          <p>
            Receipt {finding.answer.runId} · SHA256 {finding.answer.sha256}. Observation time is
            receipt time, not source freshness. Citation occurrence does not prove truth or
            independence.
          </p>
          <details>
            <summary>Original answer text and provenance</summary>
            <pre>{finding.answerText}</pre>
            <pre>{JSON.stringify(finding.answer.provenance, null, 2)}</pre>
          </details>
        </section>
      )}
      {finding.partialNote && (
        <section aria-label="Incomplete retained note">
          <h4>Incomplete research note · {finding.partialNote.status}</h4>
          {finding.answerText ? (
            <Brief text={finding.answerText} />
          ) : (
            <p>{finding.partialNote.unavailableReason ?? 'Original unavailable.'}</p>
          )}
          <p>
            Original run {finding.partialNote.runId} · SHA256{' '}
            {finding.partialNote.sha256 ?? 'unavailable'}. This is not a completed answer or
            verified claim.
          </p>
          <ul>
            {finding.partialNote.limits.map((limit, index) => (
              <li key={index}>{limit}</li>
            ))}
          </ul>
        </section>
      )}
      <details>
        <summary>About this item</summary>
        <p>
          {finding.intrinsicStrength.policy}: signal strength records an evidence policy judgment;
          it is separate from query relevance and does not prove usefulness.
        </p>
        <AssessmentConfidence />
        <p>
          License:{' '}
          {finding.license.state === 'known' ? finding.license.values.join(', ') : 'Unknown'}.
          Access:{' '}
          {finding.access.state === 'unknown'
            ? 'Unknown'
            : finding.access.freeToUse
              ? 'Free to use'
              : 'Not marked free to use'}
          .
        </p>
        {matchedFields.length > 0 && (
          <p>
            Search matched: {matchedFields.join(', ')}. This is lexical retrieval, not a suitability
            assessment.
          </p>
        )}
        {local && (
          <p>
            {finding.origin.destination === 'private'
              ? 'Private retained record'
              : 'Public corpus record'}{' '}
            · {finding.id}
          </p>
        )}
      </details>
      {finding.lead && (
        <section>
          <h4>Saved lead · not assessed</h4>
          <p>
            Saved {date(finding.lead.savedAt)} from “{finding.lead.query}”. Personal saving adds no
            evidence or Signal.
          </p>
          <ul>
            {finding.lead.limits.map((limit) => (
              <li key={limit}>{limit}</li>
            ))}
          </ul>
          <p>
            The original link is available above. Research and source inspection are separate
            actions.
          </p>
        </section>
      )}
      {finding.native && (
        <>
          <h4>What to know</h4>
          <p>{finding.native.limits[0] ?? 'No limitations recorded.'}</p>
          <details>
            <summary>All limitations ({finding.native.limits.length})</summary>
            <ul>
              {finding.native.limits.map((limit) => (
                <li key={limit}>{limit}</li>
              ))}
            </ul>
          </details>
          {finding.native.evidence.map((source) => (
            <details className="desk-source" key={source.id}>
              <summary>{source.title}</summary>
              <a href={source.uri} target="_blank" rel="noreferrer">
                Open source ↗
              </a>
              <p>
                {source.state} · {source.publisher} · {source.family}
              </p>
              <p className="desk-meta">
                Publication: {date(source.publishedAt)} · fetched: {date(source.fetchedAt)} ·
                origin: {source.origin}
              </p>
              <details>
                <summary>Acquisition receipt</summary>
                <p>
                  Acquired payload digest: <code>{source.digest ?? 'Unknown'}</code>. Equal known
                  payloads establish duplicated material, not creator identity.
                </p>
              </details>
              <p>{source.excerpt || source.reason}</p>
              <details>
                <summary>Bound observations</summary>
                {finding
                  .native!.observations.filter(
                    (observation) => observation.evidenceId === source.id,
                  )
                  .map((observation) => (
                    <div key={observation.id}>
                      <p>{observation.statement}</p>
                      <blockquote>{observation.quote}</blockquote>
                      <p>
                        {observation.status} ·{' '}
                        {observation.verified ? 'Matched passage' : 'Unmatched passage'}. Text
                        matching does not establish factual entailment.
                      </p>
                      <p className="desk-meta">
                        {observation.independent
                          ? 'Independent evidence reported'
                          : 'Independence not established'}{' '}
                        · model observation
                      </p>
                    </div>
                  ))}
              </details>
            </details>
          ))}
          <details>
            <summary>Assessment factors and history</summary>
            <p>
              {finding.native.assessment.rubric ?? finding.kind} ·{' '}
              {finding.native.assessment.disposition ?? finding.native.assessment.state}
            </p>
            <AssessmentDerivation entity={finding.native} />
            <details>
              <summary>Full stored assessment</summary>
              <pre>{JSON.stringify(finding.native.assessment, null, 2)}</pre>
            </details>
          </details>
        </>
      )}
      {finding.legacy && (
        <>
          <h4>Retained historical finding</h4>
          <p>Historical review retains its original evidence and strength meanings.</p>
          <p>{finding.legacy.reason}</p>
          <ul>
            {finding.legacy.limitations.map((limit) => (
              <li key={limit}>{limit}</li>
            ))}
          </ul>
          {finding.legacy.claims.map((claim) => (
            <section key={claim.id}>
              <p>{claim.text}</p>
              <p>
                Freshness: {claim.freshness}. Historical review: {claim.review.basis}.
              </p>
              <ul>
                {finding
                  .legacy!.sources.filter((source) => claim.source_ids.includes(source.id))
                  .map((source) => (
                    <li key={source.id}>
                      <a href={source.uri} target="_blank" rel="noreferrer">
                        {source.title}
                      </a>
                    </li>
                  ))}
              </ul>
            </section>
          ))}
          <details>
            <summary>Historical record and original policy</summary>
            <pre>{JSON.stringify(finding.legacy, null, 2)}</pre>
          </details>
        </>
      )}
      {finding.notes && (
        <>
          <h4>Private note</h4>
          <p>{finding.notes}</p>
        </>
      )}
    </div>
  );
}

function LibraryAnnotation({
  finding,
  save,
}: {
  finding: LibraryFinding;
  save: (patch: { note: string; feedback: string; novelty: string }) => Promise<void>;
}) {
  const [note, setNote] = useState(finding.notes ?? '');
  const [feedback, setFeedback] = useState(finding.feedback ?? 'none');
  const [novelty, setNovelty] = useState(finding.novelty ?? 'unknown');
  const [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void save({ note, feedback, novelty }).finally(() => setBusy(false));
      }}
    >
      <label>
        Note for {finding.title}
        <textarea
          aria-label={`Note for ${finding.title}`}
          maxLength={4000}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      <label>
        Feedback for {finding.title}
        <select
          value={feedback}
          onChange={(event) => setFeedback(event.target.value as typeof feedback)}
        >
          <option value="none">No feedback yet</option>
          <option value="useful">Useful</option>
          <option value="skip">Defer for now</option>
          <option value="mute">Mute</option>
        </select>
      </label>
      <label>
        Personal novelty for {finding.title}
        <select
          value={novelty}
          onChange={(event) => setNovelty(event.target.value as typeof novelty)}
        >
          <option value="unknown">Unknown</option>
          <option value="known">Already known</option>
          <option value="confirmed-new">New to me</option>
        </select>
      </label>
      <p>Annotations remain private and do not increase evidence strength.</p>
      <button disabled={busy}>{busy ? 'Saving annotation…' : 'Save private annotation'}</button>
    </form>
  );
}
function ProjectAssociation({
  finding,
  project,
  save,
}: {
  finding: LibraryFinding;
  project: Project;
  save: (need: string, reason: string, nextAction: string) => Promise<void>;
}) {
  const [need, setNeed] = useState(project.purpose);
  const [reason, setReason] = useState('');
  const [nextAction, setNextAction] = useState(
    finding.kind === 'learning-resource' ? 'learn' : 'explore',
  );
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save(need, reason, nextAction);
      }}
    >
      <p>
        Connect {finding.title} to {project.name}. This records your judgment; it does not execute
        or install the resource.
      </p>
      <label>
        Project need
        <textarea
          aria-label="Project need"
          required
          maxLength={3000}
          value={need}
          onChange={(event) => setNeed(event.target.value)}
        />
      </label>
      <label>
        Why this finding fits
        <textarea
          aria-label="Why this finding fits"
          required
          maxLength={3000}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <label>
        Next action
        <select value={nextAction} onChange={(event) => setNextAction(event.target.value)}>
          <option value="learn">Learn</option>
          <option value="explore">Explore</option>
          <option value="compare">Compare alternatives</option>
          <option value="consider-for-trial">Consider for an authorized trial</option>
        </select>
      </label>
      <button disabled={!need.trim() || !reason.trim()}>Attach finding to project</button>
    </form>
  );
}
