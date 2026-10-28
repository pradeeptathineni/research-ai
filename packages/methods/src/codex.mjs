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

// This profile checks advertised command options, not native protocol/permission correctness.
const readinessProfile = 'codex-exec-json-v1';
const profileFlags = [
  '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
  '--sandbox', '--json', '--output-schema', '--cd', '--model', '--config',
];
const observation = (source) => ({ source, observedAt: null, exitCode: null, failure: 'not_probed' });

async function readinessProbe(args) {
  const source = `codex ${args.join(' ')}`;
  try {
    const { stdout, stderr } = await exec('codex', args, { timeout: 5000, maxBuffer: 65536, killSignal: 'SIGKILL' });
    return { stdout, stderr, observation: { source, observedAt: new Date().toISOString(), exitCode: 0, failure: null } };
  } catch (failure) {
    const reason = failure.code === 'ENOENT' ? 'not_found' :
      failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output_limit' :
      failure.killed && failure.signal ? 'timeout' :
      typeof failure.code === 'number' || failure.signal ? 'process_failed' : 'start_failed';
    return {
      stdout: failure.stdout ?? '', stderr: failure.stderr ?? '',
      observation: { source, observedAt: new Date().toISOString(),
        exitCode: typeof failure.code === 'number' ? failure.code : null, failure: reason },
    };
  }
}

