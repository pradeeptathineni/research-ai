import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { normalizeConsiderUrl } from '../../domain/src/url.js';
import { saveQuery } from './research-store.js';
import { saveLibraryLeads, loadLibraryLeads } from './library-leads.js';
import { atomicJson } from './search-store.js';
import { loadLibrary } from './library.js';
import { searchLibrary } from '../../domain/src/library-search.js';
import { validateGrounding, type Grounding } from '@pradeeptathineni/research-ai';

export interface ResearchAnswer {
  grounding?: Grounding;
  query: string;
  answer: string;
  observedAt: string;
  provenance: { receipt: string; requestedModel: string | null; servedModel: string | null };
}
function pairedEnd(text: string, start: number, opening: string, closing: string, limit: number) {
  let depth = 1;
  for (let i = start + 1; i < Math.min(text.length, start + limit + 1); i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === opening) depth++;
    if (text[i] === closing && --depth === 0) return i;
  }
  return -1;
}
/** Bounded inline-link lexer; fenced and inline code never grant citation authority. */
function* inlineLinks(text: string) {
  for (let i = 0; i < text.length; i++) {
    if (i === 0 || text[i - 1] === '\n') {
      if (/^(?: {4}|\t)/u.test(text.slice(i))) {
        const next = text.indexOf('\n', i);
        if (next < 0) return;
        i = next;
        continue;
      }
      const fence = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/u.exec(text.slice(i));
      if (fence) {
        const tail = text.slice(i + fence[0].length);
        const close = new RegExp(
          '^ {0,3}' + fence[1]![0] + '{' + fence[1]!.length + ',}[ \\t]*$',
          'm',
        ).exec(tail);
        if (!close) return;
        i += fence[0].length + close.index + close[0].length - 1;
        continue;
      }
    }
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === '`') {
      let size = 1;
      while (text[i + size] === '`') size++;
      let end = text.indexOf('`'.repeat(size), i + size);
      while (end >= 0 && (text[end - 1] === '`' || text[end + size] === '`'))
        end = text.indexOf('`'.repeat(size), end + size);
      if (end >= 0) {
        i = end + size - 1;
        continue;
      }
      i += size - 1;
      continue;
    }
    if (text[i] !== '[' || text[i - 1] === '!') continue;
    const labelEnd = pairedEnd(text, i, '[', ']', 201);
    if (labelEnd < 0 || text[labelEnd + 1] !== '(') continue;
    const end = pairedEnd(text, labelEnd + 1, '(', ')', 4097);
    if (end < 0) continue;
    const label = text.slice(i + 1, labelEnd);
    if (!label || label.length > 200 || label.includes('\n')) continue;
    const target = text.slice(labelEnd + 2, end).trim();
    const destination = target.startsWith('<')
      ? /^<([^>]+)>/u.exec(target)?.[1]
      : /^\S+/u.exec(target)?.[0];
    if (!destination) continue;
    const targetLength = target.startsWith('<') ? destination.length + 2 : destination.length;
    const title = target.slice(targetLength).trim();
    if (title && !/^(?:"[^"\n]*"|'[^'\n]*'|\([^\n]*\))$/u.test(title)) continue;
    yield {
      start: i,
      end: end + 1,
      label,
      destination: destination.replace(/\\([\\()[\]<>])/gu, '$1'),
    };
    i = end;
  }
}
const citationUri = (uri: string) => normalizeConsiderUrl(uri).normalizedUrl + new URL(uri).hash;
/** Only literal inline references are recognized; their labels are not entity/type judgments. */
export function planResearchRetention(input: ResearchAnswer) {
  if (
    typeof input.query !== 'string' ||
    typeof input.answer !== 'string' ||
    typeof input.observedAt !== 'string' ||
    typeof input.provenance?.receipt !== 'string' ||
    !input.provenance.receipt.trim() ||
    input.provenance.receipt.length > 2000 ||
    ![input.provenance.requestedModel, input.provenance.servedModel].every(
      (model) => model === null || (typeof model === 'string' && model.length <= 200),
    ) ||
    !input.query.trim() ||
    input.query.length > 2000 ||
    !input.answer.trim() ||
    input.answer.length > 100000 ||
    !Number.isFinite(Date.parse(input.observedAt))
  )
    throw new Error('invalid_research_answer');
  if (input.grounding !== undefined) {
    validateGrounding(input.answer, input.grounding);
    for (const source of input.grounding.sources) normalizeConsiderUrl(source.uri);
  }
  return {
    input,
    answerSha256: createHash('sha256').update(input.answer).digest('hex'),
    ...retainedPartialCitationsV1(input.answer),
    limits: [
      ...(input.grounding?.limits ?? []),
      'Only ordinary inline Markdown citations outside code are recognized; bare URLs, reference-style links and unsupported Markdown remain in the raw answer.',
      'Inline labels are limited to 200 characters and destination/title segments to 4096; oversized references remain in the raw answer without citation credit.',
      'Citation destinations preserve fragments; base identity is separate and does not merge distinct navigation targets or entities.',
      'Citation occurrence validates a reference, not claim truth, source entailment or independent provenance.',
      'Observation time is receipt time, not source publication or factual freshness.',
    ],
  };
}

