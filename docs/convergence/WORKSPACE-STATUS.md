# RX02 private workspace convergence

This private integration workspace brings exact frozen Research Methods and Signals Library sources under one declared npm workspace. Standalone repositories and package identities remain the source of truth. No runtime package was installed during workspace or lock generation.

## Imported components

`packages/methods` is a history-preserving subtree of accepted Research source `f59707b9286d55f8b642bf3b2c372b8190642840` (descended through the Briefing-origin and report API integrations). Its package name/version, Node engine, 17 existing CLI names and paths, ESM export/declaration and zero-runtime-dependency boundary are unchanged. `methods-component-manifest.json` binds the source Git tree, identity projection and exact 85-file package payload. The refreshed source adds exact Briefing story/item/source refs to Research Notebook sources and exposes current report claim-register/document-recovery APIs. Package identity and every existing CLI name/path remain unchanged; the payload digest now binds the new declared file bytes. The manifest is workspace metadata outside the package's published `files` list.

`packages/library` is a history-preserving subtree of accepted Signals commit `4e2d47096251ea4646efdfdf4209e04c079d59ad`, descended from accepted Briefing baseline `14fe11e`. The subtree includes the HN, Mastodon, GitHub Releases/Tags, Lobsters, matched-term feedback, and source-change coverage descendants. All imported source blobs are identical to that source except the recorded workspace-only `package.json` dependency rewrite from the fixed Research tarball to `file:../methods`. Library's own `package-lock.json`, original fixed tarball, tarball digest/integrity, Research pin guard, capability IDs, and standalone location remain unchanged. The root workspace lock creates an exact `@pradeeptathineni/research-ai → packages/methods` workspace link and a `signals-ai → packages/library` link.

`apps/workbench` is a thin package entrypoint. Its start, dev, test and build scripts forward to the existing `signals-ai` package scripts. Its `verify:entrypoint` check resolves `packages/library/scripts/workbench.ts`, and `verify:briefing-research` composes a synthetic ranked story through exact Research Notebook origin retention and a caller-authored Research report. It contains no UI, server implementation, or duplicated workbench. The original Library workbench remains at its existing path.

## Preserved consumers

The Research/Signals inventory remains unchanged: Research's `research-ai` CLI/API and the Signals CLI retain their names and paths. The three Deep capability IDs remain `source-change-review`, `project-topic-relevance`, and `project-opportunity-brief`; the four `SignalsProviderContractBinding` consumers remain `capability-client.ts` and the source-change, project-topic-relevance, and project-opportunity-brief panels. No Deep/Root file was edited here. Their external runtime mounts are not asserted by this workspace package test.

## Workspace integrity

The Methods guard requires explicit workspace mode plus absolute root and manifest paths, manifest SHA-256, lock SHA-256, Git ancestry, package identity and every declared package payload blob. The workspace link is accepted only at the declared root. The guard does not search arbitrary parent `node_modules` directories and the default standalone mode remains unchanged. The Library source lock stays byte-for-byte at SHA-256 `6825a1a769e111dcc90b5d249b857730a28376e559101f27d0fb22a371db7dfa`; the generated root lock was produced with Node 24.19.0/npm 12.1.0 using `--package-lock-only --ignore-scripts --offline`, without creating `node_modules` or accessing the network.

The workspace component manifest records exact source roots/revisions, source package-lock hashes, package metadata shim hashes, root package/lock hashes and the unchanged archive bytes. Runtime guard variables are listed in that manifest's delivery companion `RX02-COMPATIBILITY.json`.

## Checks

The check totals below are the historical `1ce0e56` checkpoint on Methods 17eb and Library 92c; they are retained as history and were not rerun as a broad gate for this refresh.

### P2 refresh checks

The isolated workspace now imports Methods `f59707b9286d55f8b642bf3b2c372b8190642840` and Library `4e2d47096251ea4646efdfdf4209e04c079d59ad`. The Methods workspace guard and Library dependency checker passed in explicit workspace mode, verifying package identity, source ancestry, the declared payload digest, workspace link, root lock and 28 exact direct dependency versions/licenses. The default standalone Research archive pin test passed 2/2 with workspace mode unset; the standalone Library lock and fixed tarball remain unchanged.

