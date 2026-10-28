export interface Readable {
  format: "markdown";
  text: string;
}

export interface LiteraturePaper {
  id: `paper:${string}`;
  metadata: { title: string; authors?: string[]; year?: number; containerTitle?: string; publisher?: string; doi?: string; url?: string; type?: "article" | "book" | "report" | "webpage" };
  availability: "available" | "missing" | "retracted";
  statusEvidence: { kind: "missing-source" | "retraction" | "expression-of-concern" | "correction"; assertedBy: string; observedAt: string; verification: "asserted-unverified"; detail: string } | null;
  /** Exact pointer to an existing notebook-owned source; never contains article text. */
  source: { notebookId: string; notebookSha256: string; sourceId: string; sourceDigest: string; documentId: string; documentSha256: string } | null;
  /** Caller-supplied finding note; not independently synthesized or verified. */
  finding: string | null;
  stance: "supports" | "opposes" | "mixed" | "unclear" | null;
  claimKey: string | null;
  qualification: string[];
}
export interface LiteratureSet {
  schema: "research-literature-set-v1"; id: `literature-set:${string}`; title: string; revision: number;
  papers: LiteraturePaper[]; sha256: string;
}
export function createLiteratureSet(title: string, options?: { id?: string }): LiteratureSet;
export function addLiteraturePaper(value: LiteratureSet, paper: LiteraturePaper): LiteratureSet;
export function validateLiteratureSet(value: unknown): LiteratureSet;
export function deduplicateLiteraturePapers(papers: LiteraturePaper[]): { schema: "research-literature-dedupe-v1"; duplicates: Array<{ papers: string[]; basis: string; qualification: string }>; ambiguities: Array<{ papers: string[]; basis: string; similarity: number; qualification: string }> };
export function resolveLiteratureSet(value: LiteratureSet, notebooks: unknown[]): { schema: "research-literature-resolution-v1"; literatureSetId: string; literatureSetSha256: string; resolved: Array<{ paperId: string; availability: "available" | "missing" | "retracted"; notebookId?: string; sourceId?: string; sourceDigest?: string; document: unknown | null; qualification?: string[] }> };
export function rebindLiteratureSet(value: LiteratureSet, notebooks: unknown[]): {
  schema: "research-literature-rebind-v1";
  previous: { id: LiteratureSet["id"]; revision: number; sha256: string };
  literatureSet: LiteratureSet;
  changedPapers: Array<{ paperId: LiteraturePaper["id"]; fromNotebookSha256: string; toNotebookSha256: string }>;
  sourceChecks: Array<{ paperId: LiteraturePaper["id"]; notebookId: string; sourceId: string; sourceDigest: string; documentId: string; documentSha256: string }>;
};
export function prepareLiteratureQuestion(value: LiteratureSet, notebook: unknown, question: string, policy?: object, options?: { includeRetracted?: boolean }): { schema: "research-literature-question-v1"; literatureSetId: string; literatureSetSha256: string; prepared: unknown; includedPapers: Array<{ paperId: string; sourceId: string; sourceDigest: string; statusEvidence: LiteraturePaper["statusEvidence"] }>; coverage: Array<{ paperId: string; availability: LiteraturePaper["availability"]; source: LiteraturePaper["source"] | null; disposition: "included" | "not-searched-source-missing" | "excluded-retracted-by-default" | "outside-selected-notebook-cross-notebook-not-joined"; statusEvidence: LiteraturePaper["statusEvidence"]; qualification: string[] }> };
export interface LiteratureStudyPaperRecord extends Omit<LiteraturePaper, "source"> {
  source: LiteraturePaper["source"];
}
export interface LiteratureStudyPaperReference extends LiteratureStudyPaperRecord {
  source: NonNullable<LiteraturePaper["source"]>;
}
export interface LiteratureStudySourceMapEntry {
  coverageDocumentId: string;
  sourceBinding: NonNullable<LiteraturePaper["source"]>;
  papers: LiteratureStudyPaperReference[];
  sourceIndependence: "unknown" | "same-exact-source-aliases";
}
export interface PreparedLiteratureStudyQuestion {
  schema: "research-literature-study-question-v1";
  /** Complete metadata and owner pointers, without copied source text. */
  literatureSet: LiteratureSet;
  /** Explicit 1–100 unique selected paper records; exact source aliases may share one coverage document. */
  selectedPaperIds: string[];
  includeRetracted: boolean;
  /** Null when the selection contains no eligible retained source to review. */
  request: { question: string; documents: ResearchDocumentInput[]; policy: DocumentCoveragePolicy } | null;
  sourceMap: LiteratureStudySourceMapEntry[];
  includedPapers: Array<LiteratureStudyPaperReference & { coverageDocumentId: string; sourceIndependence: "unknown" | "same-exact-source-aliases" }>;
  coverage: Array<LiteratureStudyPaperRecord & {
    disposition: "included" | "not-selected" | "not-searched-source-missing" | "excluded-retracted-by-default" | "not-included";
    sourceResolution: "resolved-at-preparation" | "missing-no-retained-source" | "not-compared-not-selected" | "not-compared-excluded-retracted" | "not-compared";
    coverageDocumentId: string | null;
    sourceIndependence: "unknown" | "same-exact-source-aliases";
  }>;
  /** Deterministic document coverage preview. Null when no source document is eligible. */
  preview: PreparedDocumentCoverage | null;
  /** Content digest over the complete prepared closure, excluding this field. Not authenticated origin. */
  sha256: string;
}
export function prepareLiteratureStudyQuestion(value: LiteratureSet, notebooks: unknown[], question: string,
  policy: Partial<DocumentCoveragePolicy> | undefined, options: { /** 1–100 unique IDs from the set; the coverage planner separately caps unique exact source bindings at eight. */ paperIds: string[]; includeRetracted?: boolean }): PreparedLiteratureStudyQuestion;
/** Cold structural and digest validation; does not compare with current owner state. */
export function validateLiteratureStudyQuestion(value: unknown): PreparedLiteratureStudyQuestion;
export function checkLiteratureStudyQuestionSources(value: PreparedLiteratureStudyQuestion, currentSet: LiteratureSet, notebooks: unknown[]): {
  schema: "research-literature-study-currentness-v1";
  literatureSet: { status: "current" | "changed"; expectedSha256: string; currentSha256: string };
  sources: Array<
    | { coverageDocumentId: string; status: "current" | "changed"; notebookId: string; notebookSha256: string; sourceId: string; sourceDigest: string; documentId: string; documentSha256: string }
    | { coverageDocumentId: string; status: "missing"; notebookId: string; sourceId: string; notebookSha256?: string; sourceDigest?: null; documentId?: null; documentSha256?: null }
  >;
};
export function projectLiteratureStudyEvidence(value: PreparedLiteratureStudyQuestion, result: DocumentCoverageResult): {
  schema: "research-literature-study-evidence-v1"; literatureSetId: string; literatureSetSha256: string; question: string;
  resultStatus: DocumentCoverageResult["status"]; coverage: "answered" | "partial" | "insufficient" | null;
  answer: Array<{ text: string; evidenceIds: string[] }> | null;
  evidence: Array<DocumentCoverageEvidence & { paperReferences: LiteratureStudyPaperReference[]; sourceBinding: NonNullable<LiteraturePaper["source"]>; sourceIndependence: "unknown" | "same-exact-source-aliases"; qualification: string[] }>;
  gaps: string[]; qualification: string;
};
export interface LiteratureStudyPlanningSource {
  id: string;
  text: string;
  binding: {
    owner: "research-literature-study";
    literatureSetId: string;
    literatureSetSha256: string;
    requestId: string;
    preparedSha256: string;
    resultSha256: string;
    sourceMap: PreparedLiteratureStudyQuestion["sourceMap"];
    selectedCoverage: PreparedLiteratureStudyQuestion["coverage"];
    citations: Array<{ evidenceId: string; paperIds: string[]; sourceBinding: NonNullable<LiteraturePaper["source"]>; sourceIndependence: "unknown" | "same-exact-source-aliases"; page: number; start: number; end: number; quote: string; relation: string }>;
  };
  qualification: { executionStatus: string; reportedCoverage: "answered" | "partial" | "insufficient" | null; gaps: string[]; selectedCoverageSha256: string; sourceCurrentness: "frozen-snapshot-origin-not-checked"; claimLimit: string };
}
/** Exports a complete cited cross-notebook answer with exact selected paper, source and quote closure. Refuses output above existing Planning text/binding limits. */
export function exportLiteratureStudyPlanningSource(prepared: PreparedLiteratureStudyQuestion, result: DocumentCoverageResult, requestId: string): LiteratureStudyPlanningSource;
/** Recomputes an exported Planning source from its exact frozen question, coverage result and admission UUID. */
export function validateLiteratureStudyPlanningSource(prepared: PreparedLiteratureStudyQuestion, result: DocumentCoverageResult, requestId: string, candidate: unknown): LiteratureStudyPlanningSource;
export function exportLiteratureSet(value: LiteratureSet): string;
export function formatLiteratureSet(value: LiteratureSet): string;
export interface LiteratureSynthesisCitation {
  evidenceId: string;
  paperIds: string[];
  relation: string;
  quote: string;
  page: number;
  start: number;
  end: number;
  sourceBinding: NonNullable<LiteraturePaper["source"]>;
  sourceIndependence: "unknown" | "same-exact-source-aliases";
  qualification: string[];
}
export interface LiteratureSynthesisExport {
  schema: "research-literature-synthesis-export.v1";
  question: string;
  literatureSetId: LiteratureSet["id"];
  literatureSetRevision: number;
  literatureSetSha256: string;
  preparedSha256: string;
  resultSha256: string;
  resultStatus: "complete" | "partial";
  coverage: "answered" | "partial";
  citations: LiteratureSynthesisCitation[];
  duplicateSuggestions: ReturnType<typeof deduplicateLiteraturePapers>;
  bibliographyMarkdown: string;
  content: string;
  contentSha256: string;
  qualification: string;
  exportSha256: string;
}
/** Exports one retained cross-notebook answer with exact evidence and same-revision bibliography bindings. */
export function exportLiteratureStudySynthesis(prepared: PreparedLiteratureStudyQuestion, result: DocumentCoverageResult): LiteratureSynthesisExport;

