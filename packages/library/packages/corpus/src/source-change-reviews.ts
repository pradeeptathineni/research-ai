import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { atomicJson, withWriter } from './search-store.js';
import { openSourceCapture, type RecordRef } from './source-captures.js';
import { exactOwnerRecord } from './provider-capabilities.js';

const closed = { additionalProperties: false };
const uuid = Type.String({ pattern: '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$' });
const digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const refSchema = Type.Object(
  {
    owner: Type.Literal('signals-ai'),
    kind: Type.String({ minLength: 1, maxLength: 40 }),
    id: Type.String({ minLength: 1, maxLength: 200 }),
    revision: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
    digest,
  },
  closed,
);
const assertionSchema = Type.Object(
  {
    entity_ref: refSchema,
    observation_id: Type.String({ minLength: 1, maxLength: 200 }),
    currentness: Type.Enum(['current', 'needs-review']),
    decision: Type.Enum(['retain', 'revise']),
    revised_status: Type.Optional(Type.Enum(['supported', 'contradicted', 'uncertain'])),
    rationale: Type.String({ minLength: 1, maxLength: 1600 }),
  },
  closed,
);
const requestSchema = Type.Object(
  {
    request_id: uuid,
    prior_capture_ref: refSchema,
    new_capture_ref: refSchema,
    meaningfulness: Type.Enum(['unchanged', 'meaningful', 'not-meaningful', 'uncertain']),
    change_rationale: Type.String({ minLength: 1, maxLength: 1600 }),
    assertions: Type.Array(assertionSchema, { minItems: 1, maxItems: 40 }),
  },
  closed,
);
type Request = Static<typeof requestSchema>;
type Assertion = Static<typeof assertionSchema>;

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => JSON.stringify(key) + ':' + canonical(child))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
};

export class SourceChangeReviewError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly reason: string,
  ) {
    super(code);
  }
}
const fail = (status: number, code: string, reason: string): never => {
  throw new SourceChangeReviewError(status, code, reason);
};
const invalid = (
  reason = 'Supply a closed review request with exact version and assertion references.',
) => fail(400, 'invalid_source_change_review', reason);
const changed = (
  reason = 'An exact selected input changed. Resolve its current reference explicitly.',
) => fail(409, 'source_change_review_changed', reason);

type Diff = {
  state: 'changed' | 'unchanged';
  removed: string[];
  added: string[];
  omitted_removed_lines: number;
  omitted_added_lines: number;
  truncated_removed_line: boolean;
  truncated_added_line: boolean;
  removed_sha256: string;
  added_sha256: string;
};
function boundedDiff(before: string, after: string): Diff {
  const left = before.split('\n');
  const right = after.split('\n');
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  )
    suffix++;
  const removed = left.slice(prefix, left.length - suffix);
  const added = right.slice(prefix, right.length - suffix);
  const clipped = (rows: string[]) => {
    const kept: string[] = [];
    let bytes = 0;
    let omitted = 0;
    let truncatedLine = false;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!;
      const size = Buffer.byteLength(row);
      if (kept.length >= 40) {
        omitted += rows.length - index;
        break;
      }
      if (bytes + size > 5000) {
        const marker = '…[line excerpt truncated]';
        const available = 5000 - bytes - Buffer.byteLength(marker);
        if (available <= 0) {
          omitted += rows.length - index;
          break;
        }
        let excerpt = '';
        let excerptBytes = 0;
        for (const character of row) {
          const characterBytes = Buffer.byteLength(character);
          if (excerptBytes + characterBytes > available) break;
          excerpt += character;
          excerptBytes += characterBytes;
        }
        kept.push(excerpt + marker);
        truncatedLine = true;
        omitted += rows.length - index - 1;
        break;
      }
      kept.push(row);
      bytes += size;
    }
    return { kept, omitted, truncatedLine };
  };
  const shownRemoved = clipped(removed);
  const shownAdded = clipped(added);
  return {
    state: before === after ? 'unchanged' : 'changed',
    removed: shownRemoved.kept,
    added: shownAdded.kept,
    omitted_removed_lines: shownRemoved.omitted,
    omitted_added_lines: shownAdded.omitted,
    truncated_removed_line: shownRemoved.truncatedLine,
    truncated_added_line: shownAdded.truncatedLine,
    removed_sha256: sha256(removed.join('\n')),
    added_sha256: sha256(added.join('\n')),
  };
}

