import { createHash } from "node:crypto";
import { getResearchStudyCitation, validateResearchStudy } from "./study.mjs";
import { validateOutline } from "./outline.mjs";

const sha = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const canonical = (value) => Array.isArray(value)
  ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const originUri = (origin) => `research-notebook://source/${encodeURIComponent(origin.notebookId)}/${encodeURIComponent(origin.recordId)}/${origin.kind}/${origin.version === null ? "source" : origin.version}/${origin.page}?study=${encodeURIComponent(origin.studyId)}&studySha=${origin.studySha256}&question=${encodeURIComponent(origin.questionId)}&questionSha=${origin.questionSha256}&plan=${origin.planDigest}&selectionDigest=${origin.selectionDigest}&result=${origin.resultSha256}&selection=${encodeURIComponent(origin.selectionId)}&selectionSha=${origin.selectionSha256}&notebookSha=${origin.notebookSha256}&source=${origin.sourceDigest}&content=${origin.pageSha256}`;
const invalid = (reason) => { throw new Error(`invalid_study_report: ${reason}`); };

/** Projects only answer rows with retained citations into the existing editable report basis. */
export function createResearchStudyReportBasis(value, questionId) {
  const study = validateResearchStudy(value);
  const question = study.questions.find((item) => item.id === questionId);
  if (!question) invalid("question is not retained in this Study");
  const draft = question.result.draft;
  if (question.result.status !== "complete" || !draft || !["answered", "partial"].includes(draft.coverage)
      || !Array.isArray(draft.answer) || draft.answer.length < 1)
    invalid("Study question has no complete cited answer to continue");
  if (draft.coverage === "partial" && !draft.gaps.length) invalid("partial Study answer has no retained qualification");

  const sources = [], sourceIndexes = new Map(), points = [], omitted = [];
  for (let answerParagraph = 0; answerParagraph < draft.answer.length; answerParagraph++) {
    const row = draft.answer[answerParagraph];
    if (typeof row.text !== "string" || !row.text.trim() || row.text.length > 1000 || !Array.isArray(row.evidenceIds))
      invalid(`Study answer paragraph ${answerParagraph + 1} is malformed`);
    const evidenceIds = [...new Set(row.evidenceIds)];
    if (!evidenceIds.length) {
      omitted.push(`Original Study answer paragraph ${answerParagraph + 1} was not imported because the saved answer retained no evidence IDs.`);
      continue;
    }
    if (evidenceIds.length > 4) invalid(`Study answer paragraph ${answerParagraph + 1} has more than four citations; split or review it in Research first`);
    const citations = evidenceIds.map((evidenceId) => {
      const opened = getResearchStudyCitation(study, questionId, evidenceId);
      const { evidence, page, selection } = opened;
      if (!row.evidenceIds.includes(evidenceId) || typeof evidence.quote !== "string"
          || page.text.slice(evidence.start, evidence.end) !== evidence.quote)
        invalid(`Study answer citation ${evidenceId} no longer matches the canonical retained page`);
      const key = canonical({ selectionId: selection.id, page: page.number, pageSha256: page.sha256 });
      let source = sourceIndexes.get(key);
      if (source === undefined) {
        if (sources.length >= 8) invalid("cited answer spans exceed the eight-source report limit");
        const origin = {
          format: "research-study-source-v1",
          studyId: study.id,
          studySha256: study.sha256,
          questionId: question.id,
          questionSha256: question.sha256,
          planDigest: question.planDigest,
          selectionDigest: question.selectionDigest,
          resultSha256: sha(canonical(question.result)),
          selectionId: selection.id,
          selectionSha256: selection.sha256,
          notebookId: selection.origin.notebookId,
          notebookSha256: selection.origin.notebookSha256,
          kind: selection.origin.kind,
          recordId: selection.origin.recordId,
          version: selection.origin.version,
          documentId: selection.document.id,
          page: page.number,
          sourceDigest: selection.origin.sourceDigest,
          pageSha256: page.sha256,
          title: selection.document.title,
        };
        source = sources.length;
        sourceIndexes.set(key, source);
        sources.push({ uri: originUri(origin), text: page.text, sha256: page.sha256, retainedOrigin: origin });
      }
      return { source, start: evidence.start, end: evidence.end, quote: evidence.quote };
    });
    points.push({ text: row.text, citations });
  }
  if (!points.length) invalid("Study answer has no cited paragraph to carry into a report");

  const sections = [];
  for (let offset = 0; offset < points.length; offset += 5) {
    const index = sections.length + 1;
    sections.push({
      id: `study-findings-${index}`,
      title: `Selected findings${sections.length ? ` · part ${index}` : ""}`,
      points: points.slice(offset, offset + 5),
      gaps: index === 1 ? [...draft.gaps, ...omitted] : [],
    });
  }
  const limits = [
    "This editable report starts from answer paragraphs in a retained Research Study. It preserves their wording and citations; it does not re-evaluate them.",
    "Citations are exact occurrences in the selected Study snapshot. They do not establish entailment, truth, completeness, or present-day source availability.",
    `The source answer reported ${draft.coverage} coverage; its original qualifications remain visible.`,
  ];
  if (omitted.length) limits.push(`${omitted.length} original Study answer paragraph(s) without retained evidence IDs were omitted and listed as explicit gaps.`);
  return validateOutline({
    version: "research-outline-v1",
    topic: question.question,
    sources,
    sections,
    origin: { type: "caller-authored" },
    limits,
  });
}

/** Re-derives the closed report basis from the exact Study result and rejects caller edits. */
export function validateResearchStudyReportBasis(study, questionId, candidate) {
  const expected = createResearchStudyReportBasis(study, questionId);
  if (canonical(expected) !== canonical(candidate)) invalid("report basis differs from the exact retained Study answer");
  return expected;
}
