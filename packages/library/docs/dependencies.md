# Dependencies

`package.json` and `package-lock.json` pin exact reviewed versions. The supported toolchain is Node 24.19+ within Node 24 and npm 12.1+ within npm 12. `npm run security:dependencies` checks installed direct versions and MIT, Apache-2.0, ISC or MPL-2.0 licences. `security:audit` applies the advisory policy; `security:secrets` checks publication boundaries.

## Runtime

| Package               |    Version | License    | Purpose                                        |
| --------------------- | ---------: | ---------- | ---------------------------------------------- |
| React / React DOM     |     19.3.0 | MIT        | Local workbench and static public view         |
| TypeBox               |     1.3.34 | MIT        | Closed typed record/request validation         |
| Ajv                   |     8.20.0 | MIT        | Frozen draft-2020 peer schema validation       |
| ajv-formats           |      3.0.1 | MIT        | Peer schema formats                            |
| MiniSearch            |      7.2.0 | MIT        | In-memory native/historical metadata retrieval |
| @mozilla/readability  |      0.6.0 | Apache-2.0 | Static document extraction                     |
| linkedom              |    0.18.13 | ISC        | Inert DOM without script/resource execution    |
| rss-parser            |     3.13.0 | MIT        | RSS/Atom parsing from safely fetched bytes     |
| research-ai           | 0.4.0-rc.1 | MIT        | Bounded research and retained-source support   |
| Playwright (optional) |     1.63.0 | Apache-2.0 | Isolated static source-capture rendering       |

`@pradeeptathineni/research-ai` is first-party with no runtime dependencies. It uses the content-addressed archive under `vendor/research-ai/`, built from source commit `344a5ea30a36efaf3c10ca1fa4b6f3a319f01fa4`. The checker verifies exact SHA-256 bytes, lockfile SHA-512, version, MIT license, and an extracted installation instead of a directory link. The archive contains its MIT LICENSE, ALCE method notice independent-branch and bibliography MIT notices, and the retained SurfSense/GPT Researcher Apache-2.0 adaptation notices; no external judge weights or datasets are included. The prior accepted `c362b33a544bce8e3f4cce7f305bc32cddb90342` and preceding candidate archives remain tracked for rollback. Project-local `allow-remote=root` still limits remote dependencies under npm 12. Vitest inlines Research so process and OS test fakes apply.

An explicitly configured Research workspace may use the same Methods package at
`packages/methods`, with Library at `packages/library`. Set
`SIGNALS_RESEARCH_LAYOUT=workspace`, `SIGNALS_RESEARCH_WORKSPACE_ROOT` and
`SIGNALS_RESEARCH_WORKSPACE_MANIFEST` to exact absolute paths, and declare the
SHA-256 values in `SIGNALS_RESEARCH_WORKSPACE_MANIFEST_SHA256` and
`SIGNALS_RESEARCH_WORKSPACE_LOCK_SHA256`. The manifest uses
`research.component-source-manifest.v1` and binds the Methods identity, frozen
source commit and covered package bytes. The commit must remain an ancestor of
the workspace; package metadata and every covered file must match its Git blobs
and the manifest. The root lock must bind the Methods workspace link and identity.
For the published unified Research source at `1434a14bfb50b4d1c695545bdedf7693e0402142`, use
`packages/methods/docs/convergence/methods-component-manifest-1434a14.json`.
It pins the exact `packages/methods` subtree at that commit; the earlier
`methods-component-manifest.json` remains the historical native-root pin.
Workspace-subtree mode is accepted only when the manifest explicitly names
`packages/methods` and its Git tree, and every packaged file still matches the
declared commit. Do not substitute a current tree hash or package version for
this content check.
The existing archive declaration can remain when the private workspace root
explicitly overrides it with the exact local Methods path. Dependency metadata
is then read only from that verified root's `node_modules`, without searching
arbitrary parents. An undeclared layout, substituted link, changed source or
lock fails closed. Mutable private data is not used as an engine integrity check.
Without this explicit configuration, all standalone archive checks and paths
remain unchanged. This mode grants no installation, network, model or data access.

