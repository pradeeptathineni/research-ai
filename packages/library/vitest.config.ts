import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'apps/**/*.test.tsx'],
    exclude: ['**/*.integration.test.ts'],
    // Inline the first-party executor so node:child_process/node:os mocks still intercept it.
    server: { deps: { inline: ['@pradeeptathineni/research-ai'] } },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
    },
  },
});
