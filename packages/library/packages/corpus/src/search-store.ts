import {
  mkdir,
  lstat,
  realpath,
  readFile,
  writeFile,
  rename,
  readdir,
  rm,
  unlink,
} from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  checkSuggestions,
  offeredPayload,
  suggestionSelectionPayload,
  rejectedSuggestionsSchema,
} from '../../domain/src/search-suggestions.js';
import { isDeepStrictEqual } from 'node:util';
import { validateGrounding } from '@pradeeptathineni/research-ai';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import {
  sourceTextSchema,
  supportedSourceText,
  sourceTextRank,
} from '../../domain/src/source-text.js';
import { format } from 'prettier';
import {
  candidateSchema,
  observationSchema,
  proposalSchema,
  indicators,
  attentionBound,
  type Entity,
  type SearchItem,
  type SearchResult,
} from '../../domain/src/search-contract.js';
import {
  assessEntity,
  saveDecision,
  personalSaveDecision,
  activeEvidenceIds,
} from '../../domain/src/search-score.js';
import {
  entityIdentity,
  observationIdentity,
  reconcileDiscoveryTrail,
  contextualizeResult,
} from './signal-search.js';
import { digest, normalizeText, normalizeSpan } from './search-fetch.js';
import { validateClaimReceipt } from './search-claim.js';
import { partialNoteSelection } from './search-note.js';
import { validateFollowupChild } from './search-followup.js';
import { normalizeConsiderUrl } from '../../domain/src/url.js';
import {
  signalBasisSchema,
  rubricIds,
  interpretationSchema,
  relevanceSchema,
} from '../../domain/src/search-assessment.js';
import { importedAnswers } from './research-receipts.js';
import { planResearchRetention } from './research-answer.js';

/** Read-only private state never creates directories and rejects every symlink component. */
export async function readPrivateJson(
  root: string,
  name: string,
  fallback: unknown,
  max = 2000000,
): Promise<unknown> {
  if (!/^[a-zA-Z0-9/_-]+\.json$/.test(name)) throw new Error('invalid_private_state_path');
  const path = resolve(root, '.signals', name);
  const stat = await lstat(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') throw e;
    return null;
  });
  if (!stat) return fallback;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max || (await realpath(path)) !== path)
    throw new Error('unsafe_private_state');
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