export interface ResearchPerspectiveWorkflow {
  version: "research-perspective-workflow-v1";
  owner: "research-ai";
  id: `workflow:${string}`;
  topic: string;
  revision: number;
  sources: FrozenSource[];
  perspectiveChoices: "auto" | Array<string | { label: string; focus: string }>;
  lenses: Array<{ id: string; label: string; focus: string; origin: string; evidence?: unknown[] }>;
  perspectiveResult: PerspectiveResult | null;
  investigation: Investigation | null;
  comparisons: BranchComparison[];
  comparisonPerspectiveDigests?: string[];
  outlinePerspectiveDigests?: string[];
  outlines: Array<{ revision: number; status: "complete" | "failed" | "cancelled" | "user-modified" | "user-reviewed"; outline: ResearchOutline | null; receipt: unknown | null; setAsideDisagreements: Array<{ comparisonIndex: number; comparisonDigest: string; summary: string; reason: string }>; citationReview: { required: boolean; reason: string | null }; conflictSetAside: { removedSpans: Array<{ source: number; sourceUri: string; sourceSha256: string; start: number; end: number; quote: string }>; reason: string | null } }>;
  sha256: string;
}
export function createPerspectiveWorkflow(topic: string, options: { id?: string; sources: FrozenSource[]; perspectives?: "auto" | Array<string | { label: string; focus: string }> }): ResearchPerspectiveWorkflow;
export function validatePerspectiveWorkflow(value: unknown): ResearchPerspectiveWorkflow;
export function runWorkflowPerspectives(value: ResearchPerspectiveWorkflow, options?: object): Promise<ResearchPerspectiveWorkflow>;
export type PerspectiveAddChoice = string | { label: string; focus: string };
export function prepareWorkflowPerspectiveAddition(value: ResearchPerspectiveWorkflow, choice: PerspectiveAddChoice): { lens: { id: string; label: string; focus: string; origin: string; evidence?: unknown[] }; priorLensCount: number; totalLensCount: number; nativeSessionCount: 2; retainedLensCount: number; staleComparisonIndexes: number[]; staleOutlineRevisions: number[]; remoderation: string };
export function addWorkflowPerspective(value: ResearchPerspectiveWorkflow, choice: PerspectiveAddChoice, options?: object): Promise<ResearchPerspectiveWorkflow>;
export function perspectiveSpanContribution(value: ResearchPerspectiveWorkflow): Array<{ lensId: string; status: "complete" | "failed" | "cancelled" | "not_run"; disposition: string; uniqueCitedSpans: Array<{ source: number; sourceUri: string; sourceSha256: string; start: number; end: number; quote: string }>; sharedCitedSpans: Array<{ source: number; sourceUri: string; sourceSha256: string; start: number; end: number; quote: string; citedBy: string[] }>; conflictCitedSpans: Array<{ source: number; sourceUri: string; sourceSha256: string; start: number; end: number; quote: string }>; uniqueSourceOrigins: string[]; claimsLosingAllCitations: Array<{ question: string; answer: string; citations: Array<{ source: number; sourceUri: string; sourceSha256: string; start: number; end: number; quote: string }> }>; outlineClaimsLosingAllCitations: Array<{ section: string; text: string }>; reason?: string; qualification: string }>;
export function startWorkflowInvestigation(value: ResearchPerspectiveWorkflow, options: { goal?: string; scope?: string; questions: InvestigationQuestion[]; budget?: InvestigationBudget }): ResearchPerspectiveWorkflow;
export function runWorkflowBranches(value: ResearchPerspectiveWorkflow, branchIds: string[], options?: object): Promise<ResearchPerspectiveWorkflow>;
export function compareWorkflowBranches(value: ResearchPerspectiveWorkflow, options: { branchIds: string[]; attempts?: Record<string, string> } & object): Promise<ResearchPerspectiveWorkflow>;
export function draftWorkflowOutline(value: ResearchPerspectiveWorkflow, options?: object): Promise<ResearchPerspectiveWorkflow>;
export function reviseWorkflowOutline(value: ResearchPerspectiveWorkflow, edits: { topic?: string; sections?: ResearchOutline["sections"] }, options?: { conflictSetAsideReason?: string | null }): ResearchPerspectiveWorkflow;
export function reviewWorkflowOutlineCitations(value: ResearchPerspectiveWorkflow, options: { confirmRevision: number }): ResearchPerspectiveWorkflow;
export function workflowComparisonCurrentness(value: ResearchPerspectiveWorkflow, index?: number): { current: boolean; reasons: string[] };
export function workflowOutlineCurrentness(value: ResearchPerspectiveWorkflow, index?: number): { current: boolean; reasons: string[] };
export function renderPerspectiveWorkflow(value: ResearchPerspectiveWorkflow, options?: { format?: "json" | "markdown" }): string;

export interface DocumentRecoveryGap {
  id: string; kind: "ocr" | "table" | "layout" | "other"; documentId: string; page: number;
  detail: string; assertedBy: string; observedAt: string;
}
export interface DocumentRecoverySection {
  id: string; parentId: string | null; title: string; pageRefs: Array<{ documentId: string; page: number }>;
  extractionGaps: DocumentRecoveryGap[]; required?: boolean;
}
export interface DocumentRecoveryPolicy {
  maxCallsPerSection: number; maxRetriesPerSection: number; totalMaxCalls: number;
  passUtf16Units: number; maxSecondsPerSection: number;
}
export interface DocumentRecoveryDispatchRequest {
  workflowId: `recovery:${string}`; workflowSha256: string; sectionId: string; attemptNumber: number;
  question: string; documents: ResearchDocumentInput[]; planDigest: string;
  planCounts: PreparedDocumentCoverage["counts"]; policy: DocumentRecoveryPolicy;
  coverageOptions: Omit<DocumentCoverageOptions, "confirmedPlanDigest"> & { confirmedPlanDigest: string };
  executionId: string;
}
export type DocumentRecoveryDispatch = (request: DocumentRecoveryDispatchRequest) => Promise<DocumentCoverageResult | { status: "unknown"; reason: string }>;
export interface DocumentRecoveryPageCoverage {
  documentId: string; documentSha256: string; page: number; pageSha256: string; sectionId: string; extractedUtf16Units: number;
  executionStatus: "complete" | "partial" | "failed" | "cancelled" | "not_run" | "unknown";
  reviewStatus: "empty-extracted-text" | "unknown" | "not_run" | "no_validated_result" | "fully_reviewed" | "partially_reviewed" | "unreviewed";
  totalWindows: number; reviewedWindowIds: string[]; unreviewedWindowIds: string[];
  citationStatus: "cited" | "no_citation" | "unavailable"; citationEvidenceIds: string[]; extractionGapIds: string[];
}
export interface ResearchDocumentRecovery {
  version: "research-document-recovery-v1"; owner: "research-ai"; id: `recovery:${string}`; question: string; revision: number;
  sources: ResearchDocumentInput[]; manifest: DocumentRecoverySection[]; policy: DocumentRecoveryPolicy; plannedMaximumCalls: number;
  sections: Array<{ sectionId: string; attempts: Array<{ number: number; status: "complete" | "partial" | "failed" | "cancelled" | "not_run" | "unknown"; result: DocumentCoverageResult | null; failure: string | null }>; pageMap: Array<{ documentId: string; localPage: number; originalPage: number; sourceSha256: string; pageSha256: string }>; reservedMaximumCalls: number }>;
  aggregate: { status: "complete" | "partial" | "failed" | "unknown"; answer: Array<{ sectionId: string; sectionTitle: string; text: string; citations: Array<{ evidenceId: string; documentId: string; documentSha256: string; page: number; pageSha256: string; start: number; end: number; quote: string; relation: "supporting" | "conflicting" | "context" }> }>; pageCoverage?: DocumentRecoveryPageCoverage[]; gaps: string[]; cleanup: "complete" | "unconfirmed" | "incomplete"; plannedMaximumCalls: number; startedCalls: number; qualification: string };
  sha256: string;
}
export function createDocumentRecovery(question: string, options: { id?: string; documents: ResearchDocumentInput[]; sections: DocumentRecoverySection[]; policy?: Partial<DocumentRecoveryPolicy> }): ResearchDocumentRecovery;
export function validateDocumentRecovery(value: unknown): ResearchDocumentRecovery;
export function runDocumentRecovery(value: ResearchDocumentRecovery, options: { confirmedSha256: string; dispatchSection?: DocumentRecoveryDispatch } & Partial<Pick<DocumentCoverageOptions, "profile" | "model" | "effort" | "lease" | "signal" | "progress" | "activity">>): Promise<ResearchDocumentRecovery>;
export function retryDocumentRecovery(value: ResearchDocumentRecovery, sectionIds: string[], options: { confirmedSha256: string; dispatchSection?: DocumentRecoveryDispatch } & Partial<Pick<DocumentCoverageOptions, "profile" | "model" | "effort" | "lease" | "signal" | "progress" | "activity">>): Promise<ResearchDocumentRecovery>;
export function renderDocumentRecovery(value: ResearchDocumentRecovery, options?: { format?: "json" | "markdown" }): string;
export function renderDocumentRecoverySection(value: ResearchDocumentRecovery, sectionId: string): string;

export interface DocumentRecoverySynthesisEvidence {
  evidenceId: string; kind: "page_quote"; sectionId: string; sectionTitle: string;
  documentId: string; documentSha256: string; page: number; pageSha256: string;
  start: number; end: number; quote: string; relation: "supporting" | "conflicting" | "context";
}
export interface DocumentRecoverySynthesisPlan {
  version: "research-document-recovery-synthesis-plan-v1"; question: string; recoveryId: string; recoverySha256: string;
  policy: { maxSeconds: number; maxResponseBytes: number }; counts: { calls: 1; inputUtf16Units: number };
  sections: Array<{ sectionId: string; title: string; status: string; inputCoverage: string; answerCoverage: string;
    reviewGaps: string[]; evidenceIds: string[]; extractionGapIds: string[] }>;
  evidence: DocumentRecoverySynthesisEvidence[];
  missingWindows: Array<{ sectionId: string; documentId: string; documentSha256: string; page: number; pageSha256: string; start: number; end: number; reason: string }>;
  extractionGaps: Array<{ sectionId: string; id: string; kind: string; documentId: string; page: number; detail: string; assertedBy: string; observedAt: string; qualification: "caller-asserted-unverified-extraction-metadata" }>;
  mandatoryGaps: string[]; planDigest: string;
}
export interface DocumentRecoverySynthesisDraft {
  answer: Array<{ text: string; evidenceIds: string[] }>;
  conflicts: Array<{ text: string; sides: Array<{ position: string; evidenceIds: string[] }> }>;
  evidence: DocumentRecoverySynthesisEvidence[]; modelReportedCoverage: "answered" | "partial" | "insufficient";
  coverage: "answered" | "partial" | "insufficient"; gaps: string[]; qualification: string;
}
export interface DocumentRecoverySynthesis {
  version: "research-document-recovery-synthesis-v1"; id: `recovery-synthesis:${string}`;
  status: "complete" | "failed" | "cancelled" | "unknown"; recovery: ResearchDocumentRecovery;
  plan: DocumentRecoverySynthesisPlan; synthesis: { status: "complete" | "failed" | "cancelled" | "unknown"; reason: string | null };
  draft: DocumentRecoverySynthesisDraft | null;
  receipt: { mode: "frozen"; profile: Profile; executionId: string; outcome: SessionOutcome } | null; sha256: string;
}
export interface DocumentRecoverySynthesisDispatchRequest {
  executionId: string; plan: DocumentRecoverySynthesisPlan; prompt: string; outputSchema: Record<string, unknown>;
  profile: Profile; model?: string; effort?: string;
}
export type DocumentRecoverySynthesisDispatch = (request: DocumentRecoverySynthesisDispatchRequest) => Promise<SessionOutcome | { status: "unknown"; reason: string }>;
export function prepareDocumentRecoverySynthesis(value: ResearchDocumentRecovery, policy?: { maxSeconds?: number; maxResponseBytes?: number }): DocumentRecoverySynthesisPlan;
export function runDocumentRecoverySynthesis(value: ResearchDocumentRecovery, plan: DocumentRecoverySynthesisPlan,
  options: { confirmedPlanSha256: string; dispatchSynthesis?: DocumentRecoverySynthesisDispatch; profile?: Profile; lease?: string; signal?: AbortSignal; model?: string; effort?: string }): Promise<DocumentRecoverySynthesis>;
export function validateDocumentRecoverySynthesis(value: unknown): DocumentRecoverySynthesis;
export function renderDocumentRecoverySynthesis(value: DocumentRecoverySynthesis, options?: { format?: "json" | "markdown" }): string;

export interface ReadinessProbe {
  source: "codex --version" | "codex login status" | "codex exec --help";
  /** UTC ISO timestamp; null if not probed. */
  observedAt: string | null;
  exitCode: number | null;
  failure:
    | "not_probed"
    | "not_found"
    | "start_failed"
    | "timeout"
    | "output_limit"
    | "process_failed"
    | null;
}

export interface Readiness {
  schemaVersion: 1;
  /** The version executable ran, even if it exited nonzero/timed out. False if it could not start. */
  installed: boolean;
  /** Version is recognized, authentication true, and required execution options advertised. */
  available: boolean;
  /** Bounded version stdout, or `codex` when absent. */
  runner: string;
  version: string | null;
  /** Null means unobserved/unknown; a known logged-out status may have exit code 1. */
  authenticated: boolean | null;
  /** Required options advertised by help; not proof of native protocol/permission behavior. */
  supportedProfile: boolean | null;
  profile: "codex-exec-json-v1";
  error:
    | "missing_executable"
    | "version_probe_failed"
    | "version_unrecognized"
    | "not_authenticated"
    | "auth_probe_failed"
    | "auth_unrecognized"
    | "unsupported_profile"
    | "profile_unrecognized"
    | "profile_probe_failed"
    | null;
  remedy: string | null;
  probes: {
    version: ReadinessProbe;
    authentication: ReadinessProbe;
    profile: ReadinessProbe;
  };
}
/** Version/login/help probes only, each at most 5s and 64 KiB per output stream; no inference. */
export function codexReadiness(): Promise<Readiness>;

