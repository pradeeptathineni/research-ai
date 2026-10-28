# Opportunity briefs

An opportunity brief records a human-authored plan for examining one existing
project opportunity. It binds the exact connected project context, saved
opportunity, retained topic, and project-topic relevance review. If that review
includes a source-change review, the brief retains its exact review and capture
references too. Evidence rows may cite only exact topic-member records or those
retained captures.

Each evidence row records a caller-selected position (`supports`, `challenges`,
`context`, or `unknown`), a separate qualitative confidence (`high`, `moderate`,
`low`, or `unknown`), and the caller's rationale. Contradictions and missing
evidence remain explicit. A later read reports source currentness independently
from those confidence judgments. Changed, missing, and unavailable sources do
not cause a replacement to be selected.

New brief snapshots also copy the exact S07 relevance judgment and rationale
and, when selected, the exact S04 meaningfulness judgment, rationale, capture
hashes and assertion decisions. This bounded `review_context` is retained
inside the existing brief record. It distinguishes S04 assertion currentness
observed at review time from the brief's human confidence; export does not
refresh or interpret either judgment.

Brief snapshots are immutable entries nested in the existing private Projects
opportunity records. They do not create a second project or evidence store,
change the opportunity itself, rewrite a topic or review, or copy source
excerpts. A stable request UUID is the brief ID; repeating it with the same
request is idempotent, while different content under that ID conflicts. After an
uncertain write, open that exact UUID before taking another action.

The provider contract is `project-opportunity-brief` v1 with
`read_project_opportunity_brief` and `retain_project_opportunity_brief`, and
record kind `project_opportunity_brief`. Its reference hashes the immutable
brief bytes. The provider binding includes the canonical contract digest,
instance and owner epoch; it includes a source commit only when the owner
reports one.

The separate `project-opportunity-brief-confidence-packet` v1 contract
provides deterministic JSON and Markdown downloads from one exact retained
brief UUID. Export embeds the exact record JSON and its hash reference and
does not fetch sources or substitute newer reviews. Older brief records remain
unchanged; their export states when the embedded S04/S07 snapshot is absent.
The existing exact brief read reopens that same saved record after restart,
including when current sources are unavailable.

An opportunity brief is not a verified claim, a numerical ranking, proof of
project impact, or authority to execute or publish an intervention. Planning
receives a typed exact reference; the referenced bytes remain owned by Signals.

## Human reassessment

When the project or evidence basis changes, an operator can retain a successor
brief after reviewing a fresh current project, opportunity, topic and
relevance basis. The successor links the exact parent brief reference and hash,
requires a concise rationale, and may revise individual evidence positions,
confidence labels or explanations. Unedited rows and narrative are inherited
exactly. The parent remains immutable, and each revision has a new stable UUID.

Reassessment uses the additive `project-opportunity-brief-reassessment` v1
contract. Its binding covers only that contract and its preview/save
operations, leaving the original brief binding digest unchanged. Save checks
the exact parent, current basis and contract binding again under the existing
Projects writer lock. A changed basis rejects the save; read the exact saved
successor UUID after an uncertain reply rather than issuing a replacement.
Reassessment does not acquire new sources, infer truth, assign scores or alter
the independent source-currentness result.
