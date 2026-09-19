import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    setupFiles: ['./tests/setup.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      include: ['src/**/*.js'],
      // handler.js is two one-line Lambda entrypoints.
      //
      // The reported figure understates threads.js: src/ is CommonJS, so when
      // worker.js and web.js require it the loader hands back a copy Vitest has
      // not instrumented, and that copy's near-empty coverage displaces the
      // instrumented one. Run `vitest run tests/threads.test.js --coverage` on
      // its own and it reads 100%.
      exclude: ['src/handler.js'],
    },
  },
});