export interface Budget {
  /** Nonnegative integers, at most 10,000 each. */
  searches: number;
  documents: number;
  /** Finite and positive, at most 3,600; fractional test deadlines are supported. */
  seconds: number;
}

export interface MessageCounts {
  completed: number;
  checkpointed: number;
  unreadable: number;
  duplicate: number;
  limited: number;
  afterStop: number;
  schema: number;
}

export interface ActionCounts {
  toolCalls: number;
  reads: number;
  unclassifiedToolCalls: number;
  messages: MessageCounts;
}

export interface Termination {
  /** Null if exit was not observed, including a bounded stop with unknown cleanup. */
  exitCode: number | null;
  signal: string | null;
  trigger: string | null;
}

/** Received-byte metadata only; the unparsed wire is never decoded or retained. */
export interface StdoutReceipt {
  text: "";
  capturedDigest: string;
  capturedBytes: number;
  omittedBytes: number;
  captureComplete: false;
  captureScope: "runner-stdout";
}

/** research-outcome-v1 options. All callbacks are synchronous; promise returns are refused. */
export interface SessionOptions {
  /** Written to stdin; untrusted material belongs inside it as labelled data. */
  prompt: string;
  /** Live web search; `false` is frozen review with web search disabled. */
  live: boolean;
  budget: Budget;
  signal: AbortSignal;
  /** Synchronous ephemeral observation; stream failure stops with progress_callback_failed. */
  progress?: ((event: string) => void) | undefined;
  /** Explicit model/effort; otherwise model keys from `~/.codex/config.toml`, else CLI default. */
  model?: string | undefined;
  effort?: string | undefined;
  /** Provider-ready JSON Schema passed as `--output-schema`. */
  outputSchema?: unknown;
  /** Messages are schema-bound: counted as `schema`, never checkpointed. */
  structured?: boolean | undefined;
  /** Integer byte cap from 1 to 3,000,000; also enables the stdout digest receipt. */
  maxResponseBytes?: number | undefined;
  /** Calls already charged against budget.searches; integer from zero through that budget. */
  initialSearches?: number | undefined;
  /** Synchronously returns nonempty well-formed Markdown or undefined; failure stops with read_note_failed. */
  readNote?: ((text: string) => Readable | undefined) | undefined;
  /** Synchronous checkpoint observation; failure stops with checkpoint_callback_failed, retaining the note. */
  onCheckpoint?: ((readable: Readable) => void) | undefined;
  /** Runs synchronously after preparation, immediately before the native process starts. */
  beforeSpawn?: (() => void) | undefined;
  /** Synchronous research-activity-v1 observation after spawn; failure stops with activity_callback_failed. */
  activity?: ((event: ResearchActivity) => void) | undefined;
}

export type ResearchActivityKind =
  | "session.started" | "thread.started" | "turn.started" | "web.started" | "web.completed"
  | "checkpoint" | "runner.error" | "turn.completed" | "turn.failed" | "protocol.failed"
  | "session.stopped" | "activity.limited" | "session.settled";

/** Closed details; no provider objects, prompts, reasoning, message/schema text, queries or diagnostics. */
export interface ResearchActivityDetails {
  "session.started": { mode: "live" | "frozen" };
  "thread.started": Record<string, never>;
  "turn.started": Record<string, never>;
  /** One native web item started; `call` is the 1-based tool-call count. */
  "web.started": { call: number };
  /**
   * Native report of a completed web item, not proof of access, source truth or entailment.
   * `url` is the exact native string, only for http(s) without credentials, query or fragment.
   */
  "web.completed": {
    action: "search" | "open_page" | "find_in_page" | "other" | "unrecognized" | "absent";
    url: string | null;
    urlStatus: "reported" | "absent" | "withheld";
    searches: number;
    reads: number;
    unclassified: number;
  };
  /** Bounded readable buffer metadata; the note itself goes to `onCheckpoint`. */
  "checkpoint": { notes: number; units: number; bytes: number; omitted: boolean };
  "runner.error": Record<string, never>;
  /** A native terminal was reported; completion is judged only at settlement. */
  "turn.completed": Record<string, never>;
  "turn.failed": Record<string, never>;
  /** First sticky protocol failure. */
  "protocol.failed": { reason: string };
  /** First host stop trigger, e.g. action_limit, forbidden_runner_tool or request_aborted. */
  "session.stopped": { trigger: string };
  /** Delivery limit reached; later non-settlement observations are dropped and counted. */
  "activity.limited": { limit: number };
  /** Last event, after terminal, protocol and cleanup evidence; `completed` equals sessionCompleted. */
  "session.settled": {
    /** Native process diagnostics are replaced by native_process_error. */
    completed: boolean; failureReason: string | null; cleanup: boolean;
    delivered: number; omitted: number;
  };
}

/** Ephemeral observation only: not a store, resume cursor, task record or permission. */
export type ResearchActivity = {
  [K in ResearchActivityKind]: {
    version: "research-activity-v1";
    /** Per-session, 1-based and increasing by one per delivered event. */
    sequence: number;
    /** Host ISO time of the observation. */
    observedAt: string;
    kind: K;
    detail: Readonly<ResearchActivityDetails[K]>;
  };
}[ResearchActivityKind];

export const researchActivity: Readonly<{
  version: "research-activity-v1";
  /** Maximum delivered events before `activity.limited`; settlement is always delivered. */
  limit: 512;
  kinds: readonly ResearchActivityKind[];
  /** Facts this producer never reports, so consumers can show missing visibility honestly. */
  unsupported: readonly (
    | "fetch_status" | "http_status" | "source_verification" | "search_query" | "page_content"
    | "partial_answer_text" | "reasoning" | "non_web_items"
  )[];
}>;

/** Explicit terminal counts and sticky protocol failure; stderr alone is diagnostic.
 * Known thread/turn/item activity after a terminal invalidates completion.
 */
export interface TerminalEvidence {
  completed: number;
  failed: number;
  protocolFailure: string | null;
}

export interface SessionCleanup {
  /** True only when the spawned POSIX group is confirmed absent (or spawn never occurred). */
  complete: boolean;
  /** Failed/unknown cleanup preserves the lease and workspace for inspection. */
  error: "process_group_cleanup_failed" | null;
}

export interface SessionOutcome {
  /** Process start failure message; the session never ran or was not observed. */
  error?: string;
  aborted: boolean;
  /** Last completed message; capped output is a whole-code-point UTF-8 prefix within maxResponseBytes. */
  final: string;
  readable?: Readable;
  /** Bounded stderr/event diagnostic (at most about 1000 characters). */
  diagnostic: string;
  usage: unknown;
  model?: string;
  effort?: string;
  searches: number;
  actionCounts: ActionCounts;
  nativeSessions: 0 | 1;
  stages: { nativeSessionMs: number; nativeSessionMonotonicMs: number };
  stdoutReceipt?: StdoutReceipt;
  /** Untruncated last over-cap final message, for the caller's own bounded receipt. */
  oversizedResponse?: string;
  termination: Termination;
  terminal: TerminalEvidence;
  cleanup: SessionCleanup;
  /** Start/abort/guard, then explicit protocol/terminal cause, then exit/missing-text reason; null on success. */
  failureReason: string | null;
}

export interface CodexWorkspace {
  directory: string;
  /** One session per workspace; invalid or cancelled inputs refuse before dispatch. */
  run(options: SessionOptions): Promise<SessionOutcome>;
}

/** Callback completion drains the group; unconfirmed cleanup preserves ownership for inspection. */
export function withCodexWorkspace<T>(
  names: { lease: string; prefix: string },
  body: (workspace: CodexWorkspace) => Promise<T>,
): Promise<T>;

export function sessionCompleted(outcome: SessionOutcome): boolean;

export const profiles: Readonly<Record<Profile, Readonly<Budget>>>;
export function ordinaryResearchPrompt(
  question: string,
  context?: string,
): string;

export type Profile = "quick" | "wide";

/** research-outcome-v1: producer contract; native/consumer qualification is separate. */
export interface ResearchResult {
  /**
   * `complete`: explicit terminal success, nonempty final text, clean exit, confirmed cleanup and no contradiction.
   * `partial`: stopped or failed, but completed interim notes were checkpointed.
   * `failed`: nothing readable arrived.
   */
  status: "complete" | "partial" | "failed";
  /** Fallible Markdown research, not verified truth. Empty when nothing readable arrived. */
  answer: string;
  receipt: {
    profile: Profile;
    /** Selected model/effort, or `host-default` when the CLI chose. */
    model: string;
    effort: string;
    /** Provider-reported usage, passed through unvalidated. */
    provider: unknown;
    searches: number;
    actionCounts: ActionCounts;
    nativeSessions: 0 | 1;
    stages: SessionOutcome["stages"];
    termination: Termination;
    terminal: TerminalEvidence;
    cleanup: SessionCleanup;
    /** Legacy compatible mode: frozen for supplied sources; omission means live. */
    mode?: "frozen";
    /** Supplied sources as given, with the SHA-256 of each exact text. Not a verification. */
    source?: FrozenSourceReceipt[];
    /** Present unless complete: start/abort/guard, then protocol/terminal cause, then exit/missing-text reason. */
    failure?: string;
    /** Bounded stderr/event diagnostic, present unless complete. */
    diagnostic?: string;
  };
}

/** Caller-captured public material. Never fetched, followed or checked; text only, never a path. */
export interface FrozenSource {
  /** http(s) citation identity: printable ASCII, at most 2,000 characters, no credentials, unique. */
  uri: string;
  /** Non-empty well-formed text; all sources together at most 48,000 UTF-16 units. */
  text: string;
  /** Caller-supplied single-line note, at most 64 characters; not checked or current. */
  observedAt?: string | undefined;
  /** Up to 8 single-line caller notes (500 characters each) on what the text leaves out. */
  omissions?: string[] | undefined;
}

export interface FrozenSourceReceipt {
  uri: string;
  /** Lowercase hex SHA-256 of the exact UTF-8 text. */
  sha256: string;
  observedAt?: string;
  omissions?: string[];
}

/** Observers are synchronous as in SessionOptions; async work belongs outside the callback. */
export interface ResearchOptions {
  profile?: Profile | undefined;
  /**
   * Extra untrusted context, passed to the model as labelled data. With `sources`, at most
   * 8,000 UTF-16 units.
   */
  context?: string | undefined;
  /**
   * 1–8 supplied sources select frozen review: web search is disabled and the model sees only
   * this material. Absent means live research. Invalid or empty sources throw
   * `invalid_sources: …` before any lease or native session; there is no fallback to live.
   */
  sources?: FrozenSource[] | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  signal?: AbortSignal | undefined;
  progress?: ((event: string) => void) | undefined;
  onCheckpoint?: ((readable: Readable) => void) | undefined;
  /** As in SessionOptions; the result and answer meanings are unchanged. */
  activity?: ((event: ResearchActivity) => void) | undefined;
  /** Lease directory; defaults to a per-user path under the temporary directory. */
  lease?: string | undefined;
}

