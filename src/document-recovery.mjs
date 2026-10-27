// Hierarchical, retryable document coverage over caller-retained exact pages.
// Execution, quote validation and synthesis remain delegated to document-coverage.
import { createHash, randomUUID } from "node:crypto";
import { prepareDocumentCoverage, researchDocumentCoverage, validateDocumentCoverage, renderDocumentCoverage } from "./document-coverage.mjs";

const version = "research-document-recovery-v1";
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = value => createHash("sha256").update(value, "utf8").digest("hex");
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : plain(value) ? `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const digest = value => hash(canonical(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "sha256"))));
const fail = reason => { throw new TypeError(`invalid_document_recovery: ${reason}`); };
const line = (value, max) => typeof value === "string" && value.trim() && value.length <= max && value.isWellFormed() && !/[\p{Cc}]/u.test(value);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const clone = value => structuredClone(value);
const uuid = value => {
  const result = value ?? `recovery:${randomUUID()}`;
  if (typeof result !== "string" || !/^recovery:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result)) fail("workflow ID");
  return result;
};

const pageIndex = documents => new Map(documents.flatMap(document => document.pages.map(page => [`${document.id}\0${page.number}`, { document, page }])));
function validateManifest(documents, sections) {
  if (!Array.isArray(sections) || sections.length < 1 || sections.length > 256) fail("expected 1-256 hierarchical sections");
  const byId = new Map();
  for (const section of sections) {
    if (!plain(section) || Object.keys(section).some(key => !["id", "parentId", "title", "pageRefs", "extractionGaps", "required"].includes(key))
        || !line(section.id, 120) || !idPattern.test(section.id) || byId.has(section.id)
        || !(section.parentId === null || line(section.parentId, 120)) || !line(section.title, 240)
        || !Array.isArray(section.pageRefs) || !Array.isArray(section.extractionGaps) || section.extractionGaps.length > 64
        || section.required !== undefined && typeof section.required !== "boolean") fail("invalid section metadata");
    byId.set(section.id, section);
  }
  for (const section of sections) if (section.parentId !== null && !byId.has(section.parentId)) fail(`unknown parent for ${section.id}`);
  const visited = new Set();
  const visit = (section, path = new Set()) => {
    if (path.has(section.id)) fail("section hierarchy contains a cycle");
    if (visited.has(section.id)) fail("section hierarchy contains a repeated child");
    visited.add(section.id);
    const next = new Set(path).add(section.id);
    const children = sections.filter(child => child.parentId === section.id);
    return children.length ? children.flatMap(child => visit(child, next)) : [section];
  };
  const roots = sections.filter(section => section.parentId === null);
  const leafRows = roots.flatMap(section => visit(section));
  if (!roots.length || visited.size !== sections.length) fail("section hierarchy must be a connected forest");
  const parents = new Set(sections.map(section => section.parentId).filter(Boolean));
  const leaves = leafRows;
  if (leaves.length < 1 || leaves.some(section => section.pageRefs.length < 1)) fail("every leaf section must reference pages");
  const pages = pageIndex(documents), assigned = new Set();
  for (const section of sections) {
    if (parents.has(section.id) && (section.pageRefs.length || section.extractionGaps.length || section.required !== undefined)) fail("container sections cannot own pages, extraction gaps, or required flags");
    for (const ref of section.pageRefs) {
      if (!plain(ref) || !line(ref.documentId, 120) || !Number.isSafeInteger(ref.page) || !pages.has(`${ref.documentId}\0${ref.page}`)) fail(`unknown page reference in ${section.id}`);
      const key = `${ref.documentId}\0${ref.page}`;
      if (assigned.has(key)) fail(`page ${ref.documentId}:${ref.page} is assigned more than once`);
      assigned.add(key);
    }
    for (const gap of section.extractionGaps) {
      if (!plain(gap) || !line(gap.id, 120) || !line(gap.kind, 40) || !["ocr", "table", "layout", "other"].includes(gap.kind)
          || !line(gap.documentId, 120) || !Number.isSafeInteger(gap.page) || !pages.has(`${gap.documentId}\0${gap.page}`)
          || !line(gap.detail, 1000) || !line(gap.assertedBy, 120) || !line(gap.observedAt, 80)) fail(`invalid caller-declared extraction gap in ${section.id}`);
    }
  }
  if (assigned.size !== pages.size || [...pages.keys()].some(key => !assigned.has(key))) fail("each retained page must be assigned to exactly one leaf section");
  const gapIds = sections.flatMap(section => section.extractionGaps.map(gap => gap.id));
  if (new Set(gapIds).size !== gapIds.length) fail("extraction-gap IDs must be unique");
  return { leaves, pages };
}
const leafDocuments = (section, sources) => {
  const byDoc = new Map();
  for (const ref of section.pageRefs) {
    const source = sources.find(document => document.id === ref.documentId), page = source.pages[ref.page - 1];
    if (!byDoc.has(source.id)) byDoc.set(source.id, { id: source.id, title: source.title, sha256: source.sha256, pages: [] });
    const entry = byDoc.get(source.id);
    entry.pages.push({ number: entry.pages.length + 1, text: page.text, sha256: page.sha256 });
  }
  return [...byDoc.values()];
};
const leafIndexMap = (section, sources) => {
  const map = [];
  for (const documentId of [...new Set(section.pageRefs.map(ref => ref.documentId))]) {
    const refs = section.pageRefs.filter(ref => ref.documentId === documentId);
    refs.forEach((ref, index) => map.push({ documentId, localPage: index + 1, originalPage: ref.page,
      sourceSha256: sources.find(document => document.id === ref.documentId).sha256,
      pageSha256: sources.find(document => document.id === ref.documentId).pages[ref.page - 1].sha256 }));
  }
  return map;
};
const unresolved = entry => entry.attempts.length > 0 && entry.attempts.at(-1).status !== "unknown" && (entry.attempts.at(-1).status !== "complete"
  || !entry.attempts.at(-1).result?.inputCoverage.complete || entry.attempts.at(-1).result?.draft?.coverage !== "answered");
const qualified = (state, sections, plannedMaximumCalls) => {
  const rows = [], gaps = [];
  for (const section of state.manifest) {
    const data = sections.find(entry => entry.sectionId === section.id);
    if (!data || section.pageRefs.length === 0) continue;
    const last = data.attempts.at(-1), result = last?.result;
    if (!result) {
      gaps.push(`${section.title}: no validated coverage result${last?.failure ? ` (${last.failure})` : ""}.`);
      continue;
    }
    if (result.status !== "complete" || !result.inputCoverage.complete || result.draft?.coverage !== "answered")
      gaps.push(`${section.title}: execution ${result.status}, input coverage ${result.inputCoverage.complete ? "complete" : "partial"}, answer coverage ${result.draft?.coverage ?? "unavailable"}.`);
    for (const omission of result.draft?.gaps ?? []) gaps.push(`${section.title}: ${omission}`);
    if (result.draft) for (const answer of result.draft.answer) {
      const citations = answer.evidenceIds.map(evidenceId => {
        const evidence = result.draft.evidence.find(item => item.id === evidenceId);
        const page = data.pageMap.find(item => item.documentId === evidence.documentId && item.localPage === evidence.page);
        return { evidenceId, documentId: page.documentId, documentSha256: page.sourceSha256, page: page.originalPage,
          pageSha256: page.pageSha256, start: evidence.start, end: evidence.end, quote: evidence.quote, relation: evidence.relation };
      });
      rows.push({ sectionId: section.id, sectionTitle: section.title, text: answer.text, citations });
    }
  }
  for (const section of state.manifest.filter(section => !state.manifest.some(child => child.parentId === section.id)))
    for (const omission of section.extractionGaps) gaps.push(`${section.title}: caller-declared ${omission.kind} extraction gap (${omission.id}) at ${omission.documentId}, page ${omission.page}: ${omission.detail} [asserted by ${omission.assertedBy} at ${omission.observedAt}; unverified extraction metadata].`);
  const required = state.manifest.filter(section => section.required !== false && !state.manifest.some(child => child.parentId === section.id));
  const anyResult = sections.some(section => section.attempts.some(attempt => attempt.result?.receipt.startedCalls > 0));
  const cleanup = sections.flatMap(section => section.attempts.map(attempt => attempt.result?.receipt.cleanup)).filter(Boolean);
  const cleanupComplete = cleanup.every(value => value === "complete") && anyResult;
  const hasUnknown = sections.some(section => section.attempts.at(-1)?.status === "unknown");
  const complete = required.every(section => {
    const item = sections.find(entry => entry.sectionId === section.id)?.attempts.at(-1)?.result;
    return item?.status === "complete" && item.inputCoverage.complete && item.draft?.coverage === "answered";
  }) && !gaps.length && cleanupComplete;
  return { status: hasUnknown ? "unknown" : complete ? "complete" : rows.length ? "partial" : "failed", answer: rows, gaps, cleanup: cleanupComplete ? "complete" : cleanup.includes("unconfirmed") ? "unconfirmed" : "incomplete",
    plannedMaximumCalls, startedCalls: sections.flatMap(section => section.attempts.map(attempt => attempt.result?.receipt.startedCalls ?? 0)).reduce((a, b) => a + b, 0),
    qualification: "This answer is a section-by-section assembly of existing validated document-coverage drafts, not a new cross-section synthesis. Partial extraction or review is shown as a gap. Caller-declared OCR/table/layout gaps are unverified extraction metadata. Exact citations refer to the original retained document and page versions; exact occurrence does not establish entailment or truth." };
};

function validate(value) {
  if (!plain(value) || Object.keys(value).sort().join() !== ["version", "owner", "id", "question", "revision", "sources", "manifest", "policy", "plannedMaximumCalls", "sections", "aggregate", "sha256"].sort().join()
      || value.version !== version || value.owner !== "research-ai" || !/^recovery:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.id)
      || !line(value.question, 2000) || !Number.isSafeInteger(value.revision) || value.revision < 0 || !/^[a-f0-9]{64}$/.test(value.sha256)
      || !plain(value.policy) || Object.keys(value.policy).sort().join() !== ["maxCallsPerSection", "maxRetriesPerSection", "maxSecondsPerSection", "passUtf16Units", "totalMaxCalls"].sort().join()
      || !Number.isSafeInteger(value.policy.maxCallsPerSection) || value.policy.maxCallsPerSection < 2 || value.policy.maxCallsPerSection > 64
      || !Number.isSafeInteger(value.policy.maxRetriesPerSection) || value.policy.maxRetriesPerSection < 0 || value.policy.maxRetriesPerSection > 3
      || !Number.isSafeInteger(value.policy.totalMaxCalls) || value.policy.totalMaxCalls < 2 || value.policy.totalMaxCalls > 4096
      || !Number.isSafeInteger(value.policy.passUtf16Units) || value.policy.passUtf16Units < 1000 || value.policy.passUtf16Units > 48000
      || !Number.isSafeInteger(value.policy.maxSecondsPerSection) || value.policy.maxSecondsPerSection < 1 || value.policy.maxSecondsPerSection > 3600) fail("invalid workflow header");
  const original = prepareDocumentCoverage(value.question, value.sources, { maxCalls: 64, passUtf16Units: 48000, maxSeconds: 1 }).documents;
  if (canonical(original) !== canonical(value.sources)) fail("source snapshots changed");
  const { leaves } = validateManifest(original, value.manifest);
  if (!Array.isArray(value.sections) || value.sections.length !== leaves.length) fail("section attempts do not match manifest leaves");
  let reserved = 0;
  const normalized = leaves.map((leaf, i) => {
    const section = value.sections[i];
    if (!plain(section) || Object.keys(section).sort().join() !== ["sectionId", "attempts", "pageMap", "reservedMaximumCalls"].sort().join()
        || section.sectionId !== leaf.id || !Array.isArray(section.attempts) || section.attempts.length > value.policy.maxRetriesPerSection + 1) fail("invalid section attempt history");
    const docs = leafDocuments(leaf, original), plan = prepareDocumentCoverage(value.question, docs,
      { maxCalls: value.policy.maxCallsPerSection, passUtf16Units: value.policy.passUtf16Units, maxSeconds: value.policy.maxSecondsPerSection });
    reserved += plan.counts.maximumCalls * (value.policy.maxRetriesPerSection + 1);
    const pageMap = leafIndexMap(leaf, original);
    if (canonical(section.pageMap) !== canonical(pageMap)
        || section.reservedMaximumCalls !== plan.counts.maximumCalls * (value.policy.maxRetriesPerSection + 1)) fail("section source map or reservation changed");
    const attempts = section.attempts.map((attempt, n) => {
      if (!plain(attempt) || Object.keys(attempt).sort().join() !== ["number", "status", "result", "failure"].sort().join()
          || attempt.number !== n + 1 || !["complete", "partial", "failed", "cancelled", "not_run", "unknown"].includes(attempt.status)
          || !(attempt.result === null || plain(attempt.result)) || !(attempt.failure === null || line(attempt.failure, 500))) fail("invalid attempt record");
      if (attempt.result) {
        const result = validateDocumentCoverage(attempt.result);
        if (result.plan.question !== value.question || canonical(result.plan.documents) !== canonical(docs)
            || canonical(result.plan.policy) !== canonical({ maxCalls: value.policy.maxCallsPerSection,
              passUtf16Units: value.policy.passUtf16Units, maxSeconds: value.policy.maxSecondsPerSection })) fail("attempt source scope or budget differs from its exact section plan");
        if (result.status !== attempt.status || attempt.failure !== null) fail("attempt status does not match coverage result");
      } else if (!["not_run", "unknown"].includes(attempt.status) || !attempt.failure) fail("attempt without a result must remain visibly not run or unknown");
      return clone(attempt);
    });
    return { sectionId: leaf.id, attempts, pageMap, reservedMaximumCalls: plan.counts.maximumCalls * (value.policy.maxRetriesPerSection + 1) };
  });
  if (reserved > value.policy.totalMaxCalls || value.plannedMaximumCalls !== reserved) fail("closed retry call reservation exceeds totalMaxCalls");
  const aggregate = qualified({ manifest: value.manifest }, normalized, reserved);
  if (canonical(aggregate) !== canonical(value.aggregate)) fail("aggregate answer or gaps do not replay");
  if (digest(value) !== value.sha256 || Buffer.byteLength(canonical(value), "utf8") > 64 * 1024 * 1024) fail("workflow digest or size mismatch");
  return value;
}
const seal = value => ({ ...value, sha256: digest(value) });
const updated = (state, patch) => { const base = { ...state, ...patch, revision: state.revision + 1 }; delete base.sha256; return validate(seal(base)); };

/** Creates a finite plan over exact pages; every page is assigned once to a leaf section. */
export function createDocumentRecovery(question, { id: recoveryId, documents, sections, policy = {} } = {}) {
  if (!line(question, 2000)) fail("question required");
  if (!plain(policy) || Object.keys(policy).some(key => !["maxCallsPerSection", "maxRetriesPerSection", "totalMaxCalls", "passUtf16Units", "maxSecondsPerSection"].includes(key))) fail("unknown policy field");
  const normalized = prepareDocumentCoverage(question, documents, { maxCalls: 64, passUtf16Units: 48000, maxSeconds: 1 }).documents;
  validateManifest(normalized, sections);
  const bounded = { maxCallsPerSection: policy.maxCallsPerSection ?? 12, maxRetriesPerSection: policy.maxRetriesPerSection ?? 1,
    totalMaxCalls: policy.totalMaxCalls ?? 128, passUtf16Units: policy.passUtf16Units ?? 24000, maxSecondsPerSection: policy.maxSecondsPerSection ?? 600 };
  if (bounded.maxCallsPerSection < 2 || bounded.maxCallsPerSection > 64 || bounded.maxRetriesPerSection < 0 || bounded.maxRetriesPerSection > 3
      || bounded.totalMaxCalls < 2 || bounded.totalMaxCalls > 4096 || bounded.passUtf16Units < 1000 || bounded.passUtf16Units > 48000
      || bounded.maxSecondsPerSection < 1 || bounded.maxSecondsPerSection > 3600) fail("policy outside safe bounds");
  const leaves = validateManifest(normalized, sections).leaves;
  const shell = { version, owner: "research-ai", id: uuid(recoveryId), question, revision: 0, sources: normalized, manifest: clone(sections), policy: bounded,
    plannedMaximumCalls: 0, sections: leaves.map(section => ({ sectionId: section.id, attempts: [], pageMap: leafIndexMap(section, normalized), reservedMaximumCalls: 0 })), aggregate: null };
  let total = 0;
  for (const section of leaves) {
    const plan = prepareDocumentCoverage(question, leafDocuments(section, normalized), { maxCalls: bounded.maxCallsPerSection, passUtf16Units: bounded.passUtf16Units, maxSeconds: bounded.maxSecondsPerSection });
    total += plan.counts.maximumCalls * (bounded.maxRetriesPerSection + 1);
  }
  shell.plannedMaximumCalls = total;
  shell.sections = shell.sections.map(row => ({ ...row, reservedMaximumCalls: total / leaves.length }));
  // Per-section exact reservations can vary; calculate and retain their own values.
  shell.sections = shell.sections.map((row, index) => {
    const plan = prepareDocumentCoverage(question, leafDocuments(leaves[index], normalized), { maxCalls: bounded.maxCallsPerSection,
      passUtf16Units: bounded.passUtf16Units, maxSeconds: bounded.maxSecondsPerSection });
    return { ...row, reservedMaximumCalls: plan.counts.maximumCalls * (bounded.maxRetriesPerSection + 1) };
  });
  if (total > bounded.totalMaxCalls) fail(`closed call reservation ${total} exceeds totalMaxCalls ${bounded.totalMaxCalls}`);
  shell.aggregate = qualified(shell, shell.sections, total);
  return validate(seal(shell));
}
export function validateDocumentRecovery(value) { return validate(value); }

async function runSection(state, section, number, options) {
  const manifest = state.manifest.find(item => item.id === section.sectionId), docs = leafDocuments(manifest, state.sources);
  const plan = prepareDocumentCoverage(state.question, docs, { maxCalls: state.policy.maxCallsPerSection, passUtf16Units: state.policy.passUtf16Units, maxSeconds: state.policy.maxSecondsPerSection });
  const coverageOptions = { ...Object.fromEntries(["profile", "model", "effort", "lease", "signal", "progress", "activity"].filter(key => options[key] !== undefined).map(key => [key, options[key]])),
    maxCalls: state.policy.maxCallsPerSection, passUtf16Units: state.policy.passUtf16Units, maxSeconds: state.policy.maxSecondsPerSection,
    confirmedPlanDigest: plan.planDigest };
  const attemptNumber = number, executionId = hash(canonical({ workflowId: state.id, workflowSha256: state.sha256,
    sectionId: section.sectionId, attemptNumber, planDigest: plan.planDigest }));
  const request = { workflowId: state.id, workflowSha256: state.sha256, sectionId: section.sectionId, attemptNumber,
    question: state.question, documents: docs, planDigest: plan.planDigest, planCounts: plan.counts,
    policy: { ...state.policy }, coverageOptions, executionId };
  let response;
  try {
    response = options.dispatchSection
      ? await options.dispatchSection(request)
      : await researchDocumentCoverage(state.question, docs, coverageOptions);
  } catch {
    return { number, status: "unknown", result: null, failure: "Section dispatch callback or coverage owner threw after invocation; execution and durable result readback are unknown. Do not retry from this artifact." };
  }
  if (plain(response) && response.status === "unknown") {
    return { number, status: "unknown", result: null, failure: line(response.reason, 500)
      ? `Caller journal reports unknown execution for ${executionId}: ${response.reason}`
      : `Caller journal reports unknown execution for ${executionId}; do not retry from this artifact.` };
  }
  try {
    const result = validateDocumentCoverage(response);
    if (result.plan.question !== request.question || canonical(result.plan.documents) !== canonical(docs)
        || result.plan.planDigest !== plan.planDigest || canonical(result.plan.policy) !== canonical({ maxCalls: state.policy.maxCallsPerSection,
          passUtf16Units: state.policy.passUtf16Units, maxSeconds: state.policy.maxSecondsPerSection })) fail("returned owner result is outside the confirmed section scope or budget");
    return { number, status: result.status, result, failure: null };
  } catch {
    return { number, status: "unknown", result: null, failure: `Section dispatch returned an invalid or mismatched owner result for ${executionId}; execution readback is unknown. Do not retry from this artifact.` };
  }
}
/** Runs every manifest leaf once through the existing bounded coverage owner. */
async function runRecovery(value, options) {
  const state = validate(value);
  if (!plain(options) || Object.keys(options).some(key => !["confirmedSha256", "profile", "model", "effort", "lease", "signal", "progress", "activity", "dispatchSection"].includes(key))
      || options.dispatchSection !== undefined && typeof options.dispatchSection !== "function") fail("unsupported execution option");
  if (options.confirmedSha256 !== state.sha256) fail("confirm the exact recovery plan SHA-256 before dispatch");
  if (state.sections.some(section => section.attempts.length)) fail("initial section pass already started");
  const sections = []; let unknown = false;
  for (const section of state.sections) {
    if (unknown) sections.push({ ...section, attempts: [{ number: 1, status: "not_run", result: null, failure: "Skipped after an unknown prior section outcome; inspect the caller's durable execution journal." }] });
    else if (options.signal?.aborted) sections.push({ ...section, attempts: [{ number: 1, status: "not_run", result: null, failure: "Workflow cancelled before this section started." }] });
    else {
      const attempt = await runSection(state, section, 1, options);
      sections.push({ ...section, attempts: [attempt] });
      unknown = attempt.status === "unknown";
    }
  }
  const interim = { ...state, sections };
  return updated(state, { sections, aggregate: qualified(interim, sections, state.plannedMaximumCalls) });
}
export function runDocumentRecovery(value, options = {}) { return runRecovery(value, options); }
/** Retries only explicitly selected sections with incomplete execution or model-reported coverage. */
export async function retryDocumentRecovery(value, sectionIds, options = {}) {
  const state = validate(value);
  if (!plain(options) || Object.keys(options).some(key => !["confirmedSha256", "profile", "model", "effort", "lease", "signal", "progress", "activity", "dispatchSection"].includes(key))
      || options.dispatchSection !== undefined && typeof options.dispatchSection !== "function") fail("unsupported execution option");
  if (options.confirmedSha256 !== state.sha256) fail("confirm the exact recovery plan SHA-256 before retry dispatch");
  if (state.sections.some(section => section.attempts.at(-1)?.status === "unknown")) fail("workflow contains an unknown dispatch outcome; read the caller's durable journal before any further retry");
  if (!Array.isArray(sectionIds) || !sectionIds.length || new Set(sectionIds).size !== sectionIds.length) fail("select unique unresolved section IDs");
  const selected = new Set(sectionIds), sections = state.sections.map(section => ({ ...section, attempts: [...section.attempts] }));
  for (const section of sections) {
    if (!selected.has(section.sectionId)) continue;
    if (section.attempts.at(-1)?.status === "unknown") fail(`${section.sectionId} has an unknown dispatch outcome; read the caller's durable journal before considering recovery`);
    if (!section.attempts.length || !unresolved(section)) fail(`${section.sectionId} is not an execution or answer-coverage retry candidate`);
    if (section.attempts.length > state.policy.maxRetriesPerSection) fail(`${section.sectionId} exhausted its reserved retries`);
  }
  for (const id of selected) if (!sections.some(section => section.sectionId === id)) fail(`unknown section ID ${id}`);
  let unknown = false;
  for (const section of sections) if (selected.has(section.sectionId)) {
    const attempt = unknown
      ? { number: section.attempts.length + 1, status: "not_run", result: null, failure: "Skipped after an unknown prior retry outcome; inspect the caller's durable execution journal." }
      : options.signal?.aborted
        ? { number: section.attempts.length + 1, status: "not_run", result: null, failure: "Workflow cancelled before this retry started." }
        : await runSection(state, section, section.attempts.length + 1, options);
    section.attempts = [...section.attempts, attempt];
    unknown = attempt.status === "unknown";
  }
  return updated(state, { sections, aggregate: qualified(state, sections, state.plannedMaximumCalls) });
}

