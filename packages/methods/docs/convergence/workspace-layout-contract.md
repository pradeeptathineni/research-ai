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
`6195b0e47cc97874ab17e2434b1a1cd7be79fc42`, imported by subtree merge from
parent `80d165a21fd496641871331106bb0dda00f65594`. Its workspace package metadata
changes only the Methods dependency specification from the fixed tarball to
`file:../methods`. The original Library lock, tarball digest/integrity and all
five vendored Research archives are frozen and verified. Existing CLI names,
paths, capability IDs and the four bounded `SignalsProviderContractBinding`
consumers remain inventoried in `workspace-component-manifest.json` and
`RX02-COMPATIBILITY.json`. The workspace includes the new
`saved-entity-inspection` descriptor and native detail view, with exact receipt
and run references and no mutation to retained evidence.

## Verification

On Node 24.19, the Methods full test gate, the workspace-level Briefing to
Research consumer flow, the Library typecheck/build and focused saved-entity
inspection tests passed offline. The full Library gate is only accepted when
that script passes on its pinned source. No check here establishes live provider
quality, public deployment, or compatibility of external Deep runtime mounts.
