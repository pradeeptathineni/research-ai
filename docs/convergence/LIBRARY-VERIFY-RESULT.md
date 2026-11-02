# Library verify result for RX02

The final Knip comparison has the baseline unused-export findings plus one additional finding for the pre-existing exported `SourceCaptureScope` type, now unused internally after a redundant assertion was removed. Its export remains for compatibility.

This historical full-gate result applies to Library source 3cfd39. It remains the only recorded full `verify` invocation that reached lint; later source successors are covered by separate checks below, not by a full-gate pass. The full gate was run once on 2 November 2026 with Node 24.19.0/npm 12.1.0 from the isolated RX02 workspace, using `npm run verify --workspace signals-ai` and the explicit workspace manifest/lock environment. It exited 1 at lint.

Passed before the stop:

- Release guard: `Pre-1 release guard passed: 0.3.0`.
- Corpus consistency: 19 reviewed bundles, 20 public options, 13 native entities.
- `format:check`: `All matched files use Prettier code style!`.

The `lint` script stopped the sequence with 111 errors and 0 warnings across 27 files. Representative findings were an unused `_unboundItemId` in `packages/corpus/src/briefing/event-rank-input.test.ts`, unnecessary type assertions and unsafe `any` use in `packages/corpus/src/briefing/ingest.ts`, `any`/unsafe-return findings in `packages/corpus/src/briefing/social-pulse-workflow.test.ts`, an async `beforeRetain` without `await` in `packages/corpus/src/source-archives.ts`, and `process` reported undefined in `packages/library/scripts/research-pin.mjs`. No later verify phases ran; the full Library gate remains unqualified.

## Source attribution

Each of the 27 lint paths is under `packages/library/`. A Git tree/blob comparison between workspace `HEAD:packages/library` and native Library commit `3cfd39c31a075e1e18985c57981d4821e80dd601` found that all 27 offending blobs match exactly. None is a workspace-only source file. The complete path set is:

- `packages/library/packages/corpus/src/briefing/event-rank-input.test.ts`
- `packages/library/packages/corpus/src/briefing/ingest.ts`
- `packages/library/packages/corpus/src/briefing/interest-feedback-workflow.test.ts`
- `packages/library/packages/corpus/src/briefing/schema.test.ts`
- `packages/library/packages/corpus/src/briefing/schema.ts`
- `packages/library/packages/corpus/src/briefing/social-pulse-workflow.test.ts`
- `packages/library/packages/corpus/src/briefing/store.test.ts`
- `packages/library/packages/corpus/src/briefing/store.ts`
- `packages/library/packages/corpus/src/library-intake-workflow.test.ts`
- `packages/library/packages/corpus/src/project-opportunity-brief.ts`
- `packages/library/packages/corpus/src/project-topic-relevance.test.ts`
- `packages/library/packages/corpus/src/project-topic-relevance.ts`
- `packages/library/packages/corpus/src/projects.ts`
- `packages/library/packages/corpus/src/provider-capabilities.ts`
- `packages/library/packages/corpus/src/search-api.ts`
- `packages/library/packages/corpus/src/search-settings.ts`
- `packages/library/packages/corpus/src/source-archive-workflow.test.ts`
- `packages/library/packages/corpus/src/source-archives.ts`
- `packages/library/packages/corpus/src/source-captures.ts`
- `packages/library/packages/corpus/src/source-change-reviews.test.ts`
- `packages/library/packages/corpus/src/source-change-reviews.ts`
- `packages/library/scripts/project-topic-relevance.ts`
- `packages/library/scripts/research-pin.mjs`
- `packages/library/scripts/research-pin.test.mjs`
- `packages/library/scripts/source-archives.ts`
- `packages/library/scripts/source-change-reviews.ts`
- `packages/library/scripts/source-watches.ts`

Root also ran a targeted read-only lint on `candidate-views.tsx`, `experience.tsx`, and `saved-entity-inspection.ts`; those three files passed. Its three nearby findings were in existing `provider-capabilities.ts` and `search-api.ts` lines outside the saved-entity change.

The historical full-gate lint run predates native saved-entity recovery commit `40d69b9`, imported by subtree merge `68378765`, and subsequent lint and saved-entity successors. Among the 27 lint paths, 13 were byte-identical to the older native `4e` pin, six were newer native files, and eight had changed in native source since that pin; none was introduced only by the workspace merge. No lint repairs, store writes, browser tests, network audit, or other post-lint verify phases were run by this lane.

Final native candidate `17af801a3df3d4231f9654207584a1691020dae1` passed full ESLint with zero errors, TypeScript, production build and format checks. Focused source continuity tests passed 10/10 and the project relevance test passed. The `quality:structure` gate still fails on baseline Knip unused-export findings; jscpd reports 20 duplicates versus the baseline count of 21. One projects listener case was blocked by sandbox `EPERM`. After specific user approval, the existing external npm audit passed with no high or critical advisories and no dependency change. A fresh isolated clone of this exact workspace used normal offline `npm ci --no-audit --ignore-scripts` to install the declared Methods link; the explicit workspace dependency guard then passed 28 exact direct versions and reviewed licenses without source or lock edits. The complete `verify` gate is not passed. Prior lint-only evidence at `f06192c72fdfab0384d465c240d21f295764afdf` was 71 errors across 15 files. The historical full verify result above remains scoped to 3cfd39.