function recordRef(kind: string, id: string, bytes: Buffer): RecordRef {
  const hash = sha256(bytes);
  return { owner: 'signals-ai', kind, id, revision: `sha256:${hash}`, digest: hash };
}
const sameRef = (a: RecordRef, b: RecordRef) =>
  a.owner === b.owner &&
  a.kind === b.kind &&
  a.id === b.id &&
  a.revision === b.revision &&
  a.digest === b.digest;

type Review = {
  schema_version: 'source-change-review-v1';
  id: string;
  created_at: string;
  request_digest: string;
  source_id: string;
  prior_capture_ref: RecordRef;
  new_capture_ref: RecordRef;
  observed_change: Diff;
  meaningfulness: Request['meaningfulness'];
  change_rationale: string;
  assertions: Array<Assertion & { observation_sha256: string }>;
  qualifications: string[];
};
type Store = { schema_version: 'source-change-review-store-v1'; reviews: Review[] };
const reviewSchema = Type.Object(
  {
    schema_version: Type.Literal('source-change-review-v1'),
    id: uuid,
    created_at: Type.String({ format: 'date-time' }),
    request_digest: digest,
    source_id: Type.String({ pattern: '^source-[a-f0-9]{64}$' }),
    prior_capture_ref: refSchema,
    new_capture_ref: refSchema,
    observed_change: Type.Object(
      {
        state: Type.Enum(['changed', 'unchanged']),
        removed: Type.Array(Type.String({ maxLength: 5000 }), { maxItems: 40 }),
        added: Type.Array(Type.String({ maxLength: 5000 }), { maxItems: 40 }),
        omitted_removed_lines: Type.Integer({ minimum: 0 }),
        omitted_added_lines: Type.Integer({ minimum: 0 }),
        truncated_removed_line: Type.Boolean(),
        truncated_added_line: Type.Boolean(),
        removed_sha256: digest,
        added_sha256: digest,
      },
      closed,
    ),
    meaningfulness: Type.Enum(['unchanged', 'meaningful', 'not-meaningful', 'uncertain']),
    change_rationale: Type.String({ minLength: 1, maxLength: 1600 }),
    assertions: Type.Array(
      Type.Object({ ...assertionSchema.properties, observation_sha256: digest }, closed),
      { minItems: 1, maxItems: 40 },
    ),
    qualifications: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
      minItems: 1,
      maxItems: 8,
    }),
  },
  closed,
);
async function loadStore(root: string): Promise<Store> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readFile(resolve(root, '.signals/source-change-reviews.json'), 'utf8'),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { schema_version: 'source-change-review-store-v1', reviews: [] };
    fail(503, 'source_change_review_unavailable', 'Review history could not be read.');
  }
  const shape = Type.Object(
    {
      schema_version: Type.Literal('source-change-review-store-v1'),
      reviews: Type.Array(reviewSchema, { maxItems: 1000 }),
    },
    closed,
  );
  if (!Value.Check(shape, parsed))
    fail(
      503,
      'source_change_review_unavailable',
      'Review history is malformed; no repair or migration was attempted.',
    );
  const store = parsed as Store;
  if (
    new Set(store.reviews.map((row) => row.id)).size !== store.reviews.length ||
    store.reviews.some(
      (row) =>
        row.prior_capture_ref.kind !== 'source_capture' ||
        row.new_capture_ref.kind !== 'source_capture' ||
        row.prior_capture_ref.revision !== `sha256:${row.prior_capture_ref.digest}` ||
        row.new_capture_ref.revision !== `sha256:${row.new_capture_ref.digest}` ||
        (row.meaningfulness === 'unchanged') !== (row.observed_change.state === 'unchanged') ||
        row.assertions.some(
          (assertion) =>
            assertion.entity_ref.kind !== 'entity' ||
            assertion.entity_ref.revision !== `sha256:${assertion.entity_ref.digest}` ||
            (assertion.decision === 'revise') !== (assertion.revised_status !== undefined),
        ) ||
        Buffer.byteLength(row.observed_change.removed.join('\n')) > 5000 ||
        Buffer.byteLength(row.observed_change.added.join('\n')) > 5000,
    )
  )
    fail(
      503,
      'source_change_review_unavailable',
      'Review history failed its immutable record checks; no repair or migration was attempted.',
    );
  return store;
}

