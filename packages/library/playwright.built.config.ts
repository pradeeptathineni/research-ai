import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/built',
  outputDir: 'test-results/built',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5191/signals-ai/' },
  webServer: {
    command: 'node --import tsx tests/built/server.ts',
    url: 'http://127.0.0.1:5191/signals-ai/',
    reuseExistingServer: false,
  },
});
