import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/public-corpus',
  outputDir: 'test-results/public-corpus',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4178/signals-ai/', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run corpus:preview',
    url: 'http://127.0.0.1:4178/signals-ai/',
    reuseExistingServer: false,
  },
});
