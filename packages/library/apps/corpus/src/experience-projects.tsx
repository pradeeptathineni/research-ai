import { useEffect, useState } from 'react';
import type { LibraryFinding } from '../../../packages/domain/src/library-search.js';
import type {
  Project,
  Opportunity,
  ProjectSource,
} from '../../../packages/corpus/src/project-contract.js';
import type { ProjectPreview } from '../../../packages/corpus/src/project-preview.js';

export type ResearchPreview = {
  projectId: string;
  question: string;
  context: string;
  warning: string;
  request: { query: string; context?: string; profile?: 'quick' | 'wide' };
};
type Match = {
  findingKey: string;
  need: string;
  reason: string;
  nextAction: 'explore';
  method: 'lexical';
};
export type DisplayOpportunity = Opportunity & { needsReview?: boolean };
export function ProjectDesk({
  projects,
  findings,
  selected,
  api,
  reload,
  select,
  explore,
  research,
  openAnswer,
  onOpportunitiesChange,
}: {
  projects: Project[];
  findings: LibraryFinding[];
  selected: string;
  api: <T>(route: string, body?: unknown) => Promise<T>;
  reload: () => Promise<void>;
  select: (id: string) => void;
  explore: (project: Project) => void;
  research: (preview: ResearchPreview) => void;
  openAnswer: (finding: LibraryFinding) => void;
  onOpportunitiesChange: (opportunities: DisplayOpportunity[]) => void;
}) {
  const [sourceKind, setSourceKind] = useState<ProjectSource['kind']>('local');
  const [sourceValue, setSourceValue] = useState('');
  const [preview, setPreview] = useState<ProjectPreview | null>(null);
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [constraints, setConstraints] = useState('');
  const [opportunities, setOpportunities] = useState<DisplayOpportunity[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [tab, setTab] = useState('Opportunities');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [question, setQuestion] = useState('');
  const [researchPreview, setResearchPreview] = useState<ResearchPreview | null>(null);
  const [researchOpen, setResearchOpen] = useState(false);
  const [setup, setSetup] = useState<{ context_request: unknown } | null>(null);
  const [contextHistory, setContextHistory] = useState<unknown[]>([]);
  const [contextResult, setContextResult] = useState<Record<string, unknown> | null>(null);
  const project = projects.find((entry) => entry.id === selected);
  async function refreshOpportunities() {
    const result = await api<{ opportunities: DisplayOpportunity[] }>('opportunities');
    setOpportunities(result.opportunities);
    onOpportunitiesChange(result.opportunities);
  }
  useEffect(() => {
    void refreshOpportunities().catch((failure: unknown) => setError(String(failure)));
  }, []);
  useEffect(() => {
    setMatches([]);
    setSetup(null);
    setContextHistory([]);
    setContextResult(null);
    setResearchPreview(null);
    setResearchOpen(false);
    if (project) {
      setName(project.name);
      setPurpose(project.purpose);
      setConstraints(project.constraints.join('\n'));
    }
  }, [selected, project?.snapshot.digest, project?.purpose, JSON.stringify(project?.constraints)]);
  async function action(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }
  const attached = opportunities.filter((entry) => entry.projectId === selected);
  const unlinked = opportunities.filter((entry) => !entry.projectId);
  return (
    <section className="desk-projects">
      <div className="desk-heading">
        <h1>{project?.name ?? 'Projects'}</h1>
        <p>
          {project
            ? project.purpose
            : 'Connect evidence to an observed need. General opportunities stay here; AI equipment setup belongs to Context.'}
        </p>
      </div>
      {error && (
        <p role="alert" className="desk-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {unlinked.length > 0 && (
        <p className="desk-opportunity-index">
          <a href="#retained-opportunities">
            {unlinked.length} retained and imported opportunities
          </a>{' '}
          keep their original project references and decisions. Registration is only needed to
          connect one to a current read-only project snapshot.
        </p>
      )}
      <details open={!projects.length && !project}>
        <summary>Add a project</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void action(async () => {
              const source: ProjectSource =
                sourceKind === 'local'
                  ? { kind: 'local', path: sourceValue }
                  : { kind: 'github', uri: sourceValue };
              const result = await api<ProjectPreview>('projects/preview', { source });
              setPreview(result);
              setName(result.project.name);
              setPurpose(result.project.purpose);
              setConstraints(result.project.constraints.join('\n'));
            });
          }}
        >
          <label>
            Selected project source
            <select
              value={sourceKind}
              onChange={(event) => {
                setSourceKind(event.target.value as ProjectSource['kind']);
                setPreview(null);
              }}
            >
              <option value="local">Local folder (Git optional)</option>
              <option value="github">GitHub repository</option>
            </select>
          </label>
          <label>
            {sourceKind === 'local' ? 'Explicit local folder path' : 'GitHub repository URL'}
            <input
              required
              value={sourceValue}
              onChange={(event) => setSourceValue(event.target.value)}
              placeholder={
                sourceKind === 'local'
                  ? '/absolute/path/to/project'
                  : 'https://github.com/owner/repository'
              }
            />
          </label>
          <p>
            Read-only preview of selected documents and manifests. No package scripts, repository
            instructions or model calls run.
          </p>
          <button disabled={busy || !sourceValue.trim()}>
            {busy ? 'Reading selected source…' : 'Preview read-only summary'}
          </button>
        </form>
        {preview && (
          <section className="desk-project-preview" aria-label="Project registration preview">
            <h2>Inspect the selected summary</h2>
            <p>
              Source basis: {preview.project.snapshot.basis} · revision{' '}
              {preview.project.snapshot.revision ?? 'Not recorded'} · working-copy state{' '}
              {preview.project.snapshot.dirty}.
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void action(async () => {
                  const saved = await api<Project>('projects/register', {
                    previewId: preview.id,
                    name,
                    purpose,
                    constraints: constraints
                      .split('\n')
                      .map((line) => line.trim())
                      .filter(Boolean),
                  });
                  await reload();
                  await refreshOpportunities();
                  setPreview(null);
                  select(saved.id);
                  setMessage('Project registered locally. No inference or installation performed.');
                });
              }}
            >
              <label>
                Project name
                <input
                  required
                  maxLength={200}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                Purpose to use for this project
                <textarea
                  required
                  aria-label="Purpose to use for this project"
                  maxLength={3000}
                  value={purpose}
                  onChange={(event) => setPurpose(event.target.value)}
                />
              </label>
              <label>
                Constraints (one per line)
                <textarea
                  maxLength={10000}
                  aria-label="Constraints (one per line)"
                  value={constraints}
                  onChange={(event) => setConstraints(event.target.value)}
                />
              </label>
              <details>
                <summary>Selected files and exclusions</summary>
                {preview.project.snapshot.files.map((file) => (
                  <section key={file.path}>
                    <h3>{file.path}</h3>
                    <p>{file.excerpt}</p>
                  </section>
                ))}
                <ul>
                  {preview.project.snapshot.gaps.map((gap) => (
                    <li key={gap}>{gap}</li>
                  ))}
                </ul>
              </details>
              <details>
                <summary>What online research could send</summary>
                <p>{preview.egress.warning}</p>
                <p>Local absolute paths are excluded. This preview has sent nothing to a model.</p>
                <pre>{JSON.stringify(preview.egress, null, 2)}</pre>
              </details>
              <button disabled={busy}>Register project</button>
            </form>
          </section>
        )}
      </details>
      {!project && (
        <>
          <div className="desk-section-line">
            <h2>Registered projects</h2>
            <p>{projects.length} selected sources</p>
          </div>
          {projects.map((entry) => (
            <article className="desk-project-row" key={entry.id}>
              <h3>{entry.name}</h3>
              <p>{entry.purpose}</p>
              <p className="desk-meta">
                {entry.connected ? 'Connected' : 'Disconnected'} · read-only summary observed{' '}
                {entry.snapshot.observedAt} · {entry.snapshot.basis}
              </p>
              <button onClick={() => select(entry.id)}>Open {entry.name}</button>
            </article>
          ))}
          {!projects.length && (
            <p>No projects registered. Start with a selected folder or repository.</p>
          )}
        </>
      )}
      {project && (
        <>
          <button onClick={() => select('')}>All projects</button>
          <p className="desk-meta">
            {project.connected ? 'Connected' : 'Disconnected'} · source{' '}
            {project.source.kind === 'github' ? project.source.uri : project.source.path} · snapshot{' '}
            {project.snapshot.digest.slice(0, 12)}
          </p>
          <nav className="desk-tabs" aria-label="Project views">
            {['Opportunities', 'Saved', 'Activity'].map((value) => (
              <button key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>
                {value}
              </button>
            ))}
          </nav>
          {tab === 'Activity' ? (
            <>
              <h2>Source and decisions</h2>
              <button
                onClick={() =>
                  void action(async () => {
                    const result = await api<{ history: unknown[] }>('projects/history', {
                      id: project.id,
                    });
                    setContextHistory(result.history);
                  })
                }
              >
                Read retained project context history
              </button>
              {contextHistory.length > 0 && (
                <details>
                  <summary>{contextHistory.length} retained project contexts</summary>
                  <pre>{JSON.stringify(contextHistory, null, 2)}</pre>
                </details>
              )}
              <p>
                Summary observed {project.snapshot.observedAt}. Source basis{' '}
                {project.snapshot.basis}; revision {project.snapshot.revision ?? 'unknown'};
                working-copy state {project.snapshot.dirty}.
              </p>
              {attached.map((entry) => (
                <p key={entry.id}>
                  {entry.title}: {entry.status} · {entry.provenance.method} ·{' '}
                  {entry.provenance.importedAt}
                </p>
              ))}
              <details>
                <summary>Edit purpose and constraints</summary>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void action(async () => {
                      await api('projects/update', {
                        id: project.id,
                        name,
                        purpose,
                        constraints: constraints
                          .split('\n')
                          .map((line) => line.trim())
                          .filter(Boolean),
                      });
                      await reload();
                      setMessage(
                        'Project intent updated. Evidence and existing decisions are preserved.',
                      );
                    });
                  }}
                >
                  <label>
                    Project name
                    <input value={name} onChange={(event) => setName(event.target.value)} />
                  </label>
                  <label>
                    Project purpose
                    <textarea
                      aria-label="Project purpose"
                      value={purpose}
                      onChange={(event) => setPurpose(event.target.value)}
                    />
                  </label>
                  <label>
                    Project constraints
                    <textarea
                      aria-label="Project constraints"
                      value={constraints}
                      onChange={(event) => setConstraints(event.target.value)}
                    />
                  </label>
                  <button disabled={busy}>Save project intent</button>
                </form>
              </details>
              {project.connected && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await api('projects/disconnect', { id: project.id });
                      await reload();
                      await refreshOpportunities();
                      setMessage(
                        'Project disconnected. Files remain untouched; findings and decisions remain retained.',
                      );
                    })
                  }
                >
                  Disconnect selected project
                </button>
              )}
            </>
          ) : (
            <>
              <h2>{tab === 'Saved' ? 'Retained project opportunities' : 'Opportunities'}</h2>
              {attached
                .filter((entry) => tab !== 'Saved' || entry.status === 'saved')
                .map((entry) => (
                  <OpportunityRow
                    key={entry.id}
                    opportunity={entry}
                    finding={findings.find((finding) => finding.key === entry.findingKey)}
                    openAnswer={openAnswer}
                    onSave={(status, note) =>
                      action(async () => {
                        await api('opportunities/update', { id: entry.id, status, note });
                        await refreshOpportunities();
                      })
                    }
                    setup={
                      project.connected && !entry.needsReview && entry.status !== 'declined'
                        ? (targetProfile: string, aiNeed: string) =>
                            action(async () =>
                              setSetup(
                                await api<{ context_request: unknown }>('projects/ai-setup', {
                                  projectId: project.id,
                                  opportunityId: entry.id,
                                  need: aiNeed,
                                  targetProfile,
                                }),
                              ),
                            )
                        : undefined
                    }
                  />
                ))}
              {!attached.length && (
                <p>
                  No opportunities attached yet. Explore the corpus, keep a finding with a reason,
                  or research one named gap.
                </p>
              )}
              {project.connected && (
                <div className="desk-actions">
                  <button onClick={() => explore(project)}>
                    Explore whole corpus for this project
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        const response = await api<{ matches: Match[] }>('projects/matches', {
                          id: project.id,
                        });
                        setMatches(response.matches);
                      })
                    }
                  >
                    Find retained leads without a model
                  </button>
                </div>
              )}
              {matches.length > 0 && (
                <section aria-label="Corpus leads for project">
                  <h3>Leads from project terms</h3>
                  <p>Lexical matches are opportunities to inspect, not confirmed suitability.</p>
                  {matches.map((match) => {
                    const finding = findings.find((entry) => entry.key === match.findingKey);
                    return (
                      finding && (
                        <article className="desk-project-row" key={match.findingKey}>
                          <h3>{finding.title}</h3>
                          <p>{finding.description}</p>
                          <p>{match.reason}</p>
                          <button
                            disabled={busy}
                            onClick={() =>
                              void action(async () => {
                                await api('opportunities/attach', {
                                  projectId: project.id,
                                  findingKey: finding.key,
                                  need: match.need,
                                  reason: match.reason,
                                  nextAction: match.nextAction,
                                });
                                await refreshOpportunities();
                                setMessage('Lead attached with its lexical match limitation.');
                              })
                            }
                          >
                            Retain {finding.title} for this project
                          </button>
                        </article>
                      )
                    );
                  })}
                </section>
              )}
              {project.connected && (
                <details
                  key="project-research"
                  open={researchOpen}
                  onToggle={(event) => setResearchOpen(event.currentTarget.open)}
                >
                  <summary>Research one project gap</summary>
                  <label>
                    Question for this project
                    <input
                      value={question}
                      maxLength={2000}
                      onChange={(event) => {
                        setQuestion(event.target.value);
                        setResearchPreview(null);
                      }}
                    />
                  </label>
                  <button
                    disabled={busy || !question.trim()}
                    onClick={() =>
                      void action(async () =>
                        setResearchPreview(
                          await api<ResearchPreview>('projects/research-preview', {
                            id: project.id,
                            question,
                          }),
                        ),
                      )
                    }
                  >
                    Preview research context
                  </button>
                  {researchPreview && (
                    <section aria-label="Project research egress">
                      <h3>Inspect before online research</h3>
                      <p>{researchPreview.warning}</p>
                      <pre>{researchPreview.context}</pre>
                      <button onClick={() => research(researchPreview)}>
                        Use this context in online research
                      </button>
                      <p>
                        This opens the configured budget and explicit Start control. It does not
                        start inference.
                      </p>
                    </section>
                  )}
                </details>
              )}
            </>
          )}
        </>
      )}
      {unlinked.length > 0 && (
        <section id="retained-opportunities" aria-label="Imported or unlinked opportunities">
          <h2>Retained opportunities to associate</h2>
          <p>
            Imported records retain their original state and source ownership. They are known
            material, not new discoveries.
          </p>
          {unlinked.map((entry) => (
            <OpportunityRow
              key={entry.id}
              opportunity={entry}
              finding={findings.find((finding) => finding.key === entry.findingKey)}
              openAnswer={openAnswer}
              projects={projects}
              associate={(projectId) =>
                action(async () => {
                  await api('opportunities/project', { id: entry.id, projectId });
                  await refreshOpportunities();
                  setMessage(
                    'Imported opportunity associated. Original observation and personal decision are preserved.',
                  );
                })
              }
              onSave={(status, note) =>
                action(async () => {
                  await api('opportunities/update', { id: entry.id, status, note });
                  await refreshOpportunities();
                })
              }
            />
          ))}
        </section>
      )}
      {setup !== null && (
        <section aria-label="Context setup request">
          <h2>Portable request for Context</h2>
          <p>
            Context owns equipment selection and delivery. This request performs no installation.
          </p>
          <pre>{JSON.stringify(setup, null, 2)}</pre>
          <a
            download="context-setup-request.json"
            href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(setup.context_request))}`}
          >
            Download Context request
          </a>
        </section>
      )}
      {project && (
        <details>
          <summary>Inspect a reported Context result</summary>
          <p>
            Open an actual Context JSON result for this project. This private browser preview sends
            no file, installs nothing and does not treat a reported plan as activation evidence.
          </p>
          <label>
            Context result JSON
            <input
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                void action(async () => {
                  if (file.size > 131072)
                    throw new Error('Context result exceeds the preview byte budget.');
                  const result: unknown = JSON.parse(await file.text());
                  if (!result || typeof result !== 'object' || Array.isArray(result))
                    throw new Error('Supply the original Context result object.');
                  const record = result as Record<string, unknown>;
                  const ref = record.project_ref;
                  if (
                    !ref ||
                    typeof ref !== 'object' ||
                    !('id' in ref) ||
                    ref.id !== project.id ||
                    typeof record.profile_id !== 'string'
                  )
                    throw new Error(
                      'Context result project or profile identity is missing or does not match this project.',
                    );
                  setContextResult(record);
                });
              }}
            />
          </label>
          {contextResult !== null && (
            <section aria-label="Reported Context result">
              <h2>Reported by Context</h2>
              <p>
                Profile {String(contextResult.profile_id)} · status{' '}
                {typeof contextResult.status === 'string' ? contextResult.status : 'not reported'} ·
                plan{' '}
                {typeof contextResult.plan_id === 'string' ? contextResult.plan_id : 'not reported'}
                . No commands have been run by Signals.
              </p>
              <pre>{JSON.stringify(contextResult, null, 2)}</pre>
            </section>
          )}
        </details>
      )}
    </section>
  );
}
function OpportunityRow({
  opportunity,
  finding,
  openAnswer,
  onSave,
  setup,
  projects,
  associate,
}: {
  opportunity: DisplayOpportunity;
  finding?: LibraryFinding;
  openAnswer: (finding: LibraryFinding) => void;
  onSave: (status: Opportunity['status'], note: string) => Promise<void>;
  setup?: (targetProfile: string, aiNeed: string) => Promise<void>;
  projects?: Project[];
  associate?: (projectId: string) => Promise<void>;
}) {
  const [note, setNote] = useState(opportunity.note);
  const [status, setStatus] = useState(opportunity.status);
  const [projectId, setProjectId] = useState('');
  const [targetProfile, setTargetProfile] = useState('');
  const [aiNeed, setAiNeed] = useState('');
  return (
    <article className="desk-project-row">
      <h3>{opportunity.title}</h3>
      <p>
        <strong>Need:</strong> {opportunity.need}
      </p>
      <p>{opportunity.reason}</p>
      <p className="desk-meta">
        Next action: {opportunity.nextAction} · {opportunity.status} ·{' '}
        {opportunity.provenance.method === 'migrated'
          ? `Imported from Context at ${opportunity.provenance.sourceRevision}`
          : 'User-retained association'}
      </p>
      {opportunity.needsReview && (
        <p className="desk-error">
          The project source changed or disconnected; recheck this fit before acting.
        </p>
      )}
      {opportunity.importedSource && (
        <p className="desk-meta">
          Original Context observation: {opportunity.importedSource.status}. Personal decision is
          shown separately.
        </p>
      )}
      {opportunity.projectRef && (
        <p className="desk-meta">Original project reference: {opportunity.projectRef}</p>
      )}
      {finding ? (
        <>
          {finding.answer ? (
            <button onClick={() => openAnswer(finding)}>Reopen complete answer</button>
          ) : (
            <a href={finding.uri} target="_blank" rel="noreferrer">
              Open {finding.title}
            </a>
          )}
          <p>
            {finding.answer?.limits[0] ??
              finding.native?.limits[0] ??
              finding.legacy?.limitations[0] ??
              'Inspect supporting sources and limits.'}
          </p>
        </>
      ) : (
        <p>
          {opportunity.findingKey
            ? 'The linked finding is unavailable.'
            : 'No library finding is linked.'}{' '}
          Retained evidence and decisions remain below.
        </p>
      )}
      <details>
        <summary>Evidence, decision and private note</summary>
        <ul>
          {opportunity.evidenceRefs?.map((ref) => (
            <li key={ref.uri}>
              <a href={ref.uri} target="_blank" rel="noreferrer">
                {ref.label ?? ref.uri}
              </a>
            </li>
          ))}
        </ul>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onSave(status, note);
          }}
        >
          <label>
            Decision for {opportunity.title}
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as Opportunity['status'])}
            >
              <option value="open">Explore later</option>
              <option value="saved">Retain</option>
              <option value="declined">Decline for this need</option>
              <option value="done">Completed</option>
            </select>
          </label>
          <label>
            Private note for {opportunity.title}
            <textarea
              value={note}
              maxLength={5000}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <button>Save decision</button>
        </form>
      </details>
      {setup && (
        <details>
          <summary>AI engineering setup (Context)</summary>
          <p>
            Declare a separate AI engineering need when equipment guidance would help this project.
            The original opportunity and next action stay unchanged. Context returns a plan; this
            performs no installation.
          </p>
          <label>
            AI engineering need for {opportunity.title}
            <textarea
              aria-label={`AI engineering need for ${opportunity.title}`}
              maxLength={512}
              value={aiNeed}
              onChange={(event) => setAiNeed(event.target.value)}
            />
          </label>
          <div className="desk-actions">
            <label>
              Context profile ID for {opportunity.title}
              <input
                value={targetProfile}
                maxLength={64}
                onChange={(event) => setTargetProfile(event.target.value)}
                placeholder="An existing Context profile ID"
              />
            </label>
            <button
              disabled={!targetProfile.trim() || !aiNeed.trim()}
              onClick={() => void setup(targetProfile.trim(), aiNeed.trim())}
            >
              Prepare AI setup request for Context
            </button>
          </div>
        </details>
      )}
      {associate && projects?.some((project) => project.connected) && (
        <div className="desk-actions">
          <label>
            Associate {opportunity.title} with project
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              <option value="">Choose a registered project</option>
              {projects
                .filter((project) => project.connected)
                .map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
            </select>
          </label>
          <button disabled={!projectId} onClick={() => void associate(projectId)}>
            Associate retained opportunity
          </button>
        </div>
      )}
    </article>
  );
}
