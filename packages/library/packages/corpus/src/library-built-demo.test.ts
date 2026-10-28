import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import { retainResearchAnswer } from './research-answer.js';
import { saveLibraryLead } from './library-leads.js';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fixture = fileURLToPath(
  new URL('../../../tests/fixtures/s04-built-server.ts', import.meta.url),
);
const consumer = fileURLToPath(
  new URL('../../../scripts/examples/library-consumer.mjs', import.meta.url),
);
const stop = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  await closed;
};
async function launch(root: string, cold: boolean) {
  const child = spawn(process.execPath, ['--import', 'tsx', fixture, root], {
    env: { ...process.env, S04_NO_GENERATION: cold ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const port = await new Promise<number>((resolve, reject) => {
    child.on('message', (message: { type: string; port: number }) => {
      if (message.type === 'ready') resolve(message.port);
    });
    child.once('exit', (code) => reject(new Error(`fixture_exit_${code}: ${stderr}`)));
    child.once('error', reject);
  });
  return {
    child,
    base: `http://127.0.0.1:${port}/signals-ai/__signals/api/`,
    site: `http://127.0.0.1:${port}/signals-ai/`,
  };
}
async function external(
  root: string,
  base: string,
  instance: string,
  epoch: string,
  query: string,
) {
  const file = join(root, 'library-consumer.mjs');
  await copyFile(consumer, file);
  const child = spawn(process.execPath, [file, base, instance, epoch, query], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (bytes: Buffer) => {
    stdout += bytes.toString();
  });
  child.stderr.on('data', (bytes: Buffer) => {
    stderr += bytes.toString();
  });
  const [code] = await once(child, 'close');
  return { code, stdout, stderr };
}

it('uses a real built HTTP owner for complete and incomplete Library cold reopening with an external consumer', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signals-s04-built-')));
  const consumerRoot = await realpath(await mkdtemp(join(tmpdir(), 'signals-s04-consumer-')));
  const children: ChildProcess[] = [];
  try {
    const first = await launch(root, false);
    children.push(first.child);
    expect((await fetch(first.site)).status).toBe(200);
    const token = ((await (await fetch(first.base + 'session')).json()) as { token: string }).token;
    const post = (base: string, tokenValue: string, route: string, body: unknown) =>
      fetch(base + route, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-signals-token': tokenValue },
        body: JSON.stringify(body),
      });
    const scopeResponse = await post(first.base, token, 'request-scope', {});
    expect(scopeResponse.status).toBe(200);
    const scope = (await scopeResponse.json()) as { identity: string; epoch: string };
    const research = async (query: string) => {
      const started = await post(first.base, token, 'search', {
        query,
        method: 'answer-first',
        cache: 'memory',
        save: 'never',
      });
      expect(started.status).toBe(202);
      const { id } = (await started.json()) as { id: string };
      for (let attempt = 0; attempt < 80; attempt++) {
        const state = (await (await fetch(first.base + 'runs/' + id)).json()) as {
          result?: {
            runId: string;
            brief?: { text: string };
            status: string;
            answerReceipt?: unknown;
          };
        };
        if (state.result) return state.result;
        await new Promise((done) => setTimeout(done, 25));
      }
      throw new Error('fixture_run_timeout');
    };
    const complete = await research('complete constellation');
    const incomplete = await research('incomplete aurora');
    expect(complete.answerReceipt).toBeTruthy();
    expect(incomplete.answerReceipt).toBeUndefined();
    expect((await post(first.base, token, 'retain-answer', { runId: complete.runId })).status).toBe(
      200,
    );
    expect(
      (await post(first.base, token, 'retain-answer', { runId: incomplete.runId })).status,
    ).toBe(200);
    const completePath = join(root, '.signals/runs', `${complete.runId}.json`);
    const incompletePath = join(root, '.signals/runs', `${incomplete.runId}.json`);
    const [completeBytes, incompleteBytes] = await Promise.all([
      readFile(completePath),
      readFile(incompletePath),
    ]);
    const imported = await retainResearchAnswer(
      root,
      {
        query: 'older archive atlas',
        answer: 'Historical atlas answer Ω, not regenerated.',
        observedAt: '2026-10-19T10:00:00Z',
        provenance: { receipt: 'authored offline import', requestedModel: null, servedModel: null },
      },
      [],
    );
    const importedBytes = await readFile(imported.answerPath);
    const lead = await saveLibraryLead(
      root,
      {
        uri: 'https://example.org/s04',
        name: 'Saved source lead',
        description: 'Unassessed candidate source',
        limits: ['No primary inspection.'],
      },
      complete.runId,
      complete.status,
    );
    const entityName = 'entity-de98fd0a04b14786783fdcd4.json';
    const entityBytes = await readFile(join('signals/entities', entityName));
    await mkdir(join(root, 'signals/entities'), { recursive: true });
    await writeFile(join(root, 'signals/entities', entityName), entityBytes);
    const callbacksBefore = (await readFile(join(root, 'callbacks.jsonl'), 'utf8'))
      .trim()
      .split('\n');
    expect(callbacksBefore).toHaveLength(2);
    await stop(first.child);
    const second = await launch(root, true);
    children.push(second.child);
    const coldToken = ((await (await fetch(second.base + 'session')).json()) as { token: string })
      .token;
    expect(
      (await post(second.base, coldToken, 'retain-answer', { runId: incomplete.runId })).status,
    ).toBe(200);
    const headers = {
      'x-signals-provider-version': '1.0',
      'x-signals-instance-id': scope.identity,
      'x-signals-owner-epoch': scope.epoch,
    };
    const page = async (q: string) =>
      fetch(second.base + 'provider/library?' + new URLSearchParams({ q }).toString(), { headers });
    for (const [query, id, text] of [
      ['constellation', complete.runId, complete.brief!.text],
      ['aurora', incomplete.runId, incomplete.brief!.text],
      ['atlas', imported.runId, 'Historical atlas answer Ω, not regenerated.'],
      ['lead', lead.id, 'Unassessed candidate source'],
      ['', entityName.slice(0, -5), ''],
    ] as const) {
      const response = await page(query);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { records: { ref: { id: string } }[] };
      expect(
        body.records.some((record) => record.ref.id.endsWith(id)),
        `${query}: ${JSON.stringify(body.records.map((record) => record.ref.id))}`,
      ).toBe(true);
      if (text) {
        const read = await external(consumerRoot, second.base, scope.identity, scope.epoch, query);
        expect(read.code, read.stderr).toBe(0);
        expect(read.stdout).toContain(text);
      }
    }
    expect(await readFile(completePath)).toEqual(completeBytes);
    expect(await readFile(incompletePath)).toEqual(incompleteBytes);
    expect(await readFile(imported.answerPath)).toEqual(importedBytes);
    expect((await readFile(join(root, 'callbacks.jsonl'), 'utf8')).trim().split('\n')).toEqual(
      callbacksBefore,
    );
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
      await page.goto(second.site + '?view=Library&q=aurora');
      const noteCard = page.getByRole('article').filter({ hasText: 'incomplete aurora' });
      await noteCard.getByRole('button', { name: 'Reopen incomplete note' }).click();
      expect(
        await page.getByRole('region', { name: 'Incomplete retained note' }).textContent(),
      ).toContain('Provisional aurora field guide Ω');
      if (process.env.S04_SCREENSHOT)
        await page.screenshot({ path: process.env.S04_SCREENSHOT, fullPage: true });
    } finally {
      await browser.close();
    }
    const noteKey = `note:private:${incomplete.runId}`;
    expect(
      (await post(second.base, coldToken, 'library-saved', { key: noteKey, saved: false })).status,
    ).toBe(200);
    expect(((await (await page('aurora')).json()) as { records: unknown[] }).records).toHaveLength(
      0,
    );
    expect(await readFile(incompletePath)).toEqual(incompleteBytes);
    expect(
      (await post(second.base, coldToken, 'retain-answer', { runId: randomUUID() })).status,
    ).toBe(400);
    if (process.env.S04_DEMO_EVIDENCE)
      await writeFile(
        process.env.S04_DEMO_EVIDENCE,
        JSON.stringify(
          {
            first_pid: first.child.pid,
            restarted_pid: second.child.pid,
            scope,
            complete: {
              runId: complete.runId,
              status: complete.status,
              sha256: sha(completeBytes),
            },
            incomplete: {
              runId: incomplete.runId,
              status: incomplete.status,
              sha256: sha(incompleteBytes),
            },
            imported: { runId: imported.runId, sha256: sha(importedBytes) },
            lead: lead.id,
            entity: entityName.slice(0, -5),
            callbacks_before: callbacksBefore.length,
            callbacks_after: (await readFile(join(root, 'callbacks.jsonl'), 'utf8'))
              .trim()
              .split('\n').length,
            cold_reads: ['complete', 'incomplete', 'imported', 'lead', 'entity'],
            unsaved_note_history_sha256: sha(await readFile(incompletePath)),
          },
          null,
          2,
        ) + '\n',
      );
  } finally {
    for (const child of children) await stop(child);
    await rm(root, { recursive: true, force: true });
    await rm(consumerRoot, { recursive: true, force: true });
  }
}, 30000);
