import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    setupFiles: ['./tests/setup.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      // Tests load src/ with createRequire, never import: a file run both natively
      // and through Vite merges its coverage at mismatched offsets and under-reports.
      include: ['src/**/*.js'],
    },
  },
});
