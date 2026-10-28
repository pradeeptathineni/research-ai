import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/workbench',
  outputDir: 'test-results/workbench',
  testMatch: '*.spec.ts',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5189/signals-ai/' },
  webServer: {
    command: 'node --import tsx tests/workbench/server.ts',
    url: 'http://127.0.0.1:5189/signals-ai/',
    reuseExistingServer: false,
  },
});
