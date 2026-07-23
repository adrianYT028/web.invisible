// @vitest-environment node
//
// Crypto core property tests for the ai-proxy-key-vault feature (tasks 1.2–1.8).
//
// These exercise src/lib/crypto/key-vault.ts — the AES-256-GCM per-user key
// vault. They run in the `node` environment (see the docblock above) because
// the module relies on `node:crypto` and `process.env`.
//
// IMPORTANT — master-key memoization:
//   key-vault.ts memoizes the parsed KEY_VAULT_SECRET map in a module-level
//   variable, populated lazily on the first encrypt/decrypt call. To get
//   deterministic keys — and to be able to *change* the active version at
//   runtime (task 1.4) — every test loads the module via a helper that runs
//   `vi.resetModules()` + a dynamic `import()` AFTER setting env. This
//   guarantees a fresh, un-memoized module bound to the env we just set.

import fc from 'fast-check';
import crypto from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// -----------------------------------------------------------------------------
// Deterministic master-key material
// -----------------------------------------------------------------------------
// Two DISTINCT base64 32-byte keys under versions "1" and "2".

const KEY_V1 = Buffer.alloc(32, 0x11).toString('base64');
const KEY_V2 = Buffer.alloc(32, 0x22).toString('base64');
const SECRET_MAP = JSON.stringify({ '1': KEY_V1, '2': KEY_V2 });

type KeyVaultModule = typeof import('./key-vault');

/**
 * Set env then load a FRESH copy of the module (bypassing the per-process
 * memoized master-key cache). `activeVersion` selects which master key new
 * encryptions use.
 */
async function loadVault(activeVersion: '1' | '2' = '1'): Promise<KeyVaultModule> {
  process.env.KEY_VAULT_SECRET = SECRET_MAP;
  process.env.KEY_VAULT_ACTIVE_VERSION = activeVersion;
  vi.resetModules();
  return import('./key-vault');
}

beforeAll(() => {
  // Baseline deterministic env; individual tests re-set + reload as needed.
  process.env.KEY_VAULT_SECRET = SECRET_MAP;
  process.env.KEY_VAULT_ACTIVE_VERSION = '1';
});

afterEach(() => {
  vi.resetModules();
});

// -----------------------------------------------------------------------------
// Feature: ai-proxy-key-vault, Property 1: Encrypt/decrypt round-trip (P9)
// Validates: Requirements 8.8, 1.6
// -----------------------------------------------------------------------------
describe('Property 1 (P9): encrypt/decrypt round-trip', () => {
  it('decrypt(encrypt(k)) === k for arbitrary 1..512-char strings incl. unicode', async () => {
    const { encrypt, decrypt } = await loadVault('1');
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 512 }), (k) => {
        expect(decrypt(encrypt(k))).toBe(k);
      }),
      { numRuns: 100 },
    );
  });
});

// -----------------------------------------------------------------------------
// Feature: ai-proxy-key-vault, Property 2: Fresh unique nonce per encryption (P10)
// Validates: Requirements 1.7
// -----------------------------------------------------------------------------
describe('Property 2 (P10): fresh unique nonce per encryption', () => {
  it('N encryptions yield N distinct 12-byte IVs', async () => {
    const { encrypt } = await loadVault('1');
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 64 }), {
          minLength: 2,
          maxLength: 40,
        }),
        (plaintexts) => {
          const ivs = new Set<string>();
          for (const p of plaintexts) {
            const env = encrypt(p);
            // Each IV decodes to exactly 12 bytes (96-bit GCM nonce).
            expect(Buffer.from(env.iv, 'base64').length).toBe(12);
            ivs.add(env.iv);
          }
          // All N nonces are unique.
          expect(ivs.size).toBe(plaintexts.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// -----------------------------------------------------------------------------
// Feature: ai-proxy-key-vault, Property 3: Version-matched decryption survives
//   rotation (P11)
// Validates: Requirements 8.2, 8.5
// -----------------------------------------------------------------------------
describe('Property 3 (P11): version-matched decryption survives rotation', () => {
  it('a v1 envelope still decrypts after the active version rotates to v2', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 512 }), async (k) => {
        // Encrypt under active v1.
        const vaultV1 = await loadVault('1');
        const env = vaultV1.encrypt(k);
        expect(env.version).toBe(1);

        // Rotate: reload the module with active version v2.
        const vaultV2 = await loadVault('2');
        // A new encryption now records v2...
        expect(vaultV2.encrypt(k).version).toBe(2);
        // ...but the OLD v1 envelope still decrypts to the original plaintext.
        expect(vaultV2.decrypt(env)).toBe(k);
      }),
      { numRuns: 100 },
    );
  });
});

