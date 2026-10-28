# RX02 private workspace convergence

This private integration workspace brings exact frozen Research Methods and Signals Library sources under one declared npm workspace. Standalone repositories and package identities remain the source of truth. No runtime package was installed during workspace or lock generation.

## Imported components

`packages/methods` is a history-preserving subtree of frozen Research release-check descendant `17eb2bdd240a1318a8ae2b211947e7311ae1d31b` (containing native `0e0da1985fbf199b4723a64e8a51ee7d638ed6b6`). Its package name/version, Node engine, 17 existing CLI names and paths, ESM export/declaration and zero-runtime-dependency boundary are unchanged. `methods-component-manifest.json` binds the source Git tree, identity projection and exact 85-file package payload. The 17eb descendant updates the stale package-consumer expected-file fixture and convergence notes, with one executable mode correction; `package.json` and every declared package file byte remain unchanged from 0e0. The manifest is workspace metadata outside the package's published `files` list.

`packages/library` is a history-preserving subtree of frozen Signals commit `92c5cab967f975d4842d3ee7ddc7cad6594c7b03`, descended from accepted Briefing baseline `14fe11e`. The subtree includes frozen HN observation-metrics descendant `92c5cab967f975d4842d3ee7ddc7cad6594c7b03`. All imported source blobs are identical to that source except the recorded workspace-only `package.json` dependency rewrite from the fixed Research tarball to `file:../methods`. Library's own `package-lock.json`, original fixed tarball, tarball digest/integrity, Research pin guard, capability IDs, and standalone location remain unchanged. The root workspace lock creates an exact `@pradeeptathineni/research-ai → packages/methods` workspace link and a `signals-ai → packages/library` link.

`apps/workbench` is a thin package entrypoint. Its start, dev, test and build scripts forward to the existing `signals-ai` package scripts and its `verify:entrypoint` check resolves `packages/library/scripts/workbench.ts`. It contains no UI, server implementation, or duplicated workbench. The original Library workbench remains at its existing path.

## Preserved consumers

The Research/Signals inventory remains unchanged: Research's `research-ai` CLI/API and the Signals CLI retain their names and paths. The three Deep capability IDs remain `source-change-review`, `project-topic-relevance`, and `project-opportunity-brief`; the four `SignalsProviderContractBinding` consumers remain `capability-client.ts` and the source-change, project-topic-relevance, and project-opportunity-brief panels. No Deep/Root file was edited here. Their external runtime mounts are not asserted by this workspace package test.

## Workspace integrity

The Methods guard requires explicit workspace mode plus absolute root and manifest paths, manifest SHA-256, lock SHA-256, Git ancestry, package identity and every declared package payload blob. The workspace link is accepted only at the declared root. The guard does not search arbitrary parent `node_modules` directories and the default standalone mode remains unchanged. The Library source lock stays byte-for-byte at SHA-256 `6825a1a769e111dcc90b5d249b857730a28376e559101f27d0fb22a371db7dfa`; the generated root lock was produced with Node 24.19.0/npm 12.1.0 using `--package-lock-only --ignore-scripts --offline`, without creating `node_modules` or accessing the network.

The workspace component manifest records exact source roots/revisions, source package-lock hashes, package metadata shim hashes, root package/lock hashes and the unchanged archive bytes. Runtime guard variables are listed in that manifest's delivery companion `RX02-COMPATIBILITY.json`.

## Checks

The workspace forwarder check passed (`npm run workbench:verify`). The Methods package-consumer check passed 1/1 on exact source 17eb after importing the source's repaired expected-file fixture. A full Methods run on source 0e0 before that fixture update had 318 passed, one expected-file-list failure, and 22 skipped; the 17eb owner reported its complete standalone source gate as 319 passed and 22 skipped. This workspace did not repeat the long Methods suite after importing 17eb.

Workspace integrity checks passed: `signals-ai` verified 28 exact direct dependency versions and reviewed licenses in explicit workspace mode; the focused HN adapter test passed 3/3; the standalone plus explicit-workspace research-pin tests passed 2/2 with the appropriate environment; context verification and pack tests passed; Library typecheck and build passed. Research answer and provenance tests passed.

The full Library gate is not green in this sandbox. `verify.sh` stops at `format:check`, which reports nine files: three changed since frozen Signals baseline 14fe (`hacker-news-adapter.test.ts`, `ingest.ts`, `store.ts`) and six unchanged files. The formatter was not run because it mutates frozen source. Lint reports 75 errors and the existing quality gate reports one unused file and exported API warnings. The Vitest suite returned 543 passed and 54 failed, with seven errors; the failures report loopback `listen EPERM` and 5-second process deadlines while the lengthy Methods gate ran at the same time. Playwright web servers also stopped at loopback `EPERM`. No tests were rerun through another port or with expanded privileges. The separate `npm audit` network command was skipped under the no-network boundary.

The workspace-specific Library guard and dependency checker received explicit `SIGNALS_RESEARCH_LAYOUT=workspace`, absolute root and Methods manifest, and the recorded manifest/lock digests. The full gates were attempted with Node 24.19.0 and an owned clonefile copy of the exact-lock Library dependency cache; no packages were installed into the workspace. One offline temporary packed Methods consumer passed its install, CLI, ESM, types, and ownership checks. No external production consumer checkout, publish, or standalone Library archive install was performed.
