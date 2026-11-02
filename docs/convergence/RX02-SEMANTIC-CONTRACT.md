# RX02 Research workbench contract

The workspace composes two existing product owners under one Research workbench.
Methods (`@pradeeptathineni/research-ai`) owns bounded research execution and
portable, source-bound research artifacts. Library (`signals-ai`) owns retained
corpus records, source acquisition, Briefing ranking, saved-entity inspection,
and user-facing library views. Methods does not acquire or persist Library
records; Library ranking does not establish evidence strength or verified truth.

The Library saved-entity view reads one exact saved record and its matching
introducing receipts. It reports the record's saved state separately from its
assessment state and keeps confidence `Unknown`. The evidence and frozen run
IDs remain visible, and a saved receipt can reopen its historical run. The
operation is read-only: it does not amend the record, add an assessment, or run
research again.

The cross-owner route is explicit: Library produces a current Briefing
workbench response, and the caller selects one exact story reference and one or
more exact item references. `createResearchNotebookFromBriefingSelection`
reopens those references in that response, checks their membership, and returns
an in-memory Research Notebook retaining the exact story, item, source,
content digest, excerpt digest, observation time, health, and canonical URL.
The flow performs no additional acquisition, ranking, model call, or storage.
Research reports remain fallible; citations identify retained material and do
not certify entailment, independence, rights, currentness, or truth.

Compatibility is part of this composition. The standalone `research-ai` and
`signals-ai` package identities and all existing CLI names and paths stay
unchanged. Research workbench commands resolve to workspace-local Methods and
Library packages. The original Library scripts continue to operate on its
existing `signals/` corpus and `.signals/` private state. The fixed vendored
Research archives and Library standalone lock remain byte-identical. This P2
workspace creates no store migration or public publication.

Run `npm run workbench:verify` for the package-resolution and synthetic
Library-to-Research consumer flow. Run `npm run rx02:verify` to execute both
package gates and the workbench proof in sequence.
