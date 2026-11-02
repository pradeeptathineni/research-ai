import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateInvestigation, projectInvestigationClaimReviews, projectInvestigationMethodProgress } from './investigation.mjs';
import { validateOutline } from './outline.mjs';

const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
const fail = reason => { throw new Error(`invalid_investigation_report: ${reason}`); };
const sourceUri = (state, question, attempt, source) => `https://research-ai.invalid/investigation-source?uri=${encodeURIComponent(source.uri)}&investigation=${state.identity}&question=${encodeURIComponent(question.id)}&questionSha256=${sha(question.question)}&attempt=${encodeURIComponent(attempt.id)}&sourceSha256=${source.sha256}`;

/** Projects one explicitly selected, current investigation question into the existing cited-report owner. */
export function createInvestigationReportBasis(value, questionId, attemptId) {
  const state = validateInvestigation(value);
  const question = state.questions.find(item => item.id === questionId);
  if (!question) fail('question is not retained in this Investigation');
  const attempt = state.history.find(item => item.id === attemptId);
  const branch = projectInvestigationMethodProgress(state).branches.find(item => item.branchId === question.id);
  const compatible = branch?.status === 'complete' && branch.attemptId === attemptId;
  const reviews = projectInvestigationClaimReviews(state).filter(review => review.status === 'current'
    && review.attemptId === attemptId && review.branchId === question.id);
  if (!attempt || attempt.action !== 'investigate' || attempt.status !== 'complete'
      || attempt.branchId !== question.id || attempt.question !== question.question
      || !compatible)
    fail('select a completed investigation attempt that is current for this exact question');
  if (!Array.isArray(state.sources) || !state.sources.length) fail('the selected Investigation has no frozen source text');

  const reviewByFinding = new Map();
  for (const review of reviews) {
    const values = reviewByFinding.get(review.findingIndex) ?? [];
    values.push(review);
    reviewByFinding.set(review.findingIndex, values);
  }
  const sourceIndexes = new Map(), sources = [], points = [], gaps = [...attempt.gaps];
  for (let index = 0; index < attempt.findings.length; index++) {
    const finding = attempt.findings[index];
    const matching = reviewByFinding.get(index) ?? [];
    if (matching.length !== 1) {
      const status = matching.length ? 'multiple caller reviews require reconciliation' : 'not explicitly reviewed';
      gaps.push(`Finding ${index + 1} remains unknown (${status}): ${finding}`);
      continue;
    }
    const review = matching[0];
    if (review.assessment !== 'supports') {
      gaps.push(`Finding ${index + 1} remains unknown (caller review ${review.assessment}): ${finding} Review rationale: ${review.rationale}`);
      continue;
    }
    if (review.citations.length > 4) fail(`finding ${index + 1} exceeds the report citation limit`);
    const citations = review.citations.map(citation => {
      const source = state.sources[citation.sourceIndex];
      if (!source || source.uri !== citation.sourceUri || source.sha256 !== citation.sourceSha256
          || source.text.slice(citation.start, citation.end) !== citation.quote)
        fail(`finding ${index + 1} no longer matches its retained source span`);
      let sourceIndex = sourceIndexes.get(citation.sourceIndex);
      if (sourceIndex === undefined) {
        if (sources.length >= 8) fail('current reviewed citations exceed the eight-source report limit');
        const uri = sourceUri(state, question, attempt, source);
        if (uri.length > 2000) fail('source identity exceeds the portable report URI limit');
        sourceIndex = sources.length;
        sourceIndexes.set(citation.sourceIndex, sourceIndex);
        sources.push({ uri, text: source.text, sha256: source.sha256 });
      }
      return { source: sourceIndex, start: citation.start, end: citation.end, quote: citation.quote };
    });
    const text = `Finding: ${finding} Caller review (supports): ${review.rationale}`;
    if (text.length > 350) fail(`finding ${index + 1} review exceeds the report paragraph limit; shorten the caller rationale before projection`);
    points.push({ text, citations });
  }
  if (!sources.length) {
    // The outline format requires a source even for an all-unknown report. Select
    // only a source the chosen attempt actually used and explicitly mark it uncited.
    const used = attempt.sources.find(candidate => candidate.sha256
      && state.sources.some(source => source.uri === candidate.uri && source.sha256 === candidate.sha256));
    if (!used) fail('all-unknown report has no source identity bound to the selected attempt');
    const source = state.sources.find(candidate => candidate.uri === used.uri && candidate.sha256 === used.sha256);
    if (!source) fail('all-unknown report has no retained source used by the selected attempt');
    sources.push({
      uri: sourceUri(state, question, attempt, source),
      text: source.text,
      sha256: source.sha256,
    });
  }
  if (sources.some(source => source.uri.length > 2000)) fail('source identity exceeds the portable report URI limit');
  if (points.some(point => point.citations.length < 1)) fail('reviewed finding has no retained citation');
  if (gaps.some(gap => gap.length > 250)) fail('a retained finding or source gap exceeds the report gap limit; shorten it before projection');

  const groups = [];
  for (let index = 0; index < points.length; index += 5) groups.push({ points: points.slice(index, index + 5), gaps: [] });
  for (let index = 0; index < gaps.length; index += 5) groups.push({ points: [], gaps: gaps.slice(index, index + 5) });
  if (!groups.length) groups.push({ points: [], gaps: ['The selected attempt retained no findings; evidence remains unknown.'] });
  if (groups.length > 8) fail('reviewed findings and gaps exceed the eight-section report limit');
  const id = `question-${sha(question.id).slice(0, 16)}`;
  const reviewDigest = sha(JSON.stringify(reviews.map(({ id, findingIndex, findingSha256, assessment, rationale, citations }) =>
    ({ id, findingIndex, findingSha256, assessment, rationale, citations }))));
  return validateOutline({
    version: 'research-outline-v1', topic: question.question, sources,
    sections: groups.map((group, index) => ({
      id: `${id}-${index + 1}`,
      title: `Question ${question.id} · ${group.points.length ? 'reviewed findings' : 'unknowns'}${groups.length > 1 ? ` · part ${index + 1}` : ''}`,
      points: group.points,
      gaps: group.gaps,
    })),
    origin: { type: 'caller-authored' },
    limits: [
      `Projected from Investigation question ${question.id} (${sha(question.question)}) and completed attempt ${attempt.id}.`,
      'Only one current caller-authored supports review per finding is carried as a cited paragraph. Missing, conflicting, contradicts, context, and unresolved reviews remain unknown gaps.',
      'Exact source occurrence is checked. Review labels are caller judgments and do not establish entailment, truth, completeness, or current source availability.',
      `Investigation identity: ${state.identity}.`,
      `Selected branch attempt context: ${attempt.contextIdentity}.`,
      `Selected current caller-review digest: ${reviewDigest}.`,
      ...(points.length === 0 ? ['The retained source is included only to satisfy the report format; no evidence citation is asserted.'] : []),
    ],
  });
}

/** Re-derives a projected basis and rejects caller edits or a changed Investigation snapshot. */
export function validateInvestigationReportBasis(value, questionId, attemptId, candidate) {
  const expected = createInvestigationReportBasis(value, questionId, attemptId);
  let actual;
  try { actual = validateOutline(candidate); } catch { fail('candidate is not a valid Investigation report basis'); }
  if (!isDeepStrictEqual(expected, actual)) fail('report basis differs from the selected Investigation question, attempt, or caller-review snapshot');
  return expected;
}