/** Throws `question_required`, `unknown_profile`, `invalid_sources` or a lease error before any native session. */
export function researchQuestion(
  question: string,
  options?: ResearchOptions,
): Promise<ResearchResult>;
export interface SupportJudgment {
  verdict: "supports" | "contradicts" | "insufficient" | "unknown";
  reason: string;
}
export interface GroundedClaim {
  text: string;
  joint: SupportJudgment;
  citations: {
    source: number;
    start: number;
    end: number;
    alone: SupportJudgment;
    without: SupportJudgment;
  }[];
}
export interface Grounding {
  version: "claim-support-v1";
  owner: "research-ai";
  answerSha256: string;
  judge: {
    id: string;
    kind: "same-session-model" | "caller-judge" | "synthetic";
  };
  sources: (FrozenSource & { sha256: string })[];
  claims: (Omit<GroundedClaim, "citations"> & {
    start: number;
    end: number;
    support: "supported" | "unsupported" | "conflicting" | "unknown";
    citations: (GroundedClaim["citations"][number] & {
      quote: string;
      occurrence: "exact-retained-span";
      contribution:
        | "unknown"
        | "unsupported"
        | "necessary"
        | "supports-alone"
        | "unnecessary";
    })[];
  })[];
  estimates: { supportRecall: number | null; citationPrecision: number | null };
  limits: string[];
}
/** Exact occurrence validation and ALCE-style estimates over caller-supplied judgments, never truth. */
export function groundedAnswer(input: {
  sources: FrozenSource[];
  claims: GroundedClaim[];
  judge: Grounding["judge"];
}): { answer: string; grounding: Grounding };
export function validateGrounding(
  answer: string,
  grounding: unknown,
): Grounding;
/** Explicit caller judge, at most 9 calls/claim (360 total); cancellation refuses late replies. */
export function assessGroundedAnswer(
  input: {
    sources: FrozenSource[];
    claims: {
      text: string;
      citations: { source: number; start: number; end: number }[];
    }[];
  },
  options: {
    identity: Grounding["judge"];
    signal?: AbortSignal;
    judge: (input: {
      claim: string;
      passages: { uri: string; quote: string }[];
      signal?: AbortSignal;
    }) => Promise<SupportJudgment>;
  },
): Promise<{ answer: string; grounding: Grounding }>;
/** One frozen generation plus self-assessment session. No independent judge or acquisition. */
export function groundedResearchQuestion(
  question: string,
  options: {
    sources: FrozenSource[];
    context?: string;
    profile?: keyof typeof profiles;
    model?: string;
    effort?: string;
    lease?: string;
    signal?: AbortSignal;
    progress?: (event: string) => void;
  },
): Promise<{
  status: "complete" | "failed";
  answer: string;
  grounding?: Grounding;
  receipt: {
    mode: string;
    outcome: SessionOutcome;
    assessment: string;
    failure?: string;
  };
}>;

export interface PerspectiveLens {
  id: string;
  label: string;
  focus: string;
  origin: "default" | "heading" | "explicit";
  /** Exact heading offsets in the retained sources (heading lenses only). */
  evidence?: { source: number; start: number; end: number; heading: string }[];
}
export const basicFacts: Readonly<PerspectiveLens>;
/** Heading-grounded candidates from the supplied sources. Deterministic; no session. */
export function perspectiveCandidates(
  sources: FrozenSource[],
  options?: { limit?: number },
): PerspectiveLens[];
/** Basic facts first, then chosen candidate ids or explicit lenses (at most six in total). */
export function chooseLenses(
  sources: FrozenSource[],
  choices?: "auto" | (string | { label: string; focus: string })[],
): PerspectiveLens[];
export interface LensQuestion {
  question: string;
  status: "answered" | "partial" | "unanswered";
  answer: string;
  citations: {
    source: number;
    start: number;
    end: number;
    quote: string;
    occurrence: "exact-retained-span";
  }[];
}
export interface LensResult {
  lens: PerspectiveLens;
  status: "complete" | "failed" | "cancelled" | "not_run";
  reason?: string;
  questions?: LensQuestion[];
  omissions?: string[];
  receipt?: Pick<
    SessionOutcome,
    "termination" | "terminal" | "cleanup" | "actionCounts" | "nativeSessions"
  > & { model: string; effort: string };
}
export interface PerspectiveResult {
  version: "perspectives-v1";
  owner: "research-ai";
  status: "complete" | "partial" | "failed" | "cancelled";
  topic: string;
  sources: FrozenSourceReceipt[];
  lenses: LensResult[];
  comparison: {
    lens: string;
    status: LensResult["status"];
    answered: number;
    partial: number;
    unanswered: number;
    sourcesCited: number[];
  }[];
  unanswered: { lens: string; question: string; status: "partial" | "unanswered" }[];
  omissions: { source?: number; lens?: string; note: string; by: "caller" | "lens" | "runner" }[];
  limits: string[];
}
/** One frozen, schema-bound session per lens, run in order. Nothing is fetched or stored. */
export function perspectiveResearch(
  topic: string,
  options: {
    sources: FrozenSource[];
    perspectives?: "auto" | (string | { label: string; focus: string })[];
    questions?: number;
    context?: string;
    profile?: keyof typeof profiles;
    model?: string;
    effort?: string;
    lease?: string;
    signal?: AbortSignal;
    progress?: (event: string) => void;
    /** Synchronous lens state observation. */
    onLens?: (event: { id: string; state: string }) => void;
  },
): Promise<PerspectiveResult>;

export interface OutlineCitation { source: number; start: number; end: number; quote: string }
export type MindMapRelation = "elaborates" | "qualifies" | "contrasts";
export interface MindMapCitation { source: number; start: number; end: number; quote: string }
export interface MindMapNode {
  id: string; label: string; relation: MindMapRelation | null;
  citations: MindMapCitation[]; gap: string | null; children: MindMapNode[];
}
export interface ResearchMindMap {
  version: "research-mindmap-v1"; question: string;
  sources: (FrozenSource & { sha256: string })[]; root: MindMapNode;
  origin: { type: "caller-authored" | "model-generated" | "user-modified"; model?: string;
    receipt?: { mode: "frozen"; profile: Profile; model: string; effort: string; nativeSessions: 1; contentSha256: string } };
  limits: string[];
}
export interface MindMapTreeNode extends Omit<MindMapNode, "children"> {
  parentId: string | null; level: number; position: number; setSize: number;
  path: string[]; childIds: string[]; accessibleName: string;
}
/** View projection only: retain the document, which also contains exact source text. */
export interface MindMapTree {
  version: "research-mindmap-tree-v1"; question: string; contentSha256: string;
  origin: ResearchMindMap["origin"]; rootId: string; nodes: MindMapTreeNode[];
  sources: (FrozenSourceReceipt & { index: number; utf16Length: number })[]; limits: string[];
}
export interface MindMapEdit {
  question?: string; root?: MindMapNode;
  nodes?: ({ id: string } & Partial<Pick<MindMapNode, "label" | "relation" | "citations" | "gap">>)[];
}
export const mindMapLimits: Readonly<{ depth: 6; nodes: 60; children: 8; label: 120; gap: 300; citations: 4; quote: 4000; limits: 12; bytes: 1048576 }>;
/** Creates an explanatory hierarchy offline; custom limitations supplement the standard three. */
export function createMindMap(question: string, input: { sources: FrozenSource[]; root: MindMapNode; limits?: string[] }): ResearchMindMap;
/** Replays closed shapes, source hashes and exact UTF-16 spans; does not judge entailment. */
export function validateMindMap(value: unknown): ResearchMindMap;
/** Content edits retain the original generation binding and mark the document user-modified. */
export function reviseMindMap(value: ResearchMindMap, edits?: MindMapEdit): ResearchMindMap;
/** JSON is reopenable; tree is an accessible view projection; Markdown escapes untrusted text. */
export function renderMindMap(value: ResearchMindMap, options?: { format?: "markdown" | "json" | "tree" }): string;
/** Explicit frozen native draft; only a fully completed, cleaned-up session can return a map. */
export function mindMapResearch(question: string, options: {
  sources: FrozenSource[]; profile?: Profile; lease?: string; model?: string; effort?: string;
  signal?: AbortSignal; progress?: (event: string) => void; activity?: (event: ResearchActivity) => void;
}): Promise<{ status: "complete" | "failed" | "cancelled"; map: ResearchMindMap | null;
  receipt: { mode: "frozen"; profile: Profile; outcome: SessionOutcome; failure?: string; reason?: string } }>;

export interface OutlinePoint { text: string; citations: OutlineCitation[] }
export interface OutlineSection { id: string; title: string; points: OutlinePoint[]; gaps: string[] }
export interface ResearchOutlineSource {
  /** HTTP(S) caller URI, or a deterministic research-notebook URI paired with retainedOrigin. */
  uri: string; text: string; sha256: string; observedAt?: string; omissions?: string[];
  retainedOrigin?: ResearchStudyReportSourceOrigin;
}
export interface ResearchOutline {
  version: "research-outline-v1";
  topic: string;
  sources: ResearchOutlineSource[];
  sections: OutlineSection[];
  origin: { type: "model-generated" | "user-modified" | "caller-authored"; model?: string; receipt?: { mode: "frozen"; profile: keyof typeof profiles; model: string; effort: string; nativeSessions: 1; contentSha256: string } };
  limits: string[];
}
/** Closed canonical Study source binding used only by retained Study report sources. */
export interface ResearchStudyReportSourceOrigin {
  format: "research-study-source-v1"; studyId: string; studySha256: string;
  questionId: string; questionSha256: string; planDigest: string; selectionDigest: string;
  resultSha256: string; selectionId: string; selectionSha256: string;
  notebookId: string; notebookSha256: string; kind: "document" | "note";
  recordId: string; version: number | null; documentId: string; page: number;
  sourceDigest: string; pageSha256: string; title: string;
}
/** Validates closed shapes, exact source digests, and UTF-16 quote spans without judging entailment. */
export function validateOutline(value: unknown): ResearchOutline;
/** Applies topic/section edits and returns a validated user-modified draft. */
export function reviseOutline(value: ResearchOutline, edits?: { topic?: string; sections?: OutlineSection[] }): ResearchOutline;
/** Renders a validated draft; arbitrary URIs are shown as text, never links. */
export function renderOutline(value: ResearchOutline, options?: { format?: "markdown" | "json" }): string;
/** One frozen, schema-bound session creates an editable, source-bound outline. */
export function outlineResearch(topic: string, options: {
  sources: FrozenSource[]; maxSections?: number; profile?: keyof typeof profiles;
  model?: string; effort?: string; lease?: string; signal?: AbortSignal; progress?: (event: string) => void;
}): Promise<{ status: "complete" | "failed" | "cancelled"; draft: ResearchOutline | null; receipt: { mode: "frozen"; profile: keyof typeof profiles; outcome: SessionOutcome; failure?: string } }>;

export interface EvidenceTableColumn { id: string; title: string; question: string }
export interface EvidenceTableCitation { source: number; start: number; end: number; quote: string }
export interface EvidenceTableCell { columnId: string; text: string; citations: EvidenceTableCitation[]; gap: string }
export interface EvidenceTableRow { source: number; cells: EvidenceTableCell[] }
export interface ResearchEvidenceTable {
  version: "research-evidence-table-v1";
  question: string;
  sources: (FrozenSource & { sha256: string })[];
  columns: EvidenceTableColumn[];
  rows: EvidenceTableRow[];
  origin: { type: "caller-authored" | "model-generated" | "user-modified"; model?: string; receipt?: { mode: "frozen"; profile: Profile; model: string; effort: string; nativeSessions: 1; contentSha256: string } };
  limits: string[];
}
/** Creates a bounded caller-authored table with every cell explicitly unassessed. */
export function createEvidenceTable(question: string, input: { sources: FrozenSource[]; columns: EvidenceTableColumn[] }): ResearchEvidenceTable;
/** Validates source digests, closed shape and row-local exact UTF-16 citation spans. */
export function validateEvidenceTable(value: unknown): ResearchEvidenceTable;
/** Applies question/column/row edits while preserving the entire frozen source identity. */
export function reviseEvidenceTable(value: ResearchEvidenceTable, edits?: { question?: string; columns?: EvidenceTableColumn[]; rows?: EvidenceTableRow[] }): ResearchEvidenceTable;
/** Renders a validated table as safe Markdown or JSON. */
export function renderEvidenceTable(value: ResearchEvidenceTable, options?: { format?: "markdown" | "json" }): string;
/** One frozen schema-bound draft. Incomplete or invalid sessions never promote a partial table. */
export function evidenceTableResearch(question: string, options: {
  sources: FrozenSource[]; columns: EvidenceTableColumn[]; profile?: Profile;
  model?: string; effort?: string; lease?: string; signal?: AbortSignal; progress?: (event: string) => void;
}): Promise<{ status: "complete" | "failed" | "cancelled"; draft: ResearchEvidenceTable | null; receipt: { mode: "frozen"; profile: Profile; outcome: SessionOutcome; failure?: string } }>;