Node HTTPS/DNS/filesystem/child-process primitives own safe acquisition, bounded project previews, file writes, the loopback API, headless supervision and interval scheduling. Linkedom does not grant transport authority; original outlinks are harvested before Readability. RSS entity declarations are rejected. Ajv does not coerce or insert defaults; domain checks own semantic references/privacy. Frozen schema bytes are excluded from formatting to preserve their digest.

Optional local PDF document import uses `pypdf==6.15.0` from `requirements-private-documents.txt` (BSD-3-Clause; upstream commit `7f226a2771da4b71ed0b72d414f0e59d76a3dae9`). It is not installed by npm and is not needed for Markdown, HTML or plain text. The project calls the dependency API through a fixed stdin-only helper; no pypdf implementation is copied into this repository. Install it only in a Python environment you control and pass its executable with the private-document CLI when needed.

Source-capture rendering uses optional `playwright@1.63.0` and its matching locally installed Chromium. The capability/readiness check verifies the package version and executable path without launching or downloading a browser. Browser installation is an explicit operator setup step; without it, existing text capture remains available and the render operation is not advertised. Rendering disables JavaScript and service workers, sets the browser context offline, uses no profile/cookies, and aborts intercepted requests after loading the exact bounded HTML response already acquired by Signals. These are browser-level controls, not OS-level process network isolation.

Headless research supervises the user's installed authenticated Codex CLI; invoking Agent Skills hosts use their own permitted tools. Optional external acquisition/extraction providers have [separate reviewed pins and constraints](providers.md). Cataloging a tool never installs it.

## Development

Vite 8.3.3, TypeScript 6.0.3, Playwright 1.63.0, Vitest 5.0.2 and Prettier 3.9.9 are pinned development tools. Prettier also encodes historical public downloads reproducibly. ESLint and axe check code/accessibility; Knip 6.38.0 and jscpd 5.3.3 inspect unused structure and duplication. Repomix 1.18.1 creates bounded source maps; its SDK dependency is scoped to patched `@modelcontextprotocol/sdk@1.32.0` without enabling MCP. CCA 0.2.0 supports a reversible context hook. CCA recovery preserves normalized/redacted text rather than promising original stdout/stderr bytes. See [AI authoring context](../.meta/context/README.md) for use boundaries.

GitHub Pages actions are pinned to reviewed upstream commits in `.github/workflows/pages.yml`. They upload validated static public output only. No database driver/service, crawler SDK, hosted authentication or general agent runtime is installed.

## Advisory policy

The development-only Repomix/MCP/Express path pins `body-parser@2.4.0`
([GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828)).
Knip and Repomix share `zod@4.6.7`, which includes the fix introduced in 4.6.6
([GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)).
Both updates stay within existing dependency ranges. They grant no MCP/server
access and add no advisory exception.

The lockfile pins patched `handlebars@4.7.10` and `source-map-js@1.2.2`. Neither receives an advisory waiver.

[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) was withdrawn on 2026-10-23 as not practically exploitable. Its development-only Repomix exception is retired. The audit gate accepts no high or critical advisory, including a returned copy of the withdrawn report, and rejects malformed/inconsistent metadata and nested high/critical causes. Moderate findings remain visible in the npm report.

The reviewed `repomix@1.18.1 → globby@16.2.4 → micromatch@4.0.8 → braces@3.0.3` development path remains exact-pinned and excluded from the shipped application. Runtime reachability, versions/paths and invocation drift still fail the gate. The `context:pack` wrapper still rejects caller arguments, disables Git/dot-ignore/package-default patterns, refuses implicit ignore files and prohibits brace expansion and oversized configured patterns/output paths. No package or wrapper policy changed with the advisory review.

Dependency checks describe their inspected tree and advisory data; they do not establish universal safety. npm may block optional esbuild/fsevents lifecycle scripts; the effective installation is checked through the pinned build/browser gate without changing global policy.
