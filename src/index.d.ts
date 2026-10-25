export interface Readable {
  format: "markdown";
  text: string;
}

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
export interface ResearchOutline {
  version: "research-outline-v1";
  topic: string;
  sources: (FrozenSource & { sha256: string })[];
  sections: OutlineSection[];
  origin: { type: "model-generated" | "user-modified" | "caller-authored"; model?: string; receipt?: { mode: "frozen"; profile: keyof typeof profiles; model: string; effort: string; nativeSessions: 1; contentSha256: string } };
  limits: string[];
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
/** Converts an outline or evidence table into a report without inference or loss. */
export function createReport(input: ResearchOutline | ResearchEvidenceTable): ResearchReport;
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
export interface Investigation { version: "guided-investigation-v1"; owner: "research-ai"; /** Present only in independent mode; joins identity hashes only when present. */ branchContext?: "independent"; topic: string; goal: string; scope: string; revision: number; identity: string; questions: InvestigationQuestion[]; sources: (FrozenSource & { sha256: string })[] | null; budget: InvestigationBudget; used: { searches: number; documents: number; seconds: number; calls: number }; history: InvestigationAttempt[]; clarifications: string[]; report: { identity: string; markdown: string; attemptId: string } | null }
export function createInvestigation(topic: string, options?: Omit<InvestigationEdit, "topic">): Investigation;
export function reviseInvestigation(state: Investigation, edit: InvestigationEdit): Investigation;
export function validateInvestigation(value: unknown): Investigation;
export function advanceInvestigation(state: Investigation, options: { action: InvestigationAction; branchIds?: string[]; signal?: AbortSignal; lease?: string; model?: string; effort?: string; progress?: (event: string) => void }): Promise<Investigation>;
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
  schema: "research-document-input-v1"; question: string; documents: ResearchDocumentInput[]; inputDigest: string;
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
/** Validates complete ordered pages and their extracted-text hashes before any session. */
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
