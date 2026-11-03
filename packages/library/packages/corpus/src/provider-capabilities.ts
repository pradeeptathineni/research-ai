import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import manifest from '../../../package.json' with { type: 'json' };
import { requestStore } from './search-request-store.js';
import { loadRun } from './search-store.js';
import { loadEntities } from './search-store.js';
import { loadLibrary } from './library.js';
import { loadLibraryLeads } from './library-leads.js';
import { importedAnswers } from './research-receipts.js';
import { loadProjects } from './projects.js';
import { searchLibrary, type LibraryFinding } from '../../domain/src/library-search.js';
import { sourceCaptureRecordBytes, SourceCaptureError } from './source-captures.js';
import { sourceChangeReviewRecordBytes, SourceChangeReviewError } from './source-change-reviews.js';
import { projectTopicRelevanceRecordBytes } from './project-topic-relevance.js';
import { projectOpportunityBriefRecordBytes } from './project-opportunity-brief.js';
import { planResearchRetention, type ResearchAnswer } from './research-answer.js';
import {
  buildLibraryExploreSnapshot,
  LibraryExploreError,
  selectLibraryExploreKeys,
  type LibraryExploreFilters,
} from './library-explore.js';
import {
  sourceRenderReadiness,
  sourceRenderRecordBytes,
  SourceRenderError,
} from './source-render.js';
import { briefingRecordBytes } from './briefing/store.js';

const closed = { additionalProperties: false };
const text = Type.String({ minLength: 1, maxLength: 200 });
const digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const recordRef = Type.Object(
  {
    owner: text,
    kind: text,
    id: text,
    revision: Type.Union([text, Type.Null()]),
    digest: Type.Union([digest, Type.Null()]),
  },
  closed,
);
const capabilitiesSchema = Type.Object(
  {
    schema_version: Type.Literal('1.0'),
    owner: Type.Literal('signals-ai'),
    instance_id: text,
    product_version: text,
    contracts: Type.Array(Type.Object({ id: text, versions: Type.Array(text) }, closed)),
    operations: Type.Array(
      Type.Object(
        {
          name: text,
          target_kinds: Type.Array(text),
          mutating: Type.Boolean(),
          authority_required: Type.Boolean(),
        },
        closed,
      ),
    ),
    record_kinds: Type.Array(text),
    process_observation: Type.Boolean(),
    observed_at: Type.String({ format: 'date-time' }),
    availability: Type.Enum(['available', 'unavailable', 'unsupported']),
    reason: Type.String(),
  },
  closed,
);
const recordSchema = Type.Object(
  {
    schema_version: Type.Literal('1.0'),
    ref: recordRef,
    instance_id: text,
    owner_epoch: text,
    content_type: Type.Literal('application/json'),
    encoding: Type.Literal('utf8'),
    content: Type.String({ maxLength: 2_000_000 }),
    storage: Type.Enum([
      'retained_run_snapshot',
      'imported_answer_snapshot',
      'entity_snapshot',
      'lead_record',
      'project_record',
      'source_capture_record',
      'source_capture_render_record',
      'source_annotation_record',
      'source_change_review_record',
      'project_topic_relevance_record',
      'project_opportunity_brief_record',
      'briefing_record',
    ]),
  },
  closed,
);
type OwnerRef = Static<typeof recordRef>;

export class ProviderError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly reason: string,
  ) {
    super(code);
  }
}
const fail = (status: number, code: string, reason: string): never => {
  throw new ProviderError(status, code, reason);
};
async function ownerScope(
  root: string,
  version: unknown,
  instance: unknown,
  epoch: unknown,
  required: boolean,
) {
  if (version !== undefined && version !== '1.0')
    fail(
      426,
      'unsupported_provider_version',
      'This owner supports provider version 1.0. Configure that version explicitly; no version substitution is performed.',
    );
  let scope: Awaited<ReturnType<ReturnType<typeof requestStore>['scope']>>;
  try {
    scope = await requestStore(root).scope();
  } catch {
    return fail(
      503,
      'provider_unavailable',
      'Signals owner scope is unavailable. Explicitly initialize only a fresh workspace via request-scope; reconcile missing or corrupt existing history locally.',
    );
  }
  if (required && (typeof instance !== 'string' || typeof epoch !== 'string'))
    fail(
      428,
      'provider_owner_binding_required',
      'Bind the trusted instance_id and owner epoch from capabilities before reading an owner record.',
    );
  if (instance !== undefined && instance !== scope.identity)
    fail(
      409,
      'provider_instance_mismatch',
      'Configured Signals instance differs from this owner. Inspect trusted registration; do not silently rebind.',
    );
  if (epoch !== undefined && epoch !== scope.epoch)
    fail(
      409,
      'owner_epoch_mismatch',
      'Owner history epoch changed. Reconcile the original scope before continuing.',
    );
  return scope;
}

/** Opt-in negotiation headers also bind existing actions before body/effects. */
export async function validateProviderHeaders(
  root: string,
  version: unknown,
  instance: unknown,
  epoch: unknown,
) {
  if (version !== undefined && version !== '1.0')
    fail(
      426,
      'unsupported_provider_version',
      'This owner supports provider version 1.0. No action was dispatched under another version.',
    );
  if (instance !== undefined) await ownerScope(root, version, instance, epoch, false);
}

export async function validateProcessObserver(
  root: string,
  version: unknown,
  instance: unknown,
  epoch: unknown,
) {
  await ownerScope(root, version, instance, epoch, true);
}

