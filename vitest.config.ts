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
