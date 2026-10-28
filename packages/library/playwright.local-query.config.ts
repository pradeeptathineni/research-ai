import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/local-query',
  outputDir: 'test-results/local-query',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5178/signals-ai/' },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5178/signals-ai/',
    reuseExistingServer: false,
    env: { SIGNALS_QUERY_DIRECTORY: 'private-query-probe' },
  },
});