const feature = Type.Object(
  {
    value: Type.Number({ minimum: 0, maximum: 1 }),
    contribution: Type.Number({ minimum: 0, maximum: 40 }),
    observations: Type.Array(Type.String()),
    state: Type.Enum(['observed', 'unknown', 'not-applicable']),
  },
  { additionalProperties: false },
);
const properties = { ...candidateSchema.properties };
delete (properties as Partial<typeof properties>).match;
delete (properties as Partial<typeof properties>).discovery;
delete (properties as Partial<typeof properties>).priority;
delete (properties as Partial<typeof properties>).relevance;
delete (properties as Partial<typeof properties>).signalJudgment;
const entitySchema = Type.Object(
  {
    ...properties,
    signalBasis: Type.Optional(signalBasisSchema),
    currentChecks: Type.Optional(Type.Record(Type.String(), Type.String())),
    id: Type.String({ pattern: '^entity-[a-f0-9]{24}$' }),
    acquisition: Type.Optional(Type.Enum(['configured-live', 'native-agent', 'fixture'])),
    currentEvidence: Type.Optional(
      Type.Array(Type.String(), { maxItems: 1000, uniqueItems: true }),
    ),
    retainedDecisiveObservations: Type.Optional(
      Type.Array(Type.String(), { maxItems: 1000, uniqueItems: true }),
    ),
    observations: Type.Array(
      Type.Object(
        {
          ...observationSchema.properties,
          source: Type.Optional(observationSchema.properties.source),
          id: Type.String(),
          identityVersion: Type.Optional(Type.Literal(2)),
          basisId: Type.String(),
          supersedes: Type.Array(Type.String(), { maxItems: 1000 }),
          derivation: Type.Literal('model-assessment'),
          evidenceId: Type.String(),
          verified: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      { maxItems: 1000 },
    ),
    evidence: Type.Array(
      Type.Object(
        {
          ...proposalSchema.properties.sources.items.properties,
          id: Type.String(),
          fetchedAt: Type.String(),
          digest: Type.Union([Type.String(), Type.Null()]),
          excerptDigest: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
          normalizer: Type.Optional(sourceTextSchema),
          finalUri: Type.Optional(Type.String({ maxLength: 2048 })),
          extractor: Type.Optional(Type.String({ maxLength: 100 })),
          transport: Type.Optional(
            Type.Object(
              {
                etag: Type.Optional(
                  Type.String({ minLength: 1, maxLength: 4096, pattern: '^[^\\r\\n]+$' }),
                ),
                lastModified: Type.Optional(
                  Type.String({ minLength: 1, maxLength: 4096, pattern: '^[^\\r\\n]+$' }),
                ),
              },
              { additionalProperties: false, minProperties: 1 },
            ),
          ),
          state: Type.Enum(['fetched', 'failed', 'denied']),
          reason: Type.String(),
          excerpt: Type.String({ maxLength: 12000 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 1000 },
    ),
    assessment: Type.Object(
      {
        policy: Type.Enum([
          'signal-strength-v0',
          'signal-strength-v1',
          'signal-strength-v2',
          'signal-strength-v3',
          'signal-strength-v4',
          'signal-strength-v5',
          'signal-strength-v6',
          'signal-strength-v7',
          'signal-strength-v8',
          'signal-strength-v9',
          'signal-strength-v10',
        ]),
        asOf: Type.String(),
        score: Type.Union([Type.Integer({ minimum: 0, maximum: 100 }), Type.Null()]),
        features: Type.Union([
          Type.Object(
            {
              corroboration: feature,
              adoption: feature,
              maturity: feature,
              currentness: feature,
              authority: feature,
              verification: feature,
            },
            { additionalProperties: false },
          ),
          Type.Object(
            { basis: feature, work: feature, scrutiny: feature, applicability: feature },
            { additionalProperties: false },
          ),
        ]),
        risk: Type.Integer({ minimum: 0, maximum: 25 }),
        coverage: Type.Number({ minimum: 0, maximum: 1 }),
        missing: Type.Array(Type.String()),
        state: Type.Enum(['assessed', 'provisional', 'unassessed']),
        rubric: Type.Optional(Type.Union([Type.Enum(rubricIds), Type.Null()])),
        disposition: Type.Optional(Type.Enum(['completed', 'provisional', 'not-scoreable'])),
        reasons: Type.Optional(Type.Array(Type.String({ maxLength: 1600 }), { maxItems: 40 })),
        nextVerification: Type.Optional(
          Type.Union([Type.String({ maxLength: 1600 }), Type.Null()]),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const privatePattern =
  /(?:\/Users\/|\/home\/|file:\/\/|-----BEGIN .*PRIVATE KEY|\b(?:gh[pousr]_|github_pat_|sk-proj-)[A-Za-z0-9_-]{10,}|\b(?:password|api[_-]?key|secret|token)\s*[=:]\s*\S+)/i;
export function validateEntity(input: unknown): Entity {
  const entity = validateRetainedEntity(input);
  if (privatePattern.test(JSON.stringify(entity))) throw new Error('private_entity_bytes');
  return entity;
}
function validateRetainedEntity(input: unknown): Entity {
  if (!Value.Check(entitySchema, input)) throw new Error('invalid_entity_schema');
  const entity = input as unknown as Entity;
  if (entity.id !== entityIdentity(entity.uri)) throw new Error('invalid_entity_identity');
  const evidence = new Map(entity.evidence.map((source) => [source.id, source]));
  if (
    entity.currentEvidence &&
    (entity.currentEvidence.some((id) => evidence.get(id)?.state !== 'fetched') ||
      new Set(entity.currentEvidence.map((id) => evidence.get(id)!.uri)).size !==
        entity.currentEvidence.length)
  )
    throw new Error('invalid_current_evidence');
  if (
    evidence.size !== entity.evidence.length ||
    new Set(entity.observations.map((item) => item.id)).size !== entity.observations.length
  )
    throw new Error('duplicate_entity_evidence');
  entity.evidence.forEach((source) => {
    normalizeConsiderUrl(source.uri);
    if (
      !Number.isFinite(Date.parse(source.fetchedAt)) ||
      (source.publishedAt && !Number.isFinite(Date.parse(source.publishedAt)))
    )
      throw new Error('invalid_evidence_date');
  });
  if (entity.observations.some((item) => !evidence.has(item.evidenceId)))
    throw new Error('unbound_entity_evidence');
  for (const source of entity.evidence) {
    const canonical = normalizeConsiderUrl(source.uri).normalizedUrl;
    const basis = source.digest
      ? `${canonical}:${source.digest}${source.excerptDigest ? `:${source.excerptDigest}` : ''}${source.normalizer ? `:${source.normalizer}` : ''}`
      : canonical;
    const expected = `evidence-${digest(basis).slice(0, 24)}`;
    if (
      source.id !== expected ||
      (source.excerptDigest && source.excerptDigest !== digest(source.excerpt)) ||
      (source.state === 'fetched' && !/^[a-f0-9]{64}$/.test(source.digest ?? ''))
    )
      throw new Error('forged_evidence_identity');
  }
  for (const observation of entity.observations) {
    if (
      !Object.entries(indicators).some(
        ([feature, values]) =>
          feature === observation.feature &&
          (values as readonly string[]).includes(observation.indicator),
      )
    )
      throw new Error('invalid_observation_indicator');
    const source = evidence.get(observation.evidenceId)!;
    if (!attentionBound(observation)) throw new Error('unbound_attention_count');
    const normalize = supportedSourceText(source.normalizer) ? normalizeSpan : normalizeText;
    const quote = normalize(observation.quote);
    const rawIdentity = source.excerptDigest
      ? `evidence-${digest(`${normalizeConsiderUrl(source.uri).normalizedUrl}:${source.digest}${source.normalizer ? `:${source.normalizer}` : ''}`).slice(0, 24)}`
      : source.id;
    const identities = [
      observationIdentity(entity.id, observation.evidenceId, observation),
      observationIdentity(entity.id, observation.evidenceId, observation, rawIdentity),
      observationIdentity(entity.id, observation.evidenceId, observation, rawIdentity, true),
    ];
    // Early native projections used their projection ID as the basis. Keep that exact decode.
    if (
      !identities.some(
        (identity) => identity.id === observation.id && identity.basisId === observation.basisId,
      )
    )
      throw new Error('forged_observation_identity');
    if (
      observation.supersedes.some(
        (id) =>
          !entity.observations.some(
            (old) => old.id === id && old.basisId === observation.basisId,
          ) || id === observation.id,
      )
    )
      throw new Error('invalid_supersession');
    if (
      observation.verified &&
      (source.state !== 'fetched' ||
        !source.digest ||
        quote.length < 8 ||
        !normalize(source.excerpt).toLowerCase().includes(quote.toLowerCase()))
    )
      throw new Error('forged_span_verification');
  }
  const visit = (id: string, ancestors = new Set<string>()) => {
    if (ancestors.has(id)) throw new Error('supersession_cycle');
    const next = new Set([...ancestors, id]);
    for (const parent of entity.observations.find((item) => item.id === id)!.supersedes)
      visit(parent, next);
  };
  entity.observations.forEach((item) => visit(item.id));
  for (const [uri, checkedAt] of Object.entries(entity.currentChecks ?? {})) {
    if (
      !entity.evidence.some((source) => source.uri === uri && source.state === 'fetched') ||
      !Number.isFinite(Date.parse(checkedAt)) ||
      Date.parse(checkedAt) > Date.parse(entity.assessment.asOf)
    )
      throw new Error('invalid_current_check');
  }
  if (
    entity.signalBasis?.originInspections?.some(
      (inspection) => !entity.evidence.some((source) => source.id === inspection.source),
    )
  )
    throw new Error('unbound_origin_inspection');
  if (
    entity.signalBasis?.retainedDecisiveObservations?.some(
      (id) => !entity.observations.some((item) => item.id === id),
    )
  )
    throw new Error('unbound_retained_decisive_observation');
  if (
    entity.retainedDecisiveObservations?.some(
      (id) => !entity.observations.some((item) => item.id === id),
    )
  )
    throw new Error('unbound_retained_decisive_observation');
  if (
    !isDeepStrictEqual(
      assessEntity(entity, entity.assessment.asOf, entity.assessment.policy),
      entity.assessment,
    )
  )
    throw new Error('score_tampering');
  return entity;
}

export async function secureDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if ((await lstat(path)).isSymbolicLink() || (await realpath(path)) !== resolve(path))
    throw new Error('symlink_storage');
}
export async function atomicJson(path: string, value: unknown, publicFormat = false) {
  await secureDirectory(dirname(path));
  const existing = await lstat(path).catch(() => null);
  if (existing?.isSymbolicLink()) throw new Error('symlink_file');
  const temporary = join(dirname(path), `.pending-${randomUUID()}`);
  const bytes = publicFormat
    ? await format(JSON.stringify(value), { parser: 'json', printWidth: 100 })
    : `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try {
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
export async function withWriter<T>(root: string, operation: () => Promise<T>) {
  const folder = resolve(root, '.signals/locks');
  await secureDirectory(folder);
  const path = join(folder, 'search-writer.json');
  try {
    await writeFile(path, JSON.stringify({ pid: process.pid, started: Date.now() }), {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure;
    const owner = JSON.parse(await readFile(path, 'utf8')) as { pid: number; started: number };
    let alive = true;
    try {
      process.kill(owner.pid, 0);
    } catch {
      alive = false;
    }
    if (alive) throw new Error('writer_busy', { cause: failure });
    const recovery = `${path}.recovery`;
    try {
      await mkdir(recovery);
    } catch (recoveryFailure) {
      throw new Error('writer_busy', { cause: recoveryFailure });
    }
    try {
      const current = JSON.parse(await readFile(path, 'utf8')) as { pid: number; started: number };
      if (current.pid !== owner.pid || current.started !== owner.started)
        throw new Error('writer_busy', { cause: failure });
      await unlink(path);
      return await withWriter(root, operation);
    } finally {
      await rm(recovery, { recursive: true, force: true });
    }
  }
  try {
    return await operation();
  } finally {
    await unlink(path);
  }
}
export interface StoredEntity {
  recordVersion: 2;
  entity: Entity;
  state: 'user-saved' | 'eligible-saved';
}
export interface SelectionProvenance {
  runId: string;
  query: string;
  kind: 'one-off' | 'query-discovery' | 'corpus-refresh';
  queryId?: string;
  concepts?: string[];
  needDigest?: string;
}
export async function selectionHistory(root = process.cwd()) {
  const path = resolve(root, '.signals/selections.json');
  const stat = await lstat(path).catch((failure) => {
    if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure;
    return null;
  });
  if (stat && (stat.isSymbolicLink() || stat.size > 5000000 || (await realpath(path)) !== path))
    throw new Error('unsafe_selection_history');
  const rows = JSON.parse(
    await readFile(path, 'utf8').catch((failure) => {
      if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure;
      return '[]';
    }),
  ) as (SelectionProvenance & {
    id: string;
    at: string;
    mode: string;
    destination: string;
    selected: string[];
    changed: string[];
    skipped: string[];
  })[];
  if (!Array.isArray(rows)) throw new Error('invalid_selection_history');
  return rows;
}
export async function loadEntities(root = resolve('signals/entities')): Promise<StoredEntity[]> {
  const stat = await lstat(root).catch(() => null);
  if (!stat) return [];
  await secureDirectory(root);
  const records: StoredEntity[] = [];
  for (const name of (await readdir(root)).sort()) {
    if (!/^entity-[a-f0-9]{24}\.json$/.test(name)) throw new Error('unexpected_entity_file');
    const path = join(root, name);
    if ((await lstat(path)).isSymbolicLink()) throw new Error('symlink_entity');
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Object.keys(parsed).sort().join(',') !== 'entity,recordVersion,state'
    )
      throw new Error('invalid_entity_record');
    const record = parsed as StoredEntity;
    if (record.recordVersion !== 2 || !['user-saved', 'eligible-saved'].includes(record.state))
      throw new Error('invalid_entity_record');
    validateEntity(record.entity);
    if (name !== `${record.entity.id}.json`) throw new Error('entity_filename_identity');
    records.push(record);
  }
  return records;
}
function mergeEntity(prior: Entity, incoming: Entity): Entity {
  if (prior.id !== incoming.id) throw new Error('identity_merge_conflict');
  const newer = Date.parse(incoming.assessment.asOf) >= Date.parse(prior.assessment.asOf);
  const asOf = newer ? incoming.assessment.asOf : prior.assessment.asOf;
  const policy = newer ? incoming.assessment.policy : prior.assessment.policy;
  const current = new Map(
    [...activeEvidenceIds(prior)].map((id) => [
      prior.evidence.find((source) => source.id === id)!.uri,
      id,
    ]),
  );
  const currentChecks = {
    ...Object.fromEntries(
      [...activeEvidenceIds(prior)].map((id) => {
        const source = prior.evidence.find((source) => source.id === id)!;
        return [source.uri, source.fetchedAt];
      }),
    ),
    ...prior.currentChecks,
  };
  const priorSelected = new Map(
    [...activeEvidenceIds(prior)].map((id) => {
      const source = prior.evidence.find((source) => source.id === id)!;
      return [source.uri, source];
    }),
  );
  for (const id of activeEvidenceIds(incoming)) {
    const source = incoming.evidence.find((source) => source.id === id)!;
    const checkedAt = incoming.currentChecks?.[source.uri] ?? source.fetchedAt;
    const selected = priorSelected.get(source.uri);
    // Retained results remain replayable, but cannot rewind the canonical receipt or decoder.
    if (
      selected &&
      ((sourceTextRank(source.normalizer) < sourceTextRank(selected.normalizer) &&
        (!supportedSourceText(source.normalizer) || source.digest === selected.digest)) ||
        Date.parse(checkedAt) < Date.parse(currentChecks[source.uri]!))
    )
      continue;
    current.set(source.uri, id);
    currentChecks[source.uri] = checkedAt;
  }
  const currentEvidence = [...current.values()].sort();
  const sameEvidence = incoming.evidence.every((source) =>
    prior.evidence.some((old) => old.id === source.id),
  );
  const sameObservations = incoming.observations.every((observation) =>
    prior.observations.some((old) => old.id === observation.id),
  );
  if (
    sameEvidence &&
    sameObservations &&
    isDeepStrictEqual([...activeEvidenceIds(prior)].sort(), currentEvidence) &&
    prior.kind === incoming.kind &&
    isDeepStrictEqual(prior.signalBasis, incoming.signalBasis) &&
    isDeepStrictEqual(prior.retainedDecisiveObservations, incoming.retainedDecisiveObservations) &&
    isDeepStrictEqual(prior.inspection, incoming.inspection) &&
    incoming.aliases.every((alias) => prior.aliases.includes(alias))
  ) {
    const renewed = { ...prior, currentChecks };
    const assessment = assessEntity(renewed, asOf, policy);
    const beforeCheck = assessEntity(prior, asOf, policy);
    if (
      assessment.policy === prior.assessment.policy &&
      assessment.score === prior.assessment.score &&
      isDeepStrictEqual(assessment.features, prior.assessment.features) &&
      isDeepStrictEqual(assessment.features, beforeCheck.features)
    )
      return prior;
    return { ...renewed, assessment };
  }
  const evidence = [
    ...new Map([...incoming.evidence, ...prior.evidence].map((item) => [item.id, item])).values(),
  ].sort((a, b) => a.id.localeCompare(b.id));
  const superseded = new Set(prior.observations.flatMap((item) => item.supersedes));
  const judgment = (item: Entity['observations'][number]) =>
    [
      item.indicator,
      item.status,
      item.independent,
      item.origin.trim().toLowerCase(),
      item.attention?.metric ?? '',
      item.attention?.value ?? '',
      normalizeSpan(item.statement).toLowerCase(),
    ].join(':');
  const successors = incoming.observations
    .filter((observation) => {
      const history = prior.observations.filter((old) => old.basisId === observation.basisId);
      const latest = history.filter((old) => !superseded.has(old.id));
      return (
        !history.some((old) => judgment(old) === judgment(observation)) ||
        !latest.length ||
        latest.some((old) => judgment(old) === judgment(observation))
      );
    })
    .map(
      (observation) =>
        prior.observations.find((old) => old.id === observation.id) ?? {
          ...observation,
          supersedes: [
            ...new Set([
              ...observation.supersedes,
              ...prior.observations
                .filter(
                  (old) =>
                    !superseded.has(old.id) &&
                    old.basisId === observation.basisId &&
                    old.id !== observation.id,
                )
                .map((old) => old.id),
            ]),
          ],
        },
    );
  const observations = [
    ...new Map([...prior.observations, ...successors].map((item) => [item.id, item])).values(),
  ].sort((a, b) => a.id.localeCompare(b.id));
  const merged = {
    ...incoming,
    ...(incoming.signalBasis ? { signalBasis: structuredClone(incoming.signalBasis) } : {}),
    aliases: [...new Set([...prior.aliases, ...incoming.aliases])].sort(),
    evidence,
    observations,
    currentEvidence,
    currentChecks,
  };
  merged.retainedDecisiveObservations = [
    ...new Set([
      ...(prior.retainedDecisiveObservations ?? []),
      ...(incoming.retainedDecisiveObservations ?? []),
      ...(prior.signalBasis?.retainedDecisiveObservations ?? []),
      ...(merged.signalBasis?.retainedDecisiveObservations ?? []),
      ...['basis', 'work', 'applicability'].flatMap(
        (name) => prior.signalBasis?.dimensions[name as 'basis'].observations ?? [],
      ),
    ]),
  ].sort();
  if (merged.signalBasis)
    merged.signalBasis.retainedDecisiveObservations = [...merged.retainedDecisiveObservations];
  merged.assessment = assessEntity(merged, asOf, policy);
  if (
    prior.assessment.policy === merged.assessment.policy &&
    prior.assessment.score === merged.assessment.score &&
    isDeepStrictEqual(prior.assessment.features, merged.assessment.features) &&
    Object.values(currentChecks).every(
      (date) => Date.parse(date) <= Date.parse(prior.assessment.asOf),
    )
  )
    merged.assessment.asOf = prior.assessment.asOf;
  return merged;
}
export async function saveEntities(
  items: SearchItem[],
  mode: 'manual' | 'eligible' | 'refresh',
  root = process.cwd(),
  destination: 'public' | 'private' = 'public',
  threshold = 75,
  allowFixtures = false,
  provenance?: SelectionProvenance,
) {
  return withWriter(root, async () => {
    if (
      provenance &&
      (!/^[a-f0-9-]{36}$/.test(provenance.runId) ||
        provenance.query.length > 2000 ||
        (provenance.needDigest !== undefined && !/^[a-f0-9]{64}$/.test(provenance.needDigest)) ||
        !['one-off', 'query-discovery', 'corpus-refresh'].includes(provenance.kind))
    )
      throw new Error('invalid_selection_provenance');
    const directory = resolve(
      root,
      destination === 'public' ? 'signals/entities' : '.signals/corpus/entities',
    );
    const existing = new Map(
      (await loadEntities(directory)).map((record) => [record.entity.id, record]),
    );
    const dismissed = JSON.parse(
      await readFile(resolve(root, '.signals/dismissed.json'), 'utf8').catch(() => '[]'),
    ) as string[];
    const changes: string[] = [],
      skipped: string[] = [];
    const reasons: Record<string, string[]> = {};
    const admission = (item: SearchItem, entity = item.entity) =>
      destination === 'private'
        ? personalSaveDecision(entity, item.match, item.relevance, threshold)
        : saveDecision(entity, item.match, threshold);
    items
      .filter((item) =>
        mode === 'eligible'
          ? admission(item).eligible && !dismissed.includes(item.entity.id)
          : mode !== 'refresh' || existing.has(item.entity.id),
      )
      .forEach((item) => validateEntity(item.entity));
    for (const item of items) {
      if (
        (mode === 'eligible' &&
          (!admission(item).eligible || dismissed.includes(item.entity.id))) ||
        (mode === 'refresh' && !existing.has(item.entity.id))
      ) {
        skipped.push(item.entity.id);
        reasons[item.entity.id] =
          mode === 'eligible' ? admission(item).reasons : ['not_saved_in_destination'];
        continue;
      }
      if (item.entity.acquisition === 'fixture' && !allowFixtures)
        throw new Error('fixture_cannot_enter_corpus');
      if (
        !(mode === 'manual' && destination === 'private') &&
        (item.entity.identity !== 'resolved' ||
          (item.entity.assessment.score === null &&
            !(
              mode === 'refresh' &&
              item.entity.observations.some((observation) => observation.verified)
            )))
      ) {
        skipped.push(item.entity.id);
        reasons[item.entity.id] = ['unsavable_identity_or_evidence'];
        continue;
      }
      const prior = existing.get(item.entity.id);
      const uriAliases = new Set([
        item.entity.uri,
        ...item.entity.aliases.filter((alias) => alias.startsWith('https://')),
      ]);
      if (
        [...existing.values()].some(
          (record) =>
            record.entity.id !== item.entity.id &&
            [record.entity.uri, ...record.entity.aliases].some((alias) => uriAliases.has(alias)),
        )
      )
        throw new Error('ambiguous_identity_alias');
      const entity = prior
        ? mergeEntity(prior.entity, item.entity)
        : {
            ...item.entity,
            aliases: [...item.entity.aliases].sort(),
            evidence: [...item.entity.evidence].sort((a, b) => a.id.localeCompare(b.id)),
            observations: [...item.entity.observations].sort((a, b) => a.id.localeCompare(b.id)),
          };
      entity.assessment = assessEntity(entity, entity.assessment.asOf, entity.assessment.policy);
      validateEntity(entity);
      if (mode === 'eligible' && !admission(item, entity).eligible) {
        skipped.push(entity.id);
        reasons[entity.id] = admission(item, entity).reasons;
        continue;
      }
      const record: StoredEntity = {
        recordVersion: 2,
        entity,
        state: prior?.state ?? (mode === 'manual' ? 'user-saved' : 'eligible-saved'),
      };
      if (JSON.stringify(prior) !== JSON.stringify(record)) {
        await atomicJson(join(directory, `${entity.id}.json`), record, destination === 'public');
        changes.push(entity.id);
        existing.set(entity.id, record);
      }
    }
    if (provenance) {
      if (!/^[a-f0-9-]{36}$/.test(provenance.runId) || provenance.query.length > 2000)
        throw new Error('invalid_selection_provenance');
      const selected = items.map((item) => item.entity.id).sort();
      // Historical IDs remain intact; distinct interest scopes receive successor receipts.
      const id = provenance.queryId
        ? digest(
            JSON.stringify([
              'selection-interest-v2',
              provenance.runId,
              mode,
              destination,
              selected,
              provenance.queryId,
              provenance.query,
              provenance.concepts ?? [],
              provenance.needDigest ?? null,
            ]),
          )
        : digest(`${provenance.runId}:${mode}:${destination}:${selected.join(',')}`);
      const history = await selectionHistory(root);
      if (!history.some((row) => row.id === id))
        await atomicJson(resolve(root, '.signals/selections.json'), [
          ...history,
          {
            ...provenance,
            id,
            at: new Date().toISOString(),
            mode,
            destination,
            selected,
            changed: changes,
            skipped,
          },
        ]);
    }
    return {
      changed: changes,
      skipped,
      reasons,
      atomicity:
        'Each entity is atomic; a batch can partially complete and retries merge idempotently.',
    };
  });
}
async function validateRunSuggestions(result: SearchResult, root: string, ancestors?: Set<string>) {
  if (result.rejectedCheckSuggestions !== undefined) {
    const rejected = result.rejectedCheckSuggestions;
    const diagnostic = rejected.diagnostic;
    if (
      !Value.Check(rejectedSuggestionsSchema, rejected) ||
      result.checkSuggestions !== undefined ||
      result.claimCheck ||
      !result.answerReceipt ||
      rejected.answerDigest !== result.answerReceipt.sha256 ||
      rejected.answerDigest !== digest(result.brief?.text ?? '') ||
      (rejected.presence === 'serializable') !== (diagnostic !== undefined) ||
      (diagnostic &&
        (!diagnostic.captureComplete ||
          Buffer.byteLength(diagnostic.text) > 32768 ||
          diagnostic.capturedBytes !==
            Buffer.byteLength(diagnostic.text) + diagnostic.omittedBytes ||
          (!diagnostic.omittedBytes && digest(diagnostic.text) !== diagnostic.capturedDigest)))
    )
      throw new Error('invalid_suggestion_rejection');
  }
  if (result.checkSuggestions !== undefined) {
    if (
      !result.answerReceipt ||
      result.claimCheck ||
      result.answerReceipt.sha256 !== digest(result.brief?.text ?? '')
    )
      throw new Error('suggestions_require_answer');
    const plan = planResearchRetention({
      query: result.query,
      answer: result.brief?.text ?? '',
      observedAt: result.answerReceipt.observedAt,
      provenance: result.answerReceipt.provenance,
    });
    checkSuggestions(
      result.checkSuggestions,
      digest(result.brief?.text ?? ''),
      plan.citations
        .map((citation) => citation.uri)
        .filter((uri) => result.provisionalLeads?.some((lead) => lead.uri === uri)),
    );
    if (
      result.checkSuggestions.offeredDigest !==
      digest(offeredPayload(result.checkSuggestions.offered))
    )
      throw new Error('invalid_offered_digest');
  }
  if (result.suggestionIndex !== undefined) {
    if (
      !Number.isInteger(result.suggestionIndex) ||
      result.suggestionIndex < 0 ||
      result.suggestionIndex > 2 ||
      result.claimCheck?.version !== 1 ||
      !result.assessmentOf
    )
      throw new Error('invalid_suggestion_selection');
    const parent = await loadRun(result.assessmentOf, root, 75, ancestors);
    if (!parent.checkSuggestions?.offered[result.suggestionIndex])
      throw new Error('unknown_check_suggestion');
    if (
      result.suggestionDigest !==
      digest(
        suggestionSelectionPayload(
          parent.runId,
          parent.answerReceipt!.sha256,
          parent.checkSuggestions.offeredDigest,
          result.suggestionIndex,
        ),
      )
    )
      throw new Error('invalid_suggestion_digest');
  }
  if (result.suggestionDigest !== undefined && result.suggestionIndex === undefined)
    throw new Error('invalid_suggestion_selection');
}
export async function retainRun(result: SearchResult, root = process.cwd()) {
  if (result.grounding !== undefined) validateGrounding(result.brief?.text ?? '', result.grounding);
  await validateRunSuggestions(result, root);
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(result.runId))
    throw new Error('invalid_run_identity');
  if (result.claimCheck?.version === 3 || result.claimCheck?.version === 4)
    validateClaimReceipt(result);
  const path = resolve(root, '.signals/runs', `${result.runId}.json`);
  const stat = await lstat(path).catch((failure: NodeJS.ErrnoException) => {
    if (failure.code !== 'ENOENT') throw failure;
    return null;
  });
  if (
    stat &&
    (!stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 2000000 ||
      (await realpath(path)) !== path)
  )
    throw new Error('unsafe_run_snapshot');
  const prior = await readFile(path, 'utf8').catch((failure: NodeJS.ErrnoException) => {
    if (failure.code !== 'ENOENT') throw failure;
    return null;
  });
  const bytes = `${JSON.stringify(result, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > 2000000) throw new Error('run_snapshot_size');
  if (prior !== null) {
    if (prior !== bytes) throw new Error('immutable_run_conflict');
    return;
  }
  await atomicJson(path, result);
}
export async function loadRun(
  runId: string,
  root = process.cwd(),
  threshold = 75,
  ancestors = new Set<string>(),
): Promise<SearchResult> {
  if (ancestors.has(runId) || ancestors.size >= 16) throw new Error('cyclic_run_reference');
  const lineage = new Set([...ancestors, runId]);
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error('invalid_run_identity');
  const path = resolve(root, '.signals/runs', `${runId}.json`);
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!stat) {
    const imported = (await importedAnswers(root)).filter((answer) => answer.runId === runId);
    if (imported.length !== 1) throw new Error('unknown_retained_run');
    return imported[0]!;
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 2000000 ||
    (await realpath(path)) !== path
  )
    throw new Error('unsafe_run_snapshot');
  const result = JSON.parse(await readFile(path, 'utf8')) as SearchResult;
  if (
    result.schemaVersion !== 2 ||
    result.runId !== runId ||
    typeof result.query !== 'string' ||
    !Array.isArray(result.items) ||
    result.items.length > 60
  )
    throw new Error('invalid_run_snapshot');
  if (result.interpretation && !Value.Check(interpretationSchema, result.interpretation))
    throw new Error('invalid_run_interpretation');
  if (
    result.assessmentOf &&
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(result.assessmentOf)
  )
    throw new Error('invalid_assessment_parent');
  if (result.assessmentTargets) {
    if (
      (!result.assessmentOf &&
        result.claimCheck?.version !== 2 &&
        result.claimCheck?.version !== 4) ||
      !Array.isArray(result.assessmentTargets) ||
      result.assessmentTargets.length > 10
    )
      throw new Error('invalid_assessment_targets');
    for (const uri of result.assessmentTargets) normalizeConsiderUrl(uri);
  }
  if (
    result.brief &&
    (result.brief.format !== 'markdown' ||
      typeof result.brief.text !== 'string' ||
      result.brief.text.length > (result.answerReceipt ? 100000 : 24000))
  )
    throw new Error('invalid_run_brief');
  if (result.grounding !== undefined) validateGrounding(result.brief?.text ?? '', result.grounding);
  if (result.answerReceipt) {
    const receipt = result.answerReceipt;
    if (
      !result.brief?.text.trim() ||
      receipt.state !== 'unassessed' ||
      receipt.confidence !== 'unknown' ||
      (receipt.context !== undefined &&
        (typeof receipt.context !== 'string' || receipt.context.length > 4000)) ||
      !Number.isFinite(Date.parse(receipt.observedAt)) ||
      receipt.sha256 !== digest(result.brief.text) ||
      typeof receipt.provenance?.receipt !== 'string' ||
      ![receipt.provenance.requestedModel, receipt.provenance.servedModel].every(
        (model) => model === null || typeof model === 'string',
      )
    )
      throw new Error('invalid_answer_receipt');
  }
  // The copied closure is self-contained: a missing or changed parent never invalidates it.
  if (result.followupOf !== undefined) validateFollowupChild(result);
  await validateRunSuggestions(result, root, lineage);
  if (result.claimCheck) {
    const receipt = validateClaimReceipt(result);
    if (receipt.version === 1) {
      const parent = await loadRun(receipt.parentRunId, root, threshold, lineage);
      if (
        !parent.answerReceipt ||
        parent.answerReceipt.sha256 !== receipt.parentAnswerDigest ||
        parent.query !== receipt.originalNeed ||
        (parent.answerReceipt.context ?? '') !== receipt.originalContext ||
        result.assessmentTargets!.some(
          (uri) => !parent.provisionalLeads?.some((lead) => lead.uri === uri),
        )
      )
        throw new Error('invalid_claim_parent');
    }
    if (receipt.version === 3) {
      let parent: SearchResult | null;
      try {
        parent = await loadRun(receipt.origin.parentRunId, root, threshold, lineage);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'unknown_retained_run') throw error;
        parent = null;
      }
      if (
        parent &&
        partialNoteSelection(parent).parentSnapshotDigest !== receipt.origin.parentSnapshotDigest
      )
        throw new Error('invalid_partial_claim_parent');
    }
  }
  if (
    result.provisionalLeads &&
    (!Array.isArray(result.provisionalLeads) ||
      result.provisionalLeads.length > 60 ||
      result.provisionalLeads.some(
        (lead) =>
          typeof lead.name !== 'string' ||
          typeof lead.uri !== 'string' ||
          typeof lead.description !== 'string' ||
          !Array.isArray(lead.limits) ||
          lead.limits.some((limit) => typeof limit !== 'string'),
      ))
  )
    throw new Error('invalid_run_leads');
  for (const item of result.items) {
    if (
      item.relevance &&
      (!Value.Check(relevanceSchema, item.relevance) ||
        [
          ...item.relevance.sources,
          ...item.relevance.constraints.flatMap((constraint) => constraint.sources),
        ].some((index) => !result.sources[index]))
    )
      throw new Error('invalid_run_relevance');
    const checks = Object.entries(item.entity.currentChecks ?? {});
    const late = checks.filter(
      ([, date]) => Date.parse(date) > Date.parse(item.entity.assessment.asOf),
    );
    if (late.length) {
      if (
        late.some(
          ([uri, date]) =>
            Date.parse(date) > Date.now() ||
            !item.entity.evidence.some(
              (source) =>
                source.uri === uri && source.state === 'fetched' && source.fetchedAt === date,
            ),
        )
      )
        throw new Error('invalid_current_check');
      item.entity.assessment.asOf = new Date(
        Math.max(...late.map(([, date]) => Date.parse(date))),
      ).toISOString();
      result.gaps.push(
        'Historical acquisition completed after its original assessment cutoff; replay uses the bound actual fetch cutoff without rewriting the retained snapshot.',
      );
    }
    // Replay the development policy without rewriting the retained run bytes.
    item.entity.assessment = assessEntity(
      item.entity,
      item.entity.assessment.asOf,
      item.entity.assessment.policy,
    );
    validateRetainedEntity(item.entity);
    Object.assign(item, saveDecision(item.entity, item.match, threshold));
    // Only kernel-bound provenance can validate historical configuration or a seed.
    // Today's followed sources cannot establish how an earlier run acquired an item.
    const trail = item.discovery;
    item.discovery = reconcileDiscoveryTrail(
      { ...item.entity, discovery: trail },
      {
        query: result.query,
        ...(trail?.provenanceBasis === 'request-seed' ? { captureUrls: [item.entity.uri] } : {}),
      },
      trail?.linkVerified ?? false,
      trail?.provenanceBasis === 'configured-source' && trail.parentUri ? [trail.parentUri] : [],
      result.gaps,
    );
  }
  return await contextualizeResult(result, root);
}
export async function runHistory(root = process.cwd()) {
  const directory = resolve(root, '.signals/runs');
  const entries = [];
  for (const name of await readdir(directory).catch(() => [])) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const stat = await lstat(join(directory, name));
    if (!stat.isSymbolicLink()) entries.push({ name, date: stat.mtimeMs });
  }
  const history = await Promise.all(
    entries
      .sort((a, b) => b.date - a.date)
      .slice(0, 30)
      .map(async (entry) => {
        const run = await loadRun(entry.name.slice(0, -5), root).catch((failure: unknown) => ({
          runId: entry.name.slice(0, -5),
          query: 'Unavailable retained result',
          status: 'failed',
          items: [],
          error: failure instanceof Error ? failure.message : 'invalid_run_snapshot',
        }));
        return {
          runId: run.runId,
          query: run.query,
          status: run.status,
          candidates: run.items.length,
        };
      }),
  );
  const answers = (await importedAnswers(root)).map((run) => ({
    runId: run.runId,
    query: run.query,
    status: run.status,
    candidates: 0,
  }));
  return [...history, ...answers];
}
export async function cleanRuns(root = process.cwd(), days = 7) {
  const directory = resolve(root, '.signals/runs');
  // A retained note is history even after its bookmark is removed.
  const collection = await readPrivateJson(root, 'library-state.json', null).catch(() => 'invalid');
  const retainedNotes =
    collection === null
      ? new Set<string>()
      : collection &&
          typeof collection === 'object' &&
          'version' in collection &&
          collection.version === 1 &&
          'collection' in collection &&
          collection.collection &&
          typeof collection.collection === 'object' &&
          !Array.isArray(collection.collection)
        ? new Set(
            Object.keys(collection.collection).filter((key) => key.startsWith('note:private:')),
          )
        : null;
  for (const name of await readdir(directory).catch(() => [])) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const path = join(directory, name);
    const stat = await lstat(path);
    if (!stat.isSymbolicLink() && stat.mtimeMs < Date.now() - days * 86400000) {
      const run = await loadRun(name.slice(0, -5), root);
      if (
        !run.answerReceipt &&
        !run.assessmentOf &&
        !run.claimCheck &&
        retainedNotes !== null &&
        !retainedNotes.has(`note:private:${run.runId}`)
      )
        await rm(path);
    }
  }
  const acquisitions = resolve(root, '.signals/acquisitions');
  for (const name of await readdir(acquisitions).catch(() => [])) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const path = join(acquisitions, name);
    const stat = await lstat(path);
    if (!stat.isSymbolicLink() && stat.mtimeMs < Date.now() - days * 86400000) await rm(path);
  }
  const cache = resolve(root, '.signals/source-cache');
  for (const name of await readdir(cache).catch(() => [])) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const path = join(cache, name);
    const stat = await lstat(path);
    if (!stat.isSymbolicLink() && stat.mtimeMs < Date.now() - days * 86400000) await rm(path);
  }
}