/** Bounded version/login/help observations only. Never launches inference. */
export async function codexReadiness() {
  const versionProbe = await readinessProbe(['--version']);
  const installed = !['not_found', 'start_failed'].includes(versionProbe.observation.failure);
  const runner = versionProbe.stdout.trim().slice(0, 200) || 'codex';
  const version = /^codex-cli (\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(runner)?.[1] ?? null;
  const probes = {
    version: versionProbe.observation,
    authentication: observation('codex login status'),
    profile: observation('codex exec --help'),
  };
  let authenticated = null, supportedProfile = null;
  if (installed) {
    const [auth, profile] = await Promise.all([
      readinessProbe(['login', 'status']), readinessProbe(['exec', '--help']),
    ]);
    probes.authentication = auth.observation;
    probes.profile = profile.observation;
    const lines = `${auth.stdout}\n${auth.stderr}`.split(/\r?\n/).map(line => line.trim());
    const loggedIn = lines.some(line => /^Logged in(?: using .+)?$/.test(line));
    const loggedOut = lines.includes('Not logged in');
    if (auth.observation.failure === null) {
      if (loggedIn && !loggedOut) authenticated = true;
      else if (loggedOut && !loggedIn) authenticated = false;
    } else if (auth.observation.failure === 'process_failed' && auth.observation.exitCode === 1 &&
               loggedOut && !loggedIn) authenticated = false;
    if (profile.observation.failure === null && /^Usage:\s+codex exec\b/m.test(profile.stdout)) {
      const flags = new Set([...profile.stdout.matchAll(/(?:^|\s)(--[a-z][a-z-]*)(?=[\s,=]|$)/g)].map(match => match[1]));
      supportedProfile = profileFlags.every(flag => flags.has(flag));
    }
  }
  const error = !installed ? (probes.version.failure === 'not_found' ? 'missing_executable' : 'version_probe_failed') :
    probes.version.failure !== null ? 'version_probe_failed' : version === null ? 'version_unrecognized' :
    authenticated === false ? 'not_authenticated' : authenticated === null ?
      (probes.authentication.failure === null ? 'auth_unrecognized' : 'auth_probe_failed') :
    supportedProfile === false ? 'unsupported_profile' : supportedProfile === null ?
      (probes.profile.failure === null ? 'profile_unrecognized' : 'profile_probe_failed') : null;
  const remedies = {
    missing_executable: 'Codex CLI executable was not found; install it or correct PATH, then retry.',
    version_probe_failed: 'Could not read the Codex CLI version; check `codex --version` and executable access, then retry.',
    version_unrecognized: 'Unrecognized Codex CLI version output; use a compatible Codex CLI and retry.',
    not_authenticated: 'Codex CLI is not logged in; run `codex login` and retry.',
    auth_probe_failed: 'Could not determine Codex login state; check `codex login status` and retry.',
    auth_unrecognized: 'Unrecognized Codex login state; check `codex login status` and retry.',
    unsupported_profile: 'This Codex CLI does not advertise the required research execution flags; use a compatible CLI and retry.',
    profile_unrecognized: 'Unrecognized Codex execution help; check `codex exec --help` and use a compatible CLI.',
    profile_probe_failed: 'Could not inspect Codex execution support; check `codex exec --help` and retry.',
  };
  return { schemaVersion: 1, installed, available: error === null, runner, version,
    authenticated, supportedProfile, profile: readinessProfile, error,
    remedy: error === null ? null : remedies[error], probes };
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
    if (process.platform !== 'win32') {
      const groupId = owner.processGroupId ?? owner.childPid;
      if (!Number.isSafeInteger(groupId) || groupId < 1 ||
          groupId !== owner.childPid) throw new Error('invalid_runner_lease');
      try {
        process.kill(-groupId, 0);
        throw new Error('runner_orphan_still_active');
      } catch (failure) {
        if (failure.code !== 'ESRCH') throw failure;
      }
    }
    if (owner.cleanupRequired) throw new Error('runner_interrupted_lease_requires_inspection');
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

// Stream callbacks are synchronous host observations/readers, never provider events.
function syncCallback(callback, value) {
  const result = callback?.(value);
  if (result && typeof result.then === 'function') {
    void Promise.resolve(result).catch(() => {});
    throw new TypeError('async_session_callback');
  }
  return result;
}

/**
 * research-activity-v1: ephemeral typed observations of one session. Each kind carries a
 * closed `detail`; provider event objects, prompts, reasoning, message/schema text, queries,
 * find patterns and diagnostics never pass through. Web completion is a native report, not
 * proof of access, source truth or entailment.
 */
export const researchActivity = Object.freeze({
  version: 'research-activity-v1',
  limit: 512,
  kinds: Object.freeze([
    'session.started', 'thread.started', 'turn.started', 'web.started', 'web.completed',
    'checkpoint', 'runner.error', 'turn.completed', 'turn.failed', 'protocol.failed',
    'session.stopped', 'activity.limited', 'session.settled',
  ]),
  unsupported: Object.freeze([
    'fetch_status', 'http_status', 'source_verification', 'search_query', 'page_content',
    'partial_answer_text', 'reasoning', 'non_web_items',
  ]),
});
const webActions = new Set(['search', 'open_page', 'find_in_page', 'other']);

// Reported exactly or withheld; a URL is never rewritten into a different display identity.
function displayUrl(value) {
  if (value === undefined) return { url: null, urlStatus: 'absent' };
  if (typeof value !== 'string' || value.length > 2000 ||
      !/^https?:\/\/[\x21-\x7e]+$/i.test(value) || /[?#]/.test(value))
    return { url: null, urlStatus: 'withheld' };
  try {
    const url = new URL(value);
    if (url.username || url.password || !url.hostname) return { url: null, urlStatus: 'withheld' };
  } catch {
    return { url: null, urlStatus: 'withheld' };
  }
  return { url: value, urlStatus: 'reported' };
}

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
      (!Number.isSafeInteger(options.initialSearches) || options.initialSearches < 0 ||
        options.initialSearches > budget.searches))
  )
    throw new TypeError('invalid_session_limit');
  for (const key of ['progress', 'readNote', 'onCheckpoint', 'beforeSpawn', 'activity'])
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
    let observed;
    try {
      if (pending) observed = await pending.catch(() => {});
    } finally {
      // Unknown cleanup retains its ownership record and workspace for inspection.
      if (observed?.cleanup?.complete !== false) {
        await rm(directory, { recursive: true, force: true });
        await rm(lease, { recursive: true, force: true });
      }
    }
  }
}

