import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  TTL,
  constantTimeEq,
  isValidDeviceCode,
  isValidUuid,
  issueAccessToken,
  newRefreshToken,
  sha256Hex,
  verifyAccessToken,
} from './desktop-tokens';

// -----------------------------------------------------------------------------
// Tests cover the four primitives that protect the desktop auth flow:
//   1. Access token issue/verify round-trip (HS256 JWT)
//   2. Refresh token shape & uniqueness
//   3. SHA-256 stability and hex output
//   4. Constant-time string equality (no length leak via timing)
//   5. Device-code and UUIDv4 shape validators
//
// We also include a fast-check property test that confirms verification
// rejects any tampered token (one byte flipped anywhere in the JWT).
// -----------------------------------------------------------------------------

const ORIGINAL_SECRET = process.env.DESKTOP_ACCESS_TOKEN_SECRET;

beforeAll(() => {
  // Use a deterministic test secret so issue/verify is reproducible across
  // local dev and CI without leaking any real secret.
  process.env.DESKTOP_ACCESS_TOKEN_SECRET =
    'test-secret-do-not-use-in-production-test-secret-do-not-use-in-production';
});

afterAll(() => {
  process.env.DESKTOP_ACCESS_TOKEN_SECRET = ORIGINAL_SECRET;
});

const SAMPLE_USER = '11111111-2222-3333-4444-555555555555';
const SAMPLE_DEVICE = '66666666-7777-8888-9999-000000000000';

describe('desktop-tokens / access token', () => {
  it('round-trips: issue -> verify yields original claims', async () => {
    const tok = await issueAccessToken(SAMPLE_USER, SAMPLE_DEVICE);
    const claims = await verifyAccessToken(tok);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe(SAMPLE_USER);
    expect(claims!.device_id).toBe(SAMPLE_DEVICE);
    expect(claims!.exp - claims!.iat).toBe(TTL.ACCESS_TTL_SEC);
  });

  it('rejects tokens signed with a different secret', async () => {
    const tok = await issueAccessToken(SAMPLE_USER, SAMPLE_DEVICE);
    process.env.DESKTOP_ACCESS_TOKEN_SECRET = 'a-different-secret-of-sufficient-length-for-hs256';
    const claims = await verifyAccessToken(tok);
    expect(claims).toBeNull();
    process.env.DESKTOP_ACCESS_TOKEN_SECRET =
      'test-secret-do-not-use-in-production-test-secret-do-not-use-in-production';
  });

  it('rejects malformed tokens', async () => {
    expect(await verifyAccessToken('not.a.jwt')).toBeNull();
    expect(await verifyAccessToken('')).toBeNull();
    expect(await verifyAccessToken('header.payload')).toBeNull();
  });

  it('property: any single-byte tamper invalidates the token', async () => {
    const tok = await issueAccessToken(SAMPLE_USER, SAMPLE_DEVICE);
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: tok.length - 1 }),
        async (idx) => {
          // Flip one byte to a different ASCII char.
          const orig = tok.charCodeAt(idx);
          const swap = orig === 65 ? 66 : 65;
          // Only flip if the change is meaningful (not the same byte).
          if (orig === swap) return true;
          const tampered =
            tok.slice(0, idx) + String.fromCharCode(swap) + tok.slice(idx + 1);
          if (tampered === tok) return true;
          const claims = await verifyAccessToken(tampered);
          return claims === null;
        }
      ),
      { numRuns: 30 }
    );
  });

  it('TTLs match design contract (1h access, 30d refresh)', () => {
    expect(TTL.ACCESS_TTL_SEC).toBe(3600);
    expect(TTL.REFRESH_TTL_SEC).toBe(30 * 24 * 60 * 60);
  });
});

describe('desktop-tokens / refresh token', () => {
  it('produces a 43-char base64url string', () => {
    const t = newRefreshToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('is unique across many invocations (probabilistic)', () => {
    const set = new Set<string>();
    for (let i = 0; i < 1000; i++) set.add(newRefreshToken());
    expect(set.size).toBe(1000);
  });
});

describe('desktop-tokens / sha256Hex', () => {
  it('is deterministic for equal inputs', () => {
    expect(sha256Hex('hello')).toBe(sha256Hex('hello'));
  });

  it('produces 64 hex characters', () => {
    expect(sha256Hex('anything')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different inputs (property)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        (a, b) => {
          if (a === b) return true;
          return sha256Hex(a) !== sha256Hex(b);
        }
      )
    );
  });
});

describe('desktop-tokens / constantTimeEq', () => {
  it('returns true for equal strings', () => {
    expect(constantTimeEq('abc', 'abc')).toBe(true);
  });

  it('returns false for unequal strings of same length', () => {
    expect(constantTimeEq('abc', 'abd')).toBe(false);
  });

  it('returns false for strings of different lengths', () => {
    expect(constantTimeEq('abc', 'abcd')).toBe(false);
  });

  it('property: equality is symmetric', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        return constantTimeEq(a, b) === constantTimeEq(b, a);
      })
    );
  });
});

describe('desktop-tokens / shape validators', () => {
  it('isValidDeviceCode requires 43 base64url chars', () => {
    const valid = newRefreshToken(); // same shape as device_code
    expect(isValidDeviceCode(valid)).toBe(true);
    expect(isValidDeviceCode('')).toBe(false);
    expect(isValidDeviceCode('too-short')).toBe(false);
    expect(isValidDeviceCode('!'.repeat(43))).toBe(false); // bad chars
    expect(isValidDeviceCode(null)).toBe(false);
    expect(isValidDeviceCode(undefined)).toBe(false);
    expect(isValidDeviceCode(42)).toBe(false);
  });

  it('isValidUuid accepts a proper UUIDv4', () => {
    expect(isValidUuid('11111111-2222-3333-4444-555555555555')).toBe(true);
    expect(isValidUuid('not-a-uuid')).toBe(false);
    expect(isValidUuid('')).toBe(false);
    expect(isValidUuid(null)).toBe(false);
  });
});
