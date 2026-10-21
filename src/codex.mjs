import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';

const exec = promisify(execFile);
const omission =
  '\n\nAdditional completed notes omitted by the bounded partial-output limit (24,000 UTF16 units or 64 notes).';

/** Probes the installed CLI and its own login state. Never launches a model. */
export async function codexReadiness() {
  try {
    const version = await exec('codex', ['--version'], { timeout: 5000 });
    const auth = await exec('codex', ['login', 'status'], { timeout: 5000 });
    return {
      installed: true,
      available: /Logged in/.test(auth.stdout + auth.stderr),
      runner: version.stdout.trim(),
    };
  } catch {
    return { installed: false, available: false, runner: 'codex' };
  }
}

/** One private exclusive lease per host user; a live or orphaned owner is never displaced. */
async function acquireLease(path) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch {
    const ownerPath = join(path, 'owner.json');
    const raw = await readFile(ownerPath, 'utf8').catch(() => '');
    if (!raw) throw new Error('runner_interrupted_lease');
    const owner = JSON.parse(raw);
    if (!Number.isInteger(owner.pid) || owner.pid < 1) throw new Error('invalid_runner_lease');
    let alive = true;
    try {
      process.kill(owner.pid, 0);
    } catch {
      alive = false;
    }
    if (alive) throw new Error('runner_busy');
    if (!owner.childPid) throw new Error('runner_interrupted_lease_requires_inspection');
    try {
      process.kill(owner.childPid, 0);
      throw new Error('runner_orphan_still_active');
    } catch (failure) {
      if (failure.code !== 'ESRCH') throw failure;
    }
    const recovery = `${path}.recovery`;
    try {
      await mkdir(recovery, { mode: 0o700 });
    } catch {
      throw new Error('runner_busy');
    }
    try {
      if ((await readFile(ownerPath, 'utf8')) !== raw) throw new Error('runner_busy');
      await rm(path, { recursive: true });
      await mkdir(path, { mode: 0o700 });
    } finally {
      await rm(recovery, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(path, 'owner.json'),
    JSON.stringify({ pid: process.pid, childPid: null, started: Date.now() }),
  );
}

/** Reads model selection only, never authentication; explicit choices win. */
async function selection(model, effort) {
  const config = await readFile(join(homedir(), '.codex/config.toml'), 'utf8').catch(() => '');
  return {
    model: model ?? /^model\s*=\s*"([^"\n]+)"/m.exec(config)?.[1],
    effort: effort ?? /^model_reasoning_effort\s*=\s*"([^"\n]+)"/m.exec(config)?.[1],
  };
}

