import { parseArgs } from 'node:util';
import {
  acceptDiscovery,
  signalSearch,
  contextualizeResult,
} from '../packages/corpus/src/signal-search.js';
import { parseRequest, budgets } from '../packages/domain/src/search-contract.js';
import { nativeBriefSchema } from '../packages/domain/src/search-native.js';
import {
  codexRunner,
  answerFirstOperation,
  claimReviewOperation,
  decodeNativeOutput,
} from '../packages/corpus/src/search-runner.js';
import { execFileSync } from 'node:child_process';
import { searchEvidenceBundle } from '../packages/corpus/src/search-exchange.js';
import { retainRun, saveEntities } from '../packages/corpus/src/search-store.js';
import { randomUUID } from 'node:crypto';
import { directSearch } from '../packages/corpus/src/search-direct.js';
import {
  parseGitHubPlans,
  memoryGitHubCache,
  privateGitHubCache,
} from '../packages/corpus/src/search-github.js';
import type { SearchResult } from '../packages/domain/src/search-contract.js';
import { loadAcquisitionConfig } from '../packages/corpus/src/search-acquisition.js';
import { loadSettings } from '../packages/corpus/src/search-settings.js';
import { researchCorpusSlice, checkPrimaryMaterial } from '../packages/corpus/src/search-reuse.js';
import { selectSavedEntity } from '../packages/corpus/src/search-selection.js';

