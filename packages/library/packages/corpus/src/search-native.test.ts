import { describe, it, expect } from 'vitest';
import { mkdtemp, readdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeProposal, decodeNativeResearch } from '../../domain/src/search-native.js';
import { acceptDiscovery, signalSearch } from './signal-search.js';
import { recoverOriginalAnswer, RunnerFailure, type SearchRunner } from './search-runner.js';
import { loadRun } from './search-store.js';

const brief = () => ({
  version: 1,
  sources: [
    {
      uri: 'https://example.org/guide',
      title: 'Guide',
      publisher: 'Author',
      family: 'primary',
      publishedAt: null,
      origin: 'author',
    },
    {
      uri: 'https://example.org/unread',
      title: 'Uninspected locator',
      publisher: 'Author',
      family: 'primary',
      publishedAt: null,
      origin: 'author',
    },
  ],
  candidates: [
    {
      uri: 'https://example.org/guide',
      name: 'Guide',
      kind: 'learning-resource',
      identity: 'resolved',
      description: 'A portable guide.',
      capabilities: ['portable notes'],
      match: { level: 'direct', reason: 'Addresses portable notes.', sources: [0] },
      limits: ['No independent use demonstrated.'],
      observations: [
        {
          source: 0,
          feature: 'defining',
          indicator: 'defines',
          statement: 'Provides a portable guide.',
          quote: 'portable guide',
          independent: false,
          origin: 'author',
          status: 'supported',
        },
      ],
    },
  ],
  coverage: [],
  gaps: [],
});
describe('native brief kernel boundary', () => {
  const currentBrief = () => {
    const old = brief();
    return {
      ...old,
      version: 3,
      answer:
        'Start with this [portable guide](https://example.org/guide). It preserves portable notes; independent use remains unverified.',
      candidates: old.candidates.map((candidate) => ({
        ...candidate,
        observations: candidate.observations.map(({ feature, indicator, ...fact }) => ({
          ...fact,
          signal: `${feature}/${indicator}`,
        })),
      })),
    };
  };
  it('retains the original answer, valid sibling and good facts when secondary metadata fails', async () => {
    const input = currentBrief();
    input.candidates.push({
      ...input.candidates[0]!,
      name: 'Malformed sibling',
      kind: 'not-a-kind',
    });
    input.candidates[0]!.observations.push({
      ...input.candidates[0]!.observations[0]!,
      source: 99,
    });
    const decoded = decodeNativeResearch(input);
    expect(decoded.brief?.text).toBe(input.answer);
    expect(decoded.proposal.candidates).toHaveLength(1);
    expect(decoded.proposal.candidates[0]!.observations).toHaveLength(1);
    expect(decoded.provisionalLeads[0]!.name).toBe('Malformed sibling');
    expect(decoded.proposal.gaps.join(' ')).toContain('observation 1');
    const accepted = await acceptDiscovery(
      input,
      { query: 'Portable notes', route: 'native' },
      { fetch: async (uri) => ({ uri, text: 'A portable guide.', digest: 'a'.repeat(64) }) },
    );
    expect(accepted.brief?.text).toBe(input.answer);
    expect(accepted.items).toHaveLength(1);
    expect(accepted.items[0]!.entity.observations[0]!.verified).toBe(true);
    expect(accepted.provisionalLeads).toHaveLength(1);
  });
  it('remaps surviving source indices without manufacturing support from a malformed source', () => {
    const input = currentBrief();
    input.sources.unshift({ ...input.sources[0]!, family: 'bogus' });
    input.candidates[0]!.observations[0]!.source = 1;
    input.candidates[0]!.match.sources = [1];
    const decoded = decodeNativeResearch(input);
    expect(decoded.proposal.sources).toHaveLength(2);
    expect(decoded.proposal.candidates[0]!.observations[0]!.source).toBe(0);
    expect(decoded.proposal.gaps.join(' ')).toContain('Source 0');
  });
  it('drops unsafe optional discovery metadata while preserving supported defining facts', () => {
    const input = {
      ...currentBrief(),
      candidates: [
        {
          ...currentBrief().candidates[0]!,
          discovery: { introducedBy: 'hub-discovered', parentUri: 'http://127.0.0.1/private' },
        },
      ],
    };
    const decoded = decodeNativeResearch(input);
    expect(decoded.proposal.candidates).toHaveLength(1);
    expect(decoded.proposal.candidates[0]!.discovery).toBeUndefined();
    expect(decoded.proposal.candidates[0]!.observations).toHaveLength(1);
    expect(decoded.proposal.gaps.join(' ')).toContain('discovery metadata is invalid');
  });
  it('delivers the original answer before record validation and inspection, preserving it after cancellation', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-early-answer-')));
    const controller = new AbortController();
    const events: string[] = [];
    try {
      const input = currentBrief();
      const result = await signalSearch(
        { query: 'Portable notes', cache: 'memory', save: 'eligible' },
        {
          root,
          signal: controller.signal,
          brief: (brief) => {
            expect(brief.text).toBe(input.answer);
            events.push('answer');
            controller.abort();
          },
          runner: {
            readiness: async () => ({
              available: true,
              broadSearch: true,
              runner: 'fixture',
              reason: 'fixture',
            }),
            discover: async () => ({ proposal: input, usage: null, searches: 1 }),
          },
          fetch: async (uri) => {
            events.push('fetch');
            return { uri, text: 'A portable guide.', digest: 'a'.repeat(64) };
          },
        },
      );
      expect(events).toEqual(['answer']);
      expect(result.status).toBe('cancelled');
      expect(result.brief?.text).toBe(input.answer);
      expect(result.persistence).toBeUndefined();
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('recovers only an original answer from a broken transport and never creates facts', () => {
    expect(
      recoverOriginalAnswer('{"version":3,"answer":"Useful original answer.","candidates":BROKEN'),
    ).toEqual({ format: 'markdown', text: 'Useful original answer.' });
    expect(recoverOriginalAnswer('{"version":3,"answer":"unfinished')).toBeUndefined();
  });
  it('preserves the brief and unassessed leads when metadata exceeds inspection budgets', async () => {
    const input = currentBrief();
    input.sources = Array.from({ length: 21 }, (_, index) => ({
      ...input.sources[0]!,
      uri: `https://example.org/source-${index}`,
    }));
    input.candidates = Array.from({ length: 21 }, (_, index) => ({
      ...input.candidates[0]!,
      uri: `https://example.org/guide-${index}`,
      name: `Guide ${index}`,
      match: { ...input.candidates[0]!.match, sources: [index] },
      observations: [{ ...input.candidates[0]!.observations[0]!, source: index }],
    }));
    let fetched = 0;
    const result = await acceptDiscovery(
      input,
      { query: 'Portable notes', profile: 'quick', route: 'native' },
      {
        fetch: async (uri) => {
          fetched++;
          return { uri, text: 'A portable guide.', digest: 'a'.repeat(64) };
        },
      },
    );
    expect(result.brief?.text).toBe(input.answer);
    expect(fetched).toBe(20);
    expect(result.items).toHaveLength(20);
    expect(result.provisionalLeads).toHaveLength(1);
    expect(result.gaps.join(' ')).toContain('budget exhausted');
  });
  it('retains and reopens the useful answer privately even when record formatting or cancellation fails', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-answer-retention-')));
    try {
      const original = { format: 'markdown' as const, text: currentBrief().answer };
      const result = await signalSearch(
        { query: 'Portable notes', cache: 'private', save: 'never' },
        {
          root,
          runner: {
            readiness: async () => ({
              available: true,
              broadSearch: true,
              runner: 'fixture',
              reason: 'fixture',
            }),
            discover: async () => {
              throw new RunnerFailure('record_format_failed', 1, null, original);
            },
          },
        },
      );
      expect(result.items).toEqual([]);
      expect(result.brief).toEqual(original);
      expect((await loadRun(result.runId, root)).brief).toEqual(original);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('encodes only existing valid signal pairs and projects version 2 identically', () => {
    const old = brief();
    const current = {
      ...old,
      version: 2,
      candidates: old.candidates.map((candidate) => ({
        ...candidate,
        observations: candidate.observations.map(({ feature, indicator, ...fact }) => ({
          ...fact,
          signal: `${feature}/${indicator}`,
        })),
      })),
    };
    expect(nativeProposal(current)).toEqual(nativeProposal(old));
    current.candidates[0]!.observations[0]!.signal = 'verification/documented';
    expect(() => nativeProposal(current)).toThrow('invalid_native_brief');
  });
  it('keeps missing facets/dimensions unknown and rejects invalid binding vocabulary', () => {
    const proposal = nativeProposal(brief());
    expect(proposal.candidates[0]!.facets.domains).toEqual([]);
    expect(proposal.candidates[0]!.observations).toHaveLength(1);
    const invalid = brief();
    invalid.candidates[0]!.observations[0]!.indicator = 'broad';
    expect(() => nativeProposal(invalid)).toThrow('invalid_native_brief');
    const unbound = brief();
    unbound.candidates[0]!.observations[0]!.source = 11;
    expect(() => nativeProposal(unbound)).toThrow('invalid_evidence_binding');
  });
  it('checks claimed facts while transparently deferring unused source locators', async () => {
    const fetched: string[] = [];
    const result = await acceptDiscovery(
      nativeProposal(brief()),
      { query: 'Portable notes', route: 'native' },
      {
        fetch: async (uri) => {
          fetched.push(uri);
          return { uri, text: 'A portable guide for notes.', digest: 'a'.repeat(64) };
        },
      },
    );
    expect(fetched).toEqual(['https://example.org/guide']);
    expect(result.sources[1]!.reason).toBe('native_inspection_deferred');
    expect(result.items[0]!.eligible).toBe(false);
  });
  it.each(['native', 'assessed'] as const)(
    'emits provisional leads on %s without a second session or memory writes',
    async (route) => {
      const root = await mkdtemp(join(tmpdir(), 'signals-native-test-'));
      try {
        const events: string[] = [];
        const runner: SearchRunner = {
          readiness: async () => ({
            available: true,
            broadSearch: true,
            runner: 'fixture',
            reason: 'fixture',
          }),
          discover: async () => ({ proposal: nativeProposal(brief()), usage: null, searches: 1 }),
          enrich: async () => {
            throw new Error('second_session');
          },
        };
        const result = await signalSearch(
          { query: 'Portable notes', route, cache: 'memory', save: 'never' },
          {
            root,
            runner,
            provisional: (leads) => {
              events.push('provisional');
              expect(Object.keys(leads[0]!)).toEqual(['uri', 'name', 'description', 'limits']);
            },
            fetch: async (uri) => {
              events.push('fetch');
              return { uri, text: 'A portable guide for notes.', digest: 'a'.repeat(64) };
            },
          },
        );
        expect(events).toEqual(['provisional', 'fetch']);
        expect(result.usage.modelCalls).toBe(1);
        expect(result.usage.stages?.firstValidatedMs).toBeGreaterThanOrEqual(
          result.usage.stages!.answerReadyMs,
        );
        expect(await readdir(root)).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it('honors an explicitly requested additional grounded review on the native route', async () => {
    const root = await mkdtemp(join(tmpdir(), 'signals-native-review-'));
    let extra = 0;
    const runner: SearchRunner = {
      readiness: async () => ({
        available: true,
        broadSearch: true,
        runner: 'fixture',
        reason: 'fixture',
      }),
      discover: async () => ({ proposal: nativeProposal(brief()), usage: null, searches: 1 }),
      enrich: async (proposal) => {
        extra++;
        return { proposal, usage: { fixture: true } };
      },
    };
    try {
      const result = await signalSearch(
        { query: 'Portable notes', route: 'native', review: true, cache: 'memory', save: 'never' },
        {
          root,
          runner,
          fetch: async (uri) => ({
            uri,
            text: 'A portable guide for notes.',
            digest: 'a'.repeat(64),
          }),
        },
      );
      expect(result.status).toBe('completed');
      expect(extra).toBe(1);
      expect(result.usage.modelCalls).toBe(2);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
