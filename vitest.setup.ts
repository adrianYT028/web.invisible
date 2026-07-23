/**
 * Vitest global setup.
 *
 * Imports `@testing-library/jest-dom` so that custom DOM matchers
 * (e.g. `toBeInTheDocument`, `toHaveAttribute`) are available in every
 * test file without per-file imports.
 */
import '@testing-library/jest-dom/vitest';

// The `vmForks` pool runs each test file inside a fresh VM context whose
// globals do not include Node's WebCrypto (`globalThis.crypto.subtle`). Modules
// that rely on the Web Crypto API (e.g. `jose` for JWT signing) then fail with
// "Cannot read properties of undefined (reading 'importKey')". Expose Node's
// WebCrypto implementation on the context global when it is missing so those
// modules see the same `crypto` they would in a normal Node runtime. Test-only;
// no application code is affected.
import { webcrypto } from 'node:crypto';

const g = globalThis as unknown as { crypto?: Crypto };
if (!g.crypto || !g.crypto.subtle) {
  Object.defineProperty(g, 'crypto', {
    value: webcrypto,
    configurable: true,
    writable: true,
  });
}
