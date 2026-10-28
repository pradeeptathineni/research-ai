import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { secureDirectory } from './search-store.js';

const closed = { additionalProperties: false };
const text = Type.String({ minLength: 1, maxLength: 128 });
const key = Type.String({ pattern: '^[A-Za-z0-9_.:-]{1,128}$' });
const ref = Type.Object(
  {
    owner: text,
    kind: text,
    id: text,
    revision: Type.Union([text, Type.Null()]),
    digest: Type.Union([text, Type.Null()]),
  },
  closed,
);
const requestSchema = Type.Object(
  {
    schema_version: Type.Literal('1.0'),
    request_id: text,
    idempotency_key: key,
    query: Type.String({ minLength: 1, maxLength: 2000 }),
    method: Type.Literal('answer-first'),
    profile: Type.Enum(['quick', 'wide']),
    cache: Type.Enum(['memory', 'none']),
    save: Type.Literal('never'),
    project_ref: Type.Null(),
    authority_ref: ref,
  },
  closed,
);
type ResearchRequest = Static<typeof requestSchema>;
type Terminal = 'complete' | 'partial' | 'failed' | 'cancelled';
const recordSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-f0-9]{32}$' }),
    key,
    requestId: text,
    digest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    payloadDigest: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
    configurationDigest: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
    state: Type.Enum(['admitted', 'unknown', 'complete', 'partial', 'failed', 'cancelled']),
    reason: text,
    observedAt: Type.String({ format: 'date-time' }),
    expired: Type.Boolean(),
    cancelRequested: Type.Boolean(),
  },
  closed,
);
type RequestRecord = Static<typeof recordSchema>;
const ledgerSchema = Type.Object(
  {
    version: Type.Literal(1),
    identity: Type.String({ format: 'uuid' }),
    epoch: Type.String({ format: 'uuid' }),
    records: Type.Array(recordSchema, { maxItems: 2000 }),
    checksum: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  },
  closed,
);
type Ledger = Omit<Static<typeof ledgerSchema>, 'checksum'>;
const checksum = (ledger: Ledger) =>
  createHash('sha256').update(JSON.stringify(ledger)).digest('hex');

// RFC8785 ordering/JSON primitive encoding, for validated JSON-only inputs.
const canonical = (value: unknown): string => {
  if (typeof value === 'string' && !value.isWellFormed())
    throw new Error('invalid_request_unicode');
  if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) {
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new Error('invalid_configuration_number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (!value || typeof value !== 'object') throw new Error('invalid_configuration_json');
  return (
    '{' +
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, child]) => canonical(name) + ':' + canonical(child))
      .join(',') +
    '}'
  );
};
export const requestConfigurationDigest = (snapshot: unknown) =>
  createHash('sha256').update(canonical(snapshot)).digest('hex');
const configurationRef = (digest?: string) =>
  digest
    ? {
        schema_version: 'signals-execution-v1',
        digest_algorithm: 'jcs-sha256-v1',
        digest,
      }
    : null;
export function parseResearchRequest(input: unknown): ResearchRequest {
  if (
    !Value.Check(requestSchema, input) ||
    !input.query.trim() ||
    input.authority_ref.owner !== 'signals-ai' ||
    input.authority_ref.kind !== 'authority'
  )
    throw new Error('unsupported_research_request_v1');
  // JCS forbids lone surrogates; do not replace malformed identity bytes.
  const strings = (value: unknown): string[] =>
    typeof value === 'string'
      ? [value]
      : value && typeof value === 'object'
        ? Object.values(value).flatMap(strings)
        : [];
  if (strings(input).some((value) => !value.isWellFormed()))
    throw new Error('invalid_request_unicode');
  return { ...input, query: input.query.trim() };
}

