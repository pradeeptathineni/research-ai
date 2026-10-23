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
}

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
