# Research workspace integration status

This private workspace composes the existing Research Methods and Signals Library
packages. It does not publish new package identities, replace standalone
packages, or import a second executor or Library implementation.

`packages/methods` remains the unchanged Methods subtree from source commit
`19b20c734e6ba9614a476dbb5fda2a9895b173ac`. Its name, version, engine, entry
points, declarations and payload hash remain bound by
[`methods-component-manifest.json`](../../packages/methods/docs/convergence/methods-component-manifest.json).

`packages/library` is the whole Signals subtree from frozen commit
`73d5ec9624effe111289e18da88e233bdd9a25a1`, including its S1/F1 history and
approved Research pin guard. The subtree tree matches the source Git tree
exactly. The only workspace adaptation is in `packages/library/package.json`:
its Research dependency uses `file:../methods`, the local equivalent explicitly
accepted by the frozen guard. No Signals engine source, package identity,
standalone archive, package lock, or pin was changed. The original package
manifest remains intact in the source repository.

The private root declares Methods, Library and Library's existing nested
`apps/*` and `packages/*` workspaces. It carries the existing Repomix MCP SDK
override and remote dependency policy. The root lock is lockfile v3, seeded
from the frozen Library lock and canonicalized by npm 12.1.0 with Node 24.19.0
using `--package-lock-only --ignore-scripts --offline`; no packages were
installed and no remote lookup was allowed. It contains explicit links for
`node_modules/@pradeeptathineni/research-ai → packages/methods`,
`node_modules/signals-ai → packages/library`, and the nested `@signals/*`
workspaces. See
[`workspace-component-manifest.json`](workspace-component-manifest.json) for
source, package and lock hashes.

The canonical Deep application stays its own existing workbench and owns the
Reader/report/literature UI. This package workspace does not copy that UI under
`apps/workbench`; Sol-A owns any thin compatibility entrypoint. The Reuse
package remains owned by the Reuse/Trials lane and is not imported here.

## Guard configuration

For the existing Library Research dependency guard, set:

```text
SIGNALS_RESEARCH_LAYOUT=workspace
SIGNALS_RESEARCH_WORKSPACE_ROOT=<absolute path to this workspace root>
SIGNALS_RESEARCH_WORKSPACE_MANIFEST=<absolute path to packages/methods/docs/convergence/methods-component-manifest.json>
SIGNALS_RESEARCH_WORKSPACE_MANIFEST_SHA256=b6ae349ae352284ee04f1703fbdf78117559a1adef3d6c8399811db4ea89084c
SIGNALS_RESEARCH_WORKSPACE_LOCK_SHA256=74e6034da3cc6a4977cb08b77f0c17c0246c3f69c462f76fac719543d976f2ea
```

At runtime, the workspace manager must create the exact Methods link in the
root `node_modules`. This integration did not run an installer; the guard was
qualified separately using a temporary local link and removed after the
check. Standalone Signals archive pin behavior remains unchanged when workspace
mode is omitted.

## Entrypoints

- `npm run research -- <question>` forwards to the existing Methods CLI.
- `npm run methods:test` invokes the existing Methods test script.
- `npm run library:research -- <args>` forwards to the Signals research CLI.
- `npm run library:dependencies` invokes the frozen Library dependency guard.

`apps/workbench` and `python/reuse` remain external owned components; no
duplicate app, Python engine, or data store was added.