export interface ReportParagraph { text: string; citations: EvidenceTableCitation[] }
export interface ReportSectionVersion { id: string; origin: "model-generated" | "user-modified"; paragraphs: ReportParagraph[]; gaps: string[]; attemptId: string | null; contentSha256: string }
export interface ReportSection { id: string; title: string; currentVersion: number | null; versions: ReportSectionVersion[] }
export interface ReportPayloadDigest { sha256: string; utf8Bytes: number }
/** Bounded retained receipt; payloads are represented by digests and byte counts in report state. */
export type ReportSessionReceipt = Omit<SessionOutcome, "final" | "readable" | "oversizedResponse" | "usage"> & {
  final: string; usage: null;
  reportPayloads: { final: ReportPayloadDigest; readable?: ReportPayloadDigest; oversizedResponse?: ReportPayloadDigest; providerUsage?: ReportPayloadDigest };
};
export interface ReportAttempt {
  id: string; sectionId: string; requestSha256: string;
  status: "complete" | "failed" | "cancelled" | "not_run";
  reason: string | null; receipt: ReportSessionReceipt | null; versionId: string | null;
}
export interface ResearchReport {
  version: "research-report-v1"; owner: "research-ai"; topic: string;
  /** Complete validated outline/source and qualification closure. */
  basis: ResearchOutline; basisSha256: string;
  sections: ReportSection[]; attempts: ReportAttempt[];
  usage: { calls: number; nativeSessions: number; searches: number; reads: number; seconds: number };
  revision: number; parentHash: string | null; limits: string[];
}
export interface ReportClaimRegister {
  schema: "research-report-claim-register.v1";
  revision: number;
  reportSha256: string;
  citedClaims: Array<{
    id: string; sectionId: string; sectionTitle: string; versionId: string | null; text: string;
    citation: { sourceIndex: number; start: number; end: number; quote: string };
    source: { uri: string; sha256: string; selectionId: string | null; studyId: string | null; questionId: string | null; resultSha256: string | null; notebookId: string | null; sourceDigest: string | null };
    review: "exact-span-matched; entailment-and-truth-unassessed";
  }>;
  unresolvedClaims: Array<{ id: string; sectionId: string; sectionTitle: string; versionId: string | null; text: string; status: "unresolved"; citations: [] }>;
}
/** Converts an outline or evidence table into a report without inference or loss. */
export function createReport(input: ResearchOutline | ResearchEvidenceTable): ResearchReport;
/** Derives a revision-bound register from current section versions and exact validated citations. */
export function projectReportClaimRegister(report: ResearchReport): ReportClaimRegister;
/** Validates current report content and returns self-contained, offline HTML, capped at 8 MiB. */
export function exportReportHtml(report: ResearchReport): string;
/** Rechecks the basis, bounded version history, accounting and exact source spans. */
export function validateReport(value: unknown): ResearchReport;
/** Appends a user-authored paragraph/gap version and keeps prior section versions. */
export function reviseReport(report: ResearchReport, edit: { sectionId: string; paragraphs?: ReportParagraph[]; gaps?: string[] }): ResearchReport;
/** Drafts one explicit section in one frozen schema-bound session; failures remain in attempts. */
export function draftReportSection(report: ResearchReport, options: {
  sectionId: string; profile?: Profile; model?: string; effort?: string; lease?: string;
  signal?: AbortSignal; progress?: (event: string) => void;
}): Promise<ResearchReport>;
/** Validates and assembles the current full report, or returns complete JSON state. */
export function renderReport(report: ResearchReport, options?: { format?: "markdown" | "json" }): string;

export type InvestigationBudget = Budget & { calls: number };
export interface InvestigationQuestion { id: string; parentId: string | null; question: string }
/** `independent` withholds sibling findings from investigate prompts and requires frozen sources; absent means shared. */
export type InvestigationBranchContext = "shared" | "independent";
export interface InvestigationEdit { topic?: string; goal?: string; scope?: string; questions?: InvestigationQuestion[]; sources?: FrozenSource[] | null; budget?: InvestigationBudget; branchContext?: InvestigationBranchContext }
export type InvestigationAction = "clarify" | "expand" | "investigate" | "synthesize";
export type InvestigationBranchStatus = "complete" | "partial" | "failed" | "cancelled" | "not_run";
export interface InvestigationAttempt { id: string; identity: string; /** Compatibility hash for unchanged topic/scope/source/budget context; historical identity is retained. */ contextIdentity: string; revision: number; /** `compare` appears only from `compareInvestigation`. */ action: InvestigationAction | "compare"; branchId: string | null; question: string | null; status: InvestigationBranchStatus; findings: string[]; gaps: string[]; sources: { uri: string; sha256?: string }[]; answer: string; reason: string | null; receipt: SessionOutcome | null }
export interface InvestigationClaimReview { id: string; scopeIdentity: string; attemptId: string; branchId: string; findingIndex: number; findingSha256: string; assessment: "supports" | "contradicts" | "context" | "unresolved"; rationale: string; citations: Array<{ sourceIndex: number; sourceUri: string; sourceSha256: string; start: number; end: number; quote: string }> }
export interface InvestigationMethodProgress {
  schema: "research-investigation-method-progress.v1";
  baseline: { completedBranches: 0; reviewedFindings: 0; description: string };
  current: { branchCount: number; completedBranches: number; remainingBranches: number; findings: number; reviewedFindings: number; unreviewedFindings: number; reportedGaps: number; remaining: { calls: number; searches: number; reads: number; seconds: number }; blocked: boolean };
  branches: Array<{ branchId: string; status: InvestigationBranchStatus | "unstarted"; attemptId: string | null; findings: number; reviewedFindings: number; gaps: number; sourceIdentities: number }>;
  qualification: string;
}
export interface ProjectedInvestigationClaimReview extends InvestigationClaimReview { finding: string | null; status: "current" | "historical"; qualification: string }
export interface Investigation { version: "guided-investigation-v1"; owner: "research-ai"; /** Present only in independent mode; joins identity hashes only when present. */ branchContext?: "independent"; topic: string; goal: string; scope: string; revision: number; identity: string; questions: InvestigationQuestion[]; sources: (FrozenSource & { sha256: string })[] | null; budget: InvestigationBudget; used: { searches: number; documents: number; seconds: number; calls: number }; history: InvestigationAttempt[]; /** Added only after an explicit revision; old v1 state bytes remain unchanged before revision. */ planHistory?: { plan: InvestigationPlan; preservesCompleted: boolean }[]; /** Optional append-only claim reviews; absent in older v1 states. */ claimReviews?: InvestigationClaimReview[]; clarifications: string[]; report: { identity: string; markdown: string; attemptId: string } | null }
/** Offline review snapshot. Its digest binds the investigation identity, source digests, budget, usage and history checkpoint. */
export interface InvestigationPlan { version: "investigation-plan-v1"; owner: "research-ai"; identity: string; scopeIdentity: string; contextIdentity: string; revision: number; topic: string; goal: string; scope: string; questions: (InvestigationQuestion & { depth: number })[]; sourceDigests: { uri: string; sha256: string }[] | null; budget: InvestigationBudget; used: Investigation["used"]; remaining: { calls: number; searches: number; reads: number; seconds: number }; completedBranchIds: string[]; remainingBranchIds: string[]; stopConditions: string[]; attempts: number; lastAttemptId: string | null; blocked: boolean; methodProgress: InvestigationMethodProgress; digest: string }
export function createInvestigation(topic: string, options?: Omit<InvestigationEdit, "topic">): Investigation;
export function reviseInvestigation(state: Investigation, edit: InvestigationEdit): Investigation;
export function validateInvestigation(value: unknown): Investigation;
export interface InvestigationIncompleteCandidate {
  schema: "research-investigation-incomplete-candidate-v1";
  attemptId: string;
  executionStatus: "partial" | "failed" | "cancelled";
  reason: string | null;
  candidate: { answer: string; findings: string[]; gaps: string[]; sources: Array<{ uri: string }> };
  qualification: "Unfinished session output. Not accepted findings and not supplied automatically to later research.";
}
/** Returns schema-valid final text from a compatible unfinished investigate attempt, or null. */
export function getInvestigationIncompleteCandidate(state: Investigation, attemptId: string): InvestigationIncompleteCandidate | null;
export function planInvestigation(state: Investigation): InvestigationPlan;
/** Counts retained branch progress against a zero-work baseline; does not infer adequacy or truth. */
export function projectInvestigationMethodProgress(state: Investigation): InvestigationMethodProgress;
/** Appends a caller-authored exact-span review of a current finding over frozen source text. */
export function reviewInvestigationClaim(state: Investigation, input: { attemptId: string; findingIndex: number; assessment: InvestigationClaimReview["assessment"]; rationale: string; citations: Array<{ sourceIndex: number; start: number; end: number; quote: string }> }): Investigation;
/** Rechecks retained review identity and source spans without retargeting historical entries. */
export function projectInvestigationClaimReviews(state: Investigation): ProjectedInvestigationClaimReview[];
export function advanceInvestigation(state: Investigation, options: { action: InvestigationAction; branchIds?: string[]; signal?: AbortSignal; lease?: string; model?: string; effort?: string; progress?: (event: string) => void }): Promise<Investigation>;
/** Strict, digest-confirmed continuation. Requires frozen caller-provided sources and refuses completed compatible branches. */
export function advanceInvestigationPlan(state: Investigation, checkpoint: InvestigationPlan, options: { confirmedPlanDigest: string; action: "investigate"; branchIds: string[]; signal?: AbortSignal; lease?: string; model?: string; effort?: string; progress?: (event: string) => void }): Promise<Investigation>;
/** Requires a fresh planInvestigation checkpoint. Durable idempotency across forked/stale copies belongs to the caller. */
export function resumeInvestigation(state: Investigation, checkpoint: InvestigationPlan, options: Parameters<typeof advanceInvestigation>[1]): Promise<Investigation>;
export function renderInvestigation(state: Investigation, options?: { format?: "markdown" | "json" }): string;

export type ReferenceAuthor = { literal: string } | { family: string; given?: string }
export interface ReferenceMetadata {
  type: 'article' | 'book' | 'webpage' | 'report'; title: string; authors?: ReferenceAuthor[];
  year?: number; container_title?: string; publisher?: string; doi?: string; url?: string;
}
export interface ReferenceSelection {
  ref: { owner: string; kind: string; id: string; revision: string; digest: string };
  instance_id: string; owner_epoch: string | null;
}
export interface ReferenceRow {
  id: string; selection: ReferenceSelection; metadata_revision: number;
  metadata_sha256: string; metadata: ReferenceMetadata;
  qualification: 'User-supplied bibliographic metadata; unverified.';
}
export interface ReferenceList {
  schema: 'signals.reference-list.v1'; topic: { id: string; revision: number };
  references: ReferenceRow[];
}
/** Rejects unsupported fields, stale hashes, duplicate IDs and malformed retained reference rows. */
export function validateReferenceList(value: unknown): ReferenceList;
/** Formats the supported local metadata subset without fetching, enrichment or style-engine claims. */
export function formatBibliography(referenceList: ReferenceList, options?: { format?: 'text' | 'bibtex' | 'csl-json' }): string;
/** Adds explicitly source-index-bound, unverified bibliographic descriptions to offline report HTML. */
export function exportReportWithReferences(report: ResearchReport, referenceList: ReferenceList, bindings: { source: number; reference_id: string }[]): string;
/** A cited position: an exact quote from a selected attempt and, where supported, an exact frozen-source span. */
export interface BranchPosition { attemptId: string; branchId: string; stance: string; branchQuote: string; /** `answer` or `findings[N]`. */ branchField: string; /** Null means a branch claim only, not source evidence. */ source: { uri: string; sha256: string; quote: string; occurrence: number; start: number; end: number } | null }
export interface BranchComparisonPoint { summary: string; positions: BranchPosition[] }
export interface BranchComparisonResult { summary: string; agreements: BranchComparisonPoint[]; disagreements: BranchComparisonPoint[]; unknowns: { summary: string; attemptIds: string[] }[] }
export interface BranchAttemptSnapshot { id: string; branchId: string; question: string; identity: string; contextIdentity: string; revision: number; findings: string[]; gaps: string[]; sources: { uri: string; sha256?: string }[]; answer: string; digest: string; pinned: boolean }
/** Self-contained, fallible comparison; `digest` identifies bytes, not model truth. */
export interface BranchComparison { version: "branch-comparison-v1"; owner: "research-ai"; topic: string; goal: string; scope: string; investigationIdentity: string; contextIdentity: string; attemptId: string; status: InvestigationBranchStatus; reason: string | null; selection: BranchAttemptSnapshot[]; sources: (FrozenSource & { sha256: string })[]; preserved: { gaps: { attemptId: string; gap: string }[]; omissions: { uri: string; omission: string }[] }; result: BranchComparisonResult | null; /** Unvalidated readable text from a partial or cancelled session. */ partialText: string | null; receipt: SessionOutcome | null; digest: string }
export function compareInvestigation(state: Investigation, options: { branchIds: string[]; /** Pin exact attempts by branch id; otherwise the latest current completed attempt is used. */ attempts?: Record<string, string>; signal?: AbortSignal; lease?: string; model?: string; effort?: string; progress?: (event: string) => void }): Promise<{ investigation: Investigation; comparison: BranchComparison }>;
export function validateComparison(value: unknown): BranchComparison;
export function comparisonCurrentness(comparison: BranchComparison, state: Investigation): { current: boolean; reasons: string[] };
export function renderComparison(comparison: BranchComparison, options?: { format?: "markdown" | "json"; investigation?: Investigation }): string;