/** The existing citation lexer, without creating an answer or receipt. */
/** retained-partial-citations-v1: preserve this lexer/URI behavior for saved readers when extending grammar. */
export function retainedPartialCitationsV1(answer: string) {
  const citations = new Map<
    string,
    {
      uri: string;
      identityBase: string;
      label: string;
      context: string;
      assertions: {
        type: 'citation-reference';
        literal: string;
        start: number;
        end: number;
        truth: 'unverified';
        sourcePublishedAt: null;
      }[];
    }
  >();
  const rejectedReferences: { literal: string; reason: string }[] = [];
  for (const match of inlineLinks(answer)) {
    try {
      const uri = citationUri(match.destination);
      const start = match.start;
      const paragraphStart = answer.lastIndexOf('\n', start) + 1;
      const nextLine = answer.indexOf('\n', start);
      const context = answer
        .slice(paragraphStart, nextLine < 0 ? undefined : nextLine)
        .slice(0, 2000);
      const citation = citations.get(uri) ?? {
        uri,
        identityBase: normalizeConsiderUrl(uri).normalizedUrl,
        label: match.label,
        context,
        assertions: [],
      };
      citation.assertions.push({
        type: 'citation-reference',
        literal: answer.slice(start, match.end),
        start,
        end: match.end,
        truth: 'unverified',
        sourcePublishedAt: null,
      });
      citations.set(uri, citation);
    } catch (error) {
      rejectedReferences.push({
        literal: answer.slice(match.start, match.end),
        reason: error instanceof Error ? error.message : 'invalid_uri',
      });
    }
  }
  return {
    citations: [...citations.values()],
    rejectedReferences,
  };
}

/** A private query and explicitly selected unassessed leads; never public corpus admission. */
export async function retainResearchAnswer(
  root: string,
  input: ResearchAnswer,
  selectedUris: string[],
) {
  const started = performance.now();
  const plan = planResearchRetention(input);
  const selected = [...new Set(selectedUris.map(citationUri))];
  for (const uri of selected)
    if (!plan.citations.some((citation) => citation.uri === uri))
      throw new Error('selection_not_cited_in_answer');
  const runId = randomUUID();
  const answerPath = await saveQuery(
    { ...plan, runId, selectedUris: selected },
    resolve(root, '.signals/queries'),
  );
  const prepared = selected.map((uri) => {
    const citation = plan.citations.find((item) => item.uri === uri)!;
    return {
      uri,
      name: citation.label,
      description: citation.context,
      limits: [
        'Retained from a native answer; claims have not been independently verified.',
        'License, access, source publication date, resource type and confidence remain unknown.',
        `Original answer retained privately at ${answerPath}`,
      ],
    };
  });
  let leads: Awaited<ReturnType<typeof saveLibraryLeads>> = [];
  let failure: string | null = null;
  let leadCommitState: 'confirmed' | 'unknown' = 'confirmed';
  try {
    leads = await saveLibraryLeads(root, prepared, runId, input.query, { preserveFragment: true });
  } catch (error) {
    failure = error instanceof Error ? error.message : 'lead_batch_failed';
    try {
      leads = (await loadLibraryLeads(root))
        .filter(
          (item) =>
            selected.includes(item.uri) &&
            item.lead!.history.some((snapshot) => snapshot.runId === runId),
        )
        .map((item) => ({ key: item.key, id: item.id, state: 'saved-lead' }));
    } catch {
      leadCommitState = 'unknown';
    }
  }
  const receipt = {
    runId,
    answerPath,
    selectedUris: selected,
    leads,
    failure,
    leadCommitState,
    status:
      leadCommitState === 'unknown'
        ? 'uncertain'
        : failure
          ? leads.length === selected.length
            ? 'complete-with-warning'
            : leads.length
              ? 'partial'
              : 'answer-only'
          : 'complete',
    recovery: failure
      ? 'Original answer is saved. Inspect confirmed/unknown lead outcomes and the failure before any new explicit attempt; do not blindly retry the whole selection.'
      : null,
    elapsedMs: performance.now() - started,
    researchCalls: 0,
    modelCalls: 0,
    publicWrites: 0,
  };
  const receiptPath = resolve(root, '.signals/retention-receipts', runId + '.json');
  let receiptSaveError: string | null = null;
  try {
    await atomicJson(receiptPath, receipt);
  } catch (error) {
    receiptSaveError = error instanceof Error ? error.message : 'receipt_save_failed';
  }
  return { ...receipt, receiptPath: receiptSaveError ? null : receiptPath, receiptSaveError };
}

export async function rediscoverResearch(root: string, query: string) {
  return searchLibrary(await loadLibrary(root), query, {
    kind: 'lead',
    destination: 'private',
    saved: true,
  });
}

export function compareResearchAnswers(first: ResearchAnswer, second: ResearchAnswer) {
  const a = new Set(planResearchRetention(first).citations.map((item) => item.uri));
  const b = new Set(planResearchRetention(second).citations.map((item) => item.uri));
  return {
    sharedCitations: [...a].filter((uri) => b.has(uri)),
    newlyCited: [...b].filter((uri) => !a.has(uri)),
    noLongerCited: [...a].filter((uri) => !b.has(uri)),
    meaning: 'Locator changes only; no inferred change in truth, quality or coverage.',
  };
}