function codexArgs({ directory, live, schemaPath, model, effort }) {
  const args = [
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--json',
    ...(schemaPath ? ['--output-schema', schemaPath] : []),
    '--cd',
    directory,
    '-c',
    `web_search="${live ? 'live' : 'disabled'}"`,
    '-c',
    'features.shell_tool=false',
    '-c',
    'features.multi_agent=false',
    '-c',
    'features.hooks=false',
    '-c',
    'features.plugins=false',
    '-c',
    'features.memories=false',
    '-c',
    'apps._default.enabled=false',
    '-c',
    'approval_policy="never"',
  ];
  if (model) args.push('--model', model);
  if (effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(effort)}`);
  args.push('-');
  return args;
}

const defaultNote = (text) => {
  return text.trim() ? { format: 'markdown', text } : undefined;
};

function validateSession(options) {
  if (
    !options ||
    typeof options.prompt !== 'string' ||
    !options.prompt.trim() ||
    Buffer.byteLength(options.prompt) > 3000000 ||
    typeof options.live !== 'boolean' ||
    !(options.signal instanceof AbortSignal)
  )
    throw new TypeError('invalid_session_options');
  const budget = options.budget;
  if (
    !budget ||
    !Number.isFinite(budget.seconds) ||
    budget.seconds <= 0 ||
    budget.seconds > 3600 ||
    !['searches', 'documents'].every(
      (key) => Number.isSafeInteger(budget[key]) && budget[key] >= 0 && budget[key] <= 10000,
    )
  )
    throw new TypeError('invalid_session_budget');
  if (
    (options.maxResponseBytes !== undefined &&
      (!Number.isSafeInteger(options.maxResponseBytes) ||
        options.maxResponseBytes < 1 ||
        options.maxResponseBytes > 3000000)) ||
    (options.initialSearches !== undefined &&
      (!Number.isSafeInteger(options.initialSearches) || options.initialSearches < 0))
  )
    throw new TypeError('invalid_session_limit');
  for (const key of ['progress', 'readNote', 'onCheckpoint', 'beforeSpawn'])
    if (options[key] !== undefined && typeof options[key] !== 'function')
      throw new TypeError('invalid_session_callback');
  if (options.signal.aborted)
    throw new DOMException('Research cancelled before dispatch', 'AbortError');
}

/** One session per callback scope; unfinished work is stopped and drained before cleanup. */
export async function withCodexWorkspace({ lease, prefix }, body) {
  if (
    typeof lease !== 'string' ||
    !isAbsolute(lease) ||
    typeof prefix !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(prefix) ||
    typeof body !== 'function'
  )
    throw new TypeError('invalid_research_workspace');
  await acquireLease(lease);
  const directory = await mkdtemp(join(tmpdir(), prefix)).catch(async (failure) => {
    await rm(lease, { recursive: true, force: true });
    throw failure;
  });
  const scope = new AbortController();
  let open = true,
    used = false,
    pending;
  const run = (options) => {
    if (!open) throw new Error('research_workspace_closed');
    if (used) throw new Error('research_workspace_session_already_started');
    validateSession(options);
    used = true;
    pending = runSession(lease, directory, {
      ...options,
      signal: AbortSignal.any([options.signal, scope.signal]),
    });
    // Keep discarded calls handled while preserving rejection for callers that await them.
    void pending.catch(() => {});
    return pending;
  };
  try {
    return await body({ directory, run });
  } finally {
    open = false;
    scope.abort();
    try {
      if (pending) await pending.catch(() => {});
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(lease, { recursive: true, force: true });
    }
  }
}

async function runSession(lease, directory, options) {
  const {
    prompt,
    live,
    budget,
    signal,
    progress = () => {},
    outputSchema,
    structured = false,
    maxResponseBytes,
    initialSearches = 0,
    readNote = defaultNote,
    onCheckpoint,
    beforeSpawn,
  } = options;
  const schemaPath =
    outputSchema === undefined ? undefined : join(directory, 'proposal.schema.json');
  if (schemaPath) await writeFile(schemaPath, JSON.stringify(outputSchema));
  const selected = await selection(options.model, options.effort);
  const args = codexArgs({ directory, live, schemaPath, ...selected });
  progress(
    `Runner: Codex; model ${selected.model ?? 'CLI default'}; effort ${selected.effort ?? 'CLI default'}; ${live ? 'live search' : 'frozen evidence review'}; no shell/hooks/plugins/delegation.`,
  );
  beforeSpawn?.();
  if (signal.aborted) throw new DOMException('Research cancelled before dispatch', 'AbortError');
  const sessionStarted = Date.now();
  const sessionMonotonic = performance.now();
  return await new Promise((resolve) => {
    const child = spawn('codex', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: {
        PATH: process.env.PATH,
        HOME: homedir(),
        CODEX_HOME: process.env.CODEX_HOME,
        TMPDIR: process.env.TMPDIR,
      },
    });
    let diagnostic = '',
      pending = '',
      bytes = 0,
      searches = initialSearches,
      usage = null,
      toolCalls = 0,
      reads = 0,
      unclassifiedToolCalls = 0,
      final = '',
      readable,
      oversizedResponse,
      stdoutReceipt,
      notesOmitted = false,
      settled = false;
    const notes = [];
    // Categories partition received completed messages, not unseen provider output.
    const messages = {
      completed: 0,
      checkpointed: 0,
      unreadable: 0,
      duplicate: 0,
      limited: 0,
      afterStop: 0,
      schema: 0,
    };
    const wireDigest = maxResponseBytes ? createHash('sha256') : undefined;
    const decoder = new StringDecoder('utf8');
    const utf8 = new TextDecoder('utf-8', { fatal: true });
    const terminal = { completed: 0, failed: 0, protocolFailure: null };
    const protocolFailure = (reason) => { terminal.protocolFailure ??= reason; };
    const termination = { exitCode: null, signal: null, trigger: null };
    const outcome = (error) => ({
      ...(error === undefined ? {} : { error }),
      aborted: signal.aborted,
      final,
      readable,
      diagnostic,
      usage,
      model: selected.model,
      effort: selected.effort,
      searches,
      actionCounts: { toolCalls, reads, unclassifiedToolCalls, messages: { ...messages } },
      nativeSessions: child.pid ? 1 : 0,
      stages: {
        nativeSessionMs: Date.now() - sessionStarted,
        nativeSessionMonotonicMs: Math.max(0, Math.round(performance.now() - sessionMonotonic)),
      },
      ...(stdoutReceipt ? { stdoutReceipt } : {}),
      ...(oversizedResponse === undefined ? {} : { oversizedResponse }),
      termination: { ...termination },
      terminal: { ...terminal },
      failureReason:
        error ?? (signal.aborted ? 'cancelled' : null) ?? termination.trigger ??
        (termination.exitCode !== 0 || termination.signal !== null
          ? (final ? 'runner_failed' : 'no_final_answer') : null) ??
        terminal.protocolFailure ??
        (terminal.completed + terminal.failed > 1 ? 'conflicting_runner_terminal' : null) ??
        (terminal.failed ? 'runner_turn_failed' : null) ??
        (terminal.completed !== 1 ? 'missing_runner_terminal' : null) ??
        (!final.trim() ? 'no_final_answer' : null),
    });
    const settle = (error) => {
      if (settled) return;
      settled = true;
      resolve(outcome(error));
    };
    const stop = (trigger = 'runner_guard') => {
      termination.trigger ??= trigger;
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
    };
    if (child.pid)
      void writeFile(
        join(lease, 'owner.json'),
        JSON.stringify({ pid: process.pid, childPid: child.pid, started: Date.now() }),
      ).catch(() => {
        diagnostic = 'runner_lease_registration_failed';
        stop('lease_registration_failed');
      });
    const timer = setTimeout(() => stop('native_deadline'), budget.seconds * 1000);
    const abort = () => stop('request_aborted');
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) stop('request_aborted');
    const consumeLine = (line) => {
      try {
        const event = JSON.parse(line);
        if (!event || typeof event !== 'object' || Array.isArray(event) ||
            typeof event.type !== 'string' || !event.type)
          throw new Error('invalid event');
        const itemLifecycle = ['item.started', 'item.updated', 'item.completed'].includes(event.type);
        if ((terminal.completed || terminal.failed) &&
            (event.type === 'thread.started' || event.type === 'turn.started' || itemLifecycle))
          protocolFailure('activity_after_runner_terminal');
        if (itemLifecycle &&
            (!event.item || typeof event.item !== 'object' || Array.isArray(event.item) ||
             typeof event.item.type !== 'string')) throw new Error('invalid item');
        if (event.type === 'turn.completed') {
          terminal.completed++;
          if (event.error !== undefined || (event.usage !== undefined &&
              (!event.usage || typeof event.usage !== 'object' || Array.isArray(event.usage))))
            protocolFailure('invalid_runner_terminal');
        }
        if (event.type === 'turn.failed') terminal.failed++;
        if (event.type === 'error') protocolFailure('runner_protocol_error');
        if (event.type === 'error' || event.type === 'turn.failed')
          diagnostic = typeof event.message === 'string' ? event.message.slice(0, 1000) :
            typeof event.error?.message === 'string' ? event.error.message.slice(0, 1000) : 'runner_error';
        if (event.usage) usage = event.usage;
        if (event.item?.type === 'web_search') {
          if (event.type === 'item.started') {
            toolCalls++;
            progress(
              `Web action ${toolCalls}; search/read limits ${budget.searches}/${budget.documents}`,
            );
            if (toolCalls > budget.searches + budget.documents) stop('action_limit');
          }
          if (event.type === 'item.completed') {
            if (event.item.action?.type === 'search') searches++;
            else if (event.item.action?.type) reads++;
            else unclassifiedToolCalls++;
            if (searches > budget.searches || reads > budget.documents) stop('action_limit');
          }
        }
        if (event.item?.type === 'agent_message' && event.type === 'item.completed') {
          messages.completed++;
          const alreadyStopped = termination.trigger !== null;
          if (typeof event.item.text !== 'string' || !event.item.text.isWellFormed()) {
            if (alreadyStopped) messages.afterStop++;
            else if (structured) messages.schema++;
            else messages.unreadable++;
            throw new Error('invalid message');
          }
          final = event.item.text;
          if (maxResponseBytes && Buffer.byteLength(final) > maxResponseBytes) {
            oversizedResponse = final;
            final = Buffer.from(final).subarray(0, maxResponseBytes).toString();
            diagnostic = 'runner_response_byte_limit';
            stop('response_byte_limit');
          }
          if (alreadyStopped) messages.afterStop++;
          else if (structured) messages.schema++;
          else if (termination.trigger) messages.limited++;
          else {
            // Only completed user-facing messages can become a research checkpoint.
            const note = readNote(final);
            if (!note) messages.unreadable++;
            else if (note.text === notes.at(-1)) messages.duplicate++;
            else if (notesOmitted) messages.limited++;
            else {
              const combined = [...notes, note.text].join('\n\n---\n\n');
              if (combined.length <= 24000 && notes.length < 64) {
                notes.push(note.text);
                messages.checkpointed++;
                readable = { format: 'markdown', text: combined };
              } else {
                messages.limited++;
                notesOmitted = true;
                const retained = notes.join('\n\n---\n\n') || note.text;
                let end = Math.min(retained.length, 24000 - omission.length);
                if (end > 0 && /[\uD800-\uDBFF]/u.test(retained[end - 1])) end--;
                readable = { format: 'markdown', text: retained.slice(0, end) + omission };
              }
              onCheckpoint?.(readable);
            }
          }
        }
        if (event.item && ['command_execution', 'mcp_tool_call'].includes(event.item.type)) {
          stop('forbidden_runner_tool');
          diagnostic = 'forbidden_runner_tool';
        }
      } catch {
        protocolFailure('invalid_runner_event');
        diagnostic = 'invalid_runner_event';
      }
    };
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      wireDigest?.update(chunk);
      if (bytes > (maxResponseBytes ? maxResponseBytes + 32768 : 3000000)) {
        if (wireDigest)
          stdoutReceipt = {
            text: '',
            capturedDigest: wireDigest.copy().digest('hex'),
            capturedBytes: bytes,
            omittedBytes: bytes,
            captureComplete: false,
            captureScope: 'runner-stdout',
          };
        // An unparsed wire may contain reasoning/tool content. Retain received-byte metadata
        // only, without expanding, decoding or storing its unclassified diagnostic text.
        pending = '';
        stop('output_byte_limit');
        return;
      }
      try { utf8.decode(chunk, { stream: true }); }
      catch { protocolFailure('invalid_runner_utf8'); }
      pending += decoder.write(chunk);
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) consumeLine(line);
    });
    child.stderr.on('data', (chunk) => {
      if (diagnostic.length < 1000)
        diagnostic += chunk.toString().slice(0, 1000 - diagnostic.length);
    });
    child.on('error', (failure) => settle(failure.message));
    child.on('close', (code, childSignal) => {
      try { utf8.decode(); }
      catch { protocolFailure('invalid_runner_utf8'); }
      if (termination.trigger !== 'output_byte_limit') {
        pending += decoder.end();
        if (pending) consumeLine(pending);
      }
      termination.exitCode = code;
      termination.signal = childSignal;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      settle();
    });
    // A child that exits before reading its prompt reports through `close`, not a host crash.
    child.stdin.on?.('error', () => {});
    child.stdin.end(prompt);
  });
}

/** Explicit terminal success, exact nonempty text, clean exit and no contradiction. */
export function sessionCompleted(outcome) {
  return (
    outcome.error === undefined &&
    !outcome.aborted &&
    outcome.termination.exitCode === 0 &&
    typeof outcome.final === 'string' && Boolean(outcome.final.trim()) &&
    outcome.termination.signal === null &&
    outcome.terminal?.completed === 1 &&
    outcome.terminal.failed === 0 &&
    outcome.terminal.protocolFailure === null &&
    outcome.failureReason === null &&
    outcome.termination.trigger === null
  );
}
