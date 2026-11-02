# RX02 private workspace convergence

This private integration workspace composes the existing Research Methods and Signals Library repositories in one Node 24.19 workspace. It changes no public release, private-store location, standalone package identity, or data bytes.

## Components and contract

`packages/methods` advances the existing history-preserving source prefix to exact Research commit `cecbe5da3127826affb7630707aeb55f8aa62cd3` using Git's subtree merge strategy. Its package name/version, Node engine, 17 CLI names and paths, ESM export/declaration, and zero-runtime-dependency boundary stay intact. The component manifest binds its source tree, identity projection, and exact package payload.

`packages/library` is advanced by subtree merge to exact Signals source `3cfd39c31a075e1e18985c57981d4821e80dd601`, a formatting-only child of `6195b0e47cc97874ab17e2434b1a1cd7be79fc42`. A Git blob comparison confirms all 389 tracked Library files match the native source except the documented workspace dependency link in `package.json`. The Library standalone lock and five vendored archive files stay unchanged byte-for-byte. `signals/` and `.signals/` paths stay unchanged.

Methods owns bounded interpretation and portable research artifacts. Library owns retained records, acquisition, Briefing ranking, saved-entity inspection, and its existing user-facing workbench. Its saved-entity view joins an exact saved record to introducing receipts and run IDs, keeps saved state separate from assessment state, and reports confidence as Unknown. Inspection does not change the record or rerun research. A Briefing-to-Research handoff requires an explicit story and item selection. The Methods owner validates those exact references and retains source terms, health, URLs, and digests in an in-memory notebook. Ranking is not evidence strength; citations do not certify entailment, independence, rights, currentness, or truth. The complete contract is in [RX02-SEMANTIC-CONTRACT.md](RX02-SEMANTIC-CONTRACT.md).

`apps/workbench` is a thin npm entrypoint to the existing Library workbench. The synthetic consumer flow exercises the exact Methods selection helper, cold-reopens the Notebook, and creates a caller-authored cited report and claim register. It uses no server, network, model, or real store. It does not implement a second UI.

## Compatibility and verification

The standalone `research-ai` and `signals-ai` package identities and CLI names remain available. Root scripts provide `methods:verify`, `library:verify`, and `rx02:verify`; the combined command runs both package gates and the workbench checks in sequence. `npm run workbench:verify` runs the entrypoint and complete synthetic cross-owner flow.

The workspace lock and manifests bind package identity, declared payload hashes, exact source commits, dependency links, and the fixed archive bytes. The Library workspace guard requires an explicit root, manifest digest, lock digest, and workspace mode. With workspace mode absent, standalone fixed-tarball verification remains active. No store migration, publication, credential, or real-store write is part of this P2 workspace.

## Current focused gate results

On Node 24.19.0/npm 12.1.0, the complete Methods suite passed (348 tests: 325 passed, 23 skipped). Against Library 6195b0e, the workspace Briefing-to-Research flow and entrypoint check passed without a server, network, model, or real store. The B2 formatting successor 3cfd39 reports typecheck passed and saved-entity inspection/UI tests passed (6/6). Library typecheck and production corpus build also passed against 6195b0e. The workspace dependency guard verified 28 pinned direct dependencies and reviewed licenses.

The full Library `verify` command was attempted once against 3cfd39. Release guard, corpus check and Prettier check passed. It stopped at ESLint with exit code 1: 111 errors across 27 files whose Git blobs all match native 3cfd39; no later verify phase ran. [The verify receipt](LIBRARY-VERIFY-RESULT.md) records the representative findings and blob proof. No lint or unrelated source repairs were made.
