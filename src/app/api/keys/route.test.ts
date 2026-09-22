// @vitest-environment node
import fc from 'fast-check';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

// -----------------------------------------------------------------------------
// /api/keys route tests (tasks 5.3–5.7)
//
// The route (src/app/api/keys/route.ts) is the cookie/session-authenticated
// key-management surface for /account. Its collaborators are mocked so no real
// network or database is touched, EXCEPT the crypto core:
//
//   createSupabaseRouteClient (auth.getUser)      -> mocked (configurable user)
//   supabaseAdmin             (user_api_keys R/W) -> mocked in-memory fake store
//   validateGroqKey           (Groq validation)   -> mocked spy (configurable)
//   rateLimitKeySubmitByUser  (rate limiter)      -> mocked spy (configurable)
//
//   encrypt / decrypt / lastFour (crypto core)    -> REAL, driven by a
//     deterministic KEY_VAULT_SECRET so Property 9 ("decrypts to B") is
//     genuinely verifiable against faithful AES-256-GCM.
//
//   jsonError / logSafe (http helpers)            -> REAL. logSafe is the only
//     sanctioned log sink and THROWS in dev if a value matches a known secret,
//     which strengthens the no-leak property. console.log is spied.
// -----------------------------------------------------------------------------

// A deterministic 32-byte master key so real encrypt/decrypt round-trips.
const MASTER_KEY_B64 = Buffer.alloc(32, 7).toString('base64');
process.env.KEY_VAULT_SECRET = JSON.stringify({ '1': MASTER_KEY_B64 });
process.env.KEY_VAULT_ACTIVE_VERSION = '1';

// ---- Shared mock state (hoisted so vi.mock factories can see it) ------------
const mocks = vi.hoisted(() => {
  interface Row {
    user_id: string;
    provider?: string;
    key_ciphertext: string;
    key_nonce: string;
    key_auth_tag: string;
    key_version: number;
    last_four: string;
  }

  const store = {
    /**
     * `${user_id}::${provider}` -> row. Composite since migration 016: keying
     * by user alone is what made a second provider's key REPLACE the first.
     */
    rows: new Map<string, Row>(),
    upsertFails: false,
    deleteFails: false,
    selectFails: false,
    /** Number of times upsert() was invoked (for "never written" assertions). */
    upsertCalls: 0,
  };

  const authState: { user: { id: string } | null } = {
    user: { id: 'user-1' },
  };

  type ValidationResult =
    | { ok: true }
    | { ok: false; reason: 'invalid_key' | 'unavailable' };
  const validationState: { result: ValidationResult } = {
    result: { ok: true },
  };

  const rateLimitState: { ok: boolean } = { ok: true };

  class FakeQuery {
    _op: 'upsert' | 'delete' | 'select' | null = null;
    _row: Row | null = null;
    _filterVal: unknown = undefined;
    _filters: Record<string, unknown> = {};

    upsert(row: Row, _opts?: unknown): this {
      store.upsertCalls += 1;
      this._op = 'upsert';
      this._row = row;
      return this;
    }
    delete(): this {
      this._op = 'delete';
      return this;
    }
    select(_cols: string): this {
      this._op = 'select';
      return this;
    }
    eq(col: string, val: unknown): this {
      this._filterVal = val;
      this._filters[col] = val;
      return this;
    }
    maybeSingle(): Promise<{ data: unknown; error: unknown }> {
      if (store.selectFails) {
        return Promise.resolve({ data: null, error: { message: 'select failed' } });
      }
      const userId = this._filters.user_id as string;
      const provider = (this._filters.provider as string) ?? 'groq';
      const row = store.rows.get(`${userId}::${provider}`);
      return Promise.resolve({
        data: row ? { provider, last_four: row.last_four } : null,
        error: null,
      });
    }
    private resolve(): { data?: unknown; error: unknown } {
      if (this._op === 'upsert') {
        if (store.upsertFails) return { error: { message: 'upsert failed' } };
        const r = this._row!;
        store.rows.set(`${r.user_id}::${r.provider ?? 'groq'}`, r);
        return { error: null };
      }
      if (this._op === 'delete') {
        if (store.deleteFails) return { error: { message: 'delete failed' } };
        const userId = this._filters.user_id as string;
        const provider = (this._filters.provider as string) ?? 'groq';
        store.rows.delete(`${userId}::${provider}`);
        return { error: null };
      }
      if (this._op === 'select') {
        // GET awaits the builder and expects an ARRAY — a user may hold one key
        // per provider. The old single-row read would have thrown for two keys.
        if (store.selectFails) {
          return { data: null, error: { message: 'select failed' } };
        }
        const userId = this._filters.user_id as string;
        const rows = [...store.rows.entries()]
          .filter(([k]) => k.startsWith(`${userId}::`))
          .map(([k, r]) => ({
            provider: k.slice(userId.length + 2),
            last_four: r.last_four,
            is_preferred: false,
          }));
        return { data: rows, error: null };
      }
      return { data: null, error: null };
    }
    then(
      onF: (v: { data?: unknown; error: unknown }) => unknown,
      onR?: (e: unknown) => unknown
    ): Promise<unknown> {
      return Promise.resolve(this.resolve()).then(onF, onR);
    }
  }

  const adminClient = { from: (_table: string) => new FakeQuery() };

  const createSupabaseRouteClient = vi.fn(async () => ({
    auth: {
      getUser: async () => ({ data: { user: authState.user } }),
    },
  }));
  const supabaseAdmin = vi.fn(() => adminClient);
  const validateProviderKey = vi.fn(
    async (_provider: string, _key: string) => validationState.result
  );
  const rateLimitKeySubmitByUser = vi.fn(async (_userId: string) => ({
    ok: rateLimitState.ok,
    remaining: rateLimitState.ok ? 9 : 0,
    resetSec: 60,
  }));

  return {
    store,
    authState,
    validationState,
    rateLimitState,
    createSupabaseRouteClient,
    supabaseAdmin,
    validateProviderKey,
    rateLimitKeySubmitByUser,
  };
});

