# RX02 private workspace convergence

This private integration workspace brings exact frozen Research Methods and Signals Library sources under one declared npm workspace. Standalone repositories and package identities remain the source of truth. No runtime package was installed during workspace or lock generation.

## Imported components

`packages/methods` is a history-preserving subtree of frozen Research commit `0e0da1985fbf199b4723a64e8a51ee7d638ed6b6`. Its package name/version, Node engine, 17 existing CLI names and paths, ESM export/declaration and zero-runtime-dependency boundary are unchanged. `methods-component-manifest.json` binds the source Git tree, identity projection and exact 85-file package payload. The manifest is workspace metadata outside the package's published `files` list.

`packages/library` is a history-preserving subtree of frozen Signals commit `433f43cb17680d655477172599d925b328acc5b9`, descended from accepted Briefing baseline `14fe11e`. All imported source blobs are identical to that source except the recorded workspace-only `package.json` dependency rewrite from the fixed Research tarball to `file:../methods`. Library's own `package-lock.json`, original fixed tarball, tarball digest/integrity, Research pin guard, capability IDs, and standalone location remain unchanged. The root workspace lock creates an exact `@pradeeptathineni/research-ai → packages/methods` workspace link and a `signals-ai → packages/library` link.

`apps/workbench` is a thin package entrypoint. Its start, dev, test and build scripts forward to the existing `signals-ai` package scripts and its `verify:entrypoint` check resolves `packages/library/scripts/workbench.ts`. It contains no UI, server implementation, or duplicated workbench. The original Library workbench remains at its existing path.

## Preserved consumers

The Research/Signals inventory remains unchanged: Research's `research-ai` CLI/API and the Signals CLI retain their names and paths. The three Deep capability IDs remain `source-change-review`, `project-topic-relevance`, and `project-opportunity-brief`; the four `SignalsProviderContractBinding` consumers remain `capability-client.ts` and the source-change, project-topic-relevance, and project-opportunity-brief panels. No Deep/Root file was edited here. Their external runtime mounts are not asserted by this workspace package test.

## Workspace integrity

The Methods guard requires explicit workspace mode plus absolute root and manifest paths, manifest SHA-256, lock SHA-256, Git ancestry, package identity and every declared package payload blob. The workspace link is accepted only at the declared root. The guard does not search arbitrary parent `node_modules` directories and the default standalone mode remains unchanged. The Library source lock stays byte-for-byte at SHA-256 `6825a1a769e111dcc90b5d249b857730a28376e559101f27d0fb22a371db7dfa`; the generated root lock was produced with Node 24.19.0/npm 12.1.0 using `--package-lock-only --ignore-scripts --offline`, without creating `node_modules` or accessing the network.

The workspace component manifest records exact source roots/revisions, source package-lock hashes, package metadata shim hashes, root package/lock hashes and the unchanged archive bytes. Runtime guard variables are listed in that manifest's delivery companion `RX02-COMPATIBILITY.json`.

## Checks

Run the full Methods test gate from the root with `npm run methods:test`. The Signals full verification is `npm run verify` in `packages/library`; it includes the established release, type, format, lint, unit, research-answer, provenance, security, corpus, local-query, workbench, and built-app gates. The workspace-specific Library dependency guard must receive the exact `SIGNALS_RESEARCH_LAYOUT=workspace`, absolute workspace root and Methods manifest paths, and recorded manifest/lock digests. The workbench forwarding smoke check is `npm run workbench:verify`; it reads package metadata and the existing script entrypoint and starts no server.

No external consumer checkout, publish, tarball rebuild, install, listener, live provider or model call is claimed by this integration. The full gates were run only with the recorded Node 24.19.0 toolchain and an owned copy of the exact-lock Library dependency cache.
