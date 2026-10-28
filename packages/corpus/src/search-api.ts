import type { IncomingMessage, ServerResponse } from 'node:http';
import { knowledgeRoute } from './knowledge.js';
import { smartCollectionsRoute } from './smart-collections.js';
import {
  annotateSource,
  compareSourceCaptures,
  createSourceCapture,
  listSourceCaptures,
  openSourceCapture,
  selectSourceCapture,
  SourceCaptureError,
  type RecordRef,
  type SourceCaptureOptions,
} from './source-captures.js';
import {
  createSourceChangeReview,
  listSourceChangeReviews,
  previewSourceChange,
  readSourceChangeReview,
  SourceChangeReviewError,
} from './source-change-reviews.js';
import {
  createProjectTopicRelevance,
  listProjectTopicRelevance,
  previewProjectTopicRelevance,
  ProjectTopicRelevanceError,
  readProjectTopicRelevance,
} from './project-topic-relevance.js';
import {
  compareSourceRenderAttachments,
  openSourceRender,
  readSourceRenderBlob,
  readSourceRenderRequest,
  renderSourceCapture,
  SourceRenderError,
  type SourceRenderRuntime,
} from './source-render.js';
import {
  importPrivateDocument,
  correctPrivateDocument,
  listPrivateDocuments,
  openPrivateDocument,
  selectPrivateDocument,
  privateDocumentSections,
  previewPrivateDocumentCorrection,
  PrivateDocumentError,
  readPrivatePdfBytes,
} from './private-documents.js';
import {
  listPrivateCollection,
  openPrivateCollection,
  previewPrivateCollection,
  selectPrivateCollection,
  PrivateCollectionError,
} from './private-collection.js';
import {
  createPrivateReader,
  listPrivateReaders,
  openPrivateReader,
  revisePrivateReader,
  selectPrivateReaderAnnotations,
  PrivateReaderError,
} from './private-reader.js';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  exactOwnerRecord,
  providerCapabilities,
  providerLibrary,
  providerLibraryExplore,
  providerRecord,
  selectProviderLibraryExplore,
  ProviderError,
  validateProviderHeaders,
  validateProcessObserver,
} from './provider-capabilities.js';
import {
  requestStore,
  parseResearchRequest,
  requestConfigurationDigest,
} from './search-request-store.js';
import { processObservation, type ObservedRun } from './process-observation.js';
import { ResearchActivityBuffer, activityRead, activityLimits } from './research-activity.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import {
  parseRequest,
  type SearchRequest,
  type SearchResult,
  type ProvisionalLead,
  budgets,
} from '../../domain/src/search-contract.js';
import { signalSearch } from './signal-search.js';
import { directSearch } from './search-direct.js';
import {
  codexRunner,
  answerFirstOperation,
  claimReviewOperation,
  type SearchRunner,
} from './search-runner.js';
import { loadAcquisitionConfig, acquisitionReadiness } from './search-acquisition.js';
import { scanSources } from './search-sources.js';
import { loadPersonal, updatePersonal } from './search-personal.js';
import { loadInbox, updateInbox, removeInbox } from './search-inbox.js';
import { loadSettings, saveSettings } from './search-settings.js';
import { partialNoteSelection } from './search-note.js';
import {
  loadEntities,
  saveEntities,
  retainRun,
  atomicJson,
  cleanRuns,
  loadRun,
  runHistory,
  selectionHistory,
} from './search-store.js';
import { runDueOnce, refreshRequest } from './search-scheduler.js';
import {
  answerFromEvidence,
  answerFromRetainedMaterial,
  followupChild,
  followupChildV2,
  frozenLibraryMaterial,
  parseFollowupRequest,
  parseFollowupRequestV2,
  savedResearchMaterial,
  savedResearchMaterialV2,
} from './search-followup.js';
import { checkPrimaryMaterial } from './search-reuse.js';
import { selectSavedEntity } from './search-selection.js';
import {
  loadLibrary,
  setLibrarySaved,
  retainedIntroducingParent,
  retainIncompleteNarrative,
} from './library.js';
import { libraryPreferences, librarySearchSchema, matchLibrary } from './library-meaning.js';
import { saveQuery } from './research-store.js';
import { saveLibraryLead } from './library-leads.js';
import { personalSaveDecision } from '../../domain/src/search-score.js';
import { previewProject, type ProjectPreview } from './project-preview.js';
import {
  loadProjects,
  registerProject,
  updateProject,
  disconnectProject,
  listOpportunities,
  attachOpportunity,
  updateOpportunity,
  associateOpportunity,
  importContextOpportunities,
  projectMatches,
  projectHistory,
  projectResearchPreview,
  projectAiSetup,
} from './projects.js';
import {
  checked,
  previewRequestSchema,
  registerRequestSchema,
  projectIdSchema,
  type ProjectSource,
} from './project-contract.js';
import {
  runQueryListOnce,
  queryBatchHistory,
  loadQueryBatch,
  type QueryBatch,
} from './search-query-list.js';
import { briefingRoute } from './briefing/http.js';
import { readBriefingCaptureContext } from './briefing/store.js';

const selection = Type.Object(
  {
    runId: Type.String({ format: 'uuid' }),
    ids: Type.Array(Type.String({ pattern: '^entity-[a-f0-9]{24}$' }), {
      maxItems: 60,
      uniqueItems: true,
    }),
    mode: Type.Enum(['manual', 'eligible']),
  },
  { additionalProperties: false },
);
const idsSchema = Type.Object(
  { ids: selection.properties.ids, dismissed: Type.Boolean() },
  { additionalProperties: false },
);
const followupSchema = Type.Object(
  {
    runId: Type.Optional(selection.properties.runId),
    ids: selection.properties.ids,
    destinations: Type.Optional(Type.Array(Type.Enum(['public', 'private']), { maxItems: 60 })),
    question: Type.String({ minLength: 1, maxLength: 2000 }),
  },
  { additionalProperties: false },
);
const savedEntitySelection = Type.Object(
  {
    id: Type.String({ pattern: '^entity-[a-f0-9]{24}$' }),
    destination: Type.Optional(Type.Enum(['public', 'private'])),
  },
  { additionalProperties: false },
);
interface ActiveRun extends ObservedRun {
  activity?: ResearchActivityBuffer;
  controller: AbortController;
  requestEpoch?: string;
  events: string[];
  result?: SearchResult;
  provisional?: ProvisionalLead[];
  error?: string;
  batch?: QueryBatch;
  due?: Awaited<ReturnType<typeof runDueOnce>>;
  brief?: SearchResult['brief'];
}
/** Configured supplemental sites widen, never replace, the request's own site scopes. */
const withSiteScopes = (query: SearchRequest, sites: string[] = []) =>
  parseRequest({
    ...query,
    supplementalSites: [...new Set([...sites, ...(query.supplementalSites ?? [])])],
  });
