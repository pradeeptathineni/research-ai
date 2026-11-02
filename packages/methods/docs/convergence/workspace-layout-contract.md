# RX02 P2 workspace layout contract

This file records the exact private workspace integration. It does not authorize
publication, store migration, provider setup, or cutover of any external
consumer.

The workspace contains `packages/methods`, `packages/library` (corpus, domain,
contracts and Signals applications), and `apps/workbench`. Methods and Library
are imported in an isolated clone with Git's subtree merge strategy; their
standalone repository histories remain reachable. The workspace dependency
replaces only the Library clone's dependency on a fixed Research archive.
Library source, its standalone lock, archive bytes, canonical `signals/`
records and private `.signals/` data path stay unchanged.

## Methods source identity

The imported Methods source root is commit
`cecbe5da3127826affb7630707aeb55f8aa62cd3`, whose Git tree is
`4e19570f698ba79a2692131333ef4f3a79dab506`. Its target is
`packages/methods`. The package remains `@pradeeptathineni/research-ai`
version `0.4.0-rc.1`, engine `>=24.19.0 <25`, root export `./src/index.mjs`
with declaration `./src/index.d.ts`, and its existing 17 executable names and
paths. The package identity projection and exact payload digest are recorded in
`methods-component-manifest.json`.

Workspace-only manifests bind source revisions, package identity and payload
bytes. They do not alter the package's published `files` list. A verified
workspace link is accepted only at the declared absolute root and only when
workspace mode, manifest digest, lock digest and package payload all match.
With workspace mode unset, standalone Library fixed-tarball verification
remains active.

## Library and compatibility

Library source is pinned at
`17af801a3df3d4231f9654207584a1691020dae1`, imported by history-preserving subtree merge from parent
`15bb150a0400b0884b8d6857ba5fcfaae13c7d9a`. The source includes the project-lint and saved-entity changes; the
per-file successor blob OIDs are recorded in `workspace-component-manifest.json`. Its workspace package metadata changes only the Methods dependency
specification from the fixed tarball to `file:../methods`. The original Library
lock, tarball digest/integrity and all five vendored Research archives are
frozen and verified. Existing CLI names, paths, capability IDs and the four
bounded `SignalsProviderContractBinding` consumers remain inventoried in
`workspace-component-manifest.json` and `RX02-COMPATIBILITY.json`. The workspace
includes `saved-entity-inspection` and its native detail view, with exact
receipt/run references and no mutation to retained evidence.

## Verification

At earlier RX02 checkpoints, the Methods full test gate, the workspace-level
Briefing-to-Research consumer flow, Library typecheck/build and focused
saved-entity inspection tests passed offline. The recorded full Library `verify` against 3cfd39 reached lint after
release, corpus and format checks passed, then stopped with 111 ESLint errors
across 27 source-matching files. Later lint-only evidence at f06192c reported 71 errors across 15 files. Final
17af801 full ESLint, TypeScript, build and format checks passed, as did source
continuity (10/10) and the project relevance test. The full verify gate is not passed: `quality:structure` retains baseline Knip
unused exports (jscpd count improves from 21 to 20), a projects listener case
is blocked by sandbox EPERM, and external `npm audit` was automatically
rejected for dependency metadata disclosure and not retried. No check here
establishes live provider quality, public deployment, or compatibility of
external Deep runtime mounts.
