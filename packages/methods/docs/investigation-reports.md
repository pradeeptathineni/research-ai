# Reports from guided Investigations

`createInvestigationReportBasis(investigation, questionId, attemptId)` carries
one explicitly selected, current completed branch into the existing
`research-report-v1` owner. It uses the retained Investigation source text and
only current caller-authored finding reviews. Each carried paragraph records
the finding, the caller's `supports`, `contradicts`, or `context` assessment,
the rationale, and the exact source spans already validated by the
Investigation owner.

Attempt gaps remain report gaps. Findings with no current review, conflicting
reviews, or an `unresolved` review remain explicit unknown gaps and are not
promoted into cited paragraphs. The source occurrence check does not establish
entailment or truth. The report is limited to the selected question and attempt;
it does not claim to be a synthesis of the whole Investigation.

The projection returns a `research-outline-v1`. Continue with the existing
report API:

```js
const basis = createInvestigationReportBasis(savedInvestigation, "yield", "a1");
const draft = createReport(basis);
const reviewed = reviseReport(draft, {
  sectionId: basis.sections[0].id,
  paragraphs: [/* human-edited paragraphs with retained exact citations */],
});
const cold = validateReport(JSON.parse(JSON.stringify(reviewed)));
const html = exportReportHtml(cold);
```

Reopen and export are offline and do not rerun research. HTML contains only the
current section revision and derives its citation/unresolved register from that
exact report state. The source URL uses the reserved `research-ai.invalid`
host as an opaque, non-fetching locator; its query binds the original caller
source URI, Investigation identity, question ID and digest, selected attempt,
and source digest. All normal report bounds apply, including eight sources,
eight sections, 350-character paragraphs and 250-character gaps; projection
refuses content that cannot fit without loss.

This bridge does not add a report database or change the legacy report and
Study report exports. A caller still owns saved Investigation and report JSON
and must explicitly edit/review the report before sharing it.
