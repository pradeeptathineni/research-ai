# RX02 workspace prototype status

This private integration repository is a B1-owned prototype, not a promoted
release. `packages/methods` is brought in as an unsquashed subtree from the
frozen Research owner history. Its source package name, version, engine, bin
map, export, declarations, and payload bytes remain those recorded in
[`packages/methods/docs/convergence/methods-component-manifest.json`](../../packages/methods/docs/convergence/methods-component-manifest.json).

The root package is a private workspace coordinator. It does not publish a new
Methods identity or replace the standalone tarball. The first workspace entry
is Methods only; Library, workbench, and reuse imports and their corresponding
workspace entries are added only when their exact frozen sources and package
metadata are available. No Signals source is imported here yet. No dependency
installer has run and no lockfile is claimed.

Signals' current TypeScript configuration is a single `strict`/`noEmit`
configuration without `composite` project metadata. A valid TypeScript project
reference cannot be declared from B1's root alone until frozen imported package
configurations establish composite project boundaries. Preserve the existing
Signals typecheck command and resolve project references after S1/F1 inspection.