// ---- Module mocks -----------------------------------------------------------
vi.mock('@/lib/supabase/route', () => ({
  createSupabaseRouteClient: mocks.createSupabaseRouteClient,
}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: mocks.supabaseAdmin }));
vi.mock('@/lib/ai/upstream', () => ({
  validateProviderKey: mocks.validateProviderKey,
}));
vi.mock('@/lib/ratelimit', () => ({
  rateLimitKeySubmitByUser: mocks.rateLimitKeySubmitByUser,
}));

import { POST, DELETE, GET } from './route';
// REAL crypto — used to verify what the route actually stored.
import { decrypt, type KeyEnvelope } from '@/lib/crypto/key-vault';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
const USER = 'user-1';
/**
 * The fake store's key for this user's Groq row. Composite since migration 016 —
 * a user may hold one key per provider, so the user id alone no longer
 * identifies a row.
 */
const ROW = `${USER}::groq`;

let logSpy: MockInstance;

beforeAll(() => {
  process.env.KEY_VAULT_SECRET = JSON.stringify({ '1': MASTER_KEY_B64 });
  process.env.KEY_VAULT_ACTIVE_VERSION = '1';
});

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  resetState();
});

afterAll(() => {
  vi.restoreAllMocks();
});

function resetState() {
  const s = mocks.store;
  s.rows.clear();
  s.upsertFails = false;
  s.deleteFails = false;
  s.selectFails = false;
  s.upsertCalls = 0;
  mocks.authState.user = { id: USER };
  mocks.validationState.result = { ok: true };
  mocks.rateLimitState.ok = true;
  mocks.createSupabaseRouteClient.mockClear();
  mocks.supabaseAdmin.mockClear();
  mocks.validateProviderKey.mockClear();
  mocks.rateLimitKeySubmitByUser.mockClear();
  logSpy?.mockClear();
}

function postReq(apiKey: unknown): Request {
  return new Request('http://localhost/api/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey }),
  });
}

/**
 * Reconstruct the stored envelope and decrypt it with the REAL crypto core.
 * Takes the fake store's composite `${user}::${provider}` key.
 */
