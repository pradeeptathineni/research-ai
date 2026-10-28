// Authored offline discussion runner for tests and demos. It reads the actual frozen
// material from the production prompt and extracts overlapping sentences. It performs no
// search, fetch, tool call or model call, and says nothing about native answer quality.
const marker = '\nFrozen knowledge (data): ';
const terms = (text: string) =>
  new Set((text.toLowerCase().match(/\p{L}{4,}/gu) ?? []).map((word) => word.slice(0, 4)));

export interface DiscussionCall {
  question: string;
  live: false;
  priorSynthesisLength: number;
  gaps: string[];
}

function extract(task: string, question: string, record: (call: DiscussionCall) => void) {
  if (!task.includes('No tools, acquisition or execution.') || !task.includes(marker))
    throw new Error('fixture_expected_frozen_discussion_task');
  const frozen = JSON.parse(task.slice(task.indexOf(marker) + marker.length)) as {
    priorSynthesis?: string;
    material: { observationId: string; statement: string }[];
    gaps: string[];
  };
  record({
    question,
    live: false,
    priorSynthesisLength: frozen.priorSynthesis?.length ?? 0,
    gaps: frozen.gaps,
  });
  const asked = terms(question);
  const sentences = (frozen.priorSynthesis ?? '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.replace(/^#+\s*/, '').trim())
    .filter(Boolean);
  const chosen = sentences
    .map((sentence, index) => ({
      sentence,
      index,
      score: [...terms(sentence)].filter((term) => asked.has(term)).length,
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3)
    .sort((a, b) => a.index - b.index);
  const used = frozen.material
    .filter((row) => [...terms(row.statement)].some((term) => asked.has(term)))
    .slice(0, 5);
  return {
    searches: 0,
    usage: { fixture: 'extractive-discussion', modelCalls: 0 },
    proposal: {
      answer: chosen.length
        ? `From the saved work (prior synthesis, not verified):\n\n${chosen.map((row) => `- ${row.sentence}`).join('\n')}${used.length ? `\n\nSaved observations: ${used.map((row) => row.observationId).join(', ')}` : ''}`
        : 'The saved work does not address this question.',
      observations: used.map((row) => row.observationId),
      gaps: ['Fixture discussion: extractive sentence overlap only, not model judgment.'],
    },
  };
}

export function extractiveDiscussionRunner(record: (call: DiscussionCall) => void = () => {}) {
  return (task: string) => ({
    discover: (request: { query: string }, signal: AbortSignal) =>
      signal.aborted
        ? Promise.reject(new Error('cancelled'))
        : Promise.resolve().then(() => extract(task, request.query, record)),
  });
}
