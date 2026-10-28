import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import type * as OsModule from 'node:os';
import type * as ChildProcessModule from 'node:child_process';
const state = vi.hoisted(() => ({ home: '', reply: '', chunks: [] as Buffer[] }));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof OsModule>()),
  homedir: () => state.home,
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof ChildProcessModule>();
  return {
    ...actual,
    spawn: () => {
      const child = Object.assign(new EventEmitter(), {
        stdout: Object.assign(new EventEmitter(), { destroy: () => {} }),
        stderr: Object.assign(new EventEmitter(), { destroy: () => {} }),
        stdin: {
          destroy: () => {},
          end: () => {
            queueMicrotask(() => {
              const chunks = state.chunks.length
                ? state.chunks
                : [
                    Buffer.from(
                      JSON.stringify({
                        type: 'item.completed',
                        item: { type: 'agent_message', text: state.reply },
                      }) + '\n',
                    ),
                  ];
              for (const chunk of chunks) child.stdout.emit('data', chunk);
              child.emit('close', 0, null); // Guard must reject even if a process exits zero before kill lands.
            });
          },
        },
        pid: undefined,
        kill: () => true,
      });
      return child;
    },
  };
});
import { codexRunner, RunnerFailure } from './search-runner.js';
import { digest } from './search-fetch.js';

it.each(['oversize', 'malformed'])(
  'retains a bounded diagnostic and rejects %s output even with exit zero (authored events, no CLI/model process)',
  async (kind) => {
    state.home = await realpath(await mkdtemp(join(tmpdir(), 'signals-claim-wire-')));
    state.reply =
      kind === 'oversize' ? JSON.stringify({ value: 'public' }) + ' '.repeat(66000) : '{';
    state.chunks = [];
    try {
      const runner = codexRunner('gpt-6.1-sol', 'high', {
        task: 'Fixture only.',
        schema: Type.Object({ value: Type.String() }),
        live: false,
        maxResponseBytes: 65536,
      });
      const failure = await runner
        .discover(
          { query: 'public fixture', profile: 'quick', cache: 'memory' },
          new AbortController().signal,
          () => {},
        )
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(RunnerFailure);
      const usage = (failure as RunnerFailure).providerUsage as {
        rejectedOutput: {
          text: string;
          capturedDigest: string;
          capturedBytes: number;
          omittedBytes: number;
        };
        termination: { trigger: string | null };
      };
      expect(usage.rejectedOutput.capturedDigest).toBe(digest(state.reply));
      expect(usage.rejectedOutput.capturedBytes).toBe(Buffer.byteLength(state.reply));
      expect(Buffer.byteLength(usage.rejectedOutput.text)).toBeLessThanOrEqual(32768);
      if (kind === 'oversize') expect(usage.termination.trigger).toBe('response_byte_limit');
    } finally {
      await rm(state.home, { recursive: true, force: true });
    }
  },
);

it.each(['single', 'partial', 'reasoning'])(
  'wire byte cap records only received metadata for %s chunks',
  async (kind) => {
    state.home = await realpath(await mkdtemp(join(tmpdir(), 'signals-claim-wire-')));
    const wire = Buffer.from(
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: kind === 'reasoning' ? 'reasoning' : 'agent_message',
          text: 'PRIVATE_REASONING_SENTINEL🧪'.repeat(7000),
        },
      }) + '\n',
    );
    // Split inside a UTF8 code point: diagnostic hashes/counts must use delivered bytes exactly.
    const boundary = wire.indexOf(Buffer.from('🧪')) + 1;
    state.chunks =
      kind === 'partial' ? [wire.subarray(0, boundary), wire.subarray(boundary)] : [wire];
    try {
      const failure = await codexRunner('gpt-6.1-sol', 'high', {
        task: 'Fixture only.',
        schema: Type.Object({ value: Type.String() }),
        live: false,
        maxResponseBytes: 65536,
      })
        .discover(
          { query: 'fixture', profile: 'quick', cache: 'memory' },
          new AbortController().signal,
          () => {},
        )
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(RunnerFailure);
      const usage = (failure as RunnerFailure).providerUsage as {
        termination: { trigger: string };
        rejectedOutput: {
          text: string;
          capturedDigest: string;
          capturedBytes: number;
          omittedBytes: number;
          captureComplete: boolean;
          captureScope: string;
        };
      };
      expect(usage.termination.trigger).toBe('output_byte_limit');
      expect(usage.rejectedOutput).toEqual({
        text: '',
        capturedDigest: digest(wire.toString()),
        capturedBytes: wire.length,
        omittedBytes: wire.length,
        captureComplete: false,
        captureScope: 'runner-stdout',
      });
      expect(JSON.stringify(usage)).not.toContain('PRIVATE_REASONING_SENTINEL');
    } finally {
      state.chunks = [];
      await rm(state.home, { recursive: true, force: true });
    }
  },
);
