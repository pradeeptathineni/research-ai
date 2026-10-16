#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { codexReadiness, profiles, researchQuestion } from '../src/index.mjs';

const usage = `Usage: research-ai [options] <question>

Runs one bounded, read-only, ephemeral Codex research session and prints a
fallible Markdown answer to stdout and a JSON receipt to stderr. Nothing is saved.

Options:
  --profile quick|wide   action/time budget (default quick: 8 searches, 20 reads, 240s)
  --context TEXT         extra untrusted context for the question
  --model NAME           Codex model (default: ~/.codex/config.toml or CLI default)
  --effort LEVEL         reasoning effort (default: config or CLI default)
  --readiness            report installed/authenticated state without inference
  -h, --help             show this help

Exit codes: 0 complete, 2 partial answer, 1 failure or usage error.
Answers are research, not verified truth; sources and claims need checking.`;

const fail = (text) => {
  process.stderr.write(`${text}\n`);
  return 1;
};

// Exit codes are set, not forced, so asynchronous pipe writes are never truncated.
async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        profile: { type: 'string' },
        context: { type: 'string' },
        model: { type: 'string' },
        effort: { type: 'string' },
        readiness: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (failure) {
    return fail(`${failure.message}\n${usage}`);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  if (values.readiness) {
    const state = await codexReadiness();
    process.stdout.write(`${JSON.stringify(state)}\n`);
    return state.available ? 0 : 1;
  }
  const question = positionals.join(' ').trim();
  if (!question) return fail(usage);
  if (values.profile !== undefined && !Object.hasOwn(profiles, values.profile))
    return fail(`research-ai: unknown profile ${JSON.stringify(values.profile)}`);
  // Readiness runs only version/login probes, so an unusable CLI fails before any session.
  const ready = await codexReadiness();
  if (!ready.available)
    return fail(
      `research-ai: ${ready.installed ? 'Codex CLI is not logged in' : 'Codex CLI unavailable (not found or its login probe failed)'}; install it and run \`codex login\`.`,
    );
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  try {
    const result = await researchQuestion(question, {
      profile: values.profile,
      context: values.context,
      model: values.model,
      effort: values.effort,
      signal: controller.signal,
      progress: (event) => process.stderr.write(`${event}\n`),
    });
    if (result.answer) process.stdout.write(`${result.answer}\n`);
    process.stderr.write(`${JSON.stringify({ status: result.status, ...result.receipt })}\n`);
    return result.status === 'complete' ? 0 : result.status === 'partial' ? 2 : 1;
  } catch (failure) {
    return fail(`research-ai: ${failure instanceof Error ? failure.message : failure}`);
  }
}

process.exitCode = await main();
