#!/usr/bin/env node
// Standalone CLI for independent investigation branches and their explicit comparison.
// Every file is explicit input or output; outputs are never overwritten. Before any native
// dispatch the output state is first written with a receipt-less failed attempt, so if this
// process dies the saved state blocks later native work instead of silently replaying.
import { constants } from 'node:fs';
import { lstat, open, realpath, writeFile } from 'node:fs/promises';
import { dirname, basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInvestigation, reviseInvestigation, validateInvestigation, advanceInvestigation, compareInvestigation, validateComparison, comparisonCurrentness, renderComparison } from '../src/index.mjs';
import { recordDispatchUnknown } from '../src/investigation.mjs';

const usage = `Usage:
  research-branches create --spec SPEC.json --out STATE.json
  research-branches edit --in STATE.json --edit EDIT.json --out STATE.json
  research-branches run --in STATE.json --branch ID [--branch ID ...] --out STATE.json [--lease PATH]
  research-branches compare --in STATE.json --branch ID --branch ID [--attempt ID=ATTEMPT] --out STATE.json --comparison COMPARISON.json [--lease PATH]
  research-branches export --comparison COMPARISON.json [--in STATE.json] [--format markdown|json] --out FILE
SPEC.json: { topic, goal?, scope?, questions, sources, budget? } (frozen sources only).
Exit 0: every new attempt complete. 1: an attempt was not complete. 2: refused input.`;

const repeatable = new Set(['branch', 'attempt']);
function parse(argv) {
  const [command, ...rest] = argv, flags = { branch: [], attempt: [] };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.startsWith('--') ? rest[i].slice(2) : null, value = rest[i + 1];
    if (!['spec','in','edit','out','branch','attempt','comparison','format','lease'].includes(key) || value === undefined) throw new Error('unknown flag or missing value');
    if (repeatable.has(key)) flags[key].push(value);
    else if (Object.hasOwn(flags, key)) throw new Error(`--${key} given twice`);
    else flags[key] = value;
  }
  return { command, flags };
}
const need = (flags, ...keys) => { for (const k of keys) if (!flags[k]) throw new Error(`--${k} is required`); };
const serialize = (value) => Buffer.from(typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
const create = (path, value) => writeFile(path, serialize(value), { flag: 'wx', mode: 0o600 });

async function descriptorBytes(handle, limit) {
  const bytes = Buffer.alloc(limit + 1); let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  if (offset > limit) throw new Error(`input exceeds ${limit} bytes`);
  return bytes.subarray(0, offset);
}

async function readJson(path, limit = 1024 * 1024) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('input must be a regular non-symlink JSON file');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await descriptorBytes(handle, limit)));
  } finally { await handle.close(); }
}