async function existingDirectory(path: string) {
  if (!(await lstat(path)).isDirectory() || (await realpath(path)) !== resolve(path))
    throw new Error('request_store_unavailable');
}
async function syncDirectory(path: string) {
  const file = await open(path, constants.O_RDONLY);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function publishFile(folder: string, name: string, bytes: string) {
  const temporary = join(folder, `.pending-${randomUUID()}`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(folder, name));
    await syncDirectory(folder);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
async function publish(folder: string, ledger: Ledger) {
  const digest = checksum(ledger);
  // The separately synced head detects a missing/rolled-back snapshot. A crash
  // between these writes is unavailable, never a license to re-admit a lost key.
  await publishFile(folder, 'head', digest);
  await publishFile(folder, 'ledger.json', JSON.stringify({ ...ledger, checksum: digest }));
}

/** One private ledger is the dedupe authority; it never contains query/answer text.
 * No automatic lock stealing, ledger recreation, expiry deletion or dispatch replay.
 */
export function requestStore(root: string) {
  const privateRoot = resolve(root, '.signals');
  const folder = join(privateRoot, 'requests');
  const load = async (): Promise<Ledger> => {
    try {
      await existingDirectory(privateRoot);
      await existingDirectory(folder);
      const path = join(folder, 'ledger.json');
      const head = join(folder, 'head');
      for (const file of [path, head]) {
        if (!(await lstat(file)).isFile() || (await realpath(file)) !== file)
          throw new Error('invalid_ledger_path');
      }
      const bytes = await readFile(path, 'utf8');
      if (Buffer.byteLength(bytes) > 2_000_000) throw new Error('ledger_too_large');
      const ledger: unknown = JSON.parse(bytes);
      if (
        !Value.Check(ledgerSchema, ledger) ||
        new Set(ledger.records.map((row) => row.key)).size !== ledger.records.length ||
        new Set(ledger.records.map((row) => row.id)).size !== ledger.records.length
      )
        throw new Error('invalid_ledger');
      const { checksum: storedChecksum, ...content } = ledger;
      if (storedChecksum !== checksum(content) || (await readFile(head, 'utf8')) !== storedChecksum)
        throw new Error('ledger_checksum_mismatch');
      return content;
    } catch (cause) {
      throw new Error('request_store_unavailable', { cause });
    }
  };
  const scope = (ledger: Ledger) => ({
    owner: 'signals-ai',
    identity: ledger.identity,
    epoch: ledger.epoch,
    contract: 'research-request-v1',
    digest_algorithm: 'jcs-sha256-v1',
    at_most_once: true,
    retention: 'identity_tombstones_until_explicit_store_retirement',
  });
  const checkEpoch = (ledger: Ledger, epoch: string) => {
    if (epoch !== ledger.epoch) throw new Error('owner_epoch_mismatch');
  };
  const receipt = (record: RequestRecord) => ({
    schema_version: '1.0',
    request_id: record.requestId,
    idempotency_key: record.key,
    request_digest: record.digest,
    digest_algorithm: 'jcs-sha256-v1',
    state: record.expired
      ? 'unknown'
      : record.state === 'unknown' && record.cancelRequested
        ? 'cancel_requested'
        : record.state,
    run_ref: {
      owner: 'signals-ai',
      kind: 'research_job',
      id: record.id,
      revision: null,
      digest: null,
    },
    result_ref: null,
    reason: record.expired ? 'result_expired_tombstone_retained' : record.reason,
    observed_at: record.observedAt,
  });
  const view = (ledger: Ledger, record?: RequestRecord) => ({
    code: record ? 'request_found' : 'not_found',
    id: record?.id ?? null,
    receipt: record ? receipt(record) : null,
    execution_configuration: configurationRef(record?.configurationDigest),
    deduplication: scope(ledger),
    reason: record
      ? null
      : 'absence_is_not_proof_of_no_effect; verify_intact_scope_and_current_authority',
  });
  const write = async <T>(
    operation: (ledger: Ledger) => T | Promise<T>,
    changed: (result: T) => boolean = () => true,
  ): Promise<T> => {
    // Lookups never acquire this lock or create storage. A lock surviving a crash is
    // an explicit repair boundary; elapsed time alone cannot establish ownership.
    try {
      await existingDirectory(privateRoot);
      await existingDirectory(folder);
    } catch (cause) {
      throw new Error('request_store_unavailable', { cause });
    }
    const lock = join(folder, 'writer');
    let acquired = false;
    for (let attempt = 0; attempt < 500; attempt++) {
      try {
        await mkdir(lock, { mode: 0o700 });
        acquired = true;
        break;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST')
          throw new Error('request_store_unavailable', { cause });
        await new Promise((done) => setTimeout(done, 10));
      }
    }
    if (!acquired) throw new Error('request_store_busy_reconciliation_required');
    try {
      const ledger = await load();
      const result = await operation(ledger);
      if (changed(result)) {
        try {
          await publish(folder, ledger);
        } catch (cause) {
          throw new Error('request_store_unavailable', { cause });
        }
      }
      return result;
    } finally {
      await rmdir(lock);
    }
  };
  const update = async (id: string, epoch: string, change: (record: RequestRecord) => void) =>
    write((ledger) => {
      checkEpoch(ledger, epoch);
      const record = ledger.records.find((row) => row.id === id);
      if (!record) throw new Error('unknown_request_identity');
      change(record);
      record.observedAt = new Date().toISOString();
      return view(ledger, record);
    });
  return {
    async initialize() {
      await secureDirectory(privateRoot);
      try {
        await mkdir(folder, { mode: 0o700 });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST')
          throw new Error('request_store_unavailable', { cause });
        return scope(await load());
      }
      // mkdir is never treated as a complete ledger: interrupted initialization
      // remains unavailable, rather than silently assigning another epoch.
      const ledger: Ledger = {
        version: 1,
        identity: randomUUID(),
        epoch: randomUUID(),
        records: [],
      };
      try {
        await publish(folder, ledger);
        await syncDirectory(privateRoot);
      } catch (cause) {
        throw new Error('request_store_unavailable', { cause });
      }
      return scope(ledger);
    },
    async scope() {
      return scope(await load());
    },
    async observe() {
      const ledger = await load();
      return {
        scope: scope(ledger),
        checksum: checksum(ledger),
        requests: ledger.records.map((record) => ({
          id: record.id,
          requestId: record.requestId,
          receipt: receipt(record),
        })),
      };
    },
    async lookup(idempotencyKey: string, epoch: string) {
      const ledger = await load();
      checkEpoch(ledger, epoch);
      return view(
        ledger,
        ledger.records.find((row) => row.key === idempotencyKey),
      );
    },
    async job(id: string) {
      try {
        await lstat(folder);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new Error('request_store_unavailable', { cause });
      }
      const ledger = await load();
      return view(
        ledger,
        ledger.records.find((row) => row.id === id),
      );
    },
    async admit(
      input: { request_id: string; idempotency_key: string },
      epoch: string,
      configurationDigest?: string,
      expectedConfigurationDigest?: string,
      // Distinct closed operations share one identity scope; the action keeps their digests apart.
      action: 'search' | 'frozen-followup' = 'search',
    ) {
      for (const digest of [configurationDigest, expectedConfigurationDigest]) {
        if (digest !== undefined && !/^[a-f0-9]{64}$/.test(digest))
          throw new Error('invalid_execution_configuration_digest');
      }
      return write(
        (ledger) => {
          checkEpoch(ledger, epoch);
          const semantic = { ...input } as Partial<typeof input>;
          delete semantic.request_id;
          delete semantic.idempotency_key;
          const binding = {
            action,
            owner: { identity: ledger.identity, epoch: ledger.epoch },
            request: semantic,
          };
          const payloadDigest = requestConfigurationDigest(binding);
          const existing = ledger.records.find((row) => row.key === input.idempotency_key);
          if (existing) {
            if (
              !existing.payloadDigest ||
              (configurationDigest !== undefined && !existing.configurationDigest)
            )
              throw new Error('request_identity_version_requires_reconciliation');
            if (existing.payloadDigest !== payloadDigest) throw new Error('request_conflict');
            if (
              expectedConfigurationDigest !== undefined &&
              existing.configurationDigest !== expectedConfigurationDigest
            )
              throw new Error('request_configuration_conflict');
            return { created: false, record: existing, ...view(ledger, existing) };
          }
          if (
            expectedConfigurationDigest !== undefined &&
            configurationDigest !== expectedConfigurationDigest
          )
            throw new Error('request_configuration_changed');
          if (ledger.records.length >= 2000) throw new Error('request_ledger_full');
          const digest = requestConfigurationDigest({
            ...binding,
            execution_configuration: configurationRef(configurationDigest),
          });
          const record: RequestRecord = {
            id: randomUUID().replaceAll('-', ''),
            key: input.idempotency_key,
            requestId: input.request_id,
            digest,
            payloadDigest,
            ...(configurationDigest ? { configurationDigest } : {}),
            state: 'admitted',
            reason: 'admitted_no_dispatch_intent',
            observedAt: new Date().toISOString(),
            expired: false,
            cancelRequested: false,
          };
          ledger.records.push(record);
          return { created: true, record, ...view(ledger, record) };
        },
        (result) => result.created,
      );
    },
    async dispatch(id: string, epoch: string) {
      return update(id, epoch, (record) => {
        if (record.state !== 'admitted' || record.expired)
          throw new Error('request_dispatch_already_claimed');
        record.state = 'unknown';
        record.reason = 'dispatch_may_have_started';
      });
    },
    async settle(id: string, epoch: string, state: Terminal, reason?: string) {
      return update(id, epoch, (record) => {
        if (record.state !== 'unknown' || record.expired)
          throw new Error('request_not_dispatching');
        record.state = state;
        record.reason =
          reason ??
          (state === 'complete' ? 'research_complete_result_memory_only' : 'research_' + state);
        if (record.cancelRequested) record.reason += '_after_cancel_request';
      });
    },
    async cancel(id: string, epoch: string) {
      return update(id, epoch, (record) => {
        if (record.state !== 'unknown') throw new Error('request_not_dispatching');
        record.cancelRequested = true;
        record.reason = 'cancel_requested_dispatch_may_have_started';
      });
    },
    async expire(id: string, epoch: string) {
      return update(id, epoch, (record) => {
        if (record.state === 'admitted' || record.state === 'unknown')
          throw new Error('unresolved_request_cannot_expire');
        record.expired = true;
      });
    },
  };
}
