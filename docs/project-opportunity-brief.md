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

An opportunity brief is not a verified claim, a numerical ranking, proof of
project impact, or authority to execute or publish an intervention. Planning
receives a typed exact reference; the referenced bytes remain owned by Signals.