const { values } = parseArgs({
  options: {
    query: { type: 'string' },
    profile: { type: 'string' },
    save: { type: 'string' },
    cache: { type: 'string' },
    site: { type: 'string', multiple: true },
    source: { type: 'string', multiple: true },
    url: { type: 'string', multiple: true },
    threshold: { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string' },
    'extract-model': { type: 'string' },
    'extract-effort': { type: 'string' },
    json: { type: 'boolean' },
    schema: { type: 'boolean' },
    capability: { type: 'boolean' },
    review: { type: 'boolean' },
    method: { type: 'string' },
    'suggest-checks': { type: 'boolean' },
    'suggestion-index': { type: 'string' },
    'offered-digest': { type: 'string' },
    'assessment-of': { type: 'string' },
    claim: { type: 'string' },
    'claim-origin': { type: 'string' },
    'sources-only': { type: 'boolean' },
    'github-plan': { type: 'string' },
    'corpus-only': { type: 'boolean' },
    'check-primary': { type: 'string' },
    destination: { type: 'string' },
    accept: { type: 'boolean' },
    context: { type: 'boolean' },
  },
});
try {
  if (
    (values.claim !== undefined || values['claim-origin'] !== undefined) &&
    (values.accept ||
      values['sources-only'] ||
      values['corpus-only'] ||
      values['check-primary'] ||
      values.context ||
      values.schema ||
      values.capability)
  )
    throw new Error(
      values['claim-origin'] ? 'claim_requires_check_route' : 'claim_requires_linked_check_route',
    );
  if (values['suggest-checks'] && values.accept)
    throw new Error('suggestions_require_answer_route');
  if (values['suggestion-index'] !== undefined && !/^[0-2]$/.test(values['suggestion-index']))
    throw new Error('invalid_suggestion_selection');
  if (values.schema) process.stdout.write(`${JSON.stringify(nativeBriefSchema)}\n`);
  else if (values.capability)
    process.stdout.write(
      `${JSON.stringify({ ...(await codexRunner().readiness()), limits: budgets, persistence: 'none unless selected', unattended: false })}\n`,
    );
  else {
    const request = parseRequest({
      query: values.query ?? (values['check-primary'] ? 'Check saved primary source' : undefined),
      profile: values.profile ?? (values['claim-origin'] === 'request' ? 'quick' : 'wide'),
      route: 'native',
      method: values.method,
      suggestChecks: values['suggest-checks'],
      suggestionIndex:
        values['suggestion-index'] === undefined ? undefined : Number(values['suggestion-index']),
      offeredDigest: values['offered-digest'],
      assessmentOf: values['assessment-of'],
      claimText: values.claim,
      claimOrigin: values['claim-origin'],
      save: values.save ?? 'never',
      cache: values.cache ?? 'memory',
      supplementalSites: values.site,
      sources: values.source,
      captureUrls: values.url,
      review: values.review ?? false,
      threshold: Number(values.threshold ?? 75),
    });
    const controller = new AbortController();
    if (values['corpus-only']) {
      process.stdout.write(
        `${JSON.stringify(await researchCorpusSlice(request, process.cwd()), null, 2)}\n`,
      );
      process.exit(0);
    }
    if (values['check-primary']) {
      if (values.destination !== undefined && !['public', 'private'].includes(values.destination))
        throw new Error('invalid_entity_destination');
      const { record } = await selectSavedEntity(
        values['check-primary'],
        process.cwd(),
        values.destination as 'public' | 'private' | undefined,
      );
      const { material, ...check } = await checkPrimaryMaterial(record.entity, {
        signal: controller.signal,
      });
      process.stdout.write(
        `${JSON.stringify({ ...check, materialDigest: material?.response?.status === 304 ? check.source?.digest : (material?.digest ?? null) }, null, 2)}\n`,
      );
      process.exit(0);
    }
    const githubPlans = values['github-plan']
      ? parseGitHubPlans(JSON.parse(values['github-plan']))
      : undefined;
    if (values['sources-only']) {
      process.stdout.write(
        `${JSON.stringify(await directSearch(request, controller.signal, undefined, githubPlans ? { plans: githubPlans, cache: request.cache === 'private' ? privateGitHubCache(process.cwd()) : memoryGitHubCache() } : undefined), null, 2)}\n`,
      );
      process.exit(0);
    }
    process.once('SIGINT', () => controller.abort());
    process.once('SIGTERM', () => controller.abort());
    let input = '';
    if (values.accept)
      for await (const chunk of process.stdin) {
        input += String(chunk);
        if (input.length > 2000000) throw new Error('proposal_bytes_limit');
      }
    const started = Date.now();
    const result: SearchResult = values.accept
      ? {
          schemaVersion: 2,
          runId: randomUUID(),
          query: request.query,
          status: 'completed',
          ...(await acceptDiscovery(decodeNativeOutput(input), request, {
            signal: controller.signal,
            followedSources: (await loadSettings(process.cwd())).followedSources
              ?.filter((source) => source.enabled)
              .map((source) => source.uri),
          })),
          usage: {
            searches: 0,
            documents: 0,
            elapsedMs: 0,
            modelCalls: 0,
            providerUsage: { nativeHost: 'not instrumented by helper' },
            cost: null,
          },
          limits: budgets[request.profile ?? 'wide'],
        }
      : await signalSearch(request, {
          claimRunner: (task, schema) =>
            codexRunner(
              values.model ?? 'gpt-6.1-sol',
              values.effort ?? 'low',
              claimReviewOperation(process.cwd(), task, schema),
            ),
          ...(request.claimText
            ? {}
            : {
                runner: codexRunner(values.model ?? 'gpt-6.1-sol', values.effort ?? 'low', {
                  githubPlans,
                  root: process.cwd(),
                  acquisition: await loadAcquisitionConfig(process.cwd()),
                  extractionModel: values['extract-model'],
                  extractionEffort: values['extract-effort'],
                  ...answerFirstOperation(request),
                }),
              }),
          signal: controller.signal,
          progress: (event) => process.stderr.write(`${event}\n`),
        });
    if (values.accept) {
      await contextualizeResult(result, process.cwd());
      result.usage.documents = result.sources.filter((source) => source.state === 'fetched').length;
      // Native acquisition is owned by the caller; family counts can overlap.
      // This helper performs no search tool calls and cannot infer the host's usage.
      result.usage.elapsedMs = Date.now() - started;
      if (result.gaps.length || result.sources.some((source) => source.state !== 'fetched'))
        result.status = 'partial';
      if (controller.signal.aborted) result.status = 'cancelled';
    }
    if (values.accept && request.save === 'eligible' && result.status !== 'cancelled') {
      const saved = await saveEntities(
        result.items,
        'eligible',
        process.cwd(),
        'public',
        request.threshold ?? 75,
        false,
        { runId: result.runId, query: result.query, kind: 'one-off' },
      );
      result.persistence = { changed: saved.changed, skipped: saved.skipped, privateRun: false };
    }
    if (values.accept && request.cache === 'private') {
      result.persistence = { changed: [], skipped: [], ...result.persistence, privateRun: true };
      await retainRun(result);
    }
    const output =
      values.context && 'runId' in result
        ? searchEvidenceBundle(
            result,
            execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
          )
        : result;
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if ('status' in result && ['failed', 'not_configured'].includes(result.status))
      process.exitCode = 1;
  }
} catch (failure) {
  process.stdout.write(
    `${JSON.stringify({ status: 'failed', code: failure instanceof Error ? failure.message : 'search_failed' })}\n`,
  );
  process.exitCode = 1;
}