The workbench forwarder check passed. Its synthetic consumer flow passed from one fixture JSON Feed through the existing Briefing refresh and ranking owners, exact story/item/source references, Methods `add-briefing-source` notebook retention/cold reopen, and a caller-authored Research report with one exact excerpt citation and claim-register projection. No model or network was used. The current Library source-change-review test passed 1/1, and Library TypeScript checking passed.

At the initial f597 checkpoint, the Methods package-consumer fixture omitted four then-public exports; a disposable fixture-adjusted copy passed its probes. That gap is now closed by test-only Methods child c261 (see the current P2 qualification below), without changing production files.

The workspace forwarder check passed (`npm run workbench:verify`). The Methods package-consumer check passed 1/1 on exact source 17eb after importing the source's repaired expected-file fixture. A full Methods run on source 0e0 before that fixture update had 318 passed, one expected-file-list failure, and 22 skipped; the 17eb owner reported its complete standalone source gate as 319 passed and 22 skipped. This workspace did not repeat the long Methods suite after importing 17eb.

Workspace integrity checks passed: `signals-ai` verified 28 exact direct dependency versions and reviewed licenses in explicit workspace mode; the focused HN adapter test passed 3/3; the standalone plus explicit-workspace research-pin tests passed 2/2 with the appropriate environment; context verification and pack tests passed; Library typecheck and build passed. Research answer and provenance tests passed.

The full Library gate is not green in this sandbox. `verify.sh` stops at `format:check`, which reports nine files: three changed since frozen Signals baseline 14fe (`hacker-news-adapter.test.ts`, `ingest.ts`, `store.ts`) and six unchanged files. The formatter was not run because it mutates frozen source. Lint reports 75 errors and the existing quality gate reports one unused file and exported API warnings. The Vitest suite returned 543 passed and 54 failed, with seven errors; the failures report loopback `listen EPERM` and 5-second process deadlines while the lengthy Methods gate ran at the same time. Playwright web servers also stopped at loopback `EPERM`. No tests were rerun through another port or with expanded privileges. The separate `npm audit` network command was skipped under the no-network boundary.

The workspace-specific Library guard and dependency checker received explicit `SIGNALS_RESEARCH_LAYOUT=workspace`, absolute root and Methods manifest, and the recorded manifest/lock digests. The full gates were attempted with Node 24.19.0 and an owned clonefile copy of the exact-lock Library dependency cache; no packages were installed into the workspace. One offline temporary packed Methods consumer passed its install, CLI, ESM, types, and ownership checks. No external production consumer checkout, publish, or standalone Library archive install was performed.


## Current P2 refresh

The refreshed workspace imports exact accepted Methods `c261de3ed9827b21b5a3c818c464ed7af905f51b` (runtime-identical to f597; only the consumer fixture changes) and Library `4e2d47096251ea4646efdfdf4209e04c079d59ad`. `SOURCE-INTEGRITY.json` records byte-for-byte comparison of all 138 tracked Methods source files and 371 tracked Library source files, with only the workspace-owned Methods identity manifest and the declared Library dependency-link adaptation excluded. Methods revision c261 adds the package-consumer expected exports while retaining the prior RS07 regression test; no runtime source or package payload changed. Library's standalone lock, fixed Research tarball, package identity, Methods CLI paths and Research package exports remain bound by the manifests and existing guard.

The workbench smoke uses a synthetic JSON Feed and actual Library refresh/ranking/workbench owners, passes exact story/item/source references and source health into the Methods Briefing-origin Notebook, cold-reopens it, then creates a caller-authored Research report over the exact excerpt. The generic report has no typed Briefing-origin field; exact owner refs remain typed in the Notebook and are caller qualifications in the report. This does not claim a model answer or Study citation. No network, model, listener or real store was used.

Current targeted checks: workspace entrypoint and consumer flow passed; Library TypeScript, dependency check and source-change-review focused test passed; standalone Methods archive-pin tests passed 2/2. The Methods package-consumer expected-export fixture was corrected in a test-only child of cf618; the exact offline packed-consumer workflow now passes on that clean revision. See `DELIVERY.json` for command details and remaining qualification limits.
