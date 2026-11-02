# RX02 private workspace convergence

This private integration workspace composes the existing Research Methods and Signals Library repositories in one Node 24.19 workspace. It changes no public release, private-store location, standalone package identity, or data bytes.

## Components and contract

`packages/methods` advances the existing history-preserving source prefix to exact Research commit `cecbe5da3127826affb7630707aeb55f8aa62cd3` using Git's subtree merge strategy. Its package name/version, Node engine, 17 CLI names and paths, ESM export/declaration, and zero-runtime-dependency boundary stay intact. The component manifest binds its source tree, identity projection, and exact package payload.

`packages/library` is advanced by history-preserving subtree merges to exact Signals source `73e9925d7175a67b571da9e242aa91e28930fdf5`, a saved-entity hardening child of combined lint successor `f06192c72fdfab0384d465c240d21f295764afdf`. The 389-file Git blob comparison confirms exact native parity except the documented workspace dependency link in `package.json`. The Library standalone lock and five vendored archive files stay unchanged byte-for-byte. `signals/` and `.signals/` paths stay unchanged.

Methods owns bounded interpretation and portable research artifacts. Library owns retained records, acquisition, Briefing ranking, saved-entity inspection, and its existing user-facing workbench. Its saved-entity view joins an exact saved record to introducing receipts and run IDs, keeps saved state separate from assessment state, and reports confidence as Unknown. Inspection does not change the record or rerun research. A Briefing-to-Research handoff requires an explicit story and item selection. The Methods owner validates those exact references and retains source terms, health, URLs, and digests in an in-memory notebook. Ranking is not evidence strength; citations do not certify entailment, independence, rights, currentness, or truth. The complete contract is in [RX02-SEMANTIC-CONTRACT.md](RX02-SEMANTIC-CONTRACT.md).

`apps/workbench` is a thin npm entrypoint to the existing Library workbench. The synthetic consumer flow exercises the exact Methods selection helper, cold-reopens the Notebook, and creates a caller-authored cited report and claim register. It uses no server, network, model, or real store. It does not implement a second UI.

## Compatibility and verification

The standalone `research-ai` and `signals-ai` package identities and CLI names remain available. Root scripts provide `methods:verify`, `library:verify`, and `rx02:verify`; the combined command runs both package gates and the workbench checks in sequence. `npm run workbench:verify` runs the entrypoint and complete synthetic cross-owner flow.

The workspace lock and manifests bind package identity, declared payload hashes, exact source commits, dependency links, and the fixed archive bytes. The Library workspace guard requires an explicit root, manifest digest, lock digest, and workspace mode. With workspace mode absent, standalone fixed-tarball verification remains active. No store migration, publication, credential, or real-store write is part of this P2 workspace.

## Current focused gate results

At the earlier RX02 checkpoints, the complete Methods suite passed (348 tests: 325 passed, 23 skipped). Against Library 6195b0e, the workspace Briefing-to-Research flow, entrypoint check, Library typecheck/build, and dependency review passed; against formatting successor 3cfd39, the saved-entity inspection/UI tests passed (6/6). These are prior-source results, not a full verification of the current 73e9925 source.

The historical full Library `verify` command against 3cfd39 passed release, corpus and format checks, then stopped at ESLint with 111 errors across 27 files; no later phase ran. Current lint-only evidence at f06192c is 71 errors across 15 files and is not a full verify. The final 73e9925 saved-entity change passed targeted lint, TypeScript and inspection tests (6/6) in its native clone. The explicit workspace dependency guard was attempted here but is blocked because this isolated clone has no installed Methods workspace link. See [the verification receipt](LIBRARY-VERIFY-RESULT.md).