async function preflightOutputs(paths) {
  const identities = new Set();
  for (const path of paths) {
    const absolute = resolve(path), identity = `${await realpath(dirname(absolute))}/${basename(absolute)}`;
    if (identities.has(identity)) throw new Error('state and comparison outputs must be distinct');
    identities.add(identity);
    try { await lstat(absolute); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error(`${path} already exists`);
  }
}

// Keep the admitted descriptor and a separate final snapshot: late replies never follow a replaced path.
async function reserve(path, marker) {
  const handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const bytes = serialize(marker);
  try { await handle.writeFile(bytes); await handle.sync(); }
  catch (error) { await handle.close(); throw error; }
  return { path, handle, marker: bytes, identity: await handle.stat(), recovery: `${path}.result-${randomUUID()}.json` };
}

async function stage(slot, value) {
  slot.final = serialize(value);
  await writeFile(slot.recovery, slot.final, { flag: 'wx', mode: 0o400 });
}

async function publish(slot) {
  const matches = async () => {
    try {
      const at = await lstat(slot.path);
      return at.isFile() && at.dev === slot.identity.dev && at.ino === slot.identity.ino && at.nlink === 1;
    } catch { return false; }
  };
  let admitted;
  try { admitted = await descriptorBytes(slot.handle, slot.marker.length); } catch {}
  if (!await matches() || !admitted?.equals(slot.marker))
    throw new Error(`output changed after admission; final result retained at ${slot.recovery}`);
  await slot.handle.truncate(0);
  let offset = 0;
  while (offset < slot.final.length) {
    const { bytesWritten } = await slot.handle.write(slot.final, offset, slot.final.length - offset, offset);
    if (!bytesWritten) throw new Error(`output write incomplete; final result retained at ${slot.recovery}`);
    offset += bytesWritten;
  }
  await slot.handle.sync();
  if (!await matches()) throw new Error(`output path changed; final result retained at ${slot.recovery}`);
}

async function main(argv) {
  const { command, flags } = parse(argv);
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
  const native = { signal: controller.signal, ...(flags.lease ? { lease: flags.lease } : {}) };
  if (command === 'create') {
    need(flags, 'spec', 'out');
    const { topic, ...options } = await readJson(flags.spec);
    if (Object.hasOwn(options, 'branchContext')) throw new Error('spec must not set branchContext; this CLI always creates independent branches');
    await create(flags.out, createInvestigation(topic, { ...options, branchContext: 'independent' }));
    process.stdout.write(`Created independent investigation ${flags.out}\n`);
    return 0;
  }
  if (command === 'edit') {
    need(flags, 'in', 'edit', 'out');
    await create(flags.out, reviseInvestigation(validateInvestigation(await readJson(flags.in)), await readJson(flags.edit)));
    process.stdout.write(`Revised ${flags.out}; earlier attempts stay in history\n`);
    return 0;
  }
  if (command === 'run' || command === 'compare') {
    need(flags, 'in', 'out', ...(command === 'compare' ? ['comparison'] : []));
    if (!flags.branch.length) throw new Error('--branch is required');
    const state = validateInvestigation(await readJson(flags.in));
    if (state.branchContext !== 'independent') throw new Error('input is not an independent investigation');
    await preflightOutputs(command === 'compare' ? [flags.out, flags.comparison] : [flags.out]);
    const before = state.history.length;
    let next, comparison, stateSlot, comparisonSlot;
    try {
    if (command === 'run') {
      // Validate the selection offline before recording intent.
      for (const id of flags.branch) if (!state.questions.some((q) => q.id === id)) throw new Error(`unknown branch ${id}`);
      await advanceInvestigation(state, { action: 'investigate', branchIds: flags.branch, signal: AbortSignal.abort() });
      stateSlot = await reserve(flags.out, recordDispatchUnknown(state, 'investigate', flags.branch[0]));
      next = await advanceInvestigation(state, { action: 'investigate', branchIds: flags.branch, ...native });
    } else {
      const attempts = {};
      for (const value of flags.attempt) {
        const at = value.indexOf('='), branch = value.slice(0, at);
        if (at < 1 || at === value.length - 1 || Object.hasOwn(attempts, branch)) throw new Error('--attempt requires one unique BRANCH=ATTEMPT selection');
        attempts[branch] = value.slice(at + 1);
      }
      // Dry selection check (no dispatch): an aborted signal reaches no native session.
      const dry = new AbortController(); dry.abort();
      await compareInvestigation(state, { branchIds: flags.branch, attempts, signal: dry.signal });
      stateSlot = await reserve(flags.out, recordDispatchUnknown(state, 'compare'));
      comparisonSlot = await reserve(flags.comparison, { version: 'branch-comparison-pending-v1', investigationIdentity: state.identity, reason: 'dispatch_outcome_unknown' });
      ({ investigation: next, comparison } = await compareInvestigation(state, { branchIds: flags.branch, attempts, ...native }));
    }
    await stage(stateSlot, next);
    if (comparisonSlot) { await stage(comparisonSlot, comparison); await publish(comparisonSlot); }
    await publish(stateSlot);
    const added = next.history.slice(before);
    for (const a of added) process.stdout.write(`${a.id} ${a.action} ${a.branchId ?? '-'}: ${a.status}${a.reason ? ` (${a.reason})` : ''}\n`);
    process.stdout.write(`Calls used ${next.used.calls}/${next.budget.calls}\n`);
    process.stdout.write(`Final snapshots: ${stateSlot.recovery}${comparisonSlot ? `; ${comparisonSlot.recovery}` : ''}\n`);
    return added.every((a) => a.status === 'complete') ? 0 : 1;
    } finally {
      await stateSlot?.handle.close();
      await comparisonSlot?.handle.close();
    }
  }
  if (command === 'export') {
    need(flags, 'comparison', 'out');
    const comparison = validateComparison(await readJson(flags.comparison, 4 * 1024 * 1024));
    const investigation = flags.in ? validateInvestigation(await readJson(flags.in)) : undefined;
    await create(flags.out, renderComparison(comparison, { format: flags.format ?? 'markdown', ...(investigation ? { investigation } : {}) }));
    const currentness = investigation ? comparisonCurrentness(comparison, investigation) : null;
    process.stdout.write(`Exported ${flags.out}; comparison ${comparison.status}; ${currentness === null ? 'currentness not checked' : currentness.current ? 'current' : `stale: ${currentness.reasons.join('; ')}`}\n`);
    return 0;
  }
  throw new Error('unknown command');
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (error) => { process.stderr.write(`${error?.message ?? error}\n${usage}\n`); process.exitCode = 2; },
);
