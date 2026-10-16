export interface Readable {
  format: 'markdown';
  text: string;
}

export interface Readiness {
  /** `codex --version` and `codex login status` both ran. */
  installed: boolean;
  /** The CLI reports a login; no model call is made. */
  available: boolean;
  runner: string;
}
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
  exitCode: number | null;
  signal: string | null;
  trigger: string | null;
}

/** Received-byte metadata only; the unparsed wire is never decoded or retained. */
export interface StdoutReceipt {
  text: '';
  capturedDigest: string;
  capturedBytes: number;
  omittedBytes: number;
  captureComplete: false;
  captureScope: 'runner-stdout';
}

export interface SessionOptions {
  /** Written to stdin; untrusted material belongs inside it as labelled data. */
  prompt: string;
  /** Live web search; `false` is frozen review with web search disabled. */
  live: boolean;
  budget: Budget;
  signal: AbortSignal;
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
  /** Calls already charged against `budget.searches` before the session. */
  initialSearches?: number | undefined;
  /** Reads a completed message as a checkpoint note; default is trimmed non-empty text. */
  readNote?: ((text: string) => Readable | undefined) | undefined;
  /** Receives the bounded combined checkpoint after each accepted note. */
  onCheckpoint?: ((readable: Readable) => void) | undefined;
  /** Runs synchronously after preparation, immediately before the native process starts. */
  beforeSpawn?: (() => void) | undefined;
}

export interface SessionOutcome {
  /** Process start failure message; the session never ran or was not observed. */
  error?: string;
  aborted: boolean;
  /** Last completed message, truncated to `maxResponseBytes` when capped. */
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
}

export interface CodexWorkspace {
  directory: string;
  /** One session per workspace; invalid or cancelled inputs refuse before dispatch. */
  run(options: SessionOptions): Promise<SessionOutcome>;
}

/** Callback completion aborts/drains unfinished work before releasing the workspace. */
export function withCodexWorkspace<T>(
  names: { lease: string; prefix: string },
  body: (workspace: CodexWorkspace) => Promise<T>,
): Promise<T>;

export function sessionCompleted(outcome: SessionOutcome): boolean;

export const profiles: Readonly<Record<Profile, Readonly<Budget>>>;
export function ordinaryResearchPrompt(question: string, context?: string): string;

export type Profile = 'quick' | 'wide';

export interface ResearchResult {
  /**
   * `complete`: clean zero exit with a final message and no guard.
   * `partial`: stopped or failed, but completed interim notes were checkpointed.
   * `failed`: nothing readable arrived.
   */
  status: 'complete' | 'partial' | 'failed';
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
    stages: SessionOutcome['stages'];
    termination: Termination;
    /** Present unless complete: start error, `cancelled`, guard trigger or missing final answer. */
    failure?: string;
    /** Bounded stderr/event diagnostic, present unless complete. */
    diagnostic?: string;
  };
}

export interface ResearchOptions {
  profile?: Profile | undefined;
  /** Extra untrusted context, passed to the model as labelled data. */
  context?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  signal?: AbortSignal | undefined;
  progress?: ((event: string) => void) | undefined;
  onCheckpoint?: ((readable: Readable) => void) | undefined;
  /** Lease directory; defaults to a per-user path under the temporary directory. */
  lease?: string | undefined;
}

/** Throws `question_required`, `unknown_profile` or a lease error before any native session. */
export function researchQuestion(
  question: string,
  options?: ResearchOptions,
): Promise<ResearchResult>;