export type ResearchTableCell = string | number | boolean | null;
export interface ResearchTableColumn { id: string; label: string; type: "text" | "number" | "boolean" }
export interface ResearchTable {
  version: "research-table-v1"; id: string; columns: ResearchTableColumn[];
  rows: ResearchTableCell[][]; origin: { type: "caller-authored" | "caller-supplied"; label: string }; sha256: string;
}
export interface ResearchTableQuery {
  aggregate: "count" | "sum" | "avg" | "min" | "max"; column_id?: string; group_by?: string;
  where?: { column_id: string; op: "eq"; value: ResearchTableCell };
}
export interface ResearchTableCompleteResult {
  version: "research-table-result-v1"; status: "complete"; input_digest: string; query_digest: string;
  engine: { package: "@duckdb/node-api"; version: "2.0.0-r.1"; nativeVersion: string };
  columns: { id: string; label: string; type: "text" | "number" | "boolean" | "integer" }[];
  rows: ResearchTableCell[][]; qualifications: string[];
}
export type ResearchTableResult = ResearchTableCompleteResult | {
  version: "research-table-result-v1"; status: "failed"; input_digest: string; query_digest: string; error: string;
} | {
  version: "research-table-result-v1"; status: "unknown"; input_digest: string; query_digest: string;
  reason: "deadline" | "aborted" | "worker_cleanup_unconfirmed";
};
/** Validates a closed caller-authored or caller-supplied typed table and computes its exact canonical digest. */
export function registerTable(table: Omit<ResearchTable, "sha256">): ResearchTable;
/** Runs a closed aggregate in a short-lived restricted worker; engineRoot is trusted host configuration. */
export function analyzeTable(table: ResearchTable, query: ResearchTableQuery, options: {
  engineRoot: string; signal?: AbortSignal; timeoutMs?: number;
}): Promise<ResearchTableResult>;
export const tableAnalysisLimits: Readonly<{ rows: number; columns: number; bytes: number; groups: number; timeoutMs: number }>;

export interface ResearchTableCsvImport {
  version: "research-table-csv-v1"; csv_sha256: string; table_sha256: string;
  parser: { name: "csv-parse"; version: "7.0.3" }; headers: "first-row"; values: "text";
}
export interface ResearchTableCsvResult { table: ResearchTable; import: ResearchTableCsvImport }
/** Parses bounded UTF-8 CSV in memory through the host-configured optional csv-parse package. */
export function importTableCsv(csv: string | Uint8Array, options: { parserRoot: string; label: string }): Promise<ResearchTableCsvResult>;

export interface ResearchDocumentPage { number: number; text: string; sha256: string }
/** Caller-frozen extracted document pages; sha256 identifies raw source bytes but is not checked here. */
export interface ResearchDocumentInput { id: string; title: string; sha256: string; pages: ResearchDocumentPage[] }
export interface PreparedDocumentResearch {
  schema: "research-document-input-v2-quoted-evidence"; question: string; documents: ResearchDocumentInput[]; inputDigest: string;
  counts: { documents: number; pages: number; utf16Units: number }; limits: string[];
}
export interface DocumentAnswerParagraph { text: string; evidenceIds: string[] }
export interface DocumentResearchEvidence {
  id: string; documentId: string; page: number; start: number; end: number; quote: string;
  relation: "supporting" | "conflicting" | "context"; occurrence: "exact-page-span";
}
export interface DocumentResearchDraft {
  version: "research-document-answer-v1"; question: string; documents: ResearchDocumentInput[]; inputDigest: string;
  answer: DocumentAnswerParagraph[]; evidence: DocumentResearchEvidence[];
  coverage: "answered" | "partial" | "insufficient"; gaps: string[];
  origin: { type: "model-generated"; model: string; receipt: {
    mode: "frozen"; profile: Profile; model: string; effort: string; nativeSessions: 1; contentSha256: string;
  } }; limits: string[];
}
export type DocumentResearchResult = {
  status: "complete"; draft: DocumentResearchDraft; receipt: { mode: "frozen"; profile: Profile; outcome: SessionOutcome };
} | {
  status: "partial" | "failed" | "cancelled"; draft: null;
  receipt: { mode: "frozen"; profile: Profile; outcome: SessionOutcome; failure?: string };
};
/** Validates complete ordered pages and their extracted-text hashes before any session. The input digest binds the quoted-evidence-v2 model contract. */
export function prepareDocumentResearch(question: string, documents: ResearchDocumentInput[]): PreparedDocumentResearch;
/** Replays document hashes, answer-to-evidence links and exact UTF-16 page spans without a model. */
export function validateDocumentResearch(value: unknown): DocumentResearchDraft;
/** Researches all supplied pages in one frozen, schema-bound native session. */
export function researchDocuments(question: string, documents: ResearchDocumentInput[], options?: {
  profile?: Profile; signal?: AbortSignal; lease?: string; model?: string; effort?: string; progress?: (event: string) => void;
  activity?: (event: ResearchActivity) => void;
}): Promise<DocumentResearchResult>;
/** Renders a validated source-bound document answer without turning titles into links. */
export function renderDocumentResearch(value: DocumentResearchDraft, options?: { format?: "markdown" | "json" }): string;
export const documentResearchLimits: Readonly<{
  documents: 4; pagesPerDocument: 50; totalUtf16Units: 48000; answers: 24; evidence: 48; evidenceQuoteUtf16Units: 4000;
}>;

/** Conservative host policy; values are integers. Not measured provider limits. */
export interface DocumentCoveragePolicy { maxCalls: number; passUtf16Units: number; maxSeconds: number }
/** One ordered page range; `sha256` is of the exact substring. Empty pages have one zero-length window. */
export interface DocumentCoverageWindow { id: string; documentId: string; page: number; start: number; end: number; sha256: string }
export interface DocumentCoveragePass { id: string; windowIds: string[]; utf16Units: number }
export interface PreparedDocumentCoverage {
  version: "research-document-coverage-plan-v1"; question: string; documents: ResearchDocumentInput[];
  /** Binds question and complete documents. */
  inputDigest: string;
  /** Also binds policy, windows and passes; required as `confirmedPlanDigest` to run. */
  planDigest: string;
  policy: DocumentCoveragePolicy;
  counts: { documents: number; pages: number; utf16Units: number; windows: number; reviewCalls: number; maximumCalls: number };
  windows: DocumentCoverageWindow[]; passes: DocumentCoveragePass[]; limits: string[];
}
/** Same shape as single-session evidence; IDs are `pNN-eNN`, offsets are derived by the host. */
export type DocumentCoverageEvidence = DocumentResearchEvidence;
export interface DocumentCoverageFindings {
  answer: DocumentAnswerParagraph[]; evidence: DocumentCoverageEvidence[];
  coverage: "answered" | "partial" | "insufficient"; gaps: string[];
}
export interface DocumentCoverageSessionReceipt { mode: "frozen"; profile: Profile; outcome: SessionOutcome }
export interface DocumentCoveragePassResult {
  id: string; status: "complete" | "failed" | "cancelled" | "not_run"; windowIds: string[];
  /** Present only for a complete, validated pass. */
  findings: DocumentCoverageFindings | null;
  receipt: DocumentCoverageSessionReceipt | null; failure: string | null;
}
export interface DocumentCoverageDraft {
  version: "research-document-coverage-answer-v1"; question: string; documents: ResearchDocumentInput[];
  inputDigest: string; planDigest: string; answer: DocumentAnswerParagraph[];
  /** Exactly the cited validated evidence, in pass order. */
  evidence: DocumentCoverageEvidence[];
  coverage: "answered" | "partial" | "insufficient"; gaps: string[]; limits: string[];
}
export interface DocumentCoverageResult {
  version: "research-document-coverage-result-v1";
  /** `complete` needs every pass and synthesis complete with confirmed cleanup. */
  status: "complete" | "partial" | "failed" | "cancelled";
  plan: PreparedDocumentCoverage;
  passes: DocumentCoveragePassResult[];
  synthesis: { status: "complete" | "failed" | "cancelled" | "not_run"; reason: string | null; receipt: DocumentCoverageSessionReceipt | null };
  /** Execution coverage: windows with a completed validated review, not model understanding. */
  inputCoverage: {
    complete: boolean; reviewedWindows: string[]; unreviewedWindows: string[];
    /** A page appears only when all its windows were reviewed. */
    reviewedPages: { documentId: string; page: number }[];
    reviewedUtf16Units: number; totalUtf16Units: number;
  };
  draft: DocumentCoverageDraft | null;
  receipt: {
    mode: "frozen"; profile: Profile; plannedMaximumCalls: number;
    /** Receipts whose native process started. */
    startedCalls: number;
    cleanup: "complete" | "unconfirmed" | "not_started"; elapsedMs: number;
    stopReason: null | "cancelled" | "deadline" | "cleanup_unconfirmed" | "review_failed" | "workspace_error" | "synthesis_input_exceeds_bound";
    /** SHA-256 of the canonical result without this field; integrity only, not authenticated origin. */
    contentSha256: string;
  };
  limits: string[];
}
/** Observers are synchronous as in SessionOptions. */
export interface DocumentCoverageOptions extends Partial<DocumentCoveragePolicy> {
  /** Must equal the plan digest recomputed from the same question, documents and policy. */
  confirmedPlanDigest: string;
  profile?: Profile | undefined; model?: string | undefined; effort?: string | undefined; lease?: string | undefined;
  signal?: AbortSignal | undefined; progress?: ((event: string) => void) | undefined;
  activity?: ((event: ResearchActivity) => void) | undefined;
}
export const documentCoverageLimits: Readonly<{
  documents: 8; totalPages: 2000; totalUtf16Units: 1000000; windowsPerPass: 32; answers: 24;
  answerParagraphUtf16Units: 1200; evidencePerPass: 48; evidenceQuoteUtf16Units: 4000; gaps: 12;
  synthesisInputUtf16Units: 48000; policyDefaults: Readonly<DocumentCoveragePolicy>;
  policyRanges: Readonly<Record<keyof DocumentCoveragePolicy, readonly [number, number]>>;
}>;
/** Validates input and returns deterministic windows and passes; refuses plans above maxCalls. No inference. */
export function prepareDocumentCoverage(question: string, documents: ResearchDocumentInput[], policy?: Partial<DocumentCoveragePolicy>): PreparedDocumentCoverage;
/** One frozen session per pass in order, then one synthesis; refuses before any lease without a matching confirmation. */
export function researchDocumentCoverage(question: string, documents: ResearchDocumentInput[], options: DocumentCoverageOptions): Promise<DocumentCoverageResult>;
/** Offline replay of plan, hashes, exact quotes, statuses, accounting and content digest. */
export function validateDocumentCoverage(value: unknown): DocumentCoverageResult;
/** Validates first; never turns titles into links. */
export function renderDocumentCoverage(value: DocumentCoverageResult, options?: { format?: "markdown" | "json" }): string;