// Only the freshly spawned detached child's group is signaled; stale leases are never killed.
async function cleanupProcessGroup(child) {
  if (!child.pid) return { complete: true, error: null };
  if (process.platform === 'win32') return { complete: false, error: 'process_group_cleanup_failed' };
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (failure) {
    return failure.code === 'ESRCH' ? { complete: true, error: null } :
      { complete: false, error: 'process_group_cleanup_failed' };
  }
  const until = performance.now() + 1000;
  while (performance.now() < until) {
    try { process.kill(-child.pid, 0); }
    catch (failure) {
      if (failure.code === 'ESRCH') return { complete: true, error: null };
      // A dying/reparented group can transiently deny an existence probe.
      // EPERM is unknown, never absence; retain the bound and keep observing.
      if (failure.code !== 'EPERM') return { complete: false, error: 'process_group_cleanup_failed' };
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return { complete: false, error: 'process_group_cleanup_failed' };
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
    activity,
  } = options;
  const schemaPath =
    outputSchema === undefined ? undefined : join(directory, 'proposal.schema.json');
  if (schemaPath) await writeFile(schemaPath, JSON.stringify(outputSchema));
  const selected = await selection(options.model, options.effort);
  const args = codexArgs({ directory, live, schemaPath, ...selected });
  syncCallback(progress,
    `Runner: Codex; model ${selected.model ?? 'CLI default'}; effort ${selected.effort ?? 'CLI default'}; ${live ? 'live search' : 'frozen evidence review'}; no shell/hooks/plugins/delegation.`,
  );
  syncCallback(beforeSpawn);
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
      settled = false,
      finishing = false;
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
    // Activity is observation only: delivery failure stops the session like other callbacks.
    let sequence = 0, omittedActivity = 0, activityLost = false;
    const deliver = (kind, detail) => {
      const event = Object.freeze({ version: researchActivity.version, sequence: ++sequence,
        observedAt: new Date().toISOString(), kind, detail: Object.freeze(detail) });
      try {
        syncCallback(activity, event);
        return true;
      } catch {
        activityLost = true;
        return false;
      }
    };
    const observe = (kind, detail = {}) => {
      if (!activity || activityLost || finishing || settled) return;
      if (sequence >= researchActivity.limit) {
        if (!omittedActivity++ && !deliver('activity.limited', { limit: researchActivity.limit }))
          stop('activity_callback_failed');
        return;
      }
      if (!deliver(kind, detail)) stop('activity_callback_failed');
    };
    const terminal = { completed: 0, failed: 0, protocolFailure: null };
    const protocolFailure = (reason) => {
      if (terminal.protocolFailure !== null) return;
      terminal.protocolFailure = reason;
      observe('protocol.failed', { reason });
    };
    const termination = { exitCode: null, signal: null, trigger: null };
    let cleanup = { complete: false, error: null }, cleanupTask, startError;
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
      cleanup: { ...cleanup },
      failureReason:
        error ?? (signal.aborted ? 'cancelled' : null) ?? termination.trigger ??
        terminal.protocolFailure ??
        (terminal.completed + terminal.failed > 1 ? 'conflicting_runner_terminal' : null) ??
        (terminal.failed ? 'runner_turn_failed' : null) ??
        (termination.exitCode !== 0 || termination.signal !== null
          ? (final ? 'runner_failed' : 'no_final_answer') : null) ??
        (terminal.completed !== 1 ? 'missing_runner_terminal' : null) ??
        (!final.trim() ? 'no_final_answer' : null),
    });
    const settle = (error) => {
      if (settled) return;
      settled = true;
      let result = outcome(error);
      // Settlement is reported only after terminal, protocol and cleanup evidence is final.
      if (child.pid && activity && !activityLost && !deliver('session.settled', {
        completed: sessionCompleted(result),
        failureReason: startError === undefined ? result.failureReason : 'native_process_error',
        cleanup: result.cleanup.complete, delivered: sequence, omitted: omittedActivity,
      })) {
        termination.trigger ??= 'activity_callback_failed';
        result = outcome(error);
      }
      resolve(result);
    };
    const finish = async () => {
      if (finishing || settled) return;
      finishing = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (!cleanup.complete) child.unref();
      await registered;
      if (!cleanup.complete) {
        termination.trigger ??= cleanup.error;
        await writeFile(join(lease, 'owner.json'), JSON.stringify({ ...owner, cleanupRequired: true })).catch(() => {});
      }
      settle(startError);
    };
    const beginCleanup = () => {
      if (cleanupTask) return cleanupTask;
      cleanupTask = cleanupProcessGroup(child);
      void cleanupTask.then((result) => {
        if (finishing || settled) return;
        cleanup = result;
        if (!result.complete) void finish();
      });
      return cleanupTask;
    };
    const stop = (trigger = 'runner_guard') => {
      if (finishing || settled) return;
      if (termination.trigger === null) {
        termination.trigger = trigger;
        observe('session.stopped', { trigger });
      }
      if (!cleanup.complete) beginCleanup();
    };
    const owner = { pid: process.pid, childPid: child.pid,
      ...(process.platform === 'win32' ? {} : { processGroupId: child.pid }),
      directory, started: Date.now() };
    const registered = child.pid ? writeFile(join(lease, 'owner.json'), JSON.stringify(owner)).catch(() => {
      diagnostic = 'runner_lease_registration_failed';
      stop('lease_registration_failed');
    }) : Promise.resolve();
    const timer = setTimeout(() => stop('native_deadline'), budget.seconds * 1000);
    const abort = () => stop('request_aborted');
    if (child.pid) observe('session.started', { mode: live ? 'live' : 'frozen' });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) stop('request_aborted');
    const consumeLine = (line) => {
      if (finishing || settled) return;
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
        if (event.type === 'thread.started' || event.type === 'turn.started') observe(event.type);
        if (event.type === 'turn.completed') {
          terminal.completed++;
          observe('turn.completed');
          if (event.error !== undefined || (event.usage !== undefined &&
              (!event.usage || typeof event.usage !== 'object' || Array.isArray(event.usage))))
            protocolFailure('invalid_runner_terminal');
        }
        if (event.type === 'turn.failed') {
          terminal.failed++;
          observe('turn.failed');
        }
        if (event.type === 'error') {
          observe('runner.error');
          protocolFailure('runner_protocol_error');
        }
        if (event.type === 'error' || event.type === 'turn.failed')
          diagnostic = typeof event.message === 'string' ? event.message.slice(0, 1000) :
            typeof event.error?.message === 'string' ? event.error.message.slice(0, 1000) : 'runner_error';
        if (event.usage) usage = event.usage;
        if (event.item?.type === 'web_search') {
          if (!live) {
            stop('forbidden_runner_tool');
            diagnostic = 'forbidden_runner_tool';
          }
          if (event.type === 'item.started') {
            toolCalls++;
            observe('web.started', { call: toolCalls });
            try {
              syncCallback(progress, `Web action ${toolCalls}; search/read limits ${budget.searches}/${budget.documents}`);
            } catch {
              stop('progress_callback_failed');
            }
            if (toolCalls > budget.searches + budget.documents) stop('action_limit');
          }
          if (event.type === 'item.completed') {
            if (event.item.action?.type === 'search') searches++;
            else if (event.item.action?.type) reads++;
            else unclassifiedToolCalls++;
            const type = event.item.action?.type;
            observe('web.completed', {
              action: typeof type !== 'string' ? 'absent' : webActions.has(type) ? type : 'unrecognized',
              ...displayUrl(event.item.action?.url), searches, reads, unclassified: unclassifiedToolCalls,
            });
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
            final = new StringDecoder('utf8').write(Buffer.from(final).subarray(0, maxResponseBytes));
            diagnostic = 'runner_response_byte_limit';
            stop('response_byte_limit');
          }
          if (alreadyStopped) messages.afterStop++;
          else if (structured) messages.schema++;
          else if (termination.trigger) messages.limited++;
          else {
            // Only completed user-facing messages can become a research checkpoint.
            let note;
            try {
              note = syncCallback(readNote, final);
              if (note !== undefined && (!note || note.format !== 'markdown' ||
                  typeof note.text !== 'string' || !note.text.trim() || !note.text.isWellFormed()))
                throw new TypeError('invalid_readable_note');
            } catch {
              messages.unreadable++;
              stop('read_note_failed');
              return;
            }
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
              observe('checkpoint', { notes: notes.length, units: readable.text.length,
                bytes: Buffer.byteLength(readable.text), omitted: notesOmitted });
              try {
                syncCallback(onCheckpoint, readable);
              } catch {
                stop('checkpoint_callback_failed');
              }
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
      if (finishing || settled) return;
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
      if (finishing || settled) return;
      if (diagnostic.length < 1000)
        diagnostic += chunk.toString().slice(0, 1000 - diagnostic.length);
    });
    child.on('error', (failure) => { if (!finishing && !settled) startError = failure.message; });
    // Exit precedes close; the same bounded cleanup also starts on a live-leader stop.
    child.once('exit', (code, childSignal) => {
      if (finishing || settled) return;
      termination.exitCode = code;
      termination.signal = childSignal;
      beginCleanup();
    });
    child.on('close', async (code, childSignal) => {
      if (finishing || settled) return;
      try { utf8.decode(); }
      catch { protocolFailure('invalid_runner_utf8'); }
      if (termination.trigger !== 'output_byte_limit') {
        pending += decoder.end();
        if (pending) consumeLine(pending);
      }
      termination.exitCode = code;
      termination.signal = childSignal;
      cleanup = await beginCleanup();
      await finish();
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
    outcome.cleanup?.complete === true &&
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
