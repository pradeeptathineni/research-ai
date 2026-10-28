# Research / Signals convergence inventory (P0)

This is a read-only inventory against the clean Research `1722016738e1367f3e5a4900b6777297f83a69fd` and Signals `db17921adc2b226b34961769d6c4a4087f2afd15` candidate clones, checked against the accepted Signals runtime pin `904126d3419f63949f3c94f07825310fc2043f8e` and Deep root `81b04a851e6e0bf8743c0901270b230ab0c31367`. The Signals candidate is not the accepted runtime pin; B1 will import neither Signals tree until B3 freezes S1 and B4 freezes F1 on that ancestry. The root Deep clone and all Signals clones are inventory-only.

## Distribution and CLI/API boundary

Signals pins Research as a local npm archive in `package.json` and `package-lock.json`, rather than invoking the Research CLI. The active dependency at Signals candidate `db17921` is `file:vendor/research-ai/0f7ab726f7267e1a7e85c4f7094d909db5a7e64671a2b319d3083aa39f6ce947.tgz`; `scripts/research-pin.mjs` binds it to Research commit `344a5ea30a36efaf3c10ca1fa4b6f3a319f01fa4`, version `0.4.0-rc.1`, SHA-256 `0f7ab726f7267e1a7e85c4f7094d909db5a7e64671a2b319d3083aa39f6ce947`, and the corresponding lock integrity. Five historical archives are retained in the Signals candidate's `vendor/research-ai/`: `0f2a5824…`, `0f7ab726…` (active), `51ed349c…`, `688dbe67…`, and `c4347817…`. This is a workspace-link convergence seam; keep the checked-in archives and their history intact.

The archive commit is an ancestor of Research `1722016`. The core `src/codex.mjs`, `src/research.mjs`, and `bin/research-ai.mjs` have no diff between that archive commit and `1722016`; `src/index.mjs` and `src/index.d.ts` have additive exports/types, including notebook, study, document recovery, report and literature workflows. This is source-level compatibility evidence, not a completed workspace build. Signals `packages/corpus/src/search-runner.ts` directly imports `codexReadiness`, `sessionCompleted`, `withCodexWorkspace` and the `ResearchActivity` type; adjacent Research-answer modules use `validateGrounding`, `Grounding` and `FrozenSource` types. Preserve those exports and their semantics. Signals' visible command surface remains its own package scripts (`research`, `research-answer`, `discovery`, `start`, `corpus`, plus domain tools); no Signals script shells out to `research-ai` for inference. Research's own executable remains `bin/research-ai.mjs` / `research-ai`; package exports have accumulated additional standalone CLI tools since the tarball.

| Consumer seam | Current exact interface | Compatibility constraint |
|---|---|---|
| Signals research runner | `packages/corpus/src/search-runner.ts` imports the Research executor/readiness/activity API; Signals retains query policy, acquisition, schemas, outcome interpretation and receipts. | Preserve the bounded executor callbacks, lease, activity event shape, outcome meanings and `Grounding`/`FrozenSource` exports. Keep Research executor free of Signals vocabulary/imports. |
| Research CLI | Research package `bin/research-ai.mjs`, executable name `research-ai`; stdout answer, stderr receipt, documented exit codes. | Existing CLI and output behavior remain stable; Signals today consumes the ESM API rather than this executable. |
| Signals CLI | Signals root `package.json` scripts, including `research`, `research-answer`, `discovery`, `start` and `corpus`. | These remain Signals commands; subtree/workspace packaging must preserve their paths and script registration. |
| Deep Signals endpoints | IDs `source-change-review`, `project-topic-relevance`, `project-opportunity-brief`; each is registered as a capability and owned by `signals-ai`. | Keep IDs and `/deep/capabilities/<id>` prefixes unchanged. The server-side provider path remains `/signals-ai/__signals/api/`. |

## Loopback registration and capability binding consumers

Deep `server/providers.ts` validates loopback provider registration and uses the `/signals-ai/__signals/api/` prefix. `server/server.ts` routes that prefix to the Signals provider bridge, while `server/main.ts` injects the bridge into the existing `source-change-review`, `project-topic-relevance`, and `project-opportunity-brief` capabilities. The accepted owner manifest pins Signals runtime `904126d` and names those existing capability IDs. Signals' own `scripts/workbench.ts` serves `/signals-ai/` and its API from `127.0.0.1`, default port `5178`; the route expects the matching Host/Origin. B1 must preserve the single registration and exact owner binding; it does not add a second server or registry.

The four bounded consumers of `SignalsProviderContractBinding` in the Deep source are:

