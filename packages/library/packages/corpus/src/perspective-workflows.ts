import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { join, parse, resolve, sep } from 'node:path';
import {
  addWorkflowPerspective,
  createPerspectiveWorkflow,
  perspectiveSpanContribution,
  prepareWorkflowPerspectiveAddition,
  runWorkflowPerspectives,
  validatePerspectiveWorkflow,
  type PerspectiveAddChoice,
  type ResearchPerspectiveWorkflow,
} from '@pradeeptathineni/research-ai';
import { openSourceCapture, type RecordRef } from './source-captures.js';
import { requestStore, requestConfigurationDigest } from './search-request-store.js';
import { loadSettings } from './search-settings.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_WORKFLOWS = 200;
const MAX_SOURCES = 8;

export interface WorkflowRef {
  schemaVersion: 1;
  workflowId: string;
  revision: number;
  sha256: string;
}
interface WorkflowRecord {
  schemaVersion: 1;
  ref: WorkflowRef;
  workflow: ResearchPerspectiveWorkflow;
  sourceRefs: RecordRef[];
  operation?: { requestId: string; action: 'run' | 'perspective-add'; payloadDigest: string };
}
export class PerspectiveWorkflowError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly reason: string,
  ) {
    super(code);
    this.name = 'PerspectiveWorkflowError';
  }
}
const fail = (status: number, code: string, reason: string): never => {
  throw new PerspectiveWorkflowError(status, code, reason);
};
const invalid = (
  reason = 'Supply a closed workflow request with exact retained source references.',
) => fail(400, 'invalid_perspective_workflow', reason);
const changed = () =>
  fail(
    409,
    'perspective_workflow_changed',
    'The exact workflow revision changed; reopen it and review again.',
  );