async function exactEntityAssertion(root: string, assertion: Assertion) {
  if (assertion.entity_ref.kind !== 'entity')
    invalid('Confidence assertions must reference a canonical retained Signal entity.');
  if ((assertion.decision === 'revise') !== (assertion.revised_status !== undefined))
    invalid(
      'A revised judgment needs one explicit successor status; retained judgments cannot include one.',
    );
  const exact = await exactOwnerRecord(root, assertion.entity_ref);
  let parsed: any;
  try {
    parsed = JSON.parse(exact.bytes.toString('utf8'));
  } catch {
    return changed('The selected entity record is unreadable.');
  }
  const entity = parsed?.entity;
  if (!entity || !Array.isArray(entity.observations))
    changed('The selected entity has no retained confidence observations.');
  const observation = entity.observations.find((row: any) => row?.id === assertion.observation_id);
  if (!observation || !['supported', 'contradicted', 'uncertain'].includes(observation.status))
    changed('The selected confidence assertion is unavailable in the exact entity version.');
  return { ref: exact.ref as RecordRef, observation_sha256: sha256(canonical(observation)) };
}

export async function listSourceChangeReviews(root: string) {
  const store = await loadStore(root);
  return {
    schema_version: 'source-change-review-list-v1',
    reviews: store.reviews.map((review) => ({
      id: review.id,
      ref: reviewRef(review),
      created_at: review.created_at,
      source_id: review.source_id,
      prior_capture_ref: review.prior_capture_ref,
      new_capture_ref: review.new_capture_ref,
      meaningfulness: review.meaningfulness,
      assertions: review.assertions,
    })),
  };
}

export async function readSourceChangeReview(root: string, id: string) {
  if (!Value.Check(uuid, id)) invalid('Review identity must be a UUID.');
  const review = (await loadStore(root)).reviews.find((row) => row.id === id);
  if (!review)
    return fail(404, 'source_change_review_not_found', 'No retained review has that UUID.');
  return { ref: reviewRef(review), review, cold_read: true };
}

function reviewBytes(review: Review) {
  return Buffer.from(JSON.stringify(review), 'utf8');
}
function reviewRef(review: Review): RecordRef {
  return recordRef('source_change_review', review.id, reviewBytes(review));
}
export async function sourceChangeReviewRecordBytes(root: string, id: string) {
  if (!Value.Check(uuid, id)) invalid('Review identity must be a UUID.');
  const review = (await loadStore(root)).reviews.find((row) => row.id === id);
  if (!review)
    return fail(404, 'source_change_review_not_found', 'No retained review has that UUID.');
  return { bytes: reviewBytes(review), storage: 'source_change_review_record' as const };
}

export async function previewSourceChange(root: string, priorId: string, newId: string) {
  const [prior, next] = await Promise.all([
    openSourceCapture(root, priorId),
    openSourceCapture(root, newId),
  ]);
  if (prior.capture.source_id !== next.capture.source_id)
    invalid('Comparison requires two versions of the same immutable source identity.');
  if (next.capture.supersedes === null || !sameRef(next.capture.supersedes, prior.ref))
    changed('The selected newer capture must directly supersede the exact prior capture.');
  return {
    schema_version: 'source-change-preview-v1',
    source_id: next.capture.source_id,
    prior_capture_ref: prior.ref,
    new_capture_ref: next.ref,
    observed_change: boundedDiff(prior.capture.text, next.capture.text),
    provenance: {
      prior_observed_at: prior.capture.observed_at,
      new_observed_at: next.capture.observed_at,
      prior_text_sha256: prior.capture.text_sha256,
      new_text_sha256: next.capture.text_sha256,
      prior_provenance: prior.capture.provenance,
      new_provenance: next.capture.provenance,
    },
    qualification: [
      'Text diff is deterministic evidence of observed content change only; it does not judge relevance or confidence impact.',
    ],
  };
}

