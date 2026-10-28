# Briefing interest terms and feedback

The `briefing/workbench` read returns ranked stories, the existing score explanation, and `matchedTerms` beside each row. `matchedTerms` is a read-time projection of that row's exact retained rank inputs: enabled, source-compatible interest terms that match its item title or excerpt and are not excluded, together with any terms already retained on the Story. It is sorted by interest ID and term. The exact `input.story` and its record reference remain unchanged; the projection is not written into historical Story bytes.

Consumers should render the returned terms for the mute action instead of maintaining a second matching rule. To mute one displayed term, submit the existing `briefing/feedback` operation with `{ requestId, targetKind: "term", targetId: "<displayed term>", action: "mute-term" }`. The same normalized term comparison used by ranking applies. The next workbench read suppresses stories matching that term. The response receipt contains the canonical feedback record and its exact ID.

Undo with `briefing/feedback/undo` and `{ requestId, feedbackId }`, using a fresh request ID and the prior feedback ID. Feedback and undo are append-only and idempotent under their request IDs. A subsequent workbench read reopens the story from the same owner store; no local optimistic visibility state is required. Unknown or nonmatching terms remain stored as explicit user feedback but do not hide unrelated stories.

The score remains the versioned `briefing-linear-v1` explanation in the same row. `matchedTerms` clarifies which configured phrases support relevance; it does not replace or reinterpret the score. Source policy, measured social observations, event timezone values and calendar export remain separate fields and owners.