export type ResearchNotebookOrigin = { kind: "human"; questionId: null } | { kind: "question"; questionId: string }
  | { kind: "study"; studyId: string; questionId: string; studySha256: string; resultSha256: string };
export interface ResearchNotebookNoteVersion {
  version: number; title: string; text: string; origin: ResearchNotebookOrigin; sha256: string;
}
export interface ResearchNotebookNote { id: string; versions: ResearchNotebookNoteVersion[] }
export interface ResearchShouldaSourceOrigin {
  schemaVersion: 1; kind: "shoulda-source-selection"; sourceSelectionId: string; selectionReceiptSha256: string;
  repository: string; sourceId: string; headCommit: string; snapshotFingerprint: string;
  sourceInspectionId: string; sourceAssessmentId: string; decisionId: string;
  files: Array<{ page: number; path: string; role: string; sha256: string; byteCount: number }>;
  nearbyDocuments: Array<{ path: string; kind: "readme" | "license" | "notice"; sha256: string | null;
    truncated: boolean; state: "observed" | "missing" | "symlink" | "unavailable" }>;
  qualificationBasis: "caller-authored-only"; legalCompatibility: "not-assessed";
}
export interface ResearchBriefingRecordReference {
  owner: "signals-ai";
  kind: "briefing-item" | "briefing-source" | "briefing-story";
  id: string;
  revision: `sha256:${string}`;
}
export interface ResearchBriefingSourceHealth {
  status: "unknown" | "healthy" | "stale" | "failed";
  lastGoodAt: string | null;
  lastAttemptAt: string | null;
  lastAttemptStatus: "fetched" | "not-modified" | "failed" | null;
  lastSuccessfulLinkCount: number | null;
  failureClass: "unreachable" | "parse-error" | "refused" | "terms-blocked" | "other" | null;
  expectedIntervalSec: number | null;
}
export interface ResearchBriefingSourceOrigin {
  schemaVersion: 1;
  kind: "signals-briefing-item";
  itemReference: ResearchBriefingRecordReference & { kind: "briefing-item" };
  sourceReference: ResearchBriefingRecordReference & { kind: "briefing-source" };
  storyReference?: ResearchBriefingRecordReference & { kind: "briefing-story" };
  contentDigest: string;
  excerptSha256: string;
  observedAt: string;
  sourceHealth: ResearchBriefingSourceHealth;
}
export interface ResearchNotebookSource {
  id: string; document: ResearchDocumentInput; digest: string;
  shouldaOrigin?: ResearchShouldaSourceOrigin; briefingOrigin?: ResearchBriefingSourceOrigin;
}
export interface ResearchNotebookSourceMap {
  documentId: string; kind: "document" | "note"; recordId: string; version: number | null; digest: string; title: string;
}
export interface ResearchNotebookQuestionSpec {
  id: string; question: string; sourceIds: string[]; notes: Array<{ id: string; version: number }>;
}
export interface ResearchNotebookQuestion {
  id: string; question: string; scopeDigest: string; notebookDigest: string; spec: ResearchNotebookQuestionSpec;
  sourceMap: ResearchNotebookSourceMap[]; policy: DocumentCoveragePolicy; result: DocumentCoverageResult;
}
export interface ResearchNotebook {
  version: "research-notebook-v1"; id: string; title: string; topic: string; revision: number;
  sources: ResearchNotebookSource[]; notes: ResearchNotebookNote[]; questions: ResearchNotebookQuestion[]; sha256: string;
}
export type ResearchNotebookEdit =
  | { type: "rename"; title?: string; topic?: string }
  | { type: "add-source"; id?: string; document: ResearchDocumentInput }
  | { type: "add-shoulda-source"; id?: string; document: ResearchDocumentInput; origin: ResearchShouldaSourceOrigin }
  | { type: "add-briefing-source"; id?: string; document: ResearchDocumentInput; origin: ResearchBriefingSourceOrigin }
  | { type: "add-note"; id?: string; title: string; text: string }
  | { type: "edit-note"; id: string; title: string; text: string };
export interface PreparedNotebookQuestion {
  version: "research-notebook-question-preview-v1"; notebookId: string; notebookDigest: string;
  spec: ResearchNotebookQuestionSpec; scopeDigest: string; sourceMap: ResearchNotebookSourceMap[];
  request: { question: string; documents: ResearchDocumentInput[]; policy: DocumentCoveragePolicy };
  preview: { scopeDigest: string; planDigest: string; inputDigest: string; counts: PreparedDocumentCoverage["counts"];
    policy: DocumentCoveragePolicy; sources: Array<ResearchNotebookSourceMap & { pages: number }> };
}
export const researchNotebookLimits: Readonly<{
  sources: 16; notes: 32; versions: 16; questions: 32; bytes: 16777216;
  titleUtf16Units: 200; topicUtf16Units: 2000; noteTextUtf16Units: 20000; schema: "research-notebook-v1";
}>;
/** Creates portable notebook state without storage or inference. */
export function createResearchNotebook(title: string, options?: { topic?: string; id?: string }): ResearchNotebook;
/** Replays the entire closed notebook and returns a validated copy. */
export function validateResearchNotebook(value: unknown): ResearchNotebook;
/** Applies one metadata or append-only source/note edit. */
export function reviseResearchNotebook(notebook: ResearchNotebook, edit: ResearchNotebookEdit): ResearchNotebook;
/** Binds an explicit nonempty source/note selection to the complete coverage inputs and consent digests. */
export function prepareNotebookQuestion(notebook: ResearchNotebook, spec: ResearchNotebookQuestionSpec, policy?: Partial<DocumentCoveragePolicy>): PreparedNotebookQuestion;
/** Attaches a complete, partial or failed result to the prepared immutable scope. */
export function recordNotebookQuestion(notebook: ResearchNotebook, prepared: PreparedNotebookQuestion, result: DocumentCoverageResult): ResearchNotebook;
/** Copies a nonempty retained answer into a versioned, editable note with question origin. */
export function saveNotebookQuestionAsNote(notebook: ResearchNotebook, questionId: string, options?: { title?: string; id?: string }): ResearchNotebook;
/** Returns exact retained evidence and the source/note version selected by the question. */
export function getNotebookCitation(notebook: ResearchNotebook, questionId: string, evidenceId: string): {
  evidence: DocumentCoverageEvidence; document: ResearchDocumentInput;
  page: ResearchDocumentInput["pages"][number]; source: ResearchNotebookSource | { id: string; version: ResearchNotebookNoteVersion };
};
/** Reopens complete notebook JSON or safe Markdown without inference. */
export function renderResearchNotebook(notebook: ResearchNotebook, options?: { format?: "json" | "markdown" }): string;

export type NotebookSearchKind = "document" | "note";
export interface NotebookSearchOptions {
  mode?: "exact" | "prefix" | "fuzzy";
  kinds?: NotebookSearchKind[];
  noteVersions?: "latest" | "all";
  limit?: number;
}
export interface NotebookSearchMatch { field: "title" | "text"; start: number; end: number; text: string }
export interface NotebookSearchHit {
  id: string; notebookId: string; kind: NotebookSearchKind; recordId: string;
  version: number | null; documentId: string | null; page: number | null; title: string;
  sourceDigest: string; score: number; matchedTerms: string[]; matches: NotebookSearchMatch[];
  omittedMatchCount: number;
  excerpt: { start: number; end: number; text: string; truncatedBefore: boolean; truncatedAfter: boolean };
}
export interface NotebookSearchResult {
  version: "research-notebook-search-v1"; inputDigest: string;
  query: { text: string; mode: "exact" | "prefix" | "fuzzy"; kinds: NotebookSearchKind[]; noteVersions: "latest" | "all"; limit: number };
  scope: Array<{ id: string; sha256: string }>;
  engine: { name: "minisearch"; version: "7.2.0"; sha256: string };
  counts: { notebooks: number; records: number; utf16Units: number; totalHits: number; returnedHits: number };
  hits: NotebookSearchHit[]; qualifications: string[]; sha256: string;
}
/** Fresh in-memory lexical search over only explicitly selected, validated notebooks. */
export function searchResearchNotebooks(notebooks: ResearchNotebook[], query: string, options?: NotebookSearchOptions): NotebookSearchResult;
/** Revalidates and replays a result, then opens the exact source page or retained note version. */
export function openNotebookSearchHit(notebooks: ResearchNotebook[], result: NotebookSearchResult, hitId: string): {
  hit: NotebookSearchHit;
  source: { kind: "document"; notebookId: string; recordId: string; digest: string; document: ResearchDocumentInput; page: ResearchDocumentInput["pages"][number] }
    | { kind: "note"; notebookId: string; recordId: string; digest: string; version: ResearchNotebookNoteVersion };
};
export const notebookSearchLimits: Readonly<{ notebooks: 8; records: 8000; utf16Units: 4000000; queryUtf16Units: 200; hits: 50; matches: 64; excerptUtf16Units: 600; resultBytes: 8388608; engine: NotebookSearchResult["engine"] }>;

export interface ResearchRetrievalQuestion { id: string; text: string }
export interface ResearchRetrievalSource {
  id: string; notebook_id: string; kind: NotebookSearchKind; record_id: string;
  page: number | null; version: number | null; title: string; content_sha256: string; source_sha256: string;
}
export interface ResearchRetrievalArmExport {
  format: "research-retrieval-arm-1";
  corpus: { id: string; source_ids: string[]; source_sha256: Array<{ id: string; sha256: string }>; sources: ResearchRetrievalSource[] };
  questions: ResearchRetrievalQuestion[];
  arm: { strategy: string; provenance: { producer: string; version: string; reference: string; engine: NotebookSearchResult["engine"] };
    corpus_id: string; question_ids: string[]; rankings: Record<string, string[]> };
  qualifications: string[];
}
/** Exports one bounded frozen exact, prefix, or fuzzy lexical arm over explicit retained notebook sources. */
export function exportResearchRetrievalArm(notebooks: ResearchNotebook[], questions: ResearchRetrievalQuestion[], options: {
  mode?: "exact" | "prefix" | "fuzzy"; researchRevision: string;
}): ResearchRetrievalArmExport;

export interface ResearchAnswerCitationMap {
  format: "research-answer-citation-map-1";
  questions: Array<{
    notebook_id: string; question_id: string; status: "mapped" | "partial" | "unresolved";
    provenance: { notebook_sha256: string; question_scope_sha256: string; result_sha256: string };
    citations: Array<{ evidence_id: string; answer_paragraphs: number[]; hit_id: string; notebook_id: string;
      kind: NotebookSearchKind; record_id: string; page: number | null; version: number | null; title: string; content_sha256: string;
      provenance: { notebook_sha256: string; question_scope_sha256: string; result_sha256: string; source_sha256: string } }>;
    unresolved: Array<{ evidence_id: string | null; reason: string }>;
  }>;
  qualifications: string[];
}
/** Maps final saved answer evidence IDs to exact retained retrieval input identities; invalid citations refuse. */
export function exportResearchAnswerCitationMap(notebooks: ResearchNotebook[], questionIds: string[]): ResearchAnswerCitationMap;