export function renderDocumentRecovery(value, { format = "json" } = {}) {
  const state = validate(value);
  if (format === "json") return `${JSON.stringify(state, null, 2)}\n`;
  if (format !== "markdown") fail("format must be json or markdown");
  const leafRows = state.sections.map(section => {
    const definition = state.manifest.find(item => item.id === section.sectionId), latest = section.attempts.at(-1);
    const result = latest?.result;
    const citationRows = result?.draft?.evidence.map(evidence => {
      const original = section.pageMap.find(page => page.documentId === evidence.documentId && page.localPage === evidence.page);
      return `- ${evidence.relation}: ${evidence.documentId}, source SHA-256 ${original.sourceSha256}, page ${original.originalPage} (page SHA-256 ${original.pageSha256}), UTF-16 ${evidence.start}-${evidence.end}: ${JSON.stringify(evidence.quote)}`;
    }) ?? [];
    return `### ${definition.title} (${latest?.status ?? "not run"})\n\nAttempts: ${section.attempts.length}/${state.policy.maxRetriesPerSection + 1}; unresolved: ${unresolved(section) ? "yes" : "no"}\n\n${result?.draft?.answer.map(row => `- ${row.text} [${row.evidenceIds.join(", ")}]`).join("\n") ?? latest?.failure ?? "Not run."}\n\n${citationRows.join("\n") || "No cited exact spans."}\n\n${(result?.draft?.gaps ?? []).map(gap => `- Gap: ${gap}`).join("\n")}`;
  }).join("\n\n");
  return `# ${state.question}\n\nRecovery status: ${state.aggregate.status}\n\n${state.aggregate.qualification}\n\n## Section answers\n\n${leafRows}\n\n## Coverage and extraction gaps\n\n${state.aggregate.gaps.length ? state.aggregate.gaps.map(gap => `- ${gap}`).join("\n") : "No unresolved or caller-declared gaps."}\n\nSession budget: ${state.aggregate.startedCalls}/${state.aggregate.plannedMaximumCalls} reserved maximum calls; cleanup ${state.aggregate.cleanup}.\n\n## Retained source versions\n\n${state.sources.map(document => `- ${document.id} — source SHA-256 ${document.sha256}; ${document.pages.length} extracted pages`).join("\n")}\n\nWorkflow digest: ${state.sha256}\n`;
}

// Kept exported for inspection clients that need section-local owner exports.
export function renderDocumentRecoverySection(value, sectionId) {
  const state = validate(value), section = state.sections.find(entry => entry.sectionId === sectionId);
  if (!section?.attempts.length) fail("section has no retained attempt");
  const result = section.attempts.at(-1).result;
  return result ? renderDocumentCoverage(result, { format: "markdown" }) : `No validated result for ${sectionId}.`;
}