export async function createSourceChangeReview(root: string, input: unknown) {
  if (!Value.Check(requestSchema, input)) invalid();
  const request = input as Request;
  if (
    new Set(request.assertions.map((row) => `${row.entity_ref.id}:${row.observation_id}`)).size !==
    request.assertions.length
  )
    invalid('Confidence assertion references must be unique.');
  const requestDigest = sha256(canonical(request));
  const existing = (await loadStore(root)).reviews.find((row) => row.id === request.request_id);
  if (existing) {
    if (existing.request_digest !== requestDigest)
      changed(
        'This request UUID already names a different immutable review. Read the original UUID before continuing.',
      );
    return { ref: reviewRef(existing), review: existing, replay: true };
  }
  if (
    request.prior_capture_ref.kind !== 'source_capture' ||
    request.new_capture_ref.kind !== 'source_capture'
  )
    invalid('Both exact version references must be retained source captures.');
  const [prior, next] = await Promise.all([
    openSourceCapture(root, request.prior_capture_ref.id),
    openSourceCapture(root, request.new_capture_ref.id),
  ]);
  if (!sameRef(prior.ref, request.prior_capture_ref) || !sameRef(next.ref, request.new_capture_ref))
    changed();
  if (next.capture.supersedes === null || !sameRef(next.capture.supersedes, prior.ref))
    changed('The selected newer capture must directly supersede the exact prior capture.');
  if (prior.capture.source_id !== next.capture.source_id)
    changed('The selected versions do not share one immutable source identity.');
  const observedChange = boundedDiff(prior.capture.text, next.capture.text);
  if ((observedChange.state === 'unchanged') !== (request.meaningfulness === 'unchanged'))
    invalid(
      'The human change classification must match the deterministic unchanged/changed observation.',
    );
  const assertions = await Promise.all(
    request.assertions.map(async (row) => {
      const exact = await exactEntityAssertion(root, row);
      return { ...row, observation_sha256: exact.observation_sha256 };
    }),
  );
  const review: Review = {
    schema_version: 'source-change-review-v1',
    id: request.request_id,
    created_at: new Date().toISOString(),
    request_digest: requestDigest,
    source_id: next.capture.source_id,
    prior_capture_ref: prior.ref,
    new_capture_ref: next.ref,
    observed_change: observedChange,
    meaningfulness: request.meaningfulness,
    change_rationale: request.change_rationale,
    assertions,
    qualifications: [
      'Observed line changes are deterministic excerpts; omitted lines remain identified by hashes and counts.',
      'Meaningfulness, confidence impact, and retain/revise decisions are human judgments.',
      'The retained review does not rewrite the original Signal, its evidence, or historical assessment.',
      'Capture observation time does not establish currentness or complete source coverage.',
    ],
  };
  let retained = review;
  await withWriter(root, async () => {
    const store = await loadStore(root);
    const duplicate = store.reviews.find((row) => row.id === review.id);
    if (duplicate) {
      if (duplicate.request_digest !== requestDigest)
        changed('This request UUID already names a different immutable review.');
      retained = duplicate;
      return;
    }
    const [currentPrior, currentNext] = await Promise.all([
      openSourceCapture(root, request.prior_capture_ref.id),
      openSourceCapture(root, request.new_capture_ref.id),
    ]);
    if (
      !sameRef(currentPrior.ref, request.prior_capture_ref) ||
      !sameRef(currentNext.ref, request.new_capture_ref) ||
      currentPrior.capture.source_id !== review.source_id ||
      currentNext.capture.source_id !== review.source_id ||
      currentNext.capture.supersedes === null ||
      !sameRef(currentNext.capture.supersedes, currentPrior.ref)
    )
      changed();
    for (let index = 0; index < request.assertions.length; index++) {
      const current = await exactEntityAssertion(root, request.assertions[index]!);
      if (
        !sameRef(current.ref, assertions[index]!.entity_ref) ||
        current.observation_sha256 !== assertions[index]!.observation_sha256
      )
        changed('A confidence assertion changed before the review was retained.');
    }
    if (store.reviews.length >= 1000)
      fail(
        503,
        'source_change_review_capacity',
        'Review capacity is full; retained history was preserved.',
      );
    store.reviews.push(review);
    retained = review;
    if (Buffer.byteLength(JSON.stringify(store)) > 4_000_000)
      fail(
        503,
        'source_change_review_capacity',
        'Review history would exceed its 4 MB limit; existing records were preserved.',
      );
    await atomicJson(resolve(root, '.signals/source-change-reviews.json'), store);
  });
  return { ref: reviewRef(retained), review: retained, replay: retained !== review };
}