export interface ResearchStudySelection {
  id: string;
  origin: { notebookId: string; notebookSha256: string; searchScope: Array<{ id: string; sha256: string }>; query: string; searchOptions: NotebookSearchOptions;
    searchInputDigest: string; searchResultSha256: string; hitId: string; kind: NotebookSearchKind;
    recordId: string; version: number | null; documentId: string | null; page: number | null; sourceDigest: string;
    retrieval?: { format: "research-retrieval-selection-1"; previewId: string; comparisonId: string | null; corpusDigest: string; questionId: string;
      sourceId: string; sourceSha256: string; selectedContentSha256: string; passageStart: number; passageEnd: number;
      armDigests: Record<"research-lexical-exact" | "research-lexical-prefix" | "research-lexical-fuzzy", string> } };
  document: ResearchDocumentInput;
  noteVersion: ResearchNotebookNoteVersion | null;
  contentSha256: string;
  sha256: string;
}
export interface ResearchStudyQuestionSpec { id: string; question: string; selectionIds: string[] }
export interface ResearchStudyQuestion {
  id: string; question: string; selectionIds: string[]; selectionDigest: string;
  sourceMap: Array<{ documentId: string; selectionId: string; notebookId: string; notebookSha256: string;
    kind: NotebookSearchKind; recordId: string; version: number | null; sourceDigest: string; page: number | null }>;
  policy: DocumentCoveragePolicy; request: { question: string; documents: ResearchDocumentInput[]; policy: DocumentCoveragePolicy };
  planDigest: string; result: DocumentCoverageResult; sha256: string;
}
export interface ResearchStudyPlanningSource {
  id: string;
  text: string;
  binding: {
    owner: "research-study"; studyId: string; questionId: string; questionSha256: string;
    selectionDigest: string; planDigest: string; resultSha256: string;
    sourceSnapshots: Array<{ selectionId: string; notebookId: string; notebookSha256: string; kind: NotebookSearchKind;
      recordId: string; version: number | null; sourceDigest: string; documentId: string; title: string; contentSha256: string }>;
    citations: Array<{ evidenceId: string; answerParagraph: number; selectionId: string; documentId: string;
      page: number; start: number; end: number; quote: string; relation: "supporting" | "conflicting" | "context" }>;
  };
  qualification: { resultStatus: "complete"; coverage: "answered" | "partial"; gaps: string[]; limits: string[];
    currentness: "frozen-snapshot-origin-not-checked"; claimLimit: string };
}
/** Builds an existing report-engine outline from exact cited rows of one frozen Study answer. */
export function createResearchStudyReportBasis(study: ResearchStudy, questionId: string): ResearchOutline;
/** Re-derives and compares the exact Study report basis; caller edits are rejected. */
export function validateResearchStudyReportBasis(study: ResearchStudy, questionId: string, candidate: unknown): ResearchOutline;
export interface ResearchStudy {
  version: "research-study-v1"; id: string; title: string; revision: number;
  selections: ResearchStudySelection[]; questions: ResearchStudyQuestion[]; sha256: string;
}
export type ResearchStudyEdit =
  | { type: "select-hit"; notebooks: ResearchNotebook[]; search: NotebookSearchResult; hitId: string }
  | { type: "select-retrieval-hit"; notebooks: ResearchNotebook[]; search: NotebookSearchResult; hitId: string;
      retrieval: NonNullable<ResearchStudySelection["origin"]["retrieval"]> }
  | { type: "deselect-hit"; selectionId: string };
export interface PreparedResearchStudyQuestion {
  version: "research-study-question-preview-v1"; studyId: string; studySha256: string;
  spec: ResearchStudyQuestionSpec; selectionDigest: string; sourceMap: ResearchStudyQuestion["sourceMap"];
  request: { question: string; documents: ResearchDocumentInput[]; policy: DocumentCoveragePolicy };
  preview: { planDigest: string; inputDigest: string; counts: PreparedDocumentCoverage["counts"];
    policy: DocumentCoveragePolicy; sources: Array<ResearchStudyQuestion["sourceMap"][number] & { pages: number }> };
}
export const researchStudyLimits: Readonly<{ selections: 16; questions: 32; selectedQuestionSources: 8; bytes: 16777216; schema: "research-study-v1" }>;
/** Creates a portable composition of explicitly selected notebook evidence. */
export function createResearchStudy(title: string, options?: { id?: string }): ResearchStudy;
/** Adds a currently validated search hit or removes an unused selection. */
export function reviseResearchStudy(study: ResearchStudy, edit: ResearchStudyEdit): ResearchStudy;
/** Cold-validates the complete study from its embedded immutable source/note snapshots. */
export function validateResearchStudy(value: unknown): ResearchStudy;
/** Reports whether selected origin notebook versions are still current, changed, or missing. */
export function checkResearchStudyOrigins(study: ResearchStudy, notebooks: ResearchNotebook[]): Array<{
  selectionId: string; notebookId: string; status: "current" | "changed" | "missing"; detail: "current" | "selected_record_missing" | "selected_version_changed" | "notebook_changed_selected_version_matches";
  expectedNotebookSha256: string; currentNotebookSha256: string | null; expectedSourceDigest?: string; currentSourceDigest?: string | null;
}>;
/** Prepares a question from 1-8 complete selected records retained in the study. */
export function prepareResearchStudyQuestion(study: ResearchStudy, spec: ResearchStudyQuestionSpec, policy?: Partial<DocumentCoveragePolicy>): PreparedResearchStudyQuestion;
/** Records a coverage result after replaying its exact selected sources and plan. */
export function recordResearchStudyQuestion(study: ResearchStudy, prepared: PreparedResearchStudyQuestion, result: DocumentCoverageResult): ResearchStudy;
/** Opens the exact cited page and immutable original selection after cold reopen. */
export function getResearchStudyCitation(study: ResearchStudy, questionId: string, evidenceId: string): {
  evidence: DocumentCoverageEvidence; page: ResearchDocumentInput["pages"][number]; document: ResearchDocumentInput;
  selection: ResearchStudySelection; source: { kind: "note"; noteVersion: ResearchNotebookNoteVersion } | { kind: "document"; notebookId: string; recordId: string; digest: string };
};
/** Exports one complete saved nonempty answer with exact retained citation closure; ID/text fit Planning source rules and binding/qualification are each <=16 KiB. */
export function exportResearchStudyPlanningSource(study: ResearchStudy, questionId: string): ResearchStudyPlanningSource;
/** Recomputes an exported Planning source from the exact saved Study answer and refuses any altered field. */
export function validateResearchStudyPlanningSource(study: ResearchStudy, questionId: string, candidate: unknown): ResearchStudyPlanningSource;
/** Projects a complete, evidence-qualified study answer into a chosen notebook with immutable study and result digests. */
export function saveResearchStudyQuestionAsNotebookNote(study: ResearchStudy, notebook: ResearchNotebook, questionId: string, options?: { title?: string; id?: string }): ResearchNotebook;
/** Exports the validated portable study as JSON or Markdown. */
export function renderResearchStudy(study: ResearchStudy, options?: { format?: "json" | "markdown" }): string;



export interface TableQueryBinding { name: string; table: ResearchTable }
export interface TableQuery { sql: string; parameters: Array<string | number | boolean | null> }
export interface TableQueryInput {
  name: string; id: string; sha256: string; row_count: number; row_column: '_row';
  origin: {type: 'caller-authored' | 'caller-supplied'; label: string};
  columns: Array<{id: string; label: string; type: 'text' | 'number' | 'boolean'; sql_name: string}>;
}
export interface TableQueryColumn {id: string; label: string; sql_type: string; representation: 'number' | 'text' | 'boolean' | 'integer-string' | 'decimal-string' | 'temporal-string' | 'null'}
export interface TableQueryPreview {version: 'research-table-query-preview-v1'; input_digest: string; query_digest: string; inputs: TableQueryInput[]; query: TableQuery; limits: typeof tableQueryLimits}
export interface TableQueryComplete {
  version: 'research-table-query-result-v1'; status: 'complete'; input_digest: string; query_digest: string;
  inputs: TableQueryInput[]; query: TableQuery; engine: {package: '@duckdb/node-api'; version: '2.0.0-r.1'; nativeVersion: string};
  columns: TableQueryColumn[]; rows: Array<Array<string | number | boolean | null>>; qualifications: string[]; result_sha256: string;
}
export type TableQueryResult = TableQueryComplete | {version: 'research-table-query-result-v1'; status: 'failed'; input_digest: string; query_digest: string; error: string} | {version: 'research-table-query-result-v1'; status: 'unknown'; input_digest: string; query_digest: string; reason: 'deadline' | 'aborted' | 'worker_cleanup_unconfirmed'};
export function prepareTableQuery(tables: TableQueryBinding[], query: TableQuery): TableQueryPreview;
export function queryTables(tables: TableQueryBinding[], query: TableQuery, options: {engineRoot: string; signal?: AbortSignal; timeoutMs?: number}): Promise<TableQueryResult>;
export function validateTableQueryResult(value: unknown, options?: {tables?: TableQueryBinding[]}): TableQueryComplete;
export const tableQueryLimits: Readonly<{tables: 4; inputBytes: 2000000; sqlUnits: 8000; parameters: 32; rows: 1000; columns: 32; resultBytes: 2000000; timeoutMs: 2000; cleanupGraceMs: 300}>;

export interface ResearchTableAnalysis {
  version: 'research-table-analysis-v1'; id: string; revision: number; parent_digest: string | null; title: string;
  tables: Array<{name: string; id: string; sha256: string}>;
  steps: Array<{name: `s${number}`; sql: string; note?: string}>;
  chart: null | {mark: 'bar'|'line'|'scatter'; step: `s${number}`; x: string; y: string|null; aggregate: 'none'|'count'|'sum'|'avg'|'min'|'max'; series: string|null; order: 'x'|'y-desc'};
  analysis_digest: string;
}
export interface ResearchTableAnalysisInput {
  id?: string; revision?: number; parent_digest?: string | null; title: string;
  tables: Array<{name: string; id: string; sha256: string}>;
  steps: Array<{name: `s${number}`; sql: string; note?: string}>;
  chart?: ResearchTableAnalysis['chart'];
}
export type AnalysisTarget = {kind:'step';step:string;mode:'rows'|'profile';columns?:TableQueryColumn[]} | {kind:'chart';columns:TableQueryColumn[]};
export interface ResearchAnalysisRunEntry {target: AnalysisTarget; state:'complete'|'failed'|'unknown'|'not_started'; query_digest:string; input_digest?:string; result_sha256?:string; artifact?:TableQueryComplete; error?:string; reason?:'deadline'|'aborted'|'worker_cleanup_unconfirmed'}
export interface ResearchAnalysisRun {version:'research-table-analysis-run-v1';id:string;analysis_digest:string;state:'complete'|'failed'|'unknown'|'halted'|'interrupted';entries:ResearchAnalysisRunEntry[];run_digest:string}
export const tableNotebookLimits: Readonly<{tables:4;steps:6;titleUnits:120;noteUnits:500;totalSqlUnits:7600;bundleBytes:4000000}>;
export function createAnalysis(input: ResearchTableAnalysisInput): ResearchTableAnalysis;
export function validateAnalysis(value: unknown): ResearchTableAnalysis;
export function compileStep(analysis: ResearchTableAnalysis, step: string, mode?:'rows'|'profile', columns?:TableQueryColumn[]): TableQuery;
export function compileChart(analysis: ResearchTableAnalysis, resultColumns: TableQueryColumn[]): TableQuery;
export function prepareAnalysisQuery(analysis: ResearchTableAnalysis, tables: TableQueryBinding[], target: AnalysisTarget): TableQueryPreview & {target:AnalysisTarget;analysis_digest:string};
export function runAnalysisTarget(analysis: ResearchTableAnalysis, tables: TableQueryBinding[], target: AnalysisTarget, options:{engineRoot:string;signal?:AbortSignal}): Promise<TableQueryResult>;
export function profileFromResults(rows:TableQueryComplete, profile:TableQueryComplete, options:{analysis:ResearchTableAnalysis;step:string}): {row_count:string|null;columns:Array<{id:string;label:string;sql_type:string;representation:TableQueryColumn['representation'];null_count:string|null;profiled:boolean;flags:string[]}>;qualifications:string[]};
export function chartSeries(result:TableQueryComplete, spec:NonNullable<ResearchTableAnalysis['chart']>): {points:Array<{x:string|null;series?:string|null;y:string|null}>;caption:string;disclosures:string[]};
export function buildAnalysisRun(analysis:ResearchTableAnalysis, entries:Array<{target:AnalysisTarget;result:TableQueryResult}>, options?:{id?:string}): ResearchAnalysisRun;
export function validateAnalysisRun(run:unknown, options:{analysis:ResearchTableAnalysis;tables?:TableQueryBinding[]}): ResearchAnalysisRun;
export function exportAnalysisBundle(analysis:ResearchTableAnalysis, run:ResearchAnalysisRun, options?:{includeSourceRows?:boolean}): string;