export function searchApi(
  root = process.cwd(),
  search = signalSearch,
  locate = directSearch,
  follow = answerFromEvidence,
  check = checkPrimaryMaterial,
  // Saved-context discussion runner; the default is the no-web Codex runner.
  discussionRunner?: (task: string, schema: unknown) => Pick<SearchRunner, 'discover'>,
  sourceRenderRuntime: SourceRenderRuntime = {},
  sourceCaptureFetcher?: SourceCaptureOptions['fetcher'],
) {
  const token = randomBytes(32).toString('hex');
  const runs = new Map<string, ActiveRun>();
  const requests = requestStore(root);
  const observation = processObservation(root, runs);
  const executionConfiguration = async () => {
    const settings = await loadSettings(root);
    const acquisition = await loadAcquisitionConfig(root);
    if (!settings.model || !settings.effort)
      throw new Error('explicit_execution_configuration_required');
    const snapshot = {
      schema_version: 'signals-execution-v1',
      runner: settings.runner,
      model: settings.model,
      effort: settings.effort,
      acquisition,
      followedSources: settings.followedSources ?? [],
    };
    return { settings, acquisition, digest: requestConfigurationDigest(snapshot) };
  };
  const previews = new Map<string, ProjectPreview>();
  const pruneRuns = () => {
    for (const [key, run] of runs) {
      if (runs.size <= 30) break;
      if (run.result || run.error || run.batch || run.due) {
        runs.delete(key);
        if (!run.reopened) observation.changed();
      }
    }
  };
  const resultFor = (runId: string | undefined) =>
    [...runs.values()].find((run) => run.result && run.result.runId === runId)?.result;
  // A follow-up child reuses its durable job ID as its run UUID, so readback needs no new ledger field.
  const childRunId = (id: string) =>
    `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
  // Explicit fields only: admission internals never leave the owner.
  const followupView = async (view: Awaited<ReturnType<typeof requests.lookup>>) => {
    const reply = {
      code: view.code,
      id: view.id,
      receipt: view.receipt,
      execution_configuration: view.execution_configuration,
      deduplication: view.deduplication,
      reason: view.reason,
    };
    if (!view.id || !view.receipt) return { ...reply, result_ref: null };
    try {
      const exact = await exactOwnerRecord(root, {
        owner: 'signals-ai',
        kind: 'answer',
        id: childRunId(view.id),
        revision: null,
        digest: null,
      });
      const child = JSON.parse(exact.bytes.toString('utf8')) as SearchResult;
      return {
        ...reply,
        result_ref:
          child.followupOf?.requestDigest === view.receipt.request_digest ? exact.ref : null,
      };
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      // Absence is not proof of no effect; the receipt state stays authoritative.
      return { ...reply, result_ref: null, result_reason: error.code };
    }
  };
  // One in-process AI job at a time. Claiming is synchronous so no await separates the
  // check from the set; search-runner's filesystem lease separately guards other processes.
  let active = false;
  const claim = () => {
    if (active) return false;
    active = true;
    return true;
  };
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const path = request.url?.split('?')[0] ?? '';
    if (!path.startsWith('/signals-ai/__signals/api/')) return false;
    const json = (status: number, value: unknown) => {
      response.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      response.end(JSON.stringify(value));
    };
    /** Holds the AI lease for one synchronous answer; busy matches background jobs. */
    const exclusive = async (work: () => Promise<unknown>) => {
      if (!claim()) return json(409, { code: 'runner_busy' });
      try {
        json(200, await work());
      } finally {
        active = false;
      }
    };
    /** Starts a polled background job under the AI lease; failures stay visible in its events. */
    const startJob = (
      first: string,
      fallback: string,
      work: (run: ActiveRun, progress: (event: string) => void) => Promise<void>,
    ) => {
      if (!claim()) return json(409, { code: 'runner_busy' });
      const startedAt = new Date().toISOString();
      const run: ActiveRun = {
        controller: new AbortController(),
        events: [first],
        startedAt,
        lastEvidenceAt: startedAt,
        settled: false,
      };
      const id = randomBytes(16).toString('hex');
      runs.set(id, run);
      observation.changed();
      void work(run, (event) => {
        run.events.push(event);
        run.lastEvidenceAt = new Date().toISOString();
        observation.changed();
        if (run.events.length > 100) run.events.shift();
      })
        .catch((failure: unknown) => {
          run.error = failure instanceof Error ? failure.message : fallback;
          run.events.push(run.error);
          run.lastEvidenceAt = new Date().toISOString();
          observation.changed();
        })
        .finally(() => {
          run.settled = true;
          run.settledAt = new Date().toISOString();
          observation.changed();
          active = false;
          pruneRuns();
        });
      json(202, { id });
    };
    const host = request.headers.host ?? '';
    if (
      !/^127\.0\.0\.1:\d{2,5}$/.test(host) ||
      (request.headers.origin && request.headers.origin !== `http://${host}`) ||
      request.headers['sec-fetch-site'] === 'cross-site'
    ) {
      json(403, { code: 'untrusted_origin' });
      return true;
    }
    const mutation = request.method === 'POST';
    if (mutation && request.headers['x-signals-token'] !== token) {
      json(403, { code: 'csrf_token_required' });
      return true;
    }
    if (!['GET', 'POST'].includes(request.method ?? '')) {
      json(405, { code: 'method_not_allowed' });
      return true;
    }
    try {
      await validateProviderHeaders(
        root,
        request.headers['x-signals-provider-version'],
        request.headers['x-signals-instance-id'],
        request.headers['x-signals-owner-epoch'],
      );
      const route = path.slice('/signals-ai/__signals/api/'.length);
      let body: unknown;
      if (mutation) {
        if (!request.headers['content-type']?.startsWith('application/json'))
          throw new Error('json_required');
        let raw = '';
        const limit = route === 'private-documents' ? 6 * 1024 * 1024 : 128000;
        for await (const chunk of request) {
          raw += String(chunk);
          if (Buffer.byteLength(raw) > limit) throw new Error('request_too_large');
        }
        body = JSON.parse(raw);
      }
      if (route === 'briefing' || route.startsWith('briefing/')) {
        const params = new URL(request.url!, 'http://127.0.0.1').searchParams;
        const result = await briefingRoute(root, route, mutation, body, params.size, params);
        if (result) json(result.status, result.body);
        else json(404, { code: 'unknown_operation' });
      } else if (route === 'private-documents' || route.startsWith('private-documents/')) {
        await validateProcessObserver(
          root,
          request.headers['x-signals-provider-version'],
          request.headers['x-signals-instance-id'],
          request.headers['x-signals-owner-epoch'],
        );
        const params = new URL(request.url!, 'http://127.0.0.1').searchParams;
        if (route === 'private-documents' && mutation) {
          if (params.size)
            throw new PrivateDocumentError(
              400,
              'invalid_private_document',
              'Import does not accept query fields.',
            );
          const requestBody = body as Record<string, unknown>;
          const action = requestBody?.action;
          const payload = Object.fromEntries(
            Object.entries(requestBody ?? {}).filter(([key]) => key !== 'action'),
          );
          if (action === 'preview-correction')
            json(200, await previewPrivateDocumentCorrection(root, payload));
          else if (action === 'correct') json(201, await correctPrivateDocument(root, payload));
          else if (action === undefined || action === 'import')
            json(201, await importPrivateDocument(root, payload));
          else
            throw new PrivateDocumentError(
              400,
              'invalid_private_document',
              'Choose import, preview-correction or correct.',
            );
        } else if (route === 'private-documents' && !mutation) {
          if (params.size)
            throw new PrivateDocumentError(
              400,
              'invalid_private_document',
              'Listing does not accept query fields.',
            );
          json(200, await listPrivateDocuments(root));
        } else if (route === 'private-documents/sections' && mutation) {
          if (params.size)
            throw new PrivateDocumentError(
              400,
              'invalid_private_document',
              'Section inspection does not accept query fields.',
            );
          json(200, await privateDocumentSections(root, body));
        } else if (route === 'private-documents/selection' && mutation) {
          if (params.size)
            throw new PrivateDocumentError(
              400,
              'invalid_private_document',
              'Selection does not accept query fields.',
            );
          json(200, await selectPrivateDocument(root, body, `http://${host}`));
        } else {
          const pageMatch = /^private-documents\/([a-f0-9-]{36})\/pages\/([1-9]\d{0,2})$/.exec(
            route,
          );
          const documentMatch = /^private-documents\/([a-f0-9-]{36})$/.exec(route);
          let exactDocumentRef: RecordRef | undefined;
          if (documentMatch && params.has('ref')) {
            if (
              [...params.keys()].some((key) => key !== 'ref') ||
              params.getAll('ref').length !== 1
            )
              throw new PrivateDocumentError(
                400,
                'invalid_private_document',
                'Exact document reopen accepts one encoded ref.',
              );
            try {
              exactDocumentRef = JSON.parse(params.get('ref')!) as RecordRef;
            } catch {
              throw new PrivateDocumentError(
                400,
                'invalid_private_document',
                'Exact document ref must be encoded JSON.',
              );
            }
          }
          if (mutation) json(404, { code: 'unknown_operation' });
          else if (params.size && (!documentMatch || !exactDocumentRef))
            throw new PrivateDocumentError(
              400,
              'invalid_private_document',
              'Document reads accept no query fields except one exact ref for a document reopen.',
            );
          else if (pageMatch) {
            const reopened = await openPrivateDocument(root, pageMatch[1]!);
            const number = Number(pageMatch[2]);
            const page = reopened.document.pages[number - 1];
            if (!page || page.number !== number)
              throw new PrivateDocumentError(
                404,
                'private_document_page_not_found',
                'No extracted page has that number.',
              );
            json(200, { document_ref: reopened.ref, page });
          } else if (documentMatch)
            json(200, await openPrivateDocument(root, documentMatch[1]!, exactDocumentRef));
          else json(404, { code: 'unknown_operation' });
        }
      } else if (route === 'private-collection' || route.startsWith('private-collection/')) {
        await validateProcessObserver(
          root,
          request.headers['x-signals-provider-version'],
          request.headers['x-signals-instance-id'],
          request.headers['x-signals-owner-epoch'],
        );
        const params = new URL(request.url!, 'http://127.0.0.1').searchParams;
        if (route === 'private-collection/preview' && mutation && !params.size)
          json(200, await previewPrivateCollection(root, body));
        else if (route === 'private-collection/selection' && mutation && !params.size)
          json(200, await selectPrivateCollection(root, body, `http://${host}`));
        else if (route === 'private-collection' && !mutation && !params.size)
          json(200, await listPrivateCollection(root));
        else if (/^private-collection\/[a-f0-9-]{36}$/.test(route) && !mutation && !params.size)
          json(200, await openPrivateCollection(root, route.slice('private-collection/'.length)));
        else json(404, { code: 'unknown_operation' });
      } else if (route === 'private-reader' || route.startsWith('private-reader/')) {
        await validateProcessObserver(
          root,
          request.headers['x-signals-provider-version'],
          request.headers['x-signals-instance-id'],
          request.headers['x-signals-owner-epoch'],
        );
        const params = new URL(request.url!, 'http://127.0.0.1').searchParams;
        if (params.size)
          throw new PrivateReaderError(
            400,
            'invalid_private_reader_request',
            'Reader routes do not accept query fields.',
          );
        if (route === 'private-reader/bytes' && mutation) {
          response.setHeader('pragma', 'no-cache');
          json(200, await readPrivatePdfBytes(root, body));
        } else if (route === 'private-reader' && mutation)
          json(201, await createPrivateReader(root, body));
        else if (route === 'private-reader' && !mutation) json(200, await listPrivateReaders(root));
        else if (route === 'private-reader/revise' && mutation)
          json(200, await revisePrivateReader(root, body));
        else if (route === 'private-reader/selection' && mutation)
          json(200, await selectPrivateReaderAnnotations(root, body, `http://${host}`));
        else if (/^private-reader\/[a-f0-9-]{36}$/.test(route) && !mutation)
          json(200, await openPrivateReader(root, route.slice('private-reader/'.length)));
        else json(404, { code: 'unknown_operation' });
      } else if (
        route === 'source-captures' ||
        route.startsWith('source-captures/') ||
        route === 'source-annotations'
      ) {
        await validateProcessObserver(
          root,
          request.headers['x-signals-provider-version'],
          request.headers['x-signals-instance-id'],
          request.headers['x-signals-owner-epoch'],
        );
        const resolveSource = async (ref: RecordRef) => {
          const exact = await exactOwnerRecord(root, ref);
          return { bytes: exact.bytes, ref: exact.ref as RecordRef };
        };
        const readBriefingContext = async (ref: RecordRef) => {
          if (ref.kind !== 'briefing-item')
            throw new SourceCaptureError(400, 'invalid_source_capture_request', 'Only an exact Briefing item can be captured through this path.');
          const briefRef = { owner: ref.owner, kind: ref.kind, id: ref.id, revision: ref.revision };
          const context = await readBriefingCaptureContext(root, briefRef);
          const sourceRef = {
            owner: 'signals-ai' as const,
            kind: 'briefing-source' as const,
            id: context.sourceReference.id,
            revision: context.sourceReference.revision,
            digest: context.sourceReference.revision.slice('sha256:'.length),
          };
          const exactSource = await resolveSource(sourceRef as RecordRef);
          if (
            exactSource.ref.revision !== sourceRef.revision ||
            exactSource.ref.digest !== sourceRef.digest
          )
            throw new SourceCaptureError(409, 'provider_record_changed', 'The linked Briefing source changed.');
          return {
            item_reference: {
              owner: 'signals-ai' as const,
              kind: 'briefing-item' as const,
              id: ref.id,
              revision: ref.revision,
              digest: ref.digest,
            },
            item_content_digest: context.itemContentDigest,
            source_ref: sourceRef,
            source_health: context.sourceHealth,
            terms_policy: context.termsPolicy ?? {
              id: null,
              sourceId: context.sourceReference.id,
              termsUrl: null,
              status: 'unknown' as const,
              reviewedAt: null,
            },
            observed_at: context.observedAt,
          };
        };
        const routeParams = new URL(request.url!, 'http://127.0.0.1').searchParams;
        if (route === 'source-captures' && mutation) {
          if (routeParams.size)
            throw new SourceCaptureError(
              400,
              'invalid_source_capture_request',
              'Capture creation does not accept query fields.',
            );
          const captureBody = body as Record<string, unknown>;
          const captureId = captureBody?.capture_id;
          const payload = Object.fromEntries(
            Object.entries(captureBody ?? {}).filter(([key]) => key !== 'capture_id'),
          );
          json(
            201,
            await createSourceCapture(
              root,
              payload,
              resolveSource,
              {
                ...(captureId === undefined ? {} : { captureId: captureId as string }),
                readBriefingContext,
                ...(sourceCaptureFetcher ? { fetcher: sourceCaptureFetcher } : {}),
              },
            ),
          );
        } else if (route === 'source-captures' && !mutation) {
          const params = new URL(request.url!, 'http://127.0.0.1').searchParams;
          if (
            [...params.keys()].some((key) => key !== 'source_ref') ||
            params.getAll('source_ref').length > 1
          )
            throw new SourceCaptureError(
              400,
              'invalid_source_capture_request',
              'Use only one optional exact source_ref filter.',
            );
          let sourceRef: unknown;
          if (params.has('source_ref')) {
            try {
              sourceRef = JSON.parse(params.get('source_ref')!);
            } catch {
              throw new SourceCaptureError(
                400,
                'invalid_source_capture_request',
                'source_ref must be URL-encoded closed RecordRef JSON.',
              );
            }
          }
          json(200, await listSourceCaptures(root, sourceRef, resolveSource));
        } else if (route === 'source-captures/render' && mutation) {
          if (routeParams.size)
            throw new SourceRenderError(
              400,
              'invalid_source_render_request',
              'Render creation does not accept query fields.',
            );
          json(200, await renderSourceCapture(root, body, resolveSource, sourceRenderRuntime));
        } else if (route === 'source-captures/render' && !mutation) {
          throw new SourceRenderError(
            405,
            'invalid_source_render_request',
            'Render creation requires an explicit POST action.',
          );
        } else if (/^source-captures\/render-requests\/[a-f0-9-]{36}$/.test(route) && !mutation) {
          if (routeParams.size)
            throw new SourceRenderError(
              400,
              'invalid_source_render_request',
              'Render request readback does not accept query fields.',
            );
          json(200, await readSourceRenderRequest(root, route.split('/')[2]!));
        } else if (/^source-captures\/[a-f0-9-]{36}\/render$/.test(route) && !mutation) {
          if (
            [...routeParams.keys()].some((key) => key !== 'digest') ||
            routeParams.getAll('digest').length > 1
          )
            throw new SourceRenderError(
              400,
              'invalid_source_render_request',
              'Render reopen accepts only one optional exact manifest digest.',
            );
          json(
            200,
            await openSourceRender(
              root,
              route.split('/')[1]!,
              routeParams.get('digest') ?? undefined,
            ),
          );
        } else if (/^source-captures\/[a-f0-9-]{36}\/render\/blob$/.test(route) && !mutation) {
          if (
            routeParams.size !== 2 ||
            !routeParams.has('manifest') ||
            !routeParams.has('artifact')
          )
            throw new SourceRenderError(
              400,
              'invalid_source_render_request',
              'Artifact reopen requires one exact manifest and artifact name.',
            );
          const blob = await readSourceRenderBlob(
            root,
            route.split('/')[1]!,
            routeParams.get('manifest')!,
            routeParams.get('artifact')!,
          );
          response.writeHead(200, {
            'Content-Type': blob.mime,
            'Content-Length': String(blob.bytes.length),
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          });
          response.end(blob.bytes);
        } else if (route === 'source-captures/selection' && mutation) {
          if (routeParams.size)
            throw new SourceCaptureError(
              400,
              'invalid_source_capture_request',
              'Selection does not accept query fields.',
            );
          json(200, await selectSourceCapture(root, body));
        } else if (route === 'source-captures/compare' && !mutation) {
          const params = new URL(request.url!, 'http://127.0.0.1').searchParams;
          if (
            [...params.keys()].some((key) => key !== 'left' && key !== 'right') ||
            params.getAll('left').length !== 1 ||
            params.getAll('right').length !== 1
          )
            throw new SourceCaptureError(
              400,
              'invalid_source_capture_request',
              'Compare requires one left and one right capture UUID.',
            );
          const left = params.get('left')!;
          const right = params.get('right')!;
          const [comparison, renders] = await Promise.all([
            compareSourceCaptures(root, left, right),
            compareSourceRenderAttachments(root, left, right),
          ]);
          json(200, { ...comparison, renders });
        } else if (/^source-captures\/[a-f0-9-]{36}$/.test(route) && !mutation) {
          if (routeParams.size)
            throw new SourceCaptureError(
              400,
              'invalid_source_capture_request',
              'Capture reopen does not accept query fields.',
            );
          json(
            200,
            await openSourceCapture(
              root,
              route.slice('source-captures/'.length),
              resolveSource,
              readBriefingContext,
            ),
          );
        } else if (route === 'source-annotations' && mutation) {
          if (routeParams.size)
            throw new SourceCaptureError(
              400,
              'invalid_source_capture_request',
              'Annotation creation does not accept query fields.',
            );
          json(201, await annotateSource(root, body));
        } else {
          json(404, { code: 'unknown_operation' });
        }
      } else if (route === 'source-change-reviews' || route.startsWith('source-change-reviews/')) {
        await validateProcessObserver(
          root,
          request.headers['x-signals-provider-version'],
          request.headers['x-signals-instance-id'],
          request.headers['x-signals-owner-epoch'],
        );
        const params = new URL(request.url!, 'http://127.0.0.1').searchParams;
        if (route === 'source-change-reviews' && mutation) {
          if (params.size)
            throw new SourceChangeReviewError(
              400,
              'invalid_source_change_review',
              'Review creation does not accept query fields.',
            );
          json(201, await createSourceChangeReview(root, body));
        } else if (route === 'source-change-reviews' && !mutation) {
          if (params.size)
            throw new SourceChangeReviewError(
              400,
              'invalid_source_change_review',
              'Review listing does not accept query fields.',
            );
          json(200, await listSourceChangeReviews(root));
        } else if (route === 'source-change-reviews/compare' && !mutation) {
          if (
            [...params.keys()].some((key) => key !== 'prior' && key !== 'next') ||
            params.getAll('prior').length !== 1 ||
            params.getAll('next').length !== 1
          )
            throw new SourceChangeReviewError(
              400,
              'invalid_source_change_review',
              'Compare requires one prior and one next capture UUID.',
            );
          json(200, await previewSourceChange(root, params.get('prior')!, params.get('next')!));
        } else if (/^source-change-reviews\/[a-f0-9-]{36}$/.test(route) && !mutation) {
          if (params.size)
            throw new SourceChangeReviewError(
              400,
              'invalid_source_change_review',
              'Review reopen does not accept query fields.',
            );
          json(200, await readSourceChangeReview(root, route.split('/')[1]!));
        } else {
          json(404, { code: 'unknown_operation' });
        }
      } else if (
        route === 'project-topic-relevance' ||
        route.startsWith('project-topic-relevance/')
      ) {
        await validateProcessObserver(
          root,
          request.headers['x-signals-provider-version'],
          request.headers['x-signals-instance-id'],
          request.headers['x-signals-owner-epoch'],
        );
        const params = new URL(request.url!, 'http://127.0.0.1').searchParams;
        if (route === 'project-topic-relevance' && mutation) {
          if (params.size)
            throw new ProjectTopicRelevanceError(
              400,
              'invalid_project_topic_relevance',
              'Review creation does not accept query fields.',
            );
          json(201, await createProjectTopicRelevance(root, body));
        } else if (route === 'project-topic-relevance' && !mutation) {
          if (params.size)
            throw new ProjectTopicRelevanceError(
              400,
              'invalid_project_topic_relevance',
              'Review listing does not accept query fields.',
            );
          json(200, await listProjectTopicRelevance(root));
        } else if (route === 'project-topic-relevance/preview' && mutation) {
          if (params.size)
            throw new ProjectTopicRelevanceError(
              400,
              'invalid_project_topic_relevance',
              'Preview does not accept query fields.',
            );
          json(200, await previewProjectTopicRelevance(root, body));
        } else if (/^project-topic-relevance\/[a-f0-9-]{36}$/.test(route) && !mutation) {
          if (params.size)
            throw new ProjectTopicRelevanceError(
              400,
              'invalid_project_topic_relevance',
              'Review reopen does not accept query fields.',
            );
          json(200, await readProjectTopicRelevance(root, route.split('/')[1]!));
        } else {
          json(404, { code: 'unknown_operation' });
        }
      } else if (
        route === 'provider/knowledge' ||
        route.startsWith('knowledge/') ||
        route === 'topics' ||
        route.startsWith('topics/') ||
        route === 'smart-collections' ||
        route.startsWith('smart-collections/')
      ) {
        await validateProcessObserver(
          root,
          request.headers['x-signals-provider-version'],
          request.headers['x-signals-instance-id'],
          request.headers['x-signals-owner-epoch'],
        );
        json(
          200,
          route === 'smart-collections' || route.startsWith('smart-collections/')
            ? await smartCollectionsRoute(root, route, mutation, request.url!, body)
            : await knowledgeRoute(root, route, mutation, request.url!, body),
        );
      } else if (route === 'provider/capabilities' && !mutation)
        json(
          200,
          await providerCapabilities(
            root,
            request.headers['x-signals-provider-version'],
            request.headers['x-signals-instance-id'],
            request.headers['x-signals-owner-epoch'],
          ),
        );
      else if (route === 'provider/records' && !mutation)
        json(
          200,
          await providerRecord(
            root,
            request.url!,
            request.headers['x-signals-provider-version'],
            request.headers['x-signals-instance-id'],
            request.headers['x-signals-owner-epoch'],
          ),
        );
      else if (route === 'provider/library' && !mutation)
        json(
          200,
          await providerLibrary(
            root,
            request.url!,
            request.headers['x-signals-provider-version'],
            request.headers['x-signals-instance-id'],
            request.headers['x-signals-owner-epoch'],
          ),
        );
      else if (route === 'provider/library-explore' && !mutation)
        json(
          200,
          await providerLibraryExplore(
            root,
            request.url!,
            request.headers['x-signals-provider-version'],
            request.headers['x-signals-instance-id'],
            request.headers['x-signals-owner-epoch'],
          ),
        );
      else if (route === 'provider/library-explore/select' && mutation) {
        if (new URL(request.url!, 'http://127.0.0.1').searchParams.size)
          throw new ProviderError(
            400,
            'invalid_library_selection',
            'Selection does not accept query fields.',
          );
        json(
          200,
          await selectProviderLibraryExplore(
            root,
            body,
            request.headers['x-signals-provider-version'],
            request.headers['x-signals-instance-id'],
            request.headers['x-signals-owner-epoch'],
          ),
        );
      } else if (route === 'provider/research-activity' && !mutation) {
        if (request.headers['x-signals-provider-version'] === undefined)
          throw new ProviderError(
            428,
            'provider_owner_binding_required',
            'Bind provider version and trusted owner scope.',
          );
        await validateProcessObserver(
          root,
          request.headers['x-signals-provider-version'],
          request.headers['x-signals-instance-id'],
          request.headers['x-signals-owner-epoch'],
        );
        const query = activityRead(request.url!, observation.storeEpoch);
        const durable = await requests.job(query.id);
        if (!durable?.receipt)
          throw new ProviderError(
            404,
            'research_request_not_found',
            'No request with this exact owner identity.',
          );
        const scope = await requests.scope();
        const run = runs.get(query.id);
        if (run && run.requestEpoch !== scope.epoch)
          throw new ProviderError(
            409,
            'research_activity_owner_mismatch',
            'Request belongs to another owner epoch.',
          );
        const retained = run?.activity?.read(
          query.after,
          query.limit,
          query.session,
          run.settled,
        ) ?? {
          session_id: null,
          availability: 'unavailable',
          reason: 'buffer_unavailable',
          events: [],
          next_cursor: query.after,
          first_sequence: null,
          last_sequence: 0,
          gap: true,
          dropped: 0,
          observation_lost: true,
          last_observed_at: null,
          fresh: false,
          session_settled: false,
          complete: false,
        };
        json(200, {
          schema_version: 'signals-research-activity-v1',
          instance_id: scope.identity,
          owner_epoch: scope.epoch,
          store_epoch: observation.storeEpoch,
          request_id: query.id,
          ...retained,
          as_of: new Date().toISOString(),
          stale_after_seconds: 30,
          owner_settled: Boolean(run?.settled),
          limits: activityLimits,
        });
      } else if (route === 'provider/processes' && !mutation) {
        await validateProcessObserver(
          root,
          request.headers['x-signals-provider-version'],
          request.headers['x-signals-instance-id'],
          request.headers['x-signals-owner-epoch'],
        );
        json(200, await observation.snapshot());
      } else if (route === 'session' && !mutation)
        json(200, {
          token,
          capability: await codexRunner().readiness(),
          providers: acquisitionReadiness(await loadAcquisitionConfig(root)),
          active,
          limits: 'One AI job; quick 8 searches/20 documents/240s; wide 24/60/600s.',
        });
      else if (route === 'request-scope') {
        if (mutation && !Value.Check(Type.Object({}, { additionalProperties: false }), body))
          throw new Error('invalid_request_scope_initialization');
        json(200, mutation ? await requests.initialize() : await requests.scope());
      } else if (route === 'request-configuration' && !mutation) {
        const configuration = await executionConfiguration();
        json(200, {
          schema_version: 'signals-execution-v1',
          digest_algorithm: 'jcs-sha256-v1',
          digest: configuration.digest,
        });
      } else if (/^requests\/[A-Za-z0-9_.:-]{1,128}(\/reconcile)?$/.test(route)) {
        const reconcile = route.endsWith('/reconcile');
        if (
          mutation !== reconcile ||
          (mutation && !Value.Check(Type.Object({}, { additionalProperties: false }), body))
        )
          throw new Error('invalid_request_readback');
        const epoch = String(request.headers['x-signals-owner-epoch'] ?? '');
        const found = await requests.lookup(route.split('/')[1]!, epoch);
        json(found.receipt ? 200 : 404, found);
      } else if (/^followups\/[A-Za-z0-9_.:-]{1,128}$/.test(route) && !mutation) {
        const epoch = String(request.headers['x-signals-owner-epoch'] ?? '');
        const found = await requests.lookup(route.split('/')[1]!, epoch);
        json(found.receipt ? 200 : 404, await followupView(found));
      } else if (route === 'followups' && mutation) {
        const input =
          body &&
          typeof body === 'object' &&
          'schema_version' in body &&
          body.schema_version === '2.0'
            ? parseFollowupRequestV2(body)
            : parseFollowupRequest(body);
        const epoch = String(request.headers['x-signals-owner-epoch'] ?? '');
        const expectedConfiguration = request.headers['x-signals-execution-digest'];
        if (expectedConfiguration !== undefined && typeof expectedConfiguration !== 'string')
          throw new Error('invalid_execution_configuration_digest');
        const configuration = await executionConfiguration();
        const admit = () =>
          requests.admit(
            input,
            epoch,
            configuration.digest,
            expectedConfiguration,
            'frozen-followup',
          );
        if ((await requests.lookup(input.idempotency_key, epoch)).receipt) {
          // Same key: compare its meaning and return the original identity. Never re-run.
          json(202, await followupView(await admit()));
          return true;
        }
        // Every exact parent is verified before admission and before any model call.
        const parentRefs = input.schema_version === '2.0' ? input.parent_refs : [input.parent_ref];
        const parents = await Promise.all(
          parentRefs.map(async (ref) => ({
            ref,
            run: JSON.parse(
              (await exactOwnerRecord(root, ref)).bytes.toString('utf8'),
            ) as SearchResult,
          })),
        );
        const selected =
          input.schema_version === '2.0' ? savedResearchMaterialV2(parents, input.question) : null;
        const frozen =
          selected?.frozen ?? savedResearchMaterial(parents[0]!.run, parents[0]!.ref.kind);
        if (!claim()) {
          json(409, { code: 'runner_busy', reason: 'Another AI job is active; nothing admitted.' });
          return true;
        }
        try {
          const admission = await admit();
          if (!admission.created) {
            active = false;
            json(202, await followupView(admission));
            return true;
          }
          const { record } = admission;
          const started = await requests.dispatch(record.id, epoch);
          const startedAt = new Date().toISOString();
          const run: ActiveRun = {
            controller: new AbortController(),
            requestEpoch: epoch,
            events: ['Discussing saved research. No search, source access or verification.'],
            startedAt,
            lastEvidenceAt: startedAt,
            settled: false,
          };
          runs.set(record.id, run);
          observation.changed();
          void (async () => {
            let retaining = false;
            try {
              const { settings } = configuration;
              const answer = await answerFromRetainedMaterial(
                frozen,
                input.question,
                settings.model || undefined,
                settings.effort || undefined,
                { runner: discussionRunner, signal: run.controller.signal },
              );
              const childInput = {
                runId: childRunId(record.id),
                question: input.question,
                frozen,
                requestDigest: record.digest,
                answer,
                requestedModel: settings.model || null,
                elapsedMs: Date.now() - Date.parse(startedAt),
              };
              const child = selected
                ? followupChildV2({ ...childInput, parents, selection: selected.selection })
                : followupChild({
                    ...childInput,
                    parent: parents[0]!.run,
                    parentRef: parents[0]!.ref,
                  });
              retaining = true;
              await retainRun(child, root);
              run.result = child;
              run.events.push('Follow-up answer retained privately.');
              await requests.settle(
                record.id,
                epoch,
                'complete',
                'followup_complete_child_retained',
              );
            } catch (failure) {
              run.error = failure instanceof Error ? failure.message : 'followup_failed';
              run.events.push(run.error);
              // An interrupted retention write is not a settled effect; readback stays unknown.
              if (!retaining) {
                const cancelled = run.controller.signal.aborted;
                await requests
                  .settle(
                    record.id,
                    epoch,
                    cancelled ? 'cancelled' : 'failed',
                    cancelled ? 'followup_cancelled' : 'followup_failed',
                  )
                  .catch(() => {});
              }
            } finally {
              run.lastEvidenceAt = new Date().toISOString();
              run.settled = true;
              run.settledAt = run.lastEvidenceAt;
              observation.changed();
              active = false;
              pruneRuns();
            }
          })();
          json(202, await followupView(started));
        } catch (failure) {
          active = false;
          throw failure;
        }
      } else if (route === 'settings')
        json(200, mutation ? await saveSettings(body, root) : await loadSettings(root));
      else if (route === 'library' && !mutation) {
        const coverage: string[] = [];
        json(200, { findings: await loadLibrary(root, { coverage }), coverage });
      } else if (route === 'question' && mutation) {
        const schema = Type.Object(
          { question: Type.String({ minLength: 1, maxLength: 2000 }) },
          { additionalProperties: false },
        );
        if (!Value.Check(schema, body)) throw new Error('invalid_question');
        const file = await saveQuery(
          { question: body.question },
          process.env.SIGNALS_QUERY_DIRECTORY ?? resolve(root, '.signals/queries'),
        );
        json(200, { saved: true, id: file.split('/').at(-1) });
      } else if (route === 'library-preferences')
        json(200, await libraryPreferences(root, mutation ? body : undefined));
      else if (route === 'library-search' && mutation) {
        if (!Value.Check(librarySearchSchema, body)) throw new Error('invalid_library_search');
        const preferences = await libraryPreferences(root);
        const settings = await loadSettings(root);
        const controller = new AbortController();
        response.once('close', () => {
          if (!response.writableEnded) controller.abort();
        });
        const busy = active;
        const permitted = preferences.meaningMatching && claim();
        try {
          const result = await matchLibrary(
            await loadLibrary(root, { scope: body.scope }),
            body.query,
            body.filters ?? {},
            {
              permitted,
              model: settings.model || undefined,
              effort: settings.effort || undefined,
              signal: controller.signal,
            },
          );
          json(
            200,
            busy
              ? {
                  ...result,
                  state: 'unavailable',
                  reason: 'Another AI job is active; literal results retained.',
                }
              : result,
          );
        } finally {
          if (permitted) active = false;
        }
      } else if (route === 'library-saved' && mutation) {
        const schema = Type.Object(
          {
            key: Type.String({ minLength: 1, maxLength: 300 }),
            saved: Type.Boolean(),
            note: Type.Optional(Type.String({ maxLength: 4000 })),
            feedback: Type.Optional(Type.Enum(['none', 'skip', 'mute', 'useful'])),
            novelty: Type.Optional(Type.Enum(['confirmed-new', 'known', 'unknown'])),
          },
          { additionalProperties: false },
        );
        if (!Value.Check(schema, body)) throw new Error('invalid_library_saved');
        const { key, saved, ...patch } = body;
        await setLibrarySaved(root, key, saved, patch);
        json(200, { key, saved });
      } else if (route === 'projects' && !mutation)
        json(200, { projects: (await loadProjects(root)).projects });
      else if (route === 'projects/preview' && mutation) {
        const request = checked<{ source: ProjectSource }>(previewRequestSchema, body);
        for (const [id, entry] of previews)
          if (Date.parse(entry.expiresAt) <= Date.now()) previews.delete(id);
        if (previews.size >= 10) throw new Error('too_many_project_previews');
        const preview = await previewProject(request.source, root);
        previews.set(preview.id, preview);
        json(200, preview);
      } else if (route === 'projects/register' && mutation) {
        const request = checked<{
          previewId: string;
          name: string;
          purpose: string;
          constraints: string[];
        }>(registerRequestSchema, body);
        const preview = previews.get(request.previewId);
        if (!preview || Date.parse(preview.expiresAt) <= Date.now())
          throw new Error('project_preview_expired');
        const project = await registerProject(root, {
          ...preview.project,
          name: request.name,
          purpose: request.purpose,
          constraints: request.constraints,
        });
        previews.delete(request.previewId);
        json(200, project);
      } else if (route === 'projects/update' && mutation)
        json(200, await updateProject(root, body));
      else if (route === 'projects/disconnect' && mutation) {
        const request = checked<{ id: string }>(projectIdSchema, body);
        json(200, await disconnectProject(root, request.id));
      } else if (route === 'projects/matches' && mutation) {
        const request = checked<{ id: string }>(projectIdSchema, body);
        json(200, await projectMatches(root, request.id));
      } else if (route === 'projects/history' && mutation) {
        const request = checked<{ id: string }>(projectIdSchema, body);
        json(200, await projectHistory(root, request.id));
      } else if (route === 'projects/research-preview' && mutation)
        json(200, await projectResearchPreview(root, body));
      else if (route === 'projects/ai-setup' && mutation)
        json(200, await projectAiSetup(root, body));
      else if (route === 'opportunities' && !mutation)
        json(200, { opportunities: await listOpportunities(root) });
      else if (route === 'opportunities/attach' && mutation)
        json(200, await attachOpportunity(root, body));
      else if (route === 'opportunities/update' && mutation)
        json(200, await updateOpportunity(root, body));
      else if (route === 'opportunities/project' && mutation)
        json(200, await associateOpportunity(root, body));
      else if (route === 'opportunities/import' && mutation)
        json(200, await importContextOpportunities(root, body));
      else if (route === 'source-scan' && mutation) {
        if (
          !Value.Check(
            Type.Object(
              { interest: Type.Optional(Type.String({ maxLength: 80 })) },
              { additionalProperties: false },
            ),
            body,
          )
        )
          throw new Error('invalid_source_scan');
        json(
          200,
          await scanSources(await loadSettings(root), root, {
            interest: body.interest,
            persist: true,
          }),
        );
      } else if (route === 'personal') {
        if (!mutation) json(200, await loadPersonal(root));
        else {
          const schema = Type.Object(
            {
              id: Type.String({ pattern: '^entity-[a-f0-9]{24}$' }),
              note: Type.String({ maxLength: 5000 }),
              feedback: Type.Enum(['none', 'skip', 'mute', 'useful']),
              novelty: Type.Enum(['confirmed-new', 'known', 'unknown']),
            },
            { additionalProperties: false },
          );
          if (!Value.Check(schema, body)) throw new Error('invalid_personal_state');
          const known =
            [...runs.values()].some((run) =>
              run.result?.items.some((item) => item.entity.id === body.id),
            ) ||
            [
              ...(await loadEntities(resolve(root, 'signals/entities'))),
              ...(await loadEntities(resolve(root, '.signals/corpus/entities'))),
            ].some((record) => record.entity.id === body.id);
          if (!known) throw new Error('unknown_result_identity');
          let introducing = [...runs.values()]
            .flatMap((run) => run.result?.items ?? [])
            .find(
              (item) =>
                item.entity.id === body.id &&
                item.discovery?.linkVerified &&
                item.discovery.provenanceBasis === 'configured-source',
            )?.discovery?.parentUri;
          if (!introducing) introducing = await retainedIntroducingParent(root, body.id);
          json(
            200,
            await updatePersonal(
              root,
              body.id,
              {
                note: body.note,
                feedback: body.feedback,
                novelty: body.novelty,
                seenAt: new Date().toISOString(),
              },
              introducing,
            ),
          );
        }
      } else if (route === 'inbox') {
        if (!mutation) json(200, await loadInbox(root));
        else if (
          Value.Check(
            Type.Object({ remove: selection.properties.ids }, { additionalProperties: false }),
            body,
          )
        ) {
          json(200, await removeInbox(root, body.remove));
        } else {
          if (
            !Value.Check(
              Type.Object(
                {
                  runId: selection.properties.runId,
                  ids: selection.properties.ids,
                  remove: Type.Optional(Type.Boolean()),
                },
                { additionalProperties: false },
              ),
              body,
            )
          )
            throw new Error('invalid_inbox_selection');
          const result = resultFor(body.runId);
          if (!result) throw new Error('unknown_result_identity');
          await retainRun(result, root);
          json(200, await updateInbox(root, result, body.ids, body.remove));
        }
      } else if (route === 'sources' && mutation) {
        const query = parseRequest(body);
        const settings = await loadSettings(root);
        json(
          200,
          await locate(
            withSiteScopes(
              { ...query, sources: query.sources ?? settings.sources },
              settings.supplementalSites,
            ),
          ),
        );
      } else if (route === 'corpus' && !mutation)
        json(200, await loadEntities(resolve(root, 'signals/entities')));
      else if (route === 'private-corpus' && !mutation)
        json(200, await loadEntities(resolve(root, '.signals/corpus/entities')));
      else if (route === 'history' && !mutation)
        json(200, {
          runs: await runHistory(root),
          batches: await queryBatchHistory(root),
          selections: (await selectionHistory(root)).slice(-30).reverse(),
          discovery: JSON.parse(
            await readFile(resolve(root, '.signals/discovery-state.json'), 'utf8').catch(
              () => '{}',
            ),
          ) as unknown,
        });
      else if (route === 'history/open' && mutation) {
        if (
          !Value.Check(
            Type.Object({ runId: selection.properties.runId }, { additionalProperties: false }),
            body,
          )
        )
          throw new Error('invalid_history_selection');
        const result = await loadRun(body.runId, root, (await loadSettings(root)).threshold);
        const id = randomBytes(16).toString('hex');
        const reopenedAt = new Date().toISOString();
        runs.set(id, {
          controller: new AbortController(),
          events: ['Reopened frozen result; no inference or new acquisition.'],
          result,
          startedAt: reopenedAt,
          lastEvidenceAt: reopenedAt,
          settled: true,
          reopened: true,
        });
        pruneRuns();
        json(200, { id });
      } else if (route === 'primary-check' && mutation) {
        if (!Value.Check(savedEntitySelection, body)) throw new Error('invalid_primary_check');
        const { record } = await selectSavedEntity(body.id, root, body.destination);
        const { material, ...checked } = await check(record.entity);
        json(200, {
          ...checked,
          materialDigest:
            material?.response?.status === 304
              ? checked.source?.digest
              : (material?.digest ?? null),
        });
      } else if (
        route === 'search' &&
        mutation &&
        body &&
        typeof body === 'object' &&
        'schema_version' in body
      ) {
        const input = parseResearchRequest(body);
        const epoch = String(request.headers['x-signals-owner-epoch'] ?? '');
        const configuration = await executionConfiguration();
        const expectedConfiguration = request.headers['x-signals-execution-digest'];
        if (expectedConfiguration !== undefined && typeof expectedConfiguration !== 'string')
          throw new Error('invalid_execution_configuration_digest');
        const admission = await requests.admit(
          input,
          epoch,
          configuration.digest,
          expectedConfiguration,
        );
        const { created, record, ...accepted } = admission;
        if (!created) {
          json(202, accepted);
          return true;
        }
        if (!claim()) {
          // This accepted identity is known not to have dispatched. A retry reads
          // that same identity; it cannot become an implicit second execution.
          json(409, { ...accepted, code: 'runner_busy' });
          return true;
        }
        try {
          const query = parseRequest({
            query: input.query,
            method: input.method,
            profile: input.profile,
            save: 'never',
            cache: 'memory',
          });
          const { settings, acquisition } = configuration;
          const runner = codexRunner(settings.model || undefined, settings.effort || undefined, {
            root,
            acquisition,
            settings,
            ...answerFirstOperation(query),
          });
          // Commit uncertainty BEFORE entering the research callback. No read or
          // repeated POST can cross this boundary for an existing identity.
          const started = await requests.dispatch(record.id, epoch);
          const run: ActiveRun = {
            activity: new ResearchActivityBuffer(),
            controller: new AbortController(),
            requestEpoch: epoch,
            events: ['Starting research…'],
            startedAt: new Date().toISOString(),
            lastEvidenceAt: new Date().toISOString(),
            settled: false,
          };
          runs.set(record.id, run);
          observation.changed();
          void (async () => {
            try {
              run.result = await search(query, {
                activity: (event, sessionId) => {
                  run.activity!.accept(event, sessionId);
                },
                root,
                runner,
                acquisition,
                signal: run.controller.signal,
                progress: (event) => {
                  run.events.push(event);
                  run.lastEvidenceAt = new Date().toISOString();
                  observation.changed();
                  if (run.events.length > 100) run.events.shift();
                },
                brief: (brief) => {
                  run.brief = brief;
                },
                provisional: (leads) => {
                  run.provisional = leads;
                },
              });
              await requests.settle(
                record.id,
                epoch,
                run.result.status === 'completed'
                  ? 'complete'
                  : run.result.status === 'not_configured'
                    ? 'failed'
                    : run.result.status,
              );
            } catch (failure) {
              run.error = failure instanceof Error ? failure.message : 'search_failed';
              run.events.push(run.error);
              run.lastEvidenceAt = new Date().toISOString();
              observation.changed();
              // A failed persistence write cannot be called a settled effect.
              if (!run.result) await requests.settle(record.id, epoch, 'failed').catch(() => {});
            } finally {
              run.settled = true;
              run.settledAt = new Date().toISOString();
              observation.changed();
              active = false;
              pruneRuns();
            }
          })();
          json(202, started);
        } catch (failure) {
          active = false;
          throw failure;
        }
      } else if ((route === 'search' || route === 'capture' || route === 'refresh') && mutation) {
        const settings = await loadSettings(root);
        let input = body;
        let refreshDestination = settings.destination;
        let refreshId: string | undefined;
        if (route === 'refresh') {
          if (!Value.Check(savedEntitySelection, body)) throw new Error('invalid_refresh');
          const selected = await selectSavedEntity(body.id, root, body.destination);
          const { record } = selected;
          refreshDestination = selected.destination;
          refreshId = record.entity.id;
          input = refreshRequest(record.entity, settings);
        }
        const query = parseRequest(input);
        if (query.claimOrigin === 'selected-primary')
          throw new Error('selected_primary_producer_unavailable');
        if (route === 'capture' && !query.captureUrls?.length)
          throw new Error('capture_url_required');
        if (query.save === 'eligible') throw new Error('interactive_review_first');
        const effectiveQuery = query.claimOrigin
          ? query
          : withSiteScopes(
              {
                ...query,
                profile: query.profile ?? settings.profile,
                route: query.route ?? settings.route,
                review: query.review ?? settings.groundedReview ?? false,
                threshold: query.threshold ?? settings.threshold,
                sources: settings.sources,
                save: 'never',
              },
              settings.supplementalSites,
            );
        // Preparation that can fail finishes before the lease is claimed.
        const runner = query.claimText
          ? undefined
          : codexRunner(settings.model || undefined, settings.effort || undefined, {
              root,
              acquisition: await loadAcquisitionConfig(root),
              extractionModel: settings.extractionModel || undefined,
              extractionEffort: settings.extractionEffort || undefined,
              ...answerFirstOperation(effectiveQuery),
            });
        startJob('Starting research…', 'search_failed', async (run, progress) => {
          const result = await search(effectiveQuery, {
            root,
            claimRunner: (task, schema) =>
              codexRunner(
                settings.model || undefined,
                settings.effort || undefined,
                claimReviewOperation(root, task, schema),
              ),
            ...(runner ? { runner } : {}),
            signal: run.controller.signal,
            provisional: (leads) => {
              run.provisional = leads;
            },
            brief: (brief) => {
              run.brief = brief;
            },
            progress,
          });
          try {
            const preference = (await libraryPreferences(root)).automaticSaving;
            if (
              route !== 'refresh' &&
              query.cache !== 'memory' &&
              !result.claimCheck &&
              preference?.enabled &&
              !['failed', 'not_configured', 'cancelled'].includes(result.status)
            ) {
              const decisions = result.items.map((item) => {
                const decision = personalSaveDecision(
                  item.entity,
                  item.match,
                  item.relevance,
                  preference.signalThreshold,
                );
                const reasons = [
                  ...decision.reasons,
                  ...((item.relevance?.value ?? -1) < preference.relevanceThreshold
                    ? ['configured_topic_threshold']
                    : []),
                ];
                return { id: item.entity.id, eligible: !reasons.length, reasons };
              });
              const selected = new Set(
                decisions.filter((row) => row.eligible).map((row) => row.id),
              );
              const saved = await saveEntities(
                result.items.filter((item) => selected.has(item.entity.id)),
                'eligible',
                root,
                'private',
                preference.signalThreshold,
                false,
                { runId: result.runId, query: result.query, kind: 'one-off' },
              );
              await saveQuery(
                {
                  kind: 'automatic-personal-saving',
                  runId: result.runId,
                  query: result.query,
                  policy: preference,
                  decisions,
                  saved,
                },
                resolve(root, '.signals/queries'),
              );
              progress(
                `Automatic private saving: ${saved.changed.length} saved, ${decisions.filter((row) => !row.eligible).length} excluded. Decisions retained in private query history.`,
              );
            }
            if (query.cache === 'private') await retainRun(result, root);
            if (
              route === 'refresh' &&
              !['failed', 'not_configured', 'cancelled'].includes(result.status)
            ) {
              const target = result.items.filter((item) => item.entity.id === refreshId);
              if (!target.length) throw new Error('refresh_target_missing');
              const saved = await saveEntities(
                target,
                'refresh',
                root,
                refreshDestination,
                settings.threshold,
                false,
                { runId: result.runId, query: result.query, kind: 'corpus-refresh' },
              );
              if (saved.skipped.length) throw new Error('refresh_target_not_updated');
            }
          } catch (failure) {
            result.gaps.push(
              `Local persistence failed: ${failure instanceof Error ? failure.message : 'unknown'}`,
            );
            result.status = 'partial';
          }
          run.result = result;
        });
      } else if (/^runs\/[a-f0-9]{32}$/.test(route) && !mutation) {
        const run = runs.get(route.split('/')[1]!);
        if (!run) {
          const durable = await requests.job(route.split('/')[1]!);
          if (durable?.receipt) {
            json(200, {
              events: [],
              result: null,
              error: null,
              ...durable,
              resultAvailability: 'memory_result_unavailable_after_restart',
            });
            return true;
          }
        }
        let noteOriginalAvailable: boolean | null = null;
        if (run?.result?.claimCheck?.version === 3) {
          const origin = run.result.claimCheck.origin;
          try {
            const original = await loadRun(origin.parentRunId, root);
            if (partialNoteSelection(original).parentSnapshotDigest !== origin.parentSnapshotDigest)
              throw new Error('invalid_partial_claim_parent');
            noteOriginalAvailable = true;
          } catch (error) {
            if (!(error instanceof Error) || error.message !== 'unknown_retained_run') throw error;
            noteOriginalAvailable = false;
          }
        }
        let noteParent = null;
        let noteParentGap: string | null = null;
        if (
          run?.result &&
          ['cancelled', 'failed'].includes(run.result.status) &&
          run.result.brief?.text
        ) {
          try {
            const retained = await loadRun(run.result.runId, root);
            if (JSON.stringify(retained) !== JSON.stringify(run.result))
              throw new Error('retained_parent_mismatch');
            if (process.env.SIGNALS_PARTIAL_CHECKS === '0')
              throw new Error('partial_checks_disabled');
            noteParent = partialNoteSelection(retained);
          } catch {
            noteParentGap =
              'Checking these notes requires an eligible retained stopped parent with original safe citations. Memory-only work is not saved implicitly.';
          }
        }
        json(
          run ? 200 : 404,
          run
            ? {
                events: run.events,
                result: run.result ?? null,
                provisional: run.result ? [] : (run.provisional ?? []),
                error: run.error ?? null,
                batch: run.batch ?? null,
                due: run.due ?? null,
                brief: run.brief ?? null,
                noteOriginalAvailable,
                noteParent,
                noteParentGap,
              }
            : { code: 'unknown_run' },
        );
      } else if (/^cancel\/[a-f0-9]{32}$/.test(route) && mutation) {
        const id = route.split('/')[1]!;
        const run = runs.get(id);
        const markCancellation = () => {
          if (run && !run.cancelRequestedAt) {
            run.cancelRequestedAt = new Date().toISOString();
            observation.changed();
          }
        };
        if (run?.requestEpoch && !run.result && !run.error) {
          try {
            await requests.cancel(id, run.requestEpoch);
            markCancellation();
          } finally {
            run.controller.abort();
          }
        }
        if (run && !run.requestEpoch && !run.settled) markCancellation();
        run?.controller.abort();
        json(200, { cancelled: !!run });
      } else if (route === 'retain-answer' && mutation) {
        const schema = Type.Object(
          { runId: selection.properties.runId },
          { additionalProperties: false },
        );
        if (!Value.Check(schema, body)) throw new Error('invalid_answer_selection');
        const result = resultFor(body.runId) ?? (await loadRun(body.runId, root).catch(() => null));
        if (!result?.brief?.text) throw new Error('unknown_answer_selection');
        if (!result.answerReceipt && ['partial', 'failed', 'cancelled'].includes(result.status)) {
          const key = `note:private:${result.runId}`;
          try {
            json(200, await retainIncompleteNarrative(root, result));
          } catch (error) {
            const retained = await loadRun(result.runId, root)
              .then((run) => run.brief?.text === result.brief?.text)
              .catch(() => false);
            if (!retained) throw error;
            json(500, { code: 'note_retained_library_update_failed', retained: true, key });
          }
          return true;
        }
        if (
          result.answerReceipt?.state !== 'unassessed' ||
          result.answerReceipt.confidence !== 'unknown'
        )
          throw new Error('unknown_answer_selection');
        await retainRun(result, root);
        const key = `answer:private:${result.runId}`;
        try {
          await setLibrarySaved(root, key, true);
        } catch {
          json(500, { code: 'answer_retained_library_update_failed', retained: true, key });
          return true;
        }
        json(200, { key, runId: result.runId, saved: true });
      } else if (route === 'save-lead' && mutation) {
        const schema = Type.Object(
          { runId: Type.String({ format: 'uuid' }), uri: Type.String({ maxLength: 2048 }) },
          { additionalProperties: false },
        );
        if (!Value.Check(schema, body)) throw new Error('invalid_lead_selection');
        const result = resultFor(body.runId);
        const lead = result?.provisionalLeads?.find((lead) => lead.uri === body.uri);
        if (!result || !lead) throw new Error('unknown_lead_selection');
        json(
          200,
          await saveLibraryLead(root, lead, result.runId, result.query, {
            preserveFragment: !!result.answerReceipt,
          }),
        );
      } else if (route === 'save' && mutation) {
        if (!Value.Check(selection, body)) throw new Error('invalid_selection');
        const selected = body;
        const result = resultFor(selected.runId);
        if (
          !result ||
          selected.ids.some((id) => !result.items.some((item) => item.entity.id === id))
        )
          throw new Error('unknown_result_identity');
        const settings = await loadSettings(root);
        const interests = settings.queries.filter((query) => query.query === result.query);
        json(
          200,
          await saveEntities(
            result.items.filter((item) => selected.ids.includes(item.entity.id)),
            selected.mode,
            root,
            settings.destination,
            settings.threshold,
            false,
            {
              runId: result.runId,
              query: result.query,
              kind: 'one-off',
              ...(interests.length === 1
                ? { queryId: interests[0]!.id, concepts: interests[0]!.concepts }
                : {}),
            },
          ),
        );
      } else if (route === 'dismiss' && mutation) {
        if (!Value.Check(idsSchema, body)) throw new Error('invalid_dismissal');
        const selected = body;
        const path = resolve(root, '.signals/dismissed.json');
        const existing = JSON.parse(await readFile(path, 'utf8').catch(() => '[]')) as string[];
        const ids = selected.dismissed
          ? [...new Set([...existing, ...selected.ids])]
          : existing.filter((id) => !selected.ids.includes(id));
        await atomicJson(path, ids);
        json(200, { ids });
      } else if (route === 'library-discussion' && mutation) {
        const schema = Type.Object(
          {
            keys: Type.Array(Type.String({ maxLength: 300 }), {
              minItems: 1,
              maxItems: 20,
              uniqueItems: true,
            }),
            question: Type.String({ minLength: 1, maxLength: 2000 }),
          },
          { additionalProperties: false },
        );
        if (!Value.Check(schema, body)) throw new Error('invalid_library_discussion');
        const selected = (await loadLibrary(root)).filter((record) =>
          body.keys.includes(record.key),
        );
        if (selected.length !== body.keys.length) throw new Error('unknown_library_identity');
        await exclusive(async () => {
          const settings = await loadSettings(root);
          return answerFromRetainedMaterial(
            frozenLibraryMaterial(selected),
            body.question,
            settings.model || undefined,
            settings.effort || undefined,
          );
        });
      } else if (route === 'followup' && mutation) {
        if (!Value.Check(followupSchema, body)) throw new Error('invalid_followup');
        const question = body;
        let result = resultFor(question.runId);
        if (!question.runId) {
          if (
            !question.ids.length ||
            !question.destinations ||
            question.destinations.length !== question.ids.length
          )
            throw new Error('saved_followup_destination_required');
          const records = await Promise.all(
            question.ids.map((id, index) =>
              selectSavedEntity(id, root, question.destinations![index]),
            ),
          );
          result = {
            schemaVersion: 2,
            runId: randomUUID(),
            query: question.question,
            status: 'completed',
            items: records.map(({ record }) => ({
              entity: record.entity,
              match: { level: 'related', reason: 'User selected retained knowledge', sources: [] },
              eligible: false,
              reasons: ['retained_context_only'],
            })),
            sources: [],
            coverage: [],
            gaps: ['Frozen retained evidence; no current access or independent change check.'],
            usage: {
              searches: 0,
              documents: 0,
              elapsedMs: 0,
              modelCalls: 0,
              providerUsage: null,
              cost: null,
            },
            counts: { leads: records.length, distinct: records.length, duplicates: 0, omitted: 0 },
            limits: budgets.quick,
          };
        } else if (question.destinations) throw new Error('followup_scope_conflict');
        if (
          !result ||
          question.ids.some((id) => !result.items.some((item) => item.entity.id === id))
        )
          throw new Error('unknown_result_identity');
        const scoped = result;
        await exclusive(async () => {
          const settings = await loadSettings(root);
          return follow(
            scoped,
            question.question,
            question.ids,
            settings.model || undefined,
            settings.effort || undefined,
          );
        });
      } else if (/^batches\/[a-f0-9-]{36}$/.test(route) && !mutation) {
        json(200, await loadQueryBatch(route.split('/')[1]!, root));
      } else if (route === 'run-list' && mutation) {
        const schema = Type.Object(
          {
            ids: Type.Optional(
              Type.Array(Type.String({ pattern: '^[a-z0-9-]{1,80}$' }), { maxItems: 512 }),
            ),
            resume: Type.Optional(Type.String({ format: 'uuid' })),
          },
          { additionalProperties: false },
        );
        if (!Value.Check(schema, body)) throw new Error('invalid_query_list');
        const { ids, resume } = body;
        startJob(
          'Starting explicit query-list research…',
          'query_list_failed',
          async (run, progress) => {
            run.batch = await runQueryListOnce({
              root,
              search,
              ids,
              resume,
              signal: run.controller.signal,
              progress,
            });
          },
        );
      } else if (route === 'run-due' && mutation) {
        if (!Value.Check(Type.Object({}, { additionalProperties: false }), body))
          throw new Error('invalid_due_activation');
        startJob(
          'Starting finite due activation…',
          'due_activation_failed',
          async (run, progress) => {
            run.due = await runDueOnce({ root, search, signal: run.controller.signal, progress });
          },
        );
      } else if (route === 'cleanup' && mutation) {
        const settings = await loadSettings(root);
        await cleanRuns(root, settings.retentionDays);
        json(200, { cleaned: true, retainedHistory: 'preserved' });
      } else json(404, { code: 'unknown_operation' });
    } catch (failure) {
      if (failure instanceof ProjectTopicRelevanceError) {
        json(failure.status, { code: failure.code, reason: failure.reason });
        return true;
      }
      if (failure instanceof SourceChangeReviewError) {
        json(failure.status, { code: failure.code, reason: failure.reason });
        return true;
      }
      if (failure instanceof SourceCaptureError) {
        json(failure.status, { code: failure.code, reason: failure.reason });
        return true;
      }
      if (failure instanceof SourceRenderError) {
        json(failure.status, { code: failure.code, reason: failure.reason });
        return true;
      }
      if (failure instanceof PrivateDocumentError) {
        json(failure.status, { code: failure.code, reason: failure.reason });
        return true;
      }
      if (failure instanceof PrivateCollectionError) {
        json(failure.status, { code: failure.code, reason: failure.reason });
        return true;
      }
      if (failure instanceof PrivateReaderError) {
        json(failure.status, { code: failure.code, reason: failure.reason });
        return true;
      }
      if (failure instanceof ProviderError) {
        json(failure.status, { code: failure.code, reason: failure.reason });
        return true;
      }
      const code = failure instanceof Error ? failure.message : 'invalid_request';
      json(
        [
          'request_conflict',
          'owner_epoch_mismatch',
          'request_configuration_changed',
          'request_configuration_conflict',
          'request_identity_version_requires_reconciliation',
        ].includes(code)
          ? 409
          : code.startsWith('request_store_') || code === 'process_snapshot_too_large'
            ? 503
            : 400,
        { code },
      );
    }
    return true;
  };
}