function plain(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
function exactRef(value: unknown): value is WorkflowRef {
  return (
    plain(value) &&
    Object.keys(value).sort().join(',') === 'revision,schemaVersion,sha256,workflowId' &&
    value.schemaVersion === 1 &&
    typeof value.workflowId === 'string' &&
    UUID.test(value.workflowId) &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) >= 0 &&
    typeof value.sha256 === 'string' &&
    SHA.test(value.sha256)
  );
}
function exactRecordRef(value: unknown): value is RecordRef {
  return (
    plain(value) &&
    Object.keys(value).sort().join(',') === 'digest,id,kind,owner,revision' &&
    value.owner === 'signals-ai' &&
    value.kind === 'source_capture' &&
    typeof value.id === 'string' &&
    typeof value.revision === 'string' &&
    /^sha256:[a-f0-9]{64}$/u.test(value.revision) &&
    typeof value.digest === 'string' &&
    SHA.test(value.digest) &&
    value.revision === `sha256:${value.digest}`
  );
}
function folder(root: string) {
  return resolve(root, '.signals', 'perspective-workflows');
}
function recordFile(root: string, workflowId: string, revision: number) {
  return join(folder(root), workflowId, `${String(revision).padStart(2, '0')}.json`);
}
async function ensureDirectory(path: string) {
  const target = resolve(path);
  const filesystemRoot = parse(target).root;
  let current = filesystemRoot;
  for (const component of target.slice(filesystemRoot.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    let stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) {
      await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      stat = await lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(current)) !== current)
      fail(500, 'perspective_workflow_corrupt', 'Workflow storage must not follow symbolic links.');
  }
}
async function checkedDirectory(path: string, missing: 'empty' | 'not-found' = 'not-found') {
  const target = resolve(path),
    filesystemRoot = parse(target).root;
  let current = filesystemRoot;
  for (const component of target.slice(filesystemRoot.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' && missing === 'empty') return null;
      if (error.code === 'ENOENT')
        fail(404, 'perspective_workflow_not_found', 'Workflow was not found.');
      throw error;
    });
    if (!stat) return false;
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(current)) !== current)
      fail(500, 'perspective_workflow_corrupt', 'Workflow storage must not follow symbolic links.');
  }
  return true;
}
async function readJsonFile(path: string): Promise<unknown> {
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      fail(404, 'perspective_workflow_not_found', 'Exact workflow revision was not found.');
    throw error;
  });
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (await realpath(path)) !== path ||
    stat.size > 16 * 1024 * 1024
  )
    fail(500, 'perspective_workflow_corrupt', 'Workflow record must be a bounded ordinary file.');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes))
    fail(500, 'perspective_workflow_corrupt', 'Workflow record must contain valid UTF-8.');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail(500, 'perspective_workflow_corrupt', 'Workflow record is not valid JSON.');
  }
}
async function revisionNames(dir: string) {
  const names = await readdir(dir);
  for (const name of names) {
    if (/^\d{2}\.json$/u.test(name)) continue;
    if (/^\.lease-[a-f0-9-]{36}$/u.test(name)) {
      const path = join(dir, name),
        stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== path)
        fail(
          500,
          'perspective_workflow_corrupt',
          'Methods session lease must be a canonical directory.',
        );
      continue;
    }
    fail(
      500,
      'perspective_workflow_corrupt',
      'Workflow history contains an unmatched file or directory.',
    );
  }
  return names.filter((name) => /^\d{2}\.json$/u.test(name)).sort();
}
async function workflowIds(base: string): Promise<string[]> {
  const entries = await readdir(base);
  if (entries.some((name) => !UUID.test(name)))
    fail(500, 'perspective_workflow_corrupt', 'Workflow store contains an unmatched entry.');
  const ids = entries.sort();
  if (ids.length > MAX_WORKFLOWS)
    fail(500, 'perspective_workflow_corrupt', 'Workflow store exceeds its item limit.');
  for (const id of ids) await checkedDirectory(join(base, id));
  return ids;
}
function workflowRef(
  workflow: ResearchPerspectiveWorkflow,
  sourceRefs: RecordRef[],
  operation?: WorkflowRecord['operation'],
): WorkflowRef {
  const content = { schemaVersion: 1, workflow, sourceRefs, ...(operation ? { operation } : {}) };
  return {
    schemaVersion: 1,
    workflowId: workflow.id.slice('workflow:'.length),
    revision: workflow.revision,
    sha256: requestConfigurationDigest(content),
  };
}
function recordValid(value: unknown): WorkflowRecord {
  if (
    !plain(value) ||
    Object.keys(value).some(
      (key) => !['schemaVersion', 'ref', 'workflow', 'sourceRefs', 'operation'].includes(key),
    ) ||
    value.schemaVersion !== 1 ||
    !exactRef(value.ref) ||
    !Array.isArray(value.sourceRefs)
  )
    fail(500, 'perspective_workflow_corrupt', 'Stored workflow record has an unsupported shape.');
  const row = value as Record<string, unknown>;
  let workflow: ResearchPerspectiveWorkflow;
  try {
    workflow = validatePerspectiveWorkflow(row.workflow);
  } catch {
    return fail(500, 'perspective_workflow_corrupt', 'Stored workflow failed Methods validation.');
  }
  const sourceRefs = row.sourceRefs as RecordRef[];
  if (
    sourceRefs.length < 1 ||
    sourceRefs.length > MAX_SOURCES ||
    sourceRefs.some((item) => !exactRecordRef(item))
  )
    fail(
      500,
      'perspective_workflow_corrupt',
      'Stored workflow references do not match the exact retained source closure.',
    );
  const operation = row.operation as WorkflowRecord['operation'];
  if (
    operation !== undefined &&
    (!plain(operation) ||
      Object.keys(operation).sort().join(',') !== 'action,payloadDigest,requestId' ||
      !UUID.test(String(operation.requestId)) ||
      !['run', 'perspective-add'].includes(String(operation.action)) ||
      typeof operation.payloadDigest !== 'string' ||
      !SHA.test(operation.payloadDigest))
  )
    fail(500, 'perspective_workflow_corrupt', 'Stored operation receipt is malformed.');
  const ref = workflowRef(workflow, sourceRefs, operation);
  if (JSON.stringify(ref) !== JSON.stringify(row.ref))
    fail(
      500,
      'perspective_workflow_corrupt',
      'Workflow revision digest does not bind its retained references.',
    );
  return { schemaVersion: 1, ref, workflow, sourceRefs, ...(operation ? { operation } : {}) };
}
async function validateSourceClosure(root: string, record: WorkflowRecord) {
  if (record.sourceRefs.length !== record.workflow.sources.length)
    fail(
      500,
      'perspective_workflow_corrupt',
      'Workflow source refs do not cover its frozen source set.',
    );
  for (let index = 0; index < record.sourceRefs.length; index++) {
    const sourceRef = record.sourceRefs[index]!;
    const capture = await openSourceCapture(root, sourceRef.id);
    const source = record.workflow.sources[index]!;
    if (
      !sameSourceRef(sourceRef, capture.ref) ||
      source.uri !== capture.capture.source_uri ||
      source.text !== capture.capture.text ||
      createHash('sha256').update(source.text, 'utf8').digest('hex') !==
        capture.capture.text_sha256 ||
      source.observedAt !== capture.capture.observed_at ||
      JSON.stringify(source.omissions) !==
        JSON.stringify(capture.capture.scope.extraction.omissions)
    )
      fail(
        500,
        'perspective_workflow_corrupt',
        'Frozen workflow source no longer matches its exact retained capture.',
      );
  }
}
async function readRecord(ref: WorkflowRef, root: string): Promise<WorkflowRecord> {
  if (!exactRef(ref)) invalid('An exact workflow revision reference is required.');
  const dir = join(folder(root), ref.workflowId);
  await checkedDirectory(dir);
  const path = recordFile(root, ref.workflowId, ref.revision);
  const record = recordValid(await readJsonFile(path));
  if (
    record.ref.workflowId !== ref.workflowId ||
    record.ref.revision !== ref.revision ||
    record.ref.sha256 !== ref.sha256
  )
    changed();
  await validateSourceClosure(root, record);
  return record;
}
async function saveRecord(record: WorkflowRecord, root: string, expected?: WorkflowRef) {
  const id = record.ref.workflowId;
  const dir = join(folder(root), id);
  await ensureDirectory(dir);
  const names = await revisionNames(dir);
  if (names.some((name, index) => Number(name.slice(0, 2)) !== index))
    fail(
      500,
      'perspective_workflow_corrupt',
      'Workflow history contains a missing or reordered revision.',
    );
  const headRevision = names.length ? Number(names.at(-1)!.slice(0, 2)) : -1;
  if (
    expected &&
    (headRevision !== expected.revision ||
      headRevision < 0 ||
      (await readRecord(expected, root)).ref.sha256 !== expected.sha256)
  )
    changed();
  if (!expected && headRevision !== -1) changed();
  if (record.ref.revision !== headRevision + 1)
    fail(
      409,
      'perspective_workflow_changed',
      'A competing workflow revision was saved. Reopen the exact head.',
    );
  const destination = recordFile(root, id, record.ref.revision);
  const temporary = join(dir, `.pending-${randomUUID()}`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(record, null, 2) + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, destination);
    const directoryHandle = await open(dir, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') changed();
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return record;
}
function withRef(
  workflow: ResearchPerspectiveWorkflow,
  sourceRefs: RecordRef[],
  operation?: WorkflowRecord['operation'],
): WorkflowRecord {
  return {
    schemaVersion: 1,
    ref: workflowRef(workflow, sourceRefs, operation),
    workflow,
    sourceRefs,
    ...(operation ? { operation } : {}),
  };
}
const sameSourceRef = (a: RecordRef, b: RecordRef) =>
  a.owner === b.owner &&
  a.kind === b.kind &&
  a.id === b.id &&
  a.revision === b.revision &&
  a.digest === b.digest;

export async function listPerspectiveWorkflows(root: string) {
  const base = folder(root);
  if (!(await checkedDirectory(base, 'empty')))
    return {
      workflows: [] as Array<{
        ref: WorkflowRef;
        topic: string;
        sourceRefs: RecordRef[];
        status: string;
      }>,
    };
  const entries = await readdir(base);
  if (entries.some((name) => !UUID.test(name)))
    fail(500, 'perspective_workflow_corrupt', 'Workflow store contains an unmatched entry.');
  const ids = entries.sort();
  if (ids.length > MAX_WORKFLOWS)
    fail(500, 'perspective_workflow_corrupt', 'Workflow store exceeds its item limit.');
  const workflows = [];
  for (const id of ids) {
    const dir = join(base, id);
    await checkedDirectory(dir);
    const names = await revisionNames(dir);
    if (!names.length)
      fail(500, 'perspective_workflow_corrupt', 'Workflow folder has no retained revisions.');
    const latestRevision = Number(names.at(-1)!.slice(0, 2));
    if (names.some((name, index) => Number(name.slice(0, 2)) !== index))
      fail(
        500,
        'perspective_workflow_corrupt',
        'Workflow history contains a missing or reordered revision.',
      );
    let latest: WorkflowRecord | undefined;
    for (const name of names) {
      const revision = Number(name.slice(0, 2));
      const record = recordValid(await readJsonFile(recordFile(root, id, revision)));
      if (record.ref.workflowId !== id || record.ref.revision !== revision)
        fail(
          500,
          'perspective_workflow_corrupt',
          'Workflow history identity does not match its folder.',
        );
      await validateSourceClosure(root, record);
      latest = record;
    }
    if (!latest || latest.ref.revision !== latestRevision)
      fail(500, 'perspective_workflow_corrupt', 'Workflow history head is missing.');
    const latestRecord = latest!;
    workflows.push({
      ref: latestRecord.ref,
      topic: latestRecord.workflow.topic,
      sourceRefs: latestRecord.sourceRefs,
      status: latestRecord.workflow.perspectiveResult?.status ?? 'not_run',
    });
  }
  return { workflows };
}

export async function createPerspectiveWorkflowRecord(root: string, input: unknown) {
  if (
    !plain(input) ||
    Object.keys(input).sort().join(',') !== 'perspectives,sourceRefs,topic' ||
    typeof input.topic !== 'string' ||
    !Array.isArray(input.sourceRefs) ||
    input.sourceRefs.length < 1 ||
    input.sourceRefs.length > MAX_SOURCES ||
    !(
      input.perspectives === 'auto' ||
      (Array.isArray(input.perspectives) && input.perspectives.length <= 5)
    )
  )
    invalid();
  const payload = input as Record<string, unknown>;
  const sourceRefs = payload.sourceRefs as RecordRef[];
  if (
    sourceRefs.some((ref) => !exactRecordRef(ref)) ||
    new Set(sourceRefs.map((ref) => `${ref.id}:${ref.digest}`)).size !== sourceRefs.length
  )
    invalid();
  const captures = await Promise.all(
    sourceRefs.map(async (ref) => {
      const opened = await openSourceCapture(root, ref.id);
      if (!sameSourceRef(ref, opened.ref))
        fail(
          409,
          'perspective_source_changed',
          'A selected retained source capture changed. Reopen source history.',
        );
      return { ref, capture: opened.capture };
    }),
  );
  const sources = captures.map(({ capture }) => ({
    uri: capture.source_uri,
    text: capture.text,
    observedAt: capture.observed_at,
    omissions: capture.scope.extraction.omissions,
  }));
  let workflow: ResearchPerspectiveWorkflow;
  try {
    workflow = createPerspectiveWorkflow(payload.topic as string, {
      id: `workflow:${randomUUID()}`,
      sources,
      perspectives: payload.perspectives as
        'auto' | Array<string | { label: string; focus: string }>,
    });
  } catch (failure) {
    invalid(failure instanceof Error ? failure.message : undefined);
  }
  const record = withRef(
    workflow!,
    captures.map(({ ref }) => ref),
  );
  await ensureDirectory(folder(root));
  if ((await workflowIds(folder(root))).length >= MAX_WORKFLOWS)
    fail(413, 'perspective_workflow_limit', 'Workflow store reached its item limit.');
  return await saveRecord(record, root);
}

export async function readPerspectiveWorkflow(root: string, ref: WorkflowRef) {
  const record = await readRecord(ref, root);
  const contributions = record.workflow.perspectiveResult
    ? perspectiveSpanContribution(record.workflow)
    : null;
  return {
    ref: record.ref,
    workflow: record.workflow,
    sourceRefs: record.sourceRefs,
    contributions,
  };
}
export async function previewPerspectiveAddition(
  root: string,
  ref: WorkflowRef,
  choice: PerspectiveAddChoice,
) {
  const record = await readRecord(ref, root);
  let preview!: ReturnType<typeof prepareWorkflowPerspectiveAddition>;
  try {
    preview = prepareWorkflowPerspectiveAddition(record.workflow, choice);
  } catch (failure) {
    invalid(failure instanceof Error ? failure.message : undefined);
  }
  const previewDigest = requestConfigurationDigest({ workflowRef: record.ref, choice, preview });
  return { ref: record.ref, preview, previewDigest };
}
async function assertWorkflowHead(ref: WorkflowRef, root: string) {
  const dir = join(folder(root), ref.workflowId);
  const names = await revisionNames(dir);
  if (!names.length || names.some((name, index) => Number(name.slice(0, 2)) !== index))
    fail(
      500,
      'perspective_workflow_corrupt',
      'Workflow history contains a missing or reordered revision.',
    );
  const latestRevision = Number(names.at(-1)!.slice(0, 2));
  if (latestRevision !== ref.revision) changed();
  const latest = recordValid(await readJsonFile(recordFile(root, ref.workflowId, latestRevision)));
  if (
    latest.ref.workflowId !== ref.workflowId ||
    latest.ref.revision !== ref.revision ||
    latest.ref.sha256 !== ref.sha256
  )
    changed();
}
async function commitOperation(
  root: string,
  operation: {
    expectedRef: WorkflowRef;
    requestId: string;
    action: 'run' | 'perspective-add';
    choice?: PerspectiveAddChoice;
    previewDigest?: string;
  },
  version: unknown,
  instance: unknown,
  epoch: unknown,
) {
  const { expectedRef, requestId, action, choice, previewDigest } = operation;
  if (
    !exactRef(expectedRef) ||
    !UUID.test(requestId) ||
    (action === 'perspective-add' &&
      (!plain(choice) ||
        Object.keys(choice).sort().join(',') !== 'focus,label' ||
        typeof choice.label !== 'string' ||
        typeof choice.focus !== 'string' ||
        typeof previewDigest !== 'string' ||
        !SHA.test(previewDigest)))
  )
    invalid();
  const payload = {
    expectedRef,
    ...(choice ? { choice } : {}),
    ...(previewDigest ? { previewDigest } : {}),
  };
  const payloadDigest = requestConfigurationDigest(payload);
  const epochString = typeof epoch === 'string' ? epoch : '';
  const store = requestStore(root);
  const key = `perspective:${requestId}`;
  const admit = () =>
    store
      .admit(
        { request_id: requestId, idempotency_key: key, payload },
        epochString,
        undefined,
        undefined,
        action === 'run' ? 'perspective-run' : 'perspective-add',
      )
      .catch((failure: unknown) => {
        if (failure instanceof Error && failure.message === 'request_conflict')
          fail(
            409,
            'perspective_request_conflict',
            'This request ID was already used with different workflow inputs.',
          );
        throw failure;
      });
  const existing = await store.lookup(key, epochString);
  if (existing.receipt) {
    const admitted = await admit();
    const retained = await findOperation(root, requestId, action, payloadDigest);
    if (retained) return operationResponse(retained, requestId, action, true);
    if (admitted.created)
      fail(
        500,
        'perspective_workflow_corrupt',
        'Request ledger identity disappeared during replay.',
      );
    fail(
      409,
      'perspective_outcome_unknown',
      'This request may already have dispatched; it was not replayed. Reconcile the retained outcome before trying again.',
    );
  }
  const base = await readRecord(expectedRef, root);
  await assertWorkflowHead(expectedRef, root);
  if (action === 'run' && base.workflow.perspectiveResult)
    invalid('The baseline perspectives have already run.');
  if (action === 'perspective-add') {
    const currentPreview = await previewPerspectiveAddition(
      root,
      expectedRef,
      choice as PerspectiveAddChoice,
    );
    if (currentPreview.previewDigest !== previewDigest)
      fail(
        409,
        'perspective_preview_changed',
        'Preview no longer matches the exact workflow and lens. Review again before adding.',
      );
  }
  const settings = await loadSettings(root);
  const admitted = await admit();
  if (!admitted.created) {
    const retained = await findOperation(root, requestId, action, payloadDigest);
    if (retained) return operationResponse(retained, requestId, action, true);
    fail(
      409,
      'perspective_outcome_unknown',
      'This request may already have dispatched; it was not replayed. Reconcile the retained outcome before trying again.',
    );
  }
  try {
    await requestStore(root).dispatch(admitted.record.id, epochString);
  } catch {
    fail(
      409,
      'perspective_outcome_unknown',
      'Dispatch state could not be claimed; no second execution was started.',
    );
  }
  let workflow: ResearchPerspectiveWorkflow;
  try {
    const options = {
      model: settings.model,
      effort: settings.effort,
      lease: join(folder(root), expectedRef.workflowId, `.lease-${requestId}`),
    };
    workflow =
      action === 'run'
        ? await runWorkflowPerspectives(base.workflow, options)
        : await addWorkflowPerspective(base.workflow, choice!, options);
  } catch (failure) {
    await requestStore(root)
      .settle(admitted.record.id, epochString, 'failed', 'perspective_execution_failed')
      .catch(() => undefined);
    throw failure;
  }
  const record = withRef(workflow, base.sourceRefs, { requestId, action, payloadDigest });
  await saveRecord(record, root, expectedRef);
  await requestStore(root)
    .settle(admitted.record.id, epochString, workflow.perspectiveResult?.status ?? 'failed')
    .catch(() => undefined);
  return operationResponse(record, requestId, action, false);
}
async function findOperation(
  root: string,
  requestId: string,
  action: 'run' | 'perspective-add',
  payloadDigest: string,
) {
  const base = folder(root);
  if (!(await checkedDirectory(base, 'empty'))) return null;
  for (const id of await workflowIds(base)) {
    const dir = join(base, id);
    await checkedDirectory(dir);
    for (const name of await revisionNames(dir)) {
      const path = join(dir, name);
      const record = recordValid(await readJsonFile(path));
      const revision = Number(name.slice(0, 2));
      if (record.ref.workflowId !== id || record.ref.revision !== revision)
        fail(
          500,
          'perspective_workflow_corrupt',
          'Workflow history identity does not match its path.',
        );
      if (record.operation?.requestId === requestId) {
        if (record.operation.action !== action || record.operation.payloadDigest !== payloadDigest)
          fail(
            409,
            'perspective_request_conflict',
            'This request ID was already used with different workflow inputs.',
          );
        await validateSourceClosure(root, record);
        return record;
      }
    }
  }
  return null;
}
function operationResponse(
  record: WorkflowRecord,
  requestId: string,
  action: 'run' | 'perspective-add',
  replayed: boolean,
) {
  return {
    ref: record.ref,
    workflow: record.workflow,
    sourceRefs: record.sourceRefs,
    contributions: perspectiveSpanContribution(record.workflow),
    operation: { requestId, action, state: 'complete' as const, replayed },
  };
}
export async function runPerspectiveWorkflow(
  root: string,
  input: unknown,
  owner: { version: unknown; instance: unknown; epoch: unknown },
) {
  if (
    !plain(input) ||
    Object.keys(input).sort().join(',') !== 'expectedRef,requestId' ||
    !exactRef(input.expectedRef)
  )
    invalid();
  const payload = input as Record<string, unknown>;
  return commitOperation(
    root,
    {
      expectedRef: payload.expectedRef as WorkflowRef,
      requestId: String(payload.requestId),
      action: 'run',
    },
    owner.version,
    owner.instance,
    owner.epoch,
  );
}
export async function addPerspectiveWorkflowLens(
  root: string,
  input: unknown,
  owner: { version: unknown; instance: unknown; epoch: unknown },
) {
  if (
    !plain(input) ||
    Object.keys(input).sort().join(',') !== 'choice,expectedRef,previewDigest,requestId' ||
    !exactRef(input.expectedRef)
  )
    invalid();
  const payload = input as Record<string, unknown>;
  return commitOperation(
    root,
    {
      expectedRef: payload.expectedRef as WorkflowRef,
      requestId: String(payload.requestId),
      action: 'perspective-add',
      choice: payload.choice as PerspectiveAddChoice,
      previewDigest: String(payload.previewDigest),
    },
    owner.version,
    owner.instance,
    owner.epoch,
  );
}
