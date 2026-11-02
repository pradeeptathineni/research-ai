# Research AI workspace

Research Methods answers bounded questions without owning a store. Research Library retains sources, assessed findings, interests, Briefing stories and saved corpus records. The Workbench runs that Library from this workspace; it does not require a separate Signals source checkout.

Use Node 24.19 and npm 12.1. From this directory:

```sh
npm ci
npm run build --workspace signals-ai
SIGNALS_WORKSPACE=/absolute/path/to/existing/library-data SIGNALS_PORT=5178 npm run workbench:start
```

Set `SIGNALS_WORKSPACE` to the existing Library data root if retaining prior records. The local provider endpoint remains `http://127.0.0.1:5178/signals-ai/__signals/api/`. Its `signals-ai` owner IDs, headers, routes and `signals/` and `.signals/` paths remain compatibility contracts for saved records and current Deep consumers. Library continues to check exact owner scope, source digests and public/private separation. No data migration or automatic research occurs on startup.

`npm run workbench:verify` checks the workspace entrypoint and a synthetic Briefing-to-Research Notebook flow without binding a listener or invoking a model. It does not qualify a configured live service or a real user store.
