import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Vitest configuration.
 *
 * - `environment: 'jsdom'` for React component tests against a DOM.
 * - `globals: true` so `describe`/`it`/`expect` are available without imports.
 * - `setupFiles` registers `@testing-library/jest-dom` matchers.
 * - The `@/*` path alias mirrors `tsconfig.json` so test imports match
 *   application imports.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    // `vmForks` avoids the Node 24 + Windows worker-startup failure ("Vitest
    // failed to find the runner" / "Cannot read properties of undefined
    // (reading 'config')") that the default `forks`/`threads` pools hit in this
    // environment. See vitest-dev/vitest#8968 and related reports.
    pool: 'vmForks',
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