1. `src/owner-tools/capability-client.ts`: validates the receipt binding shape and requires `revisionKind=provider-contract-binding` to agree with `binding.contract_digest` and `owner.revision`.
2. `src/owner-tools/source-change-review-panel.tsx`: narrows to owner `signals-ai`, contract `source-change-review` v1.0 and carries the binding into capability calls.
3. `src/owner-tools/project-topic-relevance-panel.tsx`: narrows to owner `signals-ai`, contract `project-topic-relevance` v1.0 and carries the binding through preview/review calls.
4. `src/owner-tools/project-opportunity-brief-panel.tsx`: reads the capability's owner binding for brief, reassessment and confidence-packet operations.

The binding carries contract ID/version/digest kind and digest, provider instance ID, owner epoch, and optional source commit. It is runtime identity, not decorative metadata. Convergence keeps these checks; semantic owner remapping does not authorize deleting them.

## Public Pages and recurring execution

Signals `.github/workflows/pages.yml` publishes the static `dist/public-site` Corpus on a push to `main` or manual `workflow_dispatch`; it has no `schedule` trigger. A workflow trigger does not imply a local provider or private corpus is active. Deep root route/panel ids are distinct from the public static Corpus and should not be collapsed into the same store.

Signals `scripts/discovery.ts` exposes `run-due --once` and an explicit `timer` operation. The timer calls `runDueOnce` every 30 seconds only while that process is open and the machine is awake; it installs no OS scheduler. `apps/corpus/src/workbench.tsx` polls an already-running UI search every 1.5 seconds and clears the interval on unmount; that is UI status polling, not a discovery cadence. Signals local workbench binds to loopback only.

Two separate cadence surfaces also exist in the current accepted owner set. Intentional exposes `tick` (one due scheduled unit) and a `run` scheduler command in its CLI; the source inventory establishes implementation, not that an OS scheduler is active. Shoulda's `.github/workflows/catalog.yml` has GitHub Actions schedule `43 8 * * 4`; its scheduled job runs one-shot read-only catalog upkeep and uploads evidence. Its Pages deployment is conditional on `push` or `workflow_dispatch` to `main`, not on the schedule. No live job history or OS scheduler was inspected. Preserve explicit opt-in/consent and do not migrate or activate any timer based on declaration alone.

## Import order and current blockers

- B3 must freeze Signals schema S0 and ingestion S1; B4 must rebase and freeze Briefing UX F1 on S1. B1 imports only those exact commits, as history-preserving subtree imports, last.
- B2's native Research reuse-dispatch commit `2eeeb06ee063fa4c3fcfdc5e6272cd9d40db5858` and B6's Research quoted-evidence commit `911b48d5b13aef1ffa921dfb66d24d87d943ba91` are both clean frozen commits based directly on `1722016`. B1 preserved both source commits in its local octopus merge `048e33cc737c215b051c699cf27f62fc9bf820c7`; their edits are disjoint. Their original candidate clones remain untouched.
- The active tarball references Research `344a5ea`, while the current Research base is now `1722016` plus the two frozen native consumers above. Though the executor/ordinary research CLI modules compare unchanged and the new public exports are additive, the integrated Signals packages still need the defined Node 24.19 workspace build/typecheck and test gates after imports. This check is deferred to P2; no dependency install, broad suite or live provider call has been run.

### Workspace-link gate conflict

A synthetic manifest-only npm 12.1.0 check under Node 24.19.0 confirmed that a Research-root workspace with `workspaces: ["signals"]` and root override `"@pradeeptathineni/research-ai": "file:.."` can resolve the unchanged Signals dependency to a root workspace link (`package-lock.json` entry `node_modules/@demo/research-ai`: `{ "resolved": "", "link": true }`). The test used `npm install --package-lock-only --ignore-scripts --offline`; it created no `node_modules` and did not touch the Research or Signals clones.

However, Signals `scripts/research-pin.mjs` requires the Signals manifest and lock to retain the exact tarball reference and requires `SignalsRoot/node_modules/@pradeeptathineni/research-ai` to be an ordinary non-symlink directory. The full Signals `npm run verify` also runs `scripts/research-pin.test.mjs`. The proposed root-level workspace link therefore conflicts with this unchanged gate: it changes the dependency resolution away from the tarball, and npm hoists the link to the Research workspace root rather than materializing the required ordinary package directory under Signals. B1 cannot edit imported Signals paths; B3 has said its package.json is not changing absent an RU03-qualified need. Sol-A/lead must select a compatible gate contract before B1 can claim the required two full gates. No local workaround or Signals edit was made.
