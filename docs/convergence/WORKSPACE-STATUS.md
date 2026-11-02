# RX02 private workspace convergence

This private integration workspace composes the existing Research Methods and Signals Library repositories in one Node 24.19 workspace. It changes no public release, private-store location, standalone package identity, or data bytes.

## Components and contract

`packages/methods` advances the existing history-preserving source prefix to exact Research commit `cecbe5da3127826affb7630707aeb55f8aa62cd3` using Git's subtree merge strategy. Its package name/version, Node engine, 17 CLI names and paths, ESM export/declaration, and zero-runtime-dependency boundary stay intact. The component manifest binds its source tree, identity projection, and exact package payload.

`packages/library` is advanced by history-preserving subtree merges to exact Signals source `17af801a3df3d4231f9654207584a1691020dae1`, candidate parent `15bb150a0400b0884b8d6857ba5fcfaae13c7d9a`. The 389-file Git blob comparison confirms exact native parity except the documented workspace dependency link in `package.json`. The Library standalone lock and five vendored archive files stay unchanged byte-for-byte. `signals/` and `.signals/` paths stay unchanged.

Methods owns bounded interpretation and portable research artifacts. Library owns retained records, acquisition, Briefing ranking, saved-entity inspection, and its existing user-facing workbench. Its saved-entity view joins an exact saved record to introducing receipts and run IDs, keeps saved state separate from assessment state, and reports confidence as Unknown. Inspection does not change the record or rerun research. A Briefing-to-Research handoff requires an explicit story and item selection. The Methods owner validates those exact references and retains source terms, health, URLs, and digests in an in-memory notebook. Ranking is not evidence strength; citations do not certify entailment, independence, rights, currentness, or truth. The complete contract is in [RX02-SEMANTIC-CONTRACT.md](RX02-SEMANTIC-CONTRACT.md).

`apps/workbench` is a thin npm entrypoint to the existing Library workbench. The synthetic consumer flow exercises the exact Methods selection helper, cold-reopens the Notebook, and creates a caller-authored cited report and claim register. It uses no server, network, model, or real store. It does not implement a second UI.

## Compatibility and verification

The standalone `research-ai` and `signals-ai` package identities and CLI names remain available. Root scripts provide `methods:verify`, `library:verify`, and `rx02:verify`; the combined command runs both package gates and the workbench checks in sequence. `npm run workbench:verify` runs the entrypoint and complete synthetic cross-owner flow.

The workspace lock and manifests bind package identity, declared payload hashes, exact source commits, dependency links, and the fixed archive bytes. The Library workspace guard requires an explicit root, manifest digest, lock digest, and workspace mode. With workspace mode absent, standalone fixed-tarball verification remains active. No store migration, publication, credential, or real-store write is part of this P2 workspace.

## Current focused gate results

At the earlier RX02 checkpoints, the complete Methods suite passed (348 tests: 325 passed, 23 skipped). Against Library 6195b0e, the workspace Briefing-to-Research flow, entrypoint check, Library typecheck/build, and dependency review passed; against formatting successor 3cfd39, the saved-entity inspection/UI tests passed (6/6). These are prior-source results, not a full verification of the current 17af801 source.

The historical full Library `verify` against 3cfd39 stopped at lint (111 errors/27 files); f06192c later had 71 errors/15 files in lint-only evidence. On final 17af801, full ESLint (zero errors), TypeScript, release, corpus, format and production build passed; source continuity tests passed 10/10 and the project relevance test passed. After specific user approval, the existing npm audit passed with no high or critical advisories. A fresh isolated clone used normal offline `npm ci --no-audit --ignore-scripts` to create the exact declared Methods workspace link; the explicit dependency guard passed 28 pinned versions and reviewed licenses without source/lock edits. `quality:structure` still fails on baseline Knip unused exports and jscpd reports 20 duplicates versus baseline 21. One projects listener case is blocked by sandbox EPERM. The complete verify gate is not passed. See [the verification receipt](LIBRARY-VERIFY-RESULT.md).
