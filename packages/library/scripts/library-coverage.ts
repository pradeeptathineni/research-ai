import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { loadLibrary } from '../packages/corpus/src/library.js';
import { createLibraryIndex } from '../packages/domain/src/library-search.js';
const catalog = JSON.parse(await readFile('concepts.json', 'utf8')) as {
  schemaVersion: number;
  concepts: Array<{ id: string; label: string; definition: string; status: string }>;
};
if (
  catalog.schemaVersion !== 1 ||
  new Set(catalog.concepts.map((c) => c.id)).size !== catalog.concepts.length
)
  throw new Error('Invalid canonical concept catalog.');
const findings = await loadLibrary(process.cwd(), { scope: 'public' });
const index = createLibraryIndex(findings);
const cases = catalog.concepts
  .filter((c) => c.status === 'active')
  .map((concept) => {
    const query = `Which existing approach helps with ${concept.label}: ${concept.definition}`;
    const hits = index.search(query);
    return {
      conceptId: concept.id,
      label: concept.label,
      query,
      matches: hits.slice(0, 8).map((hit) => ({
        key: hit.finding.key,
        retrievalScore: hit.retrievalScore,
        matchedFields: hit.matchedFields,
        matchedTerms: hit.matchedTerms,
      })),
      disposition: hits.length
        ? 'lexical-match-needs-relevance-review'
        : 'no-lexical-match-needs-research',
    };
  });
const result = {
  policy: 'concept-library-coverage-v1',
  concepts: cases.length,
  scope: 'public',
  universe: findings.map((finding) => finding.key),
  lexicalMatches: cases.filter((c) => c.matches.length).length,
  cases,
  limits: [
    'Library lexical matches are not graded relevance. Zero matches can mean vocabulary mismatch or a knowledge coverage gap. This diagnostic uses public native and reviewed historical records only, without model calls or private metadata. It does not measure research quality or personal usefulness.',
  ],
};
const report = '.meta/context/local/library-coverage.json';
await mkdir('.meta/context/local', { recursive: true });
await writeFile(report, JSON.stringify(result, null, 2) + '\n', {
  mode: 0o600,
});
console.log(
  JSON.stringify({
    concepts: result.concepts,
    publicFindings: findings.length,
    lexicalMatches: result.lexicalMatches,
    report,
    meaning: 'coverage/retrieval diagnostic, not a passing relevance grade',
  }),
);