// -----------------------------------------------------------------------------
// Feature: ai-proxy-key-vault, Property 4: New encryptions record the active
//   version
// Validates: Requirements 8.6, 7.2
// -----------------------------------------------------------------------------
describe('Property 4: new encryptions record the active version', () => {
  it('encrypt(k).version === activeVersion and >= 1', async () => {
    const active = 2;
    const { encrypt } = await loadVault('2');
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 512 }), (k) => {
        const env = encrypt(k);
        expect(env.version).toBe(active);
        expect(env.version).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 100 },
    );
  });
});

// -----------------------------------------------------------------------------
// Feature: ai-proxy-key-vault, Property 5: Decryption fails safely on tamper or
//   unknown version
// Validates: Requirements 3.5, 8.3, 8.4
// -----------------------------------------------------------------------------
describe('Property 5: decryption fails safely on tamper or unknown version', () => {
  it('a single flipped byte in ct/iv/tag, or an absent version, throws KeyDecryptError', async () => {
    const { encrypt, decrypt, KeyDecryptError } = await loadVault('1');

    // Flip one byte of a base64-encoded field and return the new base64.
    const flipByte = (b64: string, byteIndex: number): string => {
      const buf = Buffer.from(b64, 'base64');
      const i = buf.length === 0 ? 0 : byteIndex % buf.length;
      if (buf.length === 0) return b64; // nothing to flip
      buf[i] ^= 0xff;
      return buf.toString('base64');
    };

    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 256 }),
        // which field to tamper: 0=ciphertext 1=iv 2=authTag 3=unknown version
        fc.integer({ min: 0, max: 3 }),
        fc.nat(),
        (k, mode, idx) => {
          const env = encrypt(k);
          let tampered = { ...env };
          switch (mode) {
            case 0:
              tampered.ciphertext = flipByte(env.ciphertext, idx);
              // If ciphertext was empty there is nothing to corrupt; skip.
              if (tampered.ciphertext === env.ciphertext && env.ciphertext.length === 0) {
                return;
              }
              break;
            case 1:
              tampered.iv = flipByte(env.iv, idx);
              break;
            case 2:
              tampered.authTag = flipByte(env.authTag, idx);
              break;
            case 3:
              tampered.version = 999; // absent version
              break;
          }

          let threw = false;
          let returned: string | undefined;
          try {
            returned = decrypt(tampered);
          } catch (err) {
            threw = true;
            expect(err).toBeInstanceOf(KeyDecryptError);
          }
          // Never returns the plaintext; always throws the sentinel.
          expect(threw).toBe(true);
          expect(returned).toBeUndefined();
        },
      ),
      { numRuns: 100 },
    );
  });
});

// -----------------------------------------------------------------------------
// Feature: ai-proxy-key-vault, Property 6: Database-read alone cannot recover
//   plaintext (P12)
// Validates: Requirements 8.1
// -----------------------------------------------------------------------------
describe('Property 6 (P12): DB-read alone cannot recover plaintext', () => {
  it('decrypting the stored envelope under a DIFFERENT random master key fails', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 512 }), async (k) => {
        // Encrypt with the real master-key set (active v1).
        const realVault = await loadVault('1');
        const env = realVault.encrypt(k);

        // An attacker who reads only the DB row (env) but does NOT have
        // KEY_VAULT_SECRET tries a different random 32-byte master key under
        // the same version number.
        const attackerKey = crypto.randomBytes(32).toString('base64');
        process.env.KEY_VAULT_SECRET = JSON.stringify({ '1': attackerKey });
        process.env.KEY_VAULT_ACTIVE_VERSION = '1';
        vi.resetModules();
        const attackerVault: KeyVaultModule = await import('./key-vault');

        let threw = false;
        let returned: string | undefined;
        try {
          returned = attackerVault.decrypt(env);
        } catch (err) {
          threw = true;
          expect(err).toBeInstanceOf(attackerVault.KeyDecryptError);
        }
        expect(threw).toBe(true);
        expect(returned).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });
});

// -----------------------------------------------------------------------------
// Feature: ai-proxy-key-vault, Property 8: last_four is exactly the final four
//   characters
// Validates: Requirements 1.10, 2.1
// -----------------------------------------------------------------------------
describe('Property 8: last_four is exactly the final four characters', () => {
  it('lastFour(k) === k.slice(-4) for k of length >= 4', async () => {
    const { lastFour } = await loadVault('1');
    fc.assert(
      fc.property(fc.string({ minLength: 4, maxLength: 512 }), (k) => {
        expect(lastFour(k)).toBe(k.slice(-4));
      }),
      { numRuns: 100 },
    );
  });
});
