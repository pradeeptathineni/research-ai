# RX02 private workspace convergence

This private integration workspace composes the existing Research Methods and Signals Library repositories in one Node 24.19 workspace. It changes no public release, private-store location, standalone package identity, or data bytes.

## Components and contract

`packages/methods` advances the existing history-preserving source prefix to exact Research commit `cecbe5da3127826affb7630707aeb55f8aa62cd3` using Git's subtree merge strategy. Its package name/version, Node engine, 17 CLI names and paths, ESM export/declaration, and zero-runtime-dependency boundary stay intact. The component manifest binds its source tree, identity projection, and exact package payload.

`packages/library` remains pinned at exact Signals source `4e2d47096251ea4646efdfdf4209e04c079d59ad`. Its sole source-package adaptation changes the Research dependency from the frozen tarball to the local Methods workspace link. The Library standalone lock and five vendored archive files stay unchanged byte-for-byte. `signals/` and `.signals/` paths stay unchanged.

Methods owns bounded interpretation and portable research artifacts. Library owns retained records, acquisition, Briefing ranking, and its existing user-facing workbench. A Briefing-to-Research handoff requires an explicit story and item selection. The Methods owner validates those exact references and retains source terms, health, URLs, and digests in an in-memory notebook. Ranking is not evidence strength; citations do not certify entailment, independence, rights, currentness, or truth. The complete contract is in [RX02-SEMANTIC-CONTRACT.md](RX02-SEMANTIC-CONTRACT.md).

`apps/workbench` is a thin npm entrypoint to the existing Library workbench. The synthetic consumer flow exercises the exact Methods selection helper, cold-reopens the Notebook, and creates a caller-authored cited report and claim register. It uses no server, network, model, or real store. It does not implement a second UI.

## Compatibility and verification

The standalone `research-ai` and `signals-ai` package identities and CLI names remain available. Root scripts provide `methods:verify`, `library:verify`, and `rx02:verify`; the combined command runs both package gates and the workbench checks in sequence. `npm run workbench:verify` runs the entrypoint and complete synthetic cross-owner flow.

The workspace lock and manifests bind package identity, declared payload hashes, exact source commits, dependency links, and the fixed archive bytes. The Library workspace guard requires an explicit root, manifest digest, lock digest, and workspace mode. With workspace mode absent, standalone fixed-tarball verification remains active. No store migration, publication, credential, or real-store write is part of this P2 workspace.

## Current focused gate results

On Node 24.19.0/npm 12.1.0, the complete Methods suite passed (348 tests: 325 passed, 23 skipped). The workspace Briefing-to-Research flow and entrypoint check passed without a server, network, model, or real store. The Library workspace dependency check verified 28 pinned direct dependencies and reviewed licenses; Library typecheck passed, and its production corpus build passed. The Library full `verify` sequence was not run: its first `format:check` gate reports five existing files (`briefing-calendar.test.ts`, `hacker-news-adapter.test.ts`, `json-feed-media.test.ts`, `refresh-due.test.ts`, and `scripts/corpus.ts`). Library source stays at its frozen pin, so that formatter failure remains an acceptance limitation for the full Library gate.
