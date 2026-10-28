# RX02P2 workspace layout contract (pending integration decision)

This file records the paths required by the adopted program; it does not authorize
subtree imports, source relocation, or promotion of a workspace prototype.

The original RX02P2 target is `packages/methods`, `packages/library`
(`corpus`, `domain`, and `contracts`), `apps/workbench`, and `python/reuse`.
The binding B1 brief requires a history-preserving subtree import and confines B1
to the Research clone root: workspace `package.json`, TypeScript references, CI
for both gates, and `docs/convergence/*`. B1 does not edit files under the
imported Signals path. No package configuration or import has been made pending
the lead's resolution of whether a temporary non-promoted prototype is allowed
before S1/F1 are available.

## Methods source identity

The source package is the native Research root at the B2/B6 integration commit
`048e33cc737c215b051c699cf27f62fc9bf820c7`, with package payload unchanged by
subsequent B1 documentation-only commits. Its expected target is
`packages/methods` by subtree import. The package name remains
`@pradeeptathineni/research-ai`, version `0.4.0-rc.1`, engine
`>=24.19.0 <25`, root export `./src/index.mjs` with declaration
`./src/index.d.ts`, and all 17 existing executable names and paths. The exact
package identity projection and 85-file payload digest are in
`methods-component-manifest.json`.

The subtree operation must preserve Methods history and the bytes covered by the
source manifest. Directory relocation changes only the repository-relative
prefix from the source root to `packages/methods`; it does not authorize package
identity, executable path, export, CLI, or source changes. Workspace-only root
metadata is excluded from the Methods package identity digest.

## Library and runtime references

The target Library root is `packages/library`, with B3's corpus/domain/contracts
subtrees and B4's briefing-rank subtree imported only after S1/F1 freeze. Their
final revisions, subtrees, manifests, and package export facts are intentionally
not guessed here. The Methods workspace dependency spec, the precise `python/reuse`
linkage, root workspace declaration, lockfile behavior, and TypeScript project
reference shape remain pending exact frozen package metadata and the lead's
prototype decision. No import path or build relationship is inferred from the
current standalone repositories.

## Compatibility gates when authorized

The target integration must demonstrate, in its isolated clone, that the
standalone tarball identity remains unchanged; every existing Methods bin and
root export resolves from `packages/methods`; the Library workspace link resolves
to the exact frozen Methods source/content manifest; and the Research and Signals
full gates pass on Node 24.19.0. These are future P2 acceptance checks, not checks
claimed by this document.
