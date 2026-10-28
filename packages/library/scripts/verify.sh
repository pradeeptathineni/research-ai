#!/usr/bin/env bash
set -euo pipefail

npm run release:check
npm run corpus -- check
npm run format:check
npm run lint
npm run typecheck
npm run context:verify
npm run context:pack:test
npm run quality:structure
# The Library consumer exercises built assets from a fresh checkout.
npm run build
npm test
npm run test:research-answer
npm run test:provenance
npm run security:dependencies
node --test scripts/research-pin.test.mjs
npm run security:secrets
npm run security:audit:test
npm run security:audit
npm run test:corpus
npm run test:local-query
npm run test:workbench
npm run test:built
