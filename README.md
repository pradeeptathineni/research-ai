# Research AI workspace

Research Methods answers bounded questions without owning a store. Research Library retains sources, assessed findings, interests, Briefing stories and saved corpus records. The Workbench runs that Library from this workspace; it does not require a separate Signals source checkout.

Contributors can start with [project instructions](AGENTS.md), which route to
Methods and Library guidance.

Use Node 24.19 and npm 12.1. From this directory:

```sh
npm ci
npm run build --workspace signals-ai
SIGNALS_WORKSPACE=/absolute/path/to/existing/library-data SIGNALS_PORT=5178 npm run workbench:start
```

Set `SIGNALS_WORKSPACE` to the existing Library data root if retaining prior records. The local provider endpoint remains `http://127.0.0.1:5178/signals-ai/__signals/api/`. Its `signals-ai` owner IDs, headers, routes and `signals/` and `.signals/` paths remain compatibility contracts for saved records and current Deep consumers. Library reads the exact existing owner instance and epoch from that root. A historical root without `.signals/requests/ledger.json` can still have readable saved entities, but connected provider capabilities stay unavailable until its owner scope is explicitly reconciled; startup does not silently create a new identity. Library continues to check source digests and public/private separation. No data migration or automatic research occurs on startup.

`npm run workbench:verify` checks the workspace entrypoint and a synthetic Briefing-to-Research Notebook flow without binding a listener or invoking a model. It does not qualify a configured live service or a real user store.

## Reviewed local public-data export

The Library-owned preview, reviewed export and byte verifier are invocable from
this workspace root. Run these only when you intend to inspect and export the
configured Library corpus and saved public entities:

```sh
preview_file="$(mktemp)"
npm run public:preview > "$preview_file"
# Inspect the artifact bytes, source references, qualifications and top-level sha256 in "$preview_file".
npm run public:export-reviewed -- --review-sha256=PREVIEW_SHA256 --reviewer="REVIEW_LABEL"
npm run public:site-build
npm run public:site-verify -- --preview-sha256=PREVIEW_SHA256
```

The reviewed export refuses a digest that no longer matches the current public
inputs. The site build copies those reviewed files, and verification checks
their exact bytes plus the allowed Vite shell before a local site is considered
verified. The preview digest covers public-data artifacts, not the HTML/JS/CSS
shell; the reviewer label is a caller assertion, not identity authentication.
The commands reuse the `signals-ai` workspace owner and its existing corpus
paths. `npm run public:export-test` runs the synthetic preview→review→export→site
verification check without reading the configured Library store. The existing
`corpus build` and `publishPublicData` paths remain available for development
and are not gated by this reviewed flow. No command here publishes to GitHub
Pages; the Pages workflow remains nested under `packages/library/.github` and
is not active in this converged root workspace. Keep the preview file outside
Git and remove that temporary file after review; it contains the exact proposed
public bytes, including explicitly saved entities.
