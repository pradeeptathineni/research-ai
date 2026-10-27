// Ordered composition of existing frozen Research owners; no storage or second research engine.
import { createHash, randomUUID } from "node:crypto";
import { frozenSources } from "./research.mjs";
import { chooseLenses, perspectiveResearch } from "./perspectives.mjs";
import { createInvestigation, validateInvestigation, advanceInvestigation } from "./investigation.mjs";
import { compareInvestigation, validateComparison, comparisonCurrentness, renderComparison } from "./branch-comparison.mjs";
import { outlineResearch, validateOutline, reviseOutline, renderOutline } from "./outline.mjs";

const schema = "research-perspective-workflow-v1";
const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
const hash = v => createHash("sha256").update(v, "utf8").digest("hex");
const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : plain(v) ? `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v);
const stateDigest = v => hash(canonical(Object.fromEntries(Object.entries(v).filter(([k]) => k !== "sha256"))));
const clone = v => structuredClone(v);
const fail = reason => { throw new TypeError(`invalid_research_perspective_workflow: ${reason}`); };
const validLine = (v, max) => typeof v === "string" && !!v.trim() && v.length <= max && v.isWellFormed();
const id = v => { const result = v ?? `workflow:${randomUUID()}`; if (typeof result !== "string" || !/^workflow:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result)) fail("workflow ID"); return result; };
const rawSources = sources => sources.map(({ sha256, ...source }) => source);
const sourceMetadata = sources => sources.map(({ text, ...meta }) => meta);
const outlineClaimBindings = outline => outline.sections.flatMap(section => section.points.map(point => canonical({ text: point.text, citations: point.citations.map(c => ({ source: c.source, start: c.start, end: c.end, quote: c.quote })) }))).sort();
const setAsideReason = "Kept separate from the generated outline; the existing source-only outline owner does not consume comparison output as evidence.";
const citationReviewReason = "Citation bindings changed in this user edit; inspect each exact span before relying on the edited outline.";
const outlineSpanKeys = (sources, outline) => outline.sections.flatMap(section => section.points.flatMap(point => point.citations.map(c => `${sources[c.source].sha256}:${c.start}:${c.end}`)));
const comparisonConflictSpans = (comparisons, sources) => {
  const rows = comparisons.flatMap(comparison => (comparison.result?.disagreements ?? []).flatMap(disagreement => disagreement.positions.flatMap(position => {
  if (!position.source) return [];
  const sourceIndex = sources.findIndex(source => source.uri === position.source.uri && source.sha256 === position.source.sha256);
  return sourceIndex < 0 ? [] : [{ source: sourceIndex, sourceUri: position.source.uri, sourceSha256: position.source.sha256,
    start: position.source.start, end: position.source.end, quote: position.source.quote }];
  })));
  return [...new Map(rows.map(row => [`${row.sourceSha256}:${row.start}:${row.end}`, row])).values()];
};
const seal = v => ({ ...v, sha256: stateDigest(v) });

function checkPerspectiveResult(result, topic, sources, lenses) {
  if (!plain(result) || result.version !== "perspectives-v1" || result.owner !== "research-ai" || result.topic !== topic || !["complete", "partial", "failed", "cancelled"].includes(result.status)) fail("invalid perspectives result header");
  if (canonical(result.sources) !== canonical(sourceMetadata(sources)) || !Array.isArray(result.lenses) || result.lenses.length !== lenses.length) fail("perspective source set or lens count changed");
  for (let i = 0; i < lenses.length; i++) {
    const row = result.lenses[i], expected = lenses[i];
    if (!plain(row) || canonical(row.lens) !== canonical(expected) || !["complete", "failed", "cancelled", "not_run"].includes(row.status)) fail("perspective order or identity changed");
    if (row.status === "complete") {
      if (!Array.isArray(row.questions) || !Array.isArray(row.omissions) || !plain(row.receipt)) fail("incomplete perspective result");
      for (const q of row.questions) {
        if (!Array.isArray(q.citations)) fail("missing citations list");
        for (const c of q.citations) {
          const source = sources[c.source];
          if (!source || !Number.isInteger(c.start) || !Number.isInteger(c.end) || c.end <= c.start || source.text.slice(c.start, c.end) !== c.quote || c.occurrence !== "exact-retained-span") fail("perspective citation no longer matches frozen source");
        }
      }
    }
  }
  return result;
}
function validate(value) {
  if (!plain(value) || value.version !== schema || value.owner !== "research-ai" || !/^workflow:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.id) || !validLine(value.topic, 2000) || !Number.isSafeInteger(value.revision) || value.revision < 0 || !/^[a-f0-9]{64}$/.test(value.sha256)) fail("invalid workflow header");
  const sources = frozenSources(rawSources(value.sources));
  if (canonical(sources) !== canonical(value.sources)) fail("frozen sources or digests changed");
  const lenses = chooseLenses(rawSources(sources), value.perspectiveChoices);
  if (canonical(lenses) !== canonical(value.lenses)) fail("selected perspective definitions changed");
  if (!(value.perspectiveResult === null || checkPerspectiveResult(value.perspectiveResult, value.topic, sources, lenses))) fail("invalid perspective stage");
  if (!(value.investigation === null || (() => {
    const state = validateInvestigation(value.investigation);
    return state.branchContext === "independent" && state.topic === value.topic && canonical(state.sources) === canonical(sources);
  })())) fail("investigation must retain the same sources with independent branches");
  if (!Array.isArray(value.comparisons) || value.comparisons.length > 16) fail("comparison history limit");
  for (const item of value.comparisons) {
    const comparison = validateComparison(item);
    if (comparison.topic !== value.topic || canonical(comparison.sources) !== canonical(sources)) fail("comparison source closure changed");
  }
  if (!Array.isArray(value.outlines) || value.outlines.length > 8) fail("outline history limit");
  for (let i = 0; i < value.outlines.length; i++) {
    const item = value.outlines[i];
    if (!plain(item) || !Number.isSafeInteger(item.revision) || item.revision < 1 || item.revision > 8 || !["complete", "failed", "cancelled", "user-modified", "user-reviewed"].includes(item.status) || !(item.receipt === null || plain(item.receipt)) || !Array.isArray(item.setAsideDisagreements) || !plain(item.citationReview) || typeof item.citationReview.required !== "boolean" || !(item.citationReview.reason === null || typeof item.citationReview.reason === "string") || !plain(item.conflictSetAside) || !Array.isArray(item.conflictSetAside.removedSpans) || !(item.conflictSetAside.reason === null || typeof item.conflictSetAside.reason === "string")) fail("invalid outline history item");
    if (item.outline === null) { if (["complete", "user-modified"].includes(item.status) || item.receipt === null) fail("missing successful outline draft"); }
    else {
      const outline = validateOutline(item.outline);
      if (outline.topic !== value.topic || canonical(outline.sources) !== canonical(sources)) fail("outline source closure changed");
      if (item.status === "complete" && outline.origin.type !== "model-generated" || ["user-modified", "user-reviewed"].includes(item.status) && outline.origin.type !== "user-modified") fail("outline status and origin disagree");
    }
    for (const d of item.setAsideDisagreements) {
      const comparison = value.comparisons[d?.comparisonIndex];
      if (!comparison || d.comparisonDigest !== comparison.digest || !comparison.result?.disagreements?.some(row => row.summary === d.summary) || d.reason !== setAsideReason) fail("outline set-aside disagreement is not bound to a comparison");
    }
    if (item.status === "user-modified") {
      const prior = value.outlines[i - 1];
      if (!prior?.outline || !item.outline) fail("edited outline has no previous version");
      const changed = canonical(outlineClaimBindings(prior.outline)) !== canonical(outlineClaimBindings(item.outline));
      if (item.citationReview.required !== changed || item.citationReview.reason !== (changed ? citationReviewReason : null)) fail("citation review reason mismatch");
      const priorSpans = outlineSpanKeys(sources, prior.outline), currentSpans = outlineSpanKeys(sources, item.outline);
      const conflictSpans = comparisonConflictSpans(value.comparisons, sources);
      const removed = conflictSpans.filter(span => priorSpans.includes(`${span.sourceSha256}:${span.start}:${span.end}`) && !currentSpans.includes(`${span.sourceSha256}:${span.start}:${span.end}`));
      if (canonical(item.conflictSetAside.removedSpans) !== canonical(removed) || item.conflictSetAside.reason !== (removed.length ? item.conflictSetAside.reason : null)
          || removed.length && !validLine(item.conflictSetAside.reason, 1000)) fail("removed conflict citation requires a recorded researcher reason");
    } else if (item.status === "user-reviewed") {
      const prior = value.outlines[i - 1];
      if (!prior?.outline || !prior.citationReview.required || !item.outline || canonical(outlineClaimBindings(prior.outline)) !== canonical(outlineClaimBindings(item.outline))
          || item.citationReview.required || item.citationReview.reason !== `Caller confirmed review of outline revision ${prior.revision}.`) fail("outline review confirmation does not match the exact prior revision");
    } else if (item.citationReview.required || item.citationReview.reason !== null) fail("unexpected citation review flag");
  }
  if (stateDigest(value) !== value.sha256 || Buffer.byteLength(canonical(value), "utf8") > 16 * 1024 * 1024) fail("workflow digest or size mismatch");
  return value;
}
const updated = (state, patch) => {
  const base = { ...state, ...patch, revision: state.revision + 1 };
  delete base.sha256;
  return validate(seal(base));
}

/** Starts a portable workflow over explicit frozen captures. Basic facts is always selected first. */
export function createPerspectiveWorkflow(topic, { id: workflowId, sources, perspectives = "auto" } = {}) {
  if (!validLine(topic, 2000)) fail("topic required");
  const retained = frozenSources(sources);
  const lenses = chooseLenses(rawSources(retained), perspectives);
  return validate(seal({ version: schema, owner: "research-ai", id: id(workflowId), topic, revision: 0,
    sources: retained, perspectiveChoices: clone(perspectives), lenses, perspectiveResult: null, investigation: null,
    comparisons: [], outlines: [] }));
}
export function validatePerspectiveWorkflow(value) { return validate(value); }

/** Runs the existing separate frozen lens sessions and attaches their exact source-bound result. */
export async function runWorkflowPerspectives(value, options = {}) {
  const state = validate(value); if (state.perspectiveResult) fail("perspectives already run; start a new workflow for another selection");
  const result = await perspectiveResearch(state.topic, { ...options, sources: rawSources(state.sources), perspectives: clone(state.perspectiveChoices) });
  checkPerspectiveResult(result, state.topic, state.sources, state.lenses);
  return updated(state, { perspectiveResult: result });
}

/** Exact-span marginal contribution: spans cited by this complete lens and no other complete lens. */
export function perspectiveSpanContribution(value) {
  const state = validate(value); if (!state.perspectiveResult) fail("perspectives have not run");
  const completed = state.perspectiveResult.lenses.filter(row => row.status === "complete");
  const spanKey = c => `${state.sources[c.source]?.sha256}:${c.start}:${c.end}`;
  const sets = new Map(completed.map(row => [row.lens.id, new Map(row.questions.flatMap(q => q.citations.map(c => [spanKey(c), { source: c.source, start: c.start, end: c.end, quote: c.quote }])))]));
  const citedBy = new Map();
  for (const row of completed) for (const key of sets.get(row.lens.id).keys()) citedBy.set(key, [...(citedBy.get(key) ?? []), row.lens.id]);
  const conflictKeys = new Set(state.comparisons.flatMap(comparison => (comparison.result?.disagreements ?? []).flatMap(disagreement => disagreement.positions.flatMap(position => position.source ? [`${position.source.sha256}:${position.source.start}:${position.source.end}`] : []))));
  const currentOutline = state.outlines.at(-1)?.outline;
  return state.perspectiveResult.lenses.map(row => {
    if (row.status !== "complete") return { lensId: row.lens.id, status: row.status, disposition: `lens-${row.status}`, uniqueCitedSpans: [], sharedCitedSpans: [], conflictCitedSpans: [], uniqueSourceOrigins: [], claimsLosingAllCitations: [], outlineClaimsLosingAllCitations: [], reason: row.reason ?? `Lens was ${row.status}; marginal cited-span contribution was not assessed.`, qualification: "A non-complete lens is not treated as a completed search with no supporting span." };
    const own = sets.get(row.lens.id), uniqueKeys = new Set([...own.keys()].filter(key => citedBy.get(key)?.length === 1));
    const uniqueCitedSpans = [...own].filter(([key]) => uniqueKeys.has(key)).map(([, span]) => ({ ...span, sourceUri: state.sources[span.source].uri, sourceSha256: state.sources[span.source].sha256 }));
    const sharedCitedSpans = [...own].filter(([key]) => (citedBy.get(key)?.length ?? 0) > 1).map(([key, span]) => ({ ...span, citedBy: citedBy.get(key), sourceUri: state.sources[span.source].uri, sourceSha256: state.sources[span.source].sha256 }));
    const conflictCitedSpans = [...own].filter(([key]) => conflictKeys.has(key)).map(([, span]) => ({ ...span, sourceUri: state.sources[span.source].uri, sourceSha256: state.sources[span.source].sha256 }));
    const uniqueSourceOrigins = [...new Set(uniqueCitedSpans.map(span => new URL(span.sourceUri).origin))].sort();
    const claimsLosingAllCitations = row.questions.filter(q => q.status !== "unanswered" && q.citations.length && q.citations.every(c => uniqueKeys.has(spanKey(c))))
      .map(q => ({ question: q.question, answer: q.answer, citations: q.citations.map(c => ({ source: c.source, sourceUri: state.sources[c.source].uri,
        sourceSha256: state.sources[c.source].sha256, start: c.start, end: c.end, quote: c.quote })) }));
    const outlineClaimsLosingAllCitations = currentOutline ? currentOutline.sections.flatMap(section => section.points.filter(point => point.citations.length && point.citations.every(c => uniqueKeys.has(spanKey({ ...c, source: c.source })))).map(point => ({ section: section.id, text: point.text }))) : [];
    const citedSpans = [...own.keys()];
    return { lensId: row.lens.id, status: "complete", disposition: citedSpans.length ? "completed-with-cited-spans" : "completed-no-supporting-span",
      uniqueCitedSpans, sharedCitedSpans, conflictCitedSpans, uniqueSourceOrigins, claimsLosingAllCitations, outlineClaimsLosingAllCitations,
      qualification: "Counts are exact source SHA-256 plus offsets. URL origins group by URL origin only and do not establish publisher, study independence, support, relevance, or quality. Set differences are not truth or confidence scores." };
  });
}

/** Creates the existing investigation owner in independent mode; question IDs remain caller-owned. */
export function startWorkflowInvestigation(value, { goal, scope = "", questions, budget } = {}) {
  const state = validate(value); if (state.investigation) fail("investigation already exists");
  if (!Array.isArray(questions) || questions.length < 2 || questions.length > 32) fail("provide 2-32 independent branch questions");
  const investigation = createInvestigation(state.topic, { goal: goal ?? state.topic, scope, questions, sources: rawSources(state.sources), budget, branchContext: "independent" });
  return updated(state, { investigation });
}
/** Runs selected question branches through the existing independent-investigation owner. */
export async function runWorkflowBranches(value, branchIds, options = {}) {
  const state = validate(value); if (!state.investigation) fail("start the independent investigation first");
  const investigation = await advanceInvestigation(state.investigation, { ...options, action: "investigate", branchIds });
  return updated(state, { investigation });
}
/** Compares explicit branches with the existing comparison owner; its artifact preserves source and attempt citations. */
export async function compareWorkflowBranches(value, options = {}) {
  const state = validate(value); if (!state.investigation) fail("start the independent investigation first");
  const { investigation, comparison } = await compareInvestigation(state.investigation, options);
  if (state.comparisons.length >= 16) fail("comparison history limit");
  return updated(state, { investigation, comparisons: [...state.comparisons, comparison] });
}
/** Drafts an editable outline with the existing source-cited outline owner after at least one comparison. */
export async function draftWorkflowOutline(value, options = {}) {
  const state = validate(value); if (!state.comparisons.length) fail("compare independent branches before outlining");
  if (state.outlines.length >= 8) fail("outline history limit");
  const result = await outlineResearch(state.topic, { ...options, sources: rawSources(state.sources) });
  const status = result.draft ? "complete" : result.status;
  const setAsideDisagreements = state.comparisons.flatMap((comparison, comparisonIndex) => (comparison.result?.disagreements ?? []).map(disagreement => ({ comparisonIndex, comparisonDigest: comparison.digest, summary: disagreement.summary, reason: setAsideReason })));
  return updated(state, { outlines: [...state.outlines, { revision: state.outlines.length + 1, status, outline: result.draft, receipt: result.receipt,
    setAsideDisagreements, citationReview: { required: false, reason: null }, conflictSetAside: { removedSpans: [], reason: null } }] });
}
/** User edits append a new validated outline revision; earlier generated/edit versions stay embedded. */
export function reviseWorkflowOutline(value, edits, { conflictSetAsideReason = null } = {}) {
  const state = validate(value); const prior = state.outlines.at(-1);
  if (!prior?.outline) fail("no outline draft to edit");
  if (state.outlines.length >= 8) fail("outline history limit");
  const outline = reviseOutline(prior.outline, edits);
  const changedCitations = canonical(outlineClaimBindings(prior.outline)) !== canonical(outlineClaimBindings(outline));
  const previousSpans = outlineSpanKeys(state.sources, prior.outline), nextSpans = outlineSpanKeys(state.sources, outline);
  const removedSpans = comparisonConflictSpans(state.comparisons, state.sources).filter(span => previousSpans.includes(`${span.sourceSha256}:${span.start}:${span.end}`) && !nextSpans.includes(`${span.sourceSha256}:${span.start}:${span.end}`));
  if (removedSpans.length && !validLine(conflictSetAsideReason, 1000)) fail("removing a cited side of a recorded conflict requires conflictSetAsideReason");
  if (!removedSpans.length && conflictSetAsideReason !== null) fail("conflictSetAsideReason is only valid when a conflict citation is removed");
  return updated(state, { outlines: [...state.outlines, { revision: state.outlines.length + 1, status: "user-modified", outline, receipt: prior.receipt,
    setAsideDisagreements: clone(prior.setAsideDisagreements), citationReview: { required: changedCitations, reason: changedCitations ? citationReviewReason : null },
    conflictSetAside: { removedSpans, reason: removedSpans.length ? conflictSetAsideReason : null } }] });
}
/** Records an explicit caller review of citation bindings for the exact current edited outline revision. */
export function reviewWorkflowOutlineCitations(value, { confirmRevision } = {}) {
  const state = validate(value), prior = state.outlines.at(-1);
  if (!prior?.outline || !prior.citationReview.required || confirmRevision !== prior.revision) fail("confirm the exact current revision that requires citation review");
  if (state.outlines.length >= 8) fail("outline history limit");
  return updated(state, { outlines: [...state.outlines, { ...clone(prior), revision: state.outlines.length + 1, status: "user-reviewed",
    citationReview: { required: false, reason: `Caller confirmed review of outline revision ${prior.revision}.` } }] });
}
export function workflowComparisonCurrentness(value, index = value?.comparisons?.length - 1) {
  const state = validate(value); const comparison = state.comparisons[index];
  if (!comparison || !state.investigation) fail("comparison or investigation is unavailable");
  return comparisonCurrentness(comparison, state.investigation);
}
/** Exact portable JSON closure or a readable composite export. No phase is regenerated on reopen. */
export function renderPerspectiveWorkflow(value, { format = "json" } = {}) {
  const state = validate(value);
  if (format === "json") return `${JSON.stringify(state, null, 2)}\n`;
  if (format !== "markdown") fail("format must be json or markdown");
  const contribution = state.perspectiveResult ? perspectiveSpanContribution(state).map(row => `### ${row.lensId} (${row.status}${row.disposition ? ` · ${row.disposition}` : ""})\n${row.uniqueCitedSpans.length ? `Only this perspective cited:\n${row.uniqueCitedSpans.map(s => `- Source ${s.source + 1} ${s.sourceUri} (SHA-256 ${s.sourceSha256}), UTF-16 ${s.start}-${s.end}: ${JSON.stringify(s.quote)}`).join("\n")}` : row.status === "complete" ? "Only this perspective cited: none." : `Contribution not assessed: ${row.reason}`}\n${row.sharedCitedSpans?.length ? `\nAlso cited by others:\n${row.sharedCitedSpans.map(s => `- ${JSON.stringify(s.quote)} (lenses: ${s.citedBy.join(", ")})`).join("\n")}` : ""}\n${row.conflictCitedSpans?.length ? `\nCited in a recorded conflict:\n${row.conflictCitedSpans.map(s => `- ${JSON.stringify(s.quote)} (${s.sourceUri}, SHA-256 ${s.sourceSha256})`).join("\n")}` : ""}\n${row.uniqueSourceOrigins?.length ? `\nDistinct URL origins among only-this-perspective spans: ${row.uniqueSourceOrigins.join(", ")}. URL origin is not source independence.` : ""}\n${row.claimsLosingAllCitations?.length ? `\nPerspective claims losing all their cited spans if this lens is removed:\n${row.claimsLosingAllCitations.map(c => `- ${c.answer}`).join("\n")}` : ""}\n${row.outlineClaimsLosingAllCitations?.length ? `\nOutline claims losing all citations if this lens is removed (${row.outlineClaimsLosingAllCitations.length}):\n${row.outlineClaimsLosingAllCitations.map(c => `- ${c.text}`).join("\n")}` : ""}\n\n${row.qualification}`).join("\n\n") : "Perspectives not run.";
  const comparisons = state.comparisons.map((c, i) => `## Comparison ${i + 1}\n\n${renderComparison(c, { format: "markdown", ...(state.investigation ? { investigation: state.investigation } : {}) })}`).join("\n\n") || "No comparison run.";
  const outline = state.outlines.map(item => `## Outline revision ${item.revision} (${item.status})\n\n${item.citationReview.required ? `**Citation review required:** ${item.citationReview.reason}\n\n` : ""}${item.setAsideDisagreements.length ? `**Disagreements set aside with reason:**\n${item.setAsideDisagreements.map(d => `- ${d.summary}: ${d.reason}`).join("\n")}\n\n` : ""}${item.conflictSetAside.removedSpans.length ? `**Conflict set aside by researcher:** ${item.conflictSetAside.reason}\n${item.conflictSetAside.removedSpans.map(s => `- Removed cited span: ${JSON.stringify(s.quote)} (${s.sourceUri}, SHA-256 ${s.sourceSha256}, UTF-16 ${s.start}-${s.end})`).join("\n")}\n\n` : ""}${item.outline ? renderOutline(item.outline, { format: "markdown" }) : "No validated outline draft was retained."}`).join("\n\n") || "No outline drafted.";
  return `# ${state.topic}\n\nWorkflow revision: ${state.revision}\n\nThis portable workflow is fallible research over caller-supplied frozen sources. Citations establish exact text occurrence only. Repetition across branches is not corroboration; the workflow does not count branch agreement as evidence.\n\n## Perspectives and exact-span differences\n\n${contribution}\n\n## Independent investigation\n\n${state.investigation ? "```json\n" + JSON.stringify(state.investigation, null, 2) + "\n```" : "Not started."}\n\n## Comparisons\n\n${comparisons}\n\n## Editable outline history\n\n${outline}\n\n## Exact source identities\n\n${state.sources.map(s => `- ${s.uri} — SHA-256 ${s.sha256}${s.observedAt ? `; observed ${s.observedAt}` : ""}${(s.omissions ?? []).map(o => `\n  - Caller omission: ${o}`).join("")}`).join("\n")}\n\nWorkflow digest: ${state.sha256}\n`;
}
