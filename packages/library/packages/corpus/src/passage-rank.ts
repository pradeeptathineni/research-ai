// Adapted from assafelovic/gpt-researcher, lexical.py lines 19–66 at
// 3582a6841fe7dc801e2a34e34ee408641aea9bce (Apache-2.0).
// Modified: ported from Python to TypeScript; selection policy changed by Signals.
// See THIRD_PARTY_NOTICES.md for the source attribution and license.
const stopwords = new Set(
  `a about above after again against all am an and any are as at be because been before being below
between both but by can could did do does doing down during each few for from further had has have
having he her here hers herself him himself his how i if in into is it its itself just me more most
my myself no nor not now of off on once only or other our ours ourselves out over own same she should
so some such than that the their theirs them themselves then there these they this those through to
too under until up very was we were what when where which while who whom why will with would you your
yours yourself yourselves`.split(/\s+/u),
);

function stem(token: string) {
  if ([...token].length <= 4 || token.endsWith('ss')) return token;
  if (token.endsWith('ies')) return token.slice(0, -3) + 'y';
  if (/(?:sses|xes|zes|ches|shes)$/u.test(token)) return token.slice(0, -2);
  if (token.endsWith('s')) return token.slice(0, -1);
  return token;
}

export function passageTokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])
    .filter((token) => [...token].length > 1 && !stopwords.has(token))
    .map(stem);
}

/** Lexical relevance only; scores do not establish source support or answer quality. */
export function bm25Scores(query: string, passages: readonly string[], k1 = 1.5, b = 0.75) {
  const docs = passages.map((passage) => {
    const terms = new Map<string, number>();
    for (const token of passageTokens(passage)) terms.set(token, (terms.get(token) ?? 0) + 1);
    return { terms, length: [...terms.values()].reduce((sum, count) => sum + count, 0) };
  });
  if (!docs.length) return [];
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1;
  const queryTerms = new Set(passageTokens(query));
  const idf = new Map(
    [...queryTerms].map((term) => {
      const frequency = docs.filter((doc) => doc.terms.has(term)).length;
      return [term, Math.log((docs.length - frequency + 0.5) / (frequency + 0.5) + 1)];
    }),
  );
  return docs.map((doc) =>
    [...queryTerms].reduce((score, term) => {
      const frequency = doc.terms.get(term) ?? 0;
      return (
        score +
        (frequency
          ? (idf.get(term)! * frequency * (k1 + 1)) /
            (frequency + k1 * (1 - b + (b * doc.length) / average))
          : 0)
      );
    }, 0),
  );
}

/** Fair per-parent statement slots, then redistribute spare slots by question relevance. */
export function selectPassages<T>(
  query: string,
  parents: readonly (readonly T[])[],
  text: (row: T) => string,
) {
  if (!parents.length) return { material: [] as T[], perParent: [] };
  const rows = parents.flatMap((passages, parent) =>
    passages.map((value, index) => ({ parent, index, value })),
  );
  const scores = bm25Scores(
    query,
    rows.map((row) => text(row.value)),
  );
  const ranked = rows
    .map((row, index) => ({ ...row, score: scores[index]! }))
    .sort((a, b) => b.score - a.score || a.parent - b.parent || a.index - b.index);
  const selected: typeof ranked = [];
  const add = (row: (typeof ranked)[number]) => {
    if (
      selected.length >= 40 ||
      Buffer.byteLength(JSON.stringify([...selected.map((entry) => entry.value), row.value])) >
        18000
    )
      return false;
    selected.push(row);
    return true;
  };
  const quota = Math.floor(40 / parents.length);
  const groups = parents.map((_, parent) => ranked.filter((row) => row.parent === parent));
  // Round-robin admission keeps one verbose parent from consuming the whole byte budget.
  for (let round = 0; round < quota; round++) {
    for (const group of groups) {
      const candidate = group.shift();
      if (candidate) add(candidate);
    }
  }
  const remaining = new Set(groups.flat());
  for (const row of ranked) if (remaining.has(row)) add(row);
  selected.sort((a, b) => a.parent - b.parent || a.index - b.index);
  return {
    material: selected.map((row) => row.value),
    perParent: parents.map((passages, parent) => ({
      total: passages.length,
      kept: selected.filter((row) => row.parent === parent).length,
    })),
  };
}
