import { defineConfig } from '@playwright/test';

const baseURL = 'http://127.0.0.1:5191/signals-ai/';

export default defineConfig({
  testDir: 'tests/workbench',
  testMatch: 'perspective.spec.ts',
  outputDir: 'test-results/perspective',
  workers: 1,
  use: { baseURL },
  webServer: {
    command: 'node --import tsx tests/workbench/perspective-server.mjs',
    url: baseURL,
    reuseExistingServer: false,
  },
});
