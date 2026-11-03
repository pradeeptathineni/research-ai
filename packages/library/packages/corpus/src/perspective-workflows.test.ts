import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { exactOwnerRecord } from './provider-capabilities.js';
import { saveLibraryLead } from './library-leads.js';
import { createSourceCapture, type RecordRef } from './source-captures.js';
import { type WorkflowRef } from './perspective-workflows.js';
import { searchApi } from './search-api.js';
type Fixture = {
  cleanup(): Promise<void>;
  session(index: number): Promise<{ prompt: string }>;
  probes(): Promise<Array<string[]>>;
};
type FixtureModule = {
  fakeCodex(scenario: unknown): Promise<Fixture>;
  message(text: string): unknown;
};
type Contribution = { uniqueCitedSpans: Array<{ quote: string }> };

const citation = (text: string, quote: string) => {
  const start = text.indexOf(quote);
  return { source: 0, start, end: start + quote.length };
};
const reply = (text: string, quote: string, answer: string) => ({
  questions: [
    {
      question: 'What does the retained source report?',
      status: 'answered',
      answer,
      citations: [citation(text, quote)],
    },
  ],
  omissions: [],
});

it('retains an exact owner-bound perspective workflow, dispatches once, appends an isolated lens, and cold-reopens its exact span contribution', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-perspective-owner-')));
  const sourceText = 'Synthetic report: a 12 percent reduction; installation cost is high.';
  const fixturePath: string = fileURLToPath(
    new URL('../../../../methods/test/fake-codex.mjs', import.meta.url),
  );
  const { fakeCodex, message } = (await import(fixturePath)) as FixtureModule;
  const fixture = await fakeCodex({
    sessions: [
      {
        events: [
          message(JSON.stringify(reply(sourceText, '12 percent', 'Synthetic baseline answer.'))),
          { type: 'turn.completed' },
        ],
      },
      {
        events: [
          message(
            JSON.stringify(
              reply(sourceText, '12 percent', 'Neutral facts repeated without sibling answers.'),
            ),
          ),
          { type: 'turn.completed' },
        ],
      },
      {
        events: [
          message(
            JSON.stringify(
              reply(
                sourceText,
                'installation cost is high',
                'Synthetic isolated cost perspective.',
              ),
            ),
          ),
          { type: 'turn.completed' },
        ],
      },
    ],
  });
  try {
    const api = searchApi(root);
    async function request(route: string, body?: unknown, headers: Record<string, string> = {}) {
      const incoming = Object.assign(
        Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]),
        {
          url: `/signals-ai/__signals/api/${route}`,
          method: body === undefined ? 'GET' : 'POST',
          headers: { host: '127.0.0.1:8765', 'content-type': 'application/json', ...headers },
        },
      ) as unknown as IncomingMessage;
      let status = 0;
      let text = '';
      const outgoing = {
        writeHead(code: number) {
          status = code;
        },
        end(value: string) {
          text = value;
        },
      } as unknown as ServerResponse;
      expect(await api(incoming, outgoing)).toBe(true);
      return { status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
    }
    const session = await request('session');
    const token = String(session.body.token);
    expect(token.length).toBeGreaterThan(20);
    const scopeResult = await request('request-scope', {}, { 'x-signals-token': token });
    const scope = scopeResult.body as unknown as { identity: string; epoch: string };
    const headers = {
      'x-signals-token': token,
      'x-signals-provider-version': '1.0',
      'x-signals-instance-id': scope.identity,
      'x-signals-owner-epoch': scope.epoch,
    };
    const lead = await saveLibraryLead(
      root,
      {
        uri: 'https://synthetic.example/report',
        name: 'Synthetic report',
        description: 'Test-only source record.',
        limits: [],
      },
      randomUUID(),
      'synthetic perspective fixture',
    );
    const sourceRecord = await exactOwnerRecord(root, {
      owner: 'signals-ai',
      kind: 'lead',
      id: lead.id,
      revision: null,
      digest: null,
    });
    const sourceRef = sourceRecord.ref as RecordRef;
    const resolveSource = async (ref: RecordRef) => {
      const exact = await exactOwnerRecord(root, ref);
      return { bytes: exact.bytes, ref: exact.ref as RecordRef };
    };
    const capture = await createSourceCapture(
      root,
      {
        source_ref: sourceRef,
        mode: 'paste',
        text: sourceText,
        observed_at: '2026-11-03T12:00:00Z',
      },
      resolveSource,
    );
    const createResponse = await request(
      'perspective-workflows',
      {
        topic: 'What does this synthetic report say?',
        sourceRefs: [capture.ref],
        perspectives: [],
      },
      headers,
    );
    expect(createResponse.status, JSON.stringify(createResponse.body)).toBe(201);
    const created = createResponse.body as unknown as {
      ref: WorkflowRef;
      workflow: any;
      sourceRefs: RecordRef[];
    };
    expect(created.workflow.perspectiveResult).toBeNull();
    expect(created.sourceRefs).toEqual([capture.ref]);
    const listed = await request('perspective-workflows', undefined, headers);
    expect(listed.body.workflows).toHaveLength(1);
    expect(listed.body.workflows[0].ref).toEqual(created.ref);

    const runRequestId = randomUUID();
    const mismatchedPath = await request(
      `perspective-workflows/${randomUUID()}/run`,
      {
        expectedRef: created.ref,
        requestId: randomUUID(),
      },
      headers,
    );
    expect(mismatchedPath.status).toBe(400);
    expect(
      (await fixture.probes()).filter((args) => args[0] === 'exec' && args[1] !== '--help'),
    ).toHaveLength(0);
    const baselineResponse = await request(
      `perspective-workflows/${created.ref.workflowId}/run`,
      { expectedRef: created.ref, requestId: runRequestId },
      headers,
    );
    expect(baselineResponse.status).toBe(200);
    const baseline = baselineResponse.body as unknown as {
      ref: WorkflowRef;
      workflow: any;
      operation: any;
      contributions: Contribution[];
    };
    expect(baseline.ref.revision).toBe(1);
    expect(baseline.operation).toMatchObject({
      requestId: runRequestId,
      state: 'complete',
      replayed: false,
    });
    expect(baseline.contributions[0]!.uniqueCitedSpans.map((span) => span.quote)).toEqual([
      '12 percent',
    ]);
    const replayResponse = await request(
      `perspective-workflows/${created.ref.workflowId}/run`,
      { expectedRef: created.ref, requestId: runRequestId },
      headers,
    );
    expect(replayResponse.status).toBe(200);
    const replay = replayResponse.body as unknown as { ref: WorkflowRef; operation: any };
    expect(replay.operation.replayed).toBe(true);
    expect(replay.ref).toEqual(baseline.ref);
    const staleBaseline = await request(
      `perspective-workflows/${created.ref.workflowId}/run`,
      { expectedRef: created.ref, requestId: randomUUID() },
      headers,
    );
    expect(staleBaseline.status).toBe(409);
    expect(staleBaseline.body.code).toBe('perspective_workflow_changed');
    expect(
      (await fixture.probes()).filter((args) => args[0] === 'exec' && args[1] !== '--help'),
    ).toHaveLength(1);

    const choice = {
      label: 'Cost lens',
      focus: 'Identify the report’s stated costs and limitations.',
    };
    const previewResponse = await request(
      `perspective-workflows/${baseline.ref.workflowId}/preview`,
      { ref: baseline.ref, choice },
      headers,
    );
    expect(previewResponse.status).toBe(200);
    const preview = previewResponse.body as unknown as { preview: any; previewDigest: string };
    expect(preview.preview.staleComparisonIndexes).toEqual([]);
    expect(preview.preview.staleOutlineRevisions).toEqual([]);
    const addRequestId = randomUUID();
    const stalePreview = await request(
      `perspective-workflows/${baseline.ref.workflowId}/perspectives`,
      { expectedRef: baseline.ref, requestId: randomUUID(), choice, previewDigest: '0'.repeat(64) },
      headers,
    );
    expect(stalePreview.status).toBe(409);
    expect(stalePreview.body.code).toBe('perspective_preview_changed');
    expect(
      (await fixture.probes()).filter((args) => args[0] === 'exec' && args[1] !== '--help'),
    ).toHaveLength(1);
    const appendedResponse = await request(
      `perspective-workflows/${baseline.ref.workflowId}/perspectives`,
      {
        expectedRef: baseline.ref,
        requestId: addRequestId,
        choice,
        previewDigest: preview.previewDigest,
      },
      headers,
    );
    expect(appendedResponse.status).toBe(200);
    const appended = appendedResponse.body as unknown as {
      ref: WorkflowRef;
      workflow: any;
      contributions: Contribution[];
    };
    expect(appended.ref.revision).toBe(2);
    expect(
      appended.contributions.map((row) => row.uniqueCitedSpans.map((span) => span.quote)),
    ).toEqual([['12 percent'], ['installation cost is high']]);
    const replayAfterAppend = await request(
      `perspective-workflows/${created.ref.workflowId}/run`,
      { expectedRef: created.ref, requestId: runRequestId },
      headers,
    );
    expect(replayAfterAppend.status).toBe(200);
    expect(replayAfterAppend.body.ref).toEqual(baseline.ref);
    expect(replayAfterAppend.body.operation.replayed).toBe(true);
    await expect(fixture.session(2)).resolves.toMatchObject({
      prompt: expect.not.stringContaining('Synthetic baseline answer.'),
    });
    const otherChoice = {
      label: 'Changed lens',
      focus: 'Inspect an alternate issue in the retained text.',
    };
    const changedPreviewResponse = await request(
      `perspective-workflows/${appended.ref.workflowId}/preview`,
      { ref: appended.ref, choice: otherChoice },
      headers,
    );
    const changedPreview = changedPreviewResponse.body as unknown as { previewDigest: string };
    const conflict = await request(
      `perspective-workflows/${appended.ref.workflowId}/perspectives`,
      {
        expectedRef: appended.ref,
        requestId: addRequestId,
        choice: otherChoice,
        previewDigest: changedPreview.previewDigest,
      },
      headers,
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('perspective_request_conflict');
    const coldResponse = await request(
      `perspective-workflows/${appended.ref.workflowId}?ref=${encodeURIComponent(JSON.stringify(appended.ref))}`,
      undefined,
      headers,
    );
    expect(coldResponse.status).toBe(200);
    expect(coldResponse.body.workflow).toEqual(appended.workflow);
    expect(coldResponse.body.contributions).toEqual(appended.contributions);
    expect(coldResponse.body.sourceRefs).toEqual([capture.ref]);
    const finalList = await request('perspective-workflows', undefined, headers);
    expect(finalList.body.workflows[0].ref).toEqual(appended.ref);
  } finally {
    await fixture.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