export async function providerCapabilities(
  root: string,
  version: unknown,
  instance: unknown,
  epoch: unknown,
) {
  const scope = await ownerScope(root, version, instance, epoch, false);
  const renderReadiness = await sourceRenderReadiness();
  const capabilities = {
    schema_version: '1.0',
    owner: 'signals-ai',
    instance_id: scope.identity,
    product_version: manifest.version,
    contracts: [
      ...['K01', 'K12', 'K13', 'K14', 'K15'].map((id) => ({ id, versions: ['1.0'] })),
      { id: 'library-explore', versions: ['1.0'] },
      { id: 'owner-settings', versions: ['1.0'] },
      { id: 'source-capture', versions: ['1.0'] },
      { id: 'source-archive', versions: ['1.0'] },
      { id: 'source-change-review', versions: ['1.0'] },
      { id: 'source-watch', versions: ['1.0'] },
      { id: 'project-topic-relevance', versions: ['1.0'] },
      { id: 'project-opportunity-brief', versions: ['1.0'] },
      { id: 'project-opportunity-brief-reassessment', versions: ['1.0'] },
      { id: 'project-opportunity-brief-confidence-packet', versions: ['1.0'] },
      { id: 'project-opportunity-brief-successor-comparison', versions: ['1.0'] },
      { id: 'source-capture-render', versions: ['1.0'] },
      { id: 'private-collection', versions: ['1.0'] },
      { id: 'private-pdf-reader', versions: ['1.0'] },
      { id: 'private-document-intake', versions: ['1.0'] },
      { id: 'datasets-analysis', versions: ['1.0'] },
      { id: 'saved-entity-inspection', versions: ['1.0'] },
      { id: 'briefing-sources-and-workbench', versions: ['1.1', '1.2', '1.3', '1.4'] },
      { id: 'smart-collections', versions: ['1.0'] },
      { id: 'frozen-followup-request', versions: ['1.0', '2.0'] },
      { id: 'research-activity', versions: ['1.0'] },
    ],
    operations: [
      {
        name: 'read_owner_settings',
        target_kinds: ['private-library-settings'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'preview_owner_settings',
        target_kinds: ['private-library-settings'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'edit_owner_settings',
        target_kinds: ['private-library-settings'],
        mutating: true,
        authority_required: true,
      },
      {
        name: 'preview_briefing_ranking',
        target_kinds: ['briefing-story'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'export_briefing_event_calendar',
        target_kinds: ['briefing-event'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'preview_following_opml',
        target_kinds: ['briefing-source'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'import_following_opml',
        target_kinds: ['briefing-source'],
        mutating: true,
        authority_required: true,
      },
      {
        name: 'read_following_opml_import',
        target_kinds: ['briefing-source'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'search_knowledge',
        target_kinds: [
          'answer',
          'research_note',
          'imported_answer',
          'entity',
          'lead',
          'decision',
          'review',
          'reflection',
          'principle',
          'study-session',
        ],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'library_explore',
        target_kinds: [...libraryKinds],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'read_private_documents',
        target_kinds: ['private_document'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'inspect_saved_entity',
        target_kinds: ['entity'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'import_private_document',
        target_kinds: ['private_document'],
        mutating: true,
        authority_required: true,
      },
      {
        name: 'preview_private_document_correction',
        target_kinds: ['private_document'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'correct_private_document',
        target_kinds: ['private_document'],
        mutating: true,
        authority_required: true,
      },
      {
        name: 'read_knowledge',
        target_kinds: ['owner_reference'],
        mutating: false,
        authority_required: false,
      },
      { name: 'read_topics', target_kinds: ['topic'], mutating: false, authority_required: false },
      { name: 'edit_topics', target_kinds: ['topic'], mutating: true, authority_required: true },
      {
        name: 'read_smart_collections',
        target_kinds: ['saved_query', 'query_result'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'save_smart_collection',
        target_kinds: ['saved_query'],
        mutating: true,
        authority_required: true,
      },
      {
        name: 'triage_smart_collection',
        target_kinds: ['exact_result_identity'],
        mutating: true,
        authority_required: true,
      },
      {
        name: 'freeze_smart_collection',
        target_kinds: ['topic'],
        mutating: true,
        authority_required: true,
      },
      {
        name: 'read_research_activity',
        target_kinds: ['research_request'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'observe_processes',
        target_kinds: ['research_job', 'research_request'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'read_record',
        target_kinds: [
          'answer',
          'research_run',
          'research_note',
          'imported_answer',
          'entity',
          'lead',
          'project',
          'source_capture',
          'source_capture_render',
          'source_annotation',
        ],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'capture_source',
        target_kinds: ['source_capture'],
        mutating: true,
        authority_required: true,
      },
      ...(renderReadiness.available
        ? [
            {
              name: 'source_capture_render',
              target_kinds: ['entity', 'lead'],
              mutating: true,
              authority_required: true,
            },
          ]
        : []),
      {
        name: 'read_source_captures',
        target_kinds: ['source_capture', 'source_annotation'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'create_source_archive',
        target_kinds: ['source_capture'],
        mutating: true,
        authority_required: true,
      },
      {
        name: 'read_source_archive',
        target_kinds: ['source-archive', 'source_capture'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'read_source_archive_request',
        target_kinds: ['source_capture'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'annotate_source',
        target_kinds: ['source_annotation'],
        mutating: true,
        authority_required: true,
      },
      {
        name: 'select_source_capture',
        target_kinds: ['source_capture', 'source_annotation'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'review_source_change',
        target_kinds: ['source_capture', 'entity', 'source_change_review'],
        mutating: true,
        authority_required: true,
      },
      {
        name: 'read_source_change_reviews',
        target_kinds: ['source_change_review', 'source_capture', 'entity'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'create_source_watch',
        target_kinds: ['source-watch', 'source_capture'],
        mutating: true,
        authority_required: true,
      },
      {
        name: 'read_source_watch',
        target_kinds: ['source-watch'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'list_source_watches',
        target_kinds: ['source-watch'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'check_source_watch',
        target_kinds: ['source-watch', 'source_capture'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'read_project_topic_relevance',
        target_kinds: ['project_topic_relevance'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'review_project_topic_relevance',
        target_kinds: ['topic', 'project', 'project_topic_relevance'],
        mutating: true,
        authority_required: true,
      },
      {
        name: 'export_project_opportunity_brief_packet',
        target_kinds: ['project_opportunity_brief'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'compare_project_opportunity_brief_successor',
        target_kinds: ['project_opportunity_brief'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'preview_project_opportunity_brief_reassessment',
        target_kinds: ['project_opportunity_brief'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'reassess_project_opportunity_brief',
        target_kinds: ['project_opportunity_brief'],
        mutating: true,
        authority_required: true,
      },
      {
        name: 'read_project_opportunity_brief',
        target_kinds: ['project_opportunity_brief'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'retain_project_opportunity_brief',
        target_kinds: ['project_opportunity_brief'],
        mutating: true,
        authority_required: true,
      },
      {
        name: 'search_private_collection',
        target_kinds: ['private_document'],
        mutating: true,
        authority_required: true,
      },
      {
        name: 'read_private_collection',
        target_kinds: ['private_document', 'private_collection_preview'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'select_private_collection_passages',
        target_kinds: ['private_document', 'frozen_research_source'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'read_private_pdf_bytes',
        target_kinds: ['private_document'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'read_private_pdf',
        target_kinds: ['private_document', 'private_reader'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'revise_private_pdf_reader',
        target_kinds: ['private_reader', 'private_pdf_annotation'],
        mutating: true,
        authority_required: true,
      },
      {
        name: 'select_private_pdf_passages',
        target_kinds: ['private_reader', 'private_pdf_annotation', 'frozen_research_source'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'search_library',
        target_kinds: ['answer', 'research_note', 'imported_answer', 'entity', 'lead'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'lookup_request',
        target_kinds: ['research_request'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'request_configuration',
        target_kinds: ['execution_configuration'],
        mutating: false,
        authority_required: false,
      },
      {
        name: 'search',
        target_kinds: ['research_request'],
        mutating: true,
        authority_required: true,
      },
      { name: 'cancel', target_kinds: ['research_job'], mutating: true, authority_required: true },
      {
        name: 'ask_saved_research',
        target_kinds: ['answer', 'research_note'],
        mutating: true,
        authority_required: true,
      },
      {
        name: 'ask_across_saved_research',
        target_kinds: ['answer', 'research_note'],
        mutating: true,
        authority_required: true,
      },
      {
        name: 'lookup_followup',
        target_kinds: ['followup_request'],
        mutating: false,
        authority_required: false,
      },
    ],
    record_kinds: [
      'answer',
      'research_run',
      'research_note',
      'imported_answer',
      'entity',
      'lead',
      'project',
      'source_capture',
      'source_capture_render',
      'source_annotation',
      'source_change_review',
      'project_topic_relevance',
      'project_opportunity_brief',
      'briefing_source',
      'briefing_item',
      'briefing_story',
      'briefing_event',
      'project_opportunity_brief',
      'private_pdf_reader',
      'private_document',
      'private_pdf_annotation',
    ],
    process_observation: true,
    observed_at: new Date().toISOString(),
    availability: 'available',
    reason:
      'Owner HTTP contract available. Native model readiness is separate and was not probed; retained history is not automatically a saved Library answer.',
  };
  if (!Value.Check(capabilitiesSchema, capabilities))
    fail(
      503,
      'invalid_provider_capabilities',
      'Installed provider metadata could not be validated.',
    );
  return {
    capabilities,
    deduplication: scope,
    access: {
      base_path: '/signals-ai/__signals/api/',
      transport: 'loopback-http',
      origin: 'same-origin-or-no-origin',
      mutation_authentication: 'session token in x-signals-token; existing origin checks apply',
      record_owner_headers: ['x-signals-instance-id', 'x-signals-owner-epoch'],
      read_route: 'provider/records?ref=<encoded RecordRef>',
      research_activity_route:
        'provider/research-activity?request_id=<accepted job id>&after=<sequence>&limit=<1..100>&store_epoch=<observation epoch>&session_id=<session id>',
      library_route:
        'provider/library?q=<literal Unicode text>&limit=<1..100>&kinds=<comma-separated supported kinds>&project_ref=<encoded RecordRef>&cursor=<opaque>',
      library_explore_route:
        'GET provider/library-explore?q=<literal Unicode text>&kinds=<comma-separated supported kinds>&project_ref=<encoded RecordRef> returns a complete bounded snapshot; POST provider/library-explore/select selects unique exact keys from its unchanged snapshot. Both routes use existing Library owner rules and require bound owner scope; selection also uses the existing session and origin guard.',
      source_capture_render_route:
        'When the exact optional Playwright 1.63.0 runtime and local Chromium binary are available, POST source-captures/render explicitly captures one exact current entity/lead as v1 text plus offline screenshot/DOM/ARIA attachments. GET source-captures/render-requests/<uuid> is readback only; GET source-captures/<uuid>/render and /blob reopen exact digest-bound attachments.',
      knowledge_route:
        'provider/knowledge?q=<literal text>&limit=<1..100>; knowledge/record reads an exact selected owner reference; topics supports private named collections. Foreign readers are operator-configured frozen export files.',
      smart_collections_route:
        'smart-collections saves bounded text/owner/kind/date/triage queries; /<uuid>/run revisits current configured owner snapshots; /<uuid>/triage requires exact result identities and query revision/digest; /<uuid>/freeze freezes only explicit current selections into an ordinary topic with owner coverage. Mutations require the existing session token and every route uses owner instance/epoch and loopback guards.',
      followup_route:
        'followups (frozen-followup-request-v1 or v2, session token and owner epoch); followups/<idempotency_key> reads it back',
      private_collection_route:
        'private-collection/preview searches exact imported document refs locally; private-collection and private-collection/<uuid> reopen previews; private-collection/selection freezes explicitly selected exact passage IDs. All routes retain session, loopback origin and owner epoch guards.',
      private_reader_route:
        'private-reader/bytes returns original PDF bytes only for a current exact document ref and raw hash; private-reader creates/reopens by UUID; private-reader/revise uses expected revision/digest CAS; private-reader/selection freezes only explicitly selected annotations. Routes retain session, loopback origin and owner epoch guards.',
      private_document_intake_route:
        'private-documents supports PDF text-layer, Markdown, inert HTML and plain-text imports. The private-document-intake v1 contract adds an idempotent import request and action-tagged correction preview/create on the same bounded route; corrections retain original bytes and exact parent refs in the existing immutable document store.',
      saved_entity_inspection_route:
        'GET saved-entity?id=<entity-id>&destination=private|public returns the exact saved entity record, its saved-versus-assessed status, Unknown confidence and matching save receipts. Each receipt reports whether its exact runId was cold-validated against the saved query and entity ID; stale or conflicting runs cannot be reopened. POST history/open with an available receipt runId reopens its frozen run without new research.',
      supported_records:
        'Qualified retained runs, imported answers, native entities, selected leads and project records. Library summaries are bounded; process observations use provider/processes. No arbitrary paths or commands.',
    },
  };
}

async function fileBytes(path: string) {
  try {
    if ((await realpath(path)) !== path)
      fail(503, 'provider_record_unavailable', 'Retained record storage must not follow symlinks.');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 2_000_000)
        fail(
          503,
          'provider_record_unavailable',
          'Retained record is not a supported bounded snapshot.',
        );
      const bytes = await file.readFile();
      if (bytes.length > 2_000_000 || !Buffer.from(bytes.toString('utf8')).equals(bytes))
        fail(503, 'provider_record_unavailable', 'Retained record must be bounded UTF8 JSON.');
      return bytes;
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return fail(
        404,
        'provider_record_not_found',
        'This snapshot is not retained here. Lookup never starts research or recreates an answer.',
      );
    return fail(
      503,
      'provider_record_unavailable',
      'Retained record could not be read safely. Inspect owner history locally.',
    );
  }
}
const snapshotBytes = (root: string, id: string) =>
  fileBytes(resolve(root, '.signals/runs', id + '.json'));
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const entityId = /^entity-[a-f0-9]{24}$/;
const leadId = /^lead-[a-f0-9]{24}$/;
const projectId = /^project-[a-f0-9]{24}$/;
type RecordStorage = Static<typeof recordSchema>['storage'];
function projectedBytes(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > 2_000_000)
    fail(
      503,
      'provider_record_unavailable',
      'Validated owner projection exceeds the bounded record response.',
    );
  return bytes;
}
/** Resolve only a supported owner's validated record; no path is supplied by a consumer. */
async function ownedBytes(
  root: string,
  kind: string,
  id: string,
): Promise<{ bytes: Buffer; storage: RecordStorage }> {
  if (['answer', 'research_run', 'research_note'].includes(kind)) {
    if (!uuid.test(id)) fail(400, 'invalid_provider_reference', 'Retained run IDs must be UUIDs.');
    const bytes = await snapshotBytes(root, id);
    try {
      const run = await loadRun(id, root);
      if (!['completed', 'partial', 'failed', 'cancelled', 'not_configured'].includes(run.status))
        throw new Error('unsupported_retained_status');
      if (kind === 'answer' && !run.answerReceipt) throw new Error();
      if (
        kind === 'research_note' &&
        (run.answerReceipt ||
          !['partial', 'failed', 'cancelled'].includes(run.status) ||
          !run.brief?.text)
      )
        throw new Error();
    } catch {
      fail(503, 'provider_record_unavailable', 'Retained snapshot validation failed.');
    }
    return { bytes, storage: 'retained_run_snapshot' };
  }
  if (kind === 'imported_answer') {
    if (!uuid.test(id))
      fail(400, 'invalid_provider_reference', 'Imported answer IDs must be UUIDs.');
    if (!(await importedAnswers(root)).some((run) => run.runId === id))
      fail(404, 'provider_record_not_found', 'No validated imported answer has this identity.');
    for (const name of await readdir(resolve(root, '.signals/queries')).catch(() => [])) {
      if (!uuid.test(name.replace(/\.json$/, '')) || !name.endsWith('.json')) continue;
      const bytes = await fileBytes(resolve(root, '.signals/queries', name));
      try {
        const record = JSON.parse(bytes.toString('utf8')) as { result?: { runId?: string } };
        if (record.result?.runId === id) return { bytes, storage: 'imported_answer_snapshot' };
      } catch {
        fail(503, 'provider_record_unavailable', 'Imported answer original is invalid.');
      }
    }
    return fail(404, 'provider_record_not_found', 'Imported answer original is unavailable.');
  }
  if (kind === 'entity') {
    const match = /^(public|private):(entity-[a-f0-9]{24})$/.exec(id);
    if (!match || !entityId.test(match[2]!))
      return fail(
        400,
        'invalid_provider_reference',
        'Entity IDs require their public or private destination.',
      );
    const directory = resolve(
      root,
      match[1] === 'public' ? 'signals/entities' : '.signals/corpus/entities',
    );
    if (!(await loadEntities(directory)).some((record) => record.entity.id === match[2]))
      fail(404, 'provider_record_not_found', 'Validated entity is unavailable.');
    return {
      bytes: await fileBytes(resolve(directory, match[2] + '.json')),
      storage: 'entity_snapshot',
    };
  }
  if (kind === 'lead') {
    if (!leadId.test(id)) fail(400, 'invalid_provider_reference', 'Invalid lead identity.');
    const lead = (await loadLibraryLeads(root)).find((row) => row.id === id);
    if (!lead) return fail(404, 'provider_record_not_found', 'Validated lead is unavailable.');
    return {
      bytes: projectedBytes({ id, uri: lead.uri, history: lead.lead!.history }),
      storage: 'lead_record',
    };
  }
  if (kind === 'briefing-item' || kind === 'briefing-source') {
    try {
      return { bytes: await briefingRecordBytes(root, kind, id), storage: 'briefing_record' };
    } catch (error) {
      if (error && typeof error === 'object' && 'status' in error) {
        const status = Number(error.status);
        const rawCode = 'code' in error ? error.code : undefined;
        const code = typeof rawCode === 'string' ? rawCode : 'briefing_record_unavailable';
        if (status === 404) fail(404, code, 'The exact Briefing record is missing.');
      }
      fail(
        503,
        'briefing_record_unavailable',
        'The exact Briefing record could not be read safely.',
      );
    }
  }
  if (kind === 'project') {
    if (!projectId.test(id)) fail(400, 'invalid_provider_reference', 'Invalid project identity.');
    const project = (await loadProjects(root)).projects.find((row) => row.id === id);
    if (!project)
      return fail(404, 'provider_record_not_found', 'Validated project is unavailable.');
    return { bytes: projectedBytes(project), storage: 'project_record' };
  }
  if (kind === 'source_capture_render') {
    try {
      return await sourceRenderRecordBytes(root, id);
    } catch (error) {
      if (error instanceof SourceRenderError) fail(error.status, error.code, error.reason);
      throw error;
    }
  }
  if (kind === 'source_capture' || kind === 'source_annotation') {
    if (!uuid.test(id))
      fail(400, 'invalid_provider_reference', 'Source-capture record IDs must be UUIDs.');
    try {
      return await sourceCaptureRecordBytes(root, kind, id);
    } catch (error) {
      if (error instanceof SourceCaptureError) fail(error.status, error.code, error.reason);
      throw error;
    }
  }
  if (kind === 'source_change_review') {
    if (!uuid.test(id))
      fail(400, 'invalid_provider_reference', 'Source-change review IDs must be UUIDs.');
    try {
      return await sourceChangeReviewRecordBytes(root, id);
    } catch (error) {
      if (error instanceof SourceChangeReviewError) fail(error.status, error.code, error.reason);
      throw error;
    }
  }
  if (kind === 'project_topic_relevance') {
    if (!uuid.test(id))
      fail(400, 'invalid_provider_reference', 'Project-topic relevance IDs must be UUIDs.');
    try {
      return await projectTopicRelevanceRecordBytes(root, id);
    } catch (error) {
      if (error instanceof Error && 'status' in error)
        fail(
          Number((error as { status: number }).status),
          String((error as { code?: string }).code ?? 'project_topic_relevance_unavailable'),
          String((error as { reason?: string }).reason ?? 'Project-topic review is unavailable.'),
        );
      throw error;
    }
  }
  if (kind === 'project_opportunity_brief') {
    if (!uuid.test(id))
      fail(400, 'invalid_provider_reference', 'Project opportunity brief IDs must be UUIDs.');
    try {
      return await projectOpportunityBriefRecordBytes(root, id);
    } catch (error) {
      if (error instanceof Error && 'status' in error)
        fail(
          Number((error as { status: number }).status),
          String((error as { code?: string }).code ?? 'project_opportunity_brief_unavailable'),
          String(
            (error as { reason?: string }).reason ?? 'Project opportunity brief is unavailable.',
          ),
        );
      throw error;
    }
  }
  return fail(400, 'unsupported_record_kind', 'This owner does not read that record kind.');
}
/** Exact validated bytes of one owner record; a changed revision is refused, never substituted. */
export async function exactOwnerRecord(root: string, ref: OwnerRef) {
  const { bytes, storage } = await ownedBytes(root, ref.kind, ref.id);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const revision = 'sha256:' + sha256;
  if (
    (ref.digest !== null && ref.digest !== sha256) ||
    (ref.revision !== null && ref.revision !== revision)
  )
    fail(
      409,
      'provider_record_changed',
      'The exact requested revision/digest is unavailable. Resolve a successor explicitly; no substitution was made.',
    );
  if (!(await ownedBytes(root, ref.kind, ref.id)).bytes.equals(bytes))
    fail(
      409,
      'provider_record_changed',
      'Snapshot changed while it was being validated. Retry the exact reference after owner reconciliation.',
    );
  return { bytes, storage, ref: { ...ref, revision, digest: sha256 } };
}
export async function providerRecord(
  root: string,
  url: string,
  version: unknown,
  instance: unknown,
  epoch: unknown,
) {
  const scope = await ownerScope(root, version, instance, epoch, true);
  const params = new URL(url, 'http://127.0.0.1').searchParams;
  let ref: OwnerRef;
  try {
    if (params.size !== 1 || !params.has('ref') || params.get('ref')!.length > 2000)
      throw new Error();
    const input: unknown = JSON.parse(params.get('ref')!);
    if (!Value.Check(recordRef, input)) throw new Error();
    ref = input;
  } catch {
    return fail(
      400,
      'invalid_provider_reference',
      'Supply one closed RecordRef in ref; commands, paths and extra fields are not accepted.',
    );
  }
  if (ref.owner !== 'signals-ai')
    fail(
      409,
      'provider_owner_mismatch',
      'The reference belongs to another owner. Use its explicitly registered endpoint.',
    );
  const exact = await exactOwnerRecord(root, ref);
  const result = {
    schema_version: '1.0',
    ref: exact.ref,
    instance_id: scope.identity,
    owner_epoch: scope.epoch,
    content_type: 'application/json',
    encoding: 'utf8',
    content: exact.bytes.toString('utf8'),
    storage: exact.storage,
  };
  if (!Value.Check(recordSchema, result))
    fail(503, 'provider_record_unavailable', 'Stored record response failed its runtime contract.');
  return result;
}

const libraryKinds = ['answer', 'research_note', 'imported_answer', 'entity', 'lead'] as const;
function strictLibraryParams(url: string, allowed: string[], message: string) {
  const params = new URL(url, 'http://127.0.0.1').searchParams;
  if (
    [...params.keys()].some((key) => !allowed.includes(key)) ||
    [...params.keys()].some((key) => params.getAll(key).length !== 1)
  )
    fail(400, 'invalid_library_query', message);
  return params;
}

function libraryFilterValues(params: URLSearchParams) {
  const q = params.get('q') ?? '';
  const kindsText = params.get('kinds');
  const kinds = kindsText === null ? [...libraryKinds] : kindsText.split(',');
  if (q.length > 2000)
    fail(400, 'invalid_library_query', 'Query text must be bounded and limit must be 1..100.');
  if (
    !kinds.length ||
    kinds.some((kind) => !libraryKinds.includes(kind as (typeof libraryKinds)[number])) ||
    new Set(kinds).size !== kinds.length
  )
    fail(400, 'unsupported_library_filter', 'Supply only advertised owner Library kinds.');
  let projectFilter: OwnerRef | null = null;
  if (params.has('project_ref')) {
    try {
      const candidate: unknown = JSON.parse(params.get('project_ref')!);
      if (
        !Value.Check(recordRef, candidate) ||
        candidate.owner !== 'signals-ai' ||
        candidate.kind !== 'project'
      )
        throw new Error();
      projectFilter = {
        owner: candidate.owner,
        kind: candidate.kind,
        id: candidate.id,
        revision: candidate.revision,
        digest: candidate.digest,
      };
    } catch {
      fail(
        400,
        'unsupported_library_filter',
        'Project filter must be a Signals project RecordRef.',
      );
    }
  }
  return { q, kinds, projectFilter };
}

async function importedAnswerSources(root: string, findings: LibraryFinding[]) {
  const answerFindings = new Map(
    findings
      .filter((finding) => finding.origin.format === 'answer')
      .map((finding) => [finding.origin.recordId, finding]),
  );
  if (!answerFindings.size) return new Map<string, Buffer>();
  let runNames: Set<string>;
  try {
    runNames = new Set(
      (await readdir(resolve(root, '.signals/runs'))).filter((name) =>
        /^[a-f0-9-]{36}\.json$/.test(name),
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') runNames = new Set();
    else fail(503, 'provider_record_unavailable', 'Answer owner state could not be listed safely.');
  }
  const importedIds = new Set(
    [...answerFindings.keys()].filter((id) => !runNames.has(`${id}.json`)),
  );
  if (!importedIds.size) return new Map<string, Buffer>();

  const directory = resolve(root, '.signals/queries');
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return fail(
        409,
        'provider_record_changed',
        'Imported answers changed while the Library snapshot was read.',
      );
    return fail(
      503,
      'provider_record_unavailable',
      'Imported answer storage could not be listed safely.',
    );
  }
  const sources = new Map<string, Buffer>();
  for (const name of names) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const bytes = await fileBytes(resolve(directory, name));
    let stored: {
      recordVersion?: number;
      result?: { runId?: string; input?: ResearchAnswer; answerSha256?: string };
    };
    try {
      stored = JSON.parse(bytes.toString('utf8')) as typeof stored;
    } catch {
      continue;
    }
    const id = stored.result?.runId;
    if (!id || !importedIds.has(id)) continue;
    const finding = answerFindings.get(id)!;
    try {
      const input = stored.result!.input!;
      const planned = planResearchRetention(input);
      if (
        stored.recordVersion !== 1 ||
        stored.result!.answerSha256 !== planned.answerSha256 ||
        finding.title !== input.query ||
        finding.answerText !== input.answer ||
        finding.observedAt !== input.observedAt ||
        finding.answer?.sha256 !== planned.answerSha256 ||
        JSON.stringify(finding.answer?.provenance) !== JSON.stringify(input.provenance)
      )
        fail(
          409,
          'provider_record_changed',
          'Imported answer changed while the Library snapshot was read.',
        );
      if (sources.has(id))
        fail(503, 'provider_record_unavailable', 'Imported answer identity is ambiguous.');
      sources.set(id, bytes);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      fail(503, 'provider_record_unavailable', 'Imported answer snapshot validation failed.');
    }
  }
  if (sources.size !== importedIds.size)
    fail(
      409,
      'provider_record_changed',
      'Imported answers changed while the Library snapshot was read.',
    );
  return sources;
}

async function libraryIdentity(
  root: string,
  finding: LibraryFinding,
  importedSources: Map<string, Buffer>,
) {
  if (finding.origin.format === 'native')
    return { kind: 'entity', id: `${finding.origin.destination}:${finding.id}` };
  if (finding.origin.format === 'lead') return { kind: 'lead', id: finding.id };
  if (finding.origin.format === 'note') return { kind: 'research_note', id: finding.id };
  if (finding.origin.format === 'answer') {
    if (importedSources.has(finding.id)) return { kind: 'imported_answer', id: finding.id };
    try {
      await snapshotBytes(root, finding.id);
      return { kind: 'answer', id: finding.id };
    } catch (error) {
      if (!(error instanceof ProviderError) || error.status !== 404) throw error;
      return { kind: 'imported_answer', id: finding.id };
    }
  }
  return null; // Legacy bundles do not yet have an exact per-record reader.
}

async function currentLibrarySnapshot(
  root: string,
  q: string,
  kinds: string[],
  projectFilter: OwnerRef | null,
  batchImportedAnswers = false,
) {
  if (projectFilter) {
    const current = await ownedBytes(root, 'project', projectFilter.id);
    const sha = createHash('sha256').update(current.bytes).digest('hex');
    if (
      (projectFilter.digest && projectFilter.digest !== sha) ||
      (projectFilter.revision && projectFilter.revision !== `sha256:${sha}`)
    )
      fail(
        409,
        'provider_record_changed',
        'Project filter version changed; refresh its exact owner reference.',
      );
  }
  const projectState = await loadProjects(root);
  const associations = new Map<string, string[]>();
  for (const item of projectState.opportunities) {
    if (!item.findingKey || !item.projectId) continue;
    const ids = associations.get(item.findingKey) ?? [];
    if (!ids.includes(item.projectId)) ids.push(item.projectId);
    associations.set(item.findingKey, ids);
  }
  const coverage: string[] = [];
  const findings = (await loadLibrary(root, { coverage })).filter((finding) => finding.saved);
  const hits = searchLibrary(findings, q).filter(
    ({ finding }) => !projectFilter || associations.get(finding.key)?.includes(projectFilter.id),
  );
  const importedSources =
    batchImportedAnswers && (kinds.includes('imported_answer') || kinds.includes('answer'))
      ? await importedAnswerSources(
          root,
          hits.map(({ finding }) => finding),
        )
      : new Map<string, Buffer>();
  if (!q.trim())
    hits.sort(
      (a, b) =>
        (b.finding.observedAt ?? '').localeCompare(a.finding.observedAt ?? '') ||
        a.finding.key.localeCompare(b.finding.key),
    );
  const observedAt = new Date().toISOString();
  const records = [];
  for (const { finding } of hits) {
    const identity = await libraryIdentity(root, finding, importedSources);
    if (!identity || !kinds.includes(identity.kind)) continue;
    let digestValue: string | null = null;
    let available = true;
    try {
      const bytes =
        identity.kind === 'imported_answer'
          ? batchImportedAnswers
            ? importedSources.get(identity.id)
            : (await ownedBytes(root, identity.kind, identity.id)).bytes
          : (await ownedBytes(root, identity.kind, identity.id)).bytes;
      if (!bytes)
        throw new ProviderError(
          409,
          'provider_record_changed',
          'Imported answer changed during Library snapshot.',
        );
      digestValue = createHash('sha256').update(bytes).digest('hex');
    } catch (error) {
      if (!(error instanceof ProviderError) || ![404, 503].includes(error.status)) throw error;
      available = false;
    }
    const projectRefs = [];
    for (const id of associations.get(finding.key) ?? []) {
      const project = projectState.projects.find((row) => row.id === id);
      if (!project) continue;
      const sha = createHash('sha256').update(JSON.stringify(project)).digest('hex');
      projectRefs.push({
        owner: 'signals-ai',
        kind: 'project',
        id,
        revision: `sha256:${sha}`,
        digest: sha,
      });
    }
    records.push({
      ref: {
        owner: 'signals-ai',
        ...identity,
        revision: digestValue ? `sha256:${digestValue}` : null,
        digest: digestValue,
      },
      title: finding.title,
      summary: finding.description.slice(0, 400),
      kind: identity.kind,
      project_refs: projectRefs,
      updated_at: finding.observedAt,
      visibility: finding.origin.destination,
      domain_status: finding.partialNote
        ? `incomplete:${finding.partialNote.status}`
        : finding.answer
          ? 'unassessed-answer'
          : finding.intrinsicStrength.policy,
      open_capability: available ? 'owner_route' : 'unavailable',
      observed_at: observedAt,
    });
  }
  const snapshot = createHash('sha256')
    .update(
      JSON.stringify({
        q,
        kinds,
        projectFilter,
        summaries: records.map((record) => ({ ...record, observed_at: null })),
      }),
    )
    .digest('hex');
  const owner_coverage = [
    {
      owner: 'signals-ai',
      state: 'connected',
      observed_at: observedAt,
      reason: `Saved supported records searched; legacy published bundles lack exact per-record reads and are excluded.${coverage.length ? ` Partial coverage: ${coverage.join(' ')}` : ''}`,
    },
  ];
  return { records, snapshot, owner_coverage };
}

/** K12: a bounded, owner-qualified navigation page over current saved Library records. */
export async function providerLibrary(
  root: string,
  url: string,
  version: unknown,
  instance: unknown,
  epoch: unknown,
) {
  await ownerScope(root, version, instance, epoch, true);
  const params = strictLibraryParams(
    url,
    ['q', 'limit', 'kinds', 'project_ref', 'cursor'],
    'Unknown or repeated Library filters are not supported.',
  );
  const limitText = params.get('limit') ?? '30';
  if (!/^[1-9]\d*$/.test(limitText) || Number(limitText) > 100)
    fail(400, 'invalid_library_query', 'Query text must be bounded and limit must be 1..100.');
  const limit = Number(limitText);
  const { q, kinds, projectFilter } = libraryFilterValues(params);
  const current = await currentLibrarySnapshot(root, q, kinds, projectFilter);
  const { snapshot, records, owner_coverage } = current;
  const cursor = params.get('cursor');
  let offset = 0;
  if (cursor !== null) {
    try {
      if (cursor.length > 512) throw new Error();
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
        snapshot: string;
        offset: number;
      };
      if (
        parsed.snapshot !== snapshot ||
        !Number.isSafeInteger(parsed.offset) ||
        parsed.offset < 1 ||
        parsed.offset >= records.length
      )
        throw new Error();
      offset = parsed.offset;
    } catch {
      fail(
        409,
        'library_cursor_changed',
        'Library page changed or cursor is invalid; restart from the first page.',
      );
    }
  }
  const next =
    offset + limit < records.length
      ? Buffer.from(JSON.stringify({ snapshot, offset: offset + limit })).toString('base64url')
      : null;
  return {
    schema_version: '1.0',
    records: records.slice(offset, offset + limit),
    next_cursor: next,
    owner_coverage,
  };
}

const libraryExploreFiltersSchema = Type.Object(
  {
    q: Type.String({ maxLength: 2000 }),
    kinds: Type.Array(Type.String({ minLength: 1, maxLength: 40 }), {
      minItems: 1,
      maxItems: libraryKinds.length,
    }),
    project_ref: Type.Union([recordRef, Type.Null()]),
  },
  closed,
);
const libraryExploreSelectionSchema = Type.Object(
  {
    snapshot: digest,
    filters: libraryExploreFiltersSchema,
    keys: Type.Array(digest, { maxItems: 1000 }),
  },
  closed,
);

function libraryExploreFailure(error: unknown): never {
  if (error instanceof LibraryExploreError)
    throw new ProviderError(error.status, error.code, error.reason);
  throw error;
}

async function currentLibraryExplore(
  root: string,
  filters: LibraryExploreFilters,
  version: unknown,
  instance: unknown,
  epoch: unknown,
) {
  const current = await currentLibrarySnapshot(
    root,
    filters.q,
    filters.kinds,
    filters.project_ref,
    true,
  );
  const scope = await ownerScope(root, version, instance, epoch, true);
  try {
    return buildLibraryExploreSnapshot({
      identity: scope.identity,
      epoch: scope.epoch,
      filters,
      records: current.records,
      owner_coverage: current.owner_coverage,
      kinds: libraryKinds,
    });
  } catch (error) {
    libraryExploreFailure(error);
  }
}

/** Complete, stable owner snapshot over the existing saved-Library query. */
export async function providerLibraryExplore(
  root: string,
  url: string,
  version: unknown,
  instance: unknown,
  epoch: unknown,
) {
  await ownerScope(root, version, instance, epoch, true);
  const params = strictLibraryParams(
    url,
    ['q', 'kinds', 'project_ref'],
    'Unknown or repeated Library exploration filters are not supported.',
  );
  const { q, kinds, projectFilter } = libraryFilterValues(params);
  const filters: LibraryExploreFilters = { q, kinds, project_ref: projectFilter };
  try {
    return await currentLibraryExplore(root, filters, version, instance, epoch);
  } catch (error) {
    libraryExploreFailure(error);
  }
}

/** Select exact keys only when the caller's snapshot still matches current owner metadata. */
export async function selectProviderLibraryExplore(
  root: string,
  input: unknown,
  version: unknown,
  instance: unknown,
  epoch: unknown,
) {
  await ownerScope(root, version, instance, epoch, true);
  if (!Value.Check(libraryExploreSelectionSchema, input))
    fail(
      400,
      'invalid_library_selection',
      'Selection requires one bounded snapshot, closed filters and unique exact item keys.',
    );
  const body = input as {
    snapshot: string;
    filters: LibraryExploreFilters;
    keys: string[];
  };
  if (
    !body.filters.kinds.every((kind) =>
      libraryKinds.includes(kind as (typeof libraryKinds)[number]),
    ) ||
    new Set(body.filters.kinds).size !== body.filters.kinds.length ||
    new Set(body.keys).size !== body.keys.length
  )
    fail(
      400,
      'invalid_library_selection',
      'Selection filters and exact keys must be unique supported values.',
    );
  let current;
  try {
    current = await currentLibraryExplore(root, body.filters, version, instance, epoch);
  } catch (error) {
    libraryExploreFailure(error);
  }
  if (current.snapshot !== body.snapshot)
    fail(
      409,
      'library_explore_snapshot_changed',
      'Library metadata changed since this snapshot. Refresh it and select again; no substitute records were returned.',
    );
  try {
    return selectLibraryExploreKeys(current, body.keys);
  } catch (error) {
    libraryExploreFailure(error);
  }
}