function decryptStored(rowKey: string): string {
  const row = mocks.store.rows.get(rowKey)!;
  const env: KeyEnvelope = {
    ciphertext: row.key_ciphertext,
    iv: row.key_nonce,
    authTag: row.key_auth_tag,
    version: row.key_version,
  };
  return decrypt(env);
}

function logLines(): string {
  return logSpy.mock.calls
    .map((args) =>
      args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ')
    )
    .join('\n');
}

function headerString(res: Response): string {
  const parts: string[] = [];
  res.headers.forEach((v, k) => parts.push(`${k}: ${v}`));
  parts.push(`url: ${res.url}`);
  return parts.join('\n');
}

/** DELETE now reads `request.url` for an optional `?provider=`. */
function delReq(provider?: string): Request {
  const qs = provider ? `?provider=${provider}` : '';
  return new Request(`http://localhost/api/keys${qs}`, { method: 'DELETE' });
}

// True if `haystack` exposes any contiguous run of `secret` longer than the
// allowed `last_four` (i.e. any window of length 5+). Windows of <=4 chars are
// permitted because the API legitimately surfaces last_four.
function leaks(haystack: string, secret: string): boolean {
  const win = Math.min(4, secret.length) + 1;
  if (secret.length < win) return false;
  for (let i = 0; i + win <= secret.length; i++) {
    if (haystack.includes(secret.slice(i, i + win))) return true;
  }
  return false;
}

// ---- Generators -------------------------------------------------------------
// Visible (non-whitespace) key characters so trim() never shortens the input.
const KEY_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-.'.split('');
const validKeyArb = fc
  .array(fc.constantFrom(...KEY_CHARS), { minLength: 1, maxLength: 512 })
  .map((a) => a.join(''));
// A gsk_-prefixed secret so it reads like a real Groq key.
const secretArb = fc
  .array(fc.constantFrom(...KEY_CHARS), { minLength: 8, maxLength: 60 })
  .map((a) => `gsk_${a.join('')}`);
// Whitespace-only strings (trim -> empty).
const WS = [' ', '\t', '\n', '\r', '\f', '\v'];
const whitespaceOnlyArb = fc
  .array(fc.constantFrom(...WS), { minLength: 1, maxLength: 20 })
  .map((a) => a.join(''));
// Over-length non-whitespace strings (trimmed length still > 512).
const overLengthArb = fc
  .array(fc.constantFrom(...KEY_CHARS), { minLength: 513, maxLength: 640 })
  .map((a) => a.join(''));

// =============================================================================
// Task 5.3 — Property 10: Input validation rejects whitespace / over-length
// Validates: Requirements 1.2
// =============================================================================
describe('POST /api/keys — input validation (Property 10)', () => {
  // Feature: ai-proxy-key-vault, Property 10: Input validation rejects empty, whitespace, and over-length keys
  it('rejects whitespace-only and >512-char keys with 400 invalid_groq_key, never validating or writing', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(whitespaceOnlyArb, overLengthArb),
        async (badKey) => {
          resetState();

          const res = await POST(postReq(badKey));
          const json = (await res.json()) as { code: string };

          expect(res.status).toBe(400);
          expect(json.code).toBe('invalid_groq_key');
          // Groq validation must never be invoked for invalid input.
          expect(mocks.validateProviderKey).not.toHaveBeenCalled();
          // Nothing is ever written to the Key_Vault.
          expect(mocks.store.upsertCalls).toBe(0);
          expect(mocks.store.rows.size).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// =============================================================================
// Task 5.4 — Property 9: Replace is idempotent to the latest key
// Validates: Requirements 1.11, 7.3, 7.4
// =============================================================================
describe('POST /api/keys — replace idempotence (Property 9)', () => {
  // Feature: ai-proxy-key-vault, Property 9: Replace is idempotent to the latest key
  it('after submitting A then B, exactly one row remains for the user and it decrypts to B', async () => {
    await fc.assert(
      fc.asyncProperty(validKeyArb, validKeyArb, async (keyA, keyB) => {
        resetState();

        const resA = await POST(postReq(keyA));
        expect(resA.status).toBe(200);
        const resB = await POST(postReq(keyB));
        expect(resB.status).toBe(200);

        // Exactly one row for this user.
        expect(mocks.store.rows.size).toBe(1);
        expect(mocks.store.rows.has(ROW)).toBe(true);

        // And it decrypts to B (the latest submission).
        expect(decryptStored(ROW)).toBe(keyB);
        // last_four reflects B as well.
        const jsonB = (await resB.json()) as { ok: boolean; last_four: string };
        expect(jsonB.ok).toBe(true);
        expect(jsonB.last_four).toBe(keyB.slice(-4));
      }),
      { numRuns: 100 }
    );
  });
});

// =============================================================================
// Task 5.5 — Property 7 (P8): No secret leakage across the lifecycle
// Validates: Requirements 1.9, 1.12, 2.2, 8.7, 10.1, 10.2, 10.4
// =============================================================================
describe('POST/GET/DELETE /api/keys — no secret leakage (Property 7)', () => {
  type Outcome =
    | 'success'
    | 'invalid_key'
    | 'unavailable'
    | 'upsert_fail'
    | 'delete_fail';

  // Feature: ai-proxy-key-vault, Property 7: No secret ever leaks to storage, responses, or logs (P8)
  it('never leaks the plaintext key or the ciphertext/nonce/tag across submit/store/view/delete and induced failures', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<Outcome>(
          'success',
          'invalid_key',
          'unavailable',
          'upsert_fail',
          'delete_fail'
        ),
        secretArb,
        async (outcome, secret) => {
          resetState();

          if (outcome === 'invalid_key') {
            mocks.validationState.result = { ok: false, reason: 'invalid_key' };
          } else if (outcome === 'unavailable') {
            mocks.validationState.result = { ok: false, reason: 'unavailable' };
          } else if (outcome === 'upsert_fail') {
            mocks.store.upsertFails = true;
          } else if (outcome === 'delete_fail') {
            mocks.store.deleteFails = true;
          }

          const sinks: string[] = [];

          // 1. Submit (store).
          const postRes = await POST(postReq(secret));
          sinks.push(await postRes.text(), headerString(postRes));

          // Capture the stored envelope fields (if any) to assert they never
          // surface in a response/header/log.
          const storedRow = mocks.store.rows.get(ROW);

          // 2. View.
          const getRes = await GET();
          sinks.push(await getRes.text(), headerString(getRes));

          // 3. Delete.
          const delRes = await DELETE(delReq());
          sinks.push(await delRes.text(), headerString(delRes));

          // 4. Every captured log line.
          sinks.push(logLines());

          for (const sink of sinks) {
            // Plaintext key never appears in full or as a >last_four run.
            expect(sink.includes(secret)).toBe(false);
            expect(leaks(sink, secret)).toBe(false);
            // Ciphertext / nonce / auth tag never appear anywhere.
            if (storedRow) {
              expect(sink.includes(storedRow.key_ciphertext)).toBe(false);
              expect(sink.includes(storedRow.key_nonce)).toBe(false);
              expect(sink.includes(storedRow.key_auth_tag)).toBe(false);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// =============================================================================
// Task 5.6 — Property 18: Failures leave the Key_Vault row unchanged
// Validates: Requirements 10.3, 2.8
// =============================================================================
describe('/api/keys — row unchanged on failure (Property 18)', () => {
  // Feature: ai-proxy-key-vault, Property 18: Failures leave the Key_Vault row unchanged
  it('an induced DELETE failure and a validation failure both leave the stored row byte-for-byte identical', async () => {
    await fc.assert(
      fc.asyncProperty(validKeyArb, validKeyArb, async (stored, attempted) => {
        resetState();

        // Seed a stored key.
        const seed = await POST(postReq(stored));
        expect(seed.status).toBe(200);
        const snapshot = JSON.stringify(mocks.store.rows.get(ROW));

        // --- Induced DELETE failure: row must be untouched (Req 2.8). ---
        mocks.store.deleteFails = true;
        const delRes = await DELETE(delReq());
        const delJson = (await delRes.json()) as { code: string };
        expect(delRes.status).toBe(500);
        expect(delJson.code).toBe('removal_failed');
        expect(JSON.stringify(mocks.store.rows.get(ROW))).toBe(snapshot);
        mocks.store.deleteFails = false;

        // --- Induced validation failure on a replace: row untouched. ---
        mocks.validationState.result = { ok: false, reason: 'invalid_key' };
        const postRes = await POST(postReq(attempted));
        const postJson = (await postRes.json()) as { code: string };
        expect(postRes.status).toBe(400);
        expect(postJson.code).toBe('invalid_groq_key');
        expect(JSON.stringify(mocks.store.rows.get(ROW))).toBe(snapshot);
      }),
      { numRuns: 100 }
    );
  });
});

// =============================================================================
// Task 5.7 — Unit tests: DELETE paths, auth, and GET shape
// Requirements: 2.4, 2.5, 2.6, 2.7, 2.8
// =============================================================================
describe('/api/keys — DELETE, auth, and GET unit tests', () => {
  it('DELETE removes an existing key and reports success (Req 2.4)', async () => {
    resetState();
    await POST(postReq('gsk_existingkey1234'));
    expect(mocks.store.rows.size).toBe(1);

    const res = await DELETE(delReq());
    const json = (await res.json()) as {
      ok: boolean;
      provider: string;
      has_key: boolean;
    };

    expect(res.status).toBe(200);
    // `provider` is echoed so the UI knows which row went away.
    expect(json).toEqual({ ok: true, provider: 'groq', has_key: false });
    expect(mocks.store.rows.size).toBe(0);
  });

  it('DELETE succeeds even when no key exists (Req 2.5, 2.6)', async () => {
    resetState();
    expect(mocks.store.rows.size).toBe(0);

    const res = await DELETE(delReq());
    const json = (await res.json()) as {
      ok: boolean;
      provider: string;
      has_key: boolean;
    };

    expect(res.status).toBe(200);
    // `provider` is echoed so the UI knows which row went away.
    expect(json).toEqual({ ok: true, provider: 'groq', has_key: false });
  });

  it('DELETE failure returns 500 removal_failed and leaves the row intact (Req 2.8)', async () => {
    resetState();
    await POST(postReq('gsk_existingkey1234'));
    const before = JSON.stringify(mocks.store.rows.get(ROW));

    mocks.store.deleteFails = true;
    const res = await DELETE(delReq());
    const json = (await res.json()) as { code: string };

    expect(res.status).toBe(500);
    expect(json.code).toBe('removal_failed');
    expect(mocks.store.rows.size).toBe(1);
    expect(JSON.stringify(mocks.store.rows.get(ROW))).toBe(before);
  });

  it('missing session returns 401 not_authenticated for POST/DELETE/GET (Req 2.7)', async () => {
    resetState();
    mocks.authState.user = null;

    const postRes = await POST(postReq('gsk_somekey12345678'));
    expect(postRes.status).toBe(401);
    expect(((await postRes.json()) as { code: string }).code).toBe('not_authenticated');

    const delRes = await DELETE(delReq());
    expect(delRes.status).toBe(401);
    expect(((await delRes.json()) as { code: string }).code).toBe('not_authenticated');

    const getRes = await GET();
    expect(getRes.status).toBe(401);
    expect(((await getRes.json()) as { code: string }).code).toBe('not_authenticated');

    // No side effects: no validation, no write.
    expect(mocks.validateProviderKey).not.toHaveBeenCalled();
    expect(mocks.store.upsertCalls).toBe(0);
  });

  it('GET lists saved keys, and keeps last_four for the pre-multi-provider UI (Req 2.1, 2.3)', async () => {
    resetState();
    await POST(postReq('gsk_visiblekeyABCD'));

    const res = await GET();
    const json = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(Object.keys(json).sort()).toEqual(['has_key', 'keys', 'last_four']);
    expect(json).toEqual({
      has_key: true,
      // One row per provider since migration 016.
      keys: [{ provider: 'groq', last_four: 'ABCD', is_preferred: false }],
      // Retained, and still means the Groq key, which is what it always meant.
      last_four: 'ABCD',
    });
  });

  it('GET returns has_key:false with no stored key (Req 2.3)', async () => {
    resetState();

    const res = await GET();
    const json = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(Object.keys(json).sort()).toEqual(['has_key', 'keys', 'last_four']);
    expect(json).toEqual({ has_key: false, keys: [], last_four: null });
  });
});
