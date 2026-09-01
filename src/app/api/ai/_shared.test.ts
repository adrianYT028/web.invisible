import fc from 'fast-check';
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

// -----------------------------------------------------------------------------
// /api/ai/* shared proxy handler tests (tasks 7.4–7.9)
//
// `handleAiProxy` (src/app/api/ai/_shared.ts) is the security-critical pipeline
// behind all three AI proxy endpoints. Its dependencies are mocked so no real
// network or database is ever touched:
//
//   verifyAccessToken  (bearer auth)            -> mocked (configurable claims)
//   supabaseAdmin      (DB read/write)          -> mocked in-memory store with
//                                                  profiles / feature_limits /
//                                                  api_usage / user_api_keys
//   forwardToGroq      (upstream provider call) -> mocked spy (configurable)
//   decrypt / KeyDecryptError                   -> mocked (configurable result)
//   env.groqApiKey     (platform premium key)   -> mocked
//
//   jsonError / logSafe / extractBearer (http helpers) -> REAL. logSafe is the
//   only sanctioned log sink and THROWS in dev if a value matches a known
//   secret, so leaving it real strengthens the no-leak property.
// -----------------------------------------------------------------------------

// ---- Shared mock state (hoisted so vi.mock factories can see it) ------------
const mocks = vi.hoisted(() => {
  interface ForwardResult {
    status: number;
    body: ArrayBuffer;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  }

  interface State {
    /** profiles.plan; null simulates an absent profile row (defaults to free). */
    plan: string | null;
    /** user_api_keys row, or null when no key is stored. */
    keyRow: Record<string, unknown> | null;
    /** feature_limits cap value for the resolved column; null = unlimited. */
    cap: number | null;
    /** api_usage count returned for the current UTC day. */
    todayCount: number;
    /** Captured api_usage inserts. */
    usageInserts: Record<string, unknown>[];
    /** When true, the mocked decrypt() throws KeyDecryptError. */
    decryptFails: boolean;
    /** The plaintext returned by a successful mocked decrypt(). */
    decryptValue: string;
    /** Models treated as premium for this run. */
    premiumModels: Set<string>;
    /** Platform Groq key for the premium path. */
    groqApiKey: string | undefined;
    /** verifyAccessToken result (null => not authenticated). */
    verifyResult: { sub: string; device_id: string; iat: number; exp: number } | null;
    /** Optional override for forwardToGroq. */
    forwardImpl: ((...args: unknown[]) => Promise<ForwardResult>) | null;
  }

  const state: State = {
    plan: 'free',
    keyRow: null,
    cap: null,
    todayCount: 0,
    usageInserts: [],
    decryptFails: false,
    decryptValue: 'gsk_decrypteddefault0000',
    premiumModels: new Set<string>(),
    groqApiKey: 'platform-groq-key',
    verifyResult: { sub: 'user-1', device_id: 'dev-1', iat: 0, exp: 0 },
    forwardImpl: null,
  };

  type QueryResult = { data?: unknown; count?: number | null; error: unknown };

  interface QueryLike {
    _table: string;
    _cols: string;
    _op: 'select' | 'insert';
    _isCount: boolean;
    _row: Record<string, unknown> | null;
  }

  function resolveSingle(q: QueryLike): QueryResult {
    switch (q._table) {
      case 'profiles':
        return state.plan === null
          ? { data: null, error: null }
          : { data: { plan: state.plan }, error: null };
      case 'feature_limits':
        return { data: { [q._cols]: state.cap }, error: null };
      case 'user_api_keys':
        return { data: state.keyRow, error: null };
      default:
        return { data: null, error: null };
    }
  }

  function resolveAwait(q: QueryLike): QueryResult {
    if (q._op === 'insert') {
      state.usageInserts.push(q._row as Record<string, unknown>);
      return { error: null };
    }
    if (q._isCount) {
      return { count: state.todayCount, error: null };
    }
    return { data: null, error: null };
  }

  class FakeQuery implements QueryLike {
    _table: string;
    _cols = '';
    _op: 'select' | 'insert' = 'select';
    _isCount = false;
    _row: Record<string, unknown> | null = null;

    constructor(table: string) {
      this._table = table;
    }
    select(cols: string, opts?: { count?: string; head?: boolean }): this {
      this._cols = cols;
      this._op = 'select';
      if (opts?.count) this._isCount = true;
      return this;
    }
    insert(row: Record<string, unknown>): this {
      this._op = 'insert';
      this._row = row;
      return this;
    }
    eq(): this {
      return this;
    }
    gte(): this {
      return this;
    }
    lt(): this {
      return this;
    }
    maybeSingle(): Promise<QueryResult> {
      return Promise.resolve(resolveSingle(this));
    }
    then(
      onF: (v: QueryResult) => unknown,
      onR?: (e: unknown) => unknown
    ): Promise<unknown> {
      return Promise.resolve(resolveAwait(this)).then(onF, onR);
    }
  }

  const client = { from: (table: string) => new FakeQuery(table) };

  const verifyAccessToken = vi.fn(async (_token: string) => state.verifyResult);
  const forwardToGroq = vi.fn(async (...args: unknown[]): Promise<ForwardResult> => {
    if (state.forwardImpl) return state.forwardImpl(...args);
    return { status: 200, body: new TextEncoder().encode('{}').buffer, usage: null };
  });

  return {
    state,
    client,
    verifyAccessToken,
    forwardToGroq,
    supabaseAdmin: () => client,
  };
});

// ---- Module mocks -----------------------------------------------------------
vi.mock('@/lib/auth/desktop-tokens', () => ({
  verifyAccessToken: mocks.verifyAccessToken,
}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: mocks.supabaseAdmin }));
vi.mock('@/lib/groq/client', () => ({ forwardToGroq: mocks.forwardToGroq }));
vi.mock('@/lib/env', () => ({
  env: {
    get groqApiKey() {
      return mocks.state.groqApiKey;
    },
  },
}));
// Keep the real model classification but inject premium membership per run.
vi.mock('@/lib/ai/models', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/ai/models')>();
  return {
    ...actual,
    isPremiumModel: (model: string) => mocks.state.premiumModels.has(model),
  };
});
// decrypt/KeyDecryptError mocked so we control the round-trip without real env.
vi.mock('@/lib/crypto/key-vault', () => {
  class KeyDecryptError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'KeyDecryptError';
    }
  }
  return {
    KeyDecryptError,
    decrypt: (_env: unknown) => {
      if (mocks.state.decryptFails) {
        throw new KeyDecryptError('auth_tag_verification_failed');
      }
      return mocks.state.decryptValue;
    },
  };
});

import { handleAiProxy } from './_shared';

type Endpoint = 'chat' | 'transcribe' | 'vision';
const ENDPOINTS: Endpoint[] = ['chat', 'transcribe', 'vision'];

const ALLOWED_USAGE_KEYS = [
  'completion_tokens',
  'endpoint',
  'latency_ms',
  'model',
  'prompt_tokens',
  'status_code',
  'total_tokens',
  'user_id',
];

let logSpy: MockInstance;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  resetState();
});

afterAll(() => {
  vi.restoreAllMocks();
});

function resetState() {
  const s = mocks.state;
  s.plan = 'free';
  s.keyRow = null;
  s.cap = null;
  s.todayCount = 0;
  s.usageInserts.length = 0;
  s.decryptFails = false;
  s.decryptValue = 'gsk_decrypteddefault0000';
  s.premiumModels.clear();
  s.groqApiKey = 'platform-groq-key';
  s.verifyResult = { sub: 'user-1', device_id: 'dev-1', iat: 0, exp: 0 };
  s.forwardImpl = null;
  mocks.verifyAccessToken.mockClear();
  mocks.forwardToGroq.mockClear();
  logSpy?.mockClear();
}

// ---- Helpers ----------------------------------------------------------------
function aiReq(
  endpoint: Endpoint,
  body: unknown,
  opts: { auth?: boolean } = {}
): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.auth !== false) headers['authorization'] = 'Bearer test-token';
  return new Request(`http://localhost/api/ai/${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function keyRow(): Record<string, unknown> {
  return {
    key_ciphertext: 'Y2lwaGVydGV4dA==',
    key_nonce: 'bm9uY2V2YWw=',
    key_auth_tag: 'YXV0aHRhZw==',
    key_version: 1,
  };
}

function enc(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer as ArrayBuffer;
}

function headerString(res: Response): string {
  const parts: string[] = [];
  res.headers.forEach((v, k) => parts.push(`${k}: ${v}`));
  parts.push(`url: ${res.url}`);
  return parts.join('\n');
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

// True if `haystack` exposes any contiguous run of `secret` longer than the
// allowed `last_four` (i.e. any window of length 5+).
function leaks(haystack: string, secret: string): boolean {
  const win = Math.min(4, secret.length) + 1;
  if (secret.length < win) return false;
  for (let i = 0; i + win <= secret.length; i++) {
    if (haystack.includes(secret.slice(i, i + win))) return true;
  }
  return false;
}

// ---- Generators -------------------------------------------------------------
const KEY_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.split('');
// A gsk_-prefixed alphanumeric secret (the decrypted plaintext key).
const secretArb = fc
  .array(fc.constantFrom(...KEY_CHARS), { minLength: 8, maxLength: 48 })
  .map((a) => `gsk_${a.join('')}`);
// A non-premium model id: any non-empty alphanumeric string (PREMIUM_MODELS
// is empty by default, so these are never premium).
const nonPremiumModelArb = fc
  .array(fc.constantFrom(...KEY_CHARS), { minLength: 1, maxLength: 24 })
  .map((a) => a.join(''));
// A premium model id (registered into the premium set inside each run).
const premiumModelArb = fc
  .array(fc.constantFrom(...KEY_CHARS), { minLength: 1, maxLength: 24 })
  .map((a) => `prem_${a.join('')}`);

// =============================================================================
// Task 7.4 — Property 11: No key means no upstream call (P13)
// Validates: Requirements 4.1, 6.7
// =============================================================================
describe('handleAiProxy — no key, no upstream call', () => {
  // Feature: ai-proxy-key-vault, Property 11: No key means no upstream call (P13)
  it('a Free_Plan user with no stored key gets 403 no_api_key and never reaches upstream (incl. after downgrade)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ENDPOINTS),
        nonPremiumModelArb,
        fc.boolean(),
        async (endpoint, model, downgraded) => {
          resetState();
          mocks.state.keyRow = null; // no stored key

          if (downgraded) {
            // Simulate the user briefly on premium, then a Plan_Downgrade to
            // free. A non-premium model with no key is rejected in both states
            // and never forwards.
            mocks.state.plan = 'premium';
            const pre = await handleAiProxy(aiReq(endpoint, { model }), { endpoint });
            expect(pre.status).toBe(403);
            mocks.state.plan = 'free';
          } else {
            mocks.state.plan = 'free';
          }

          const res = await handleAiProxy(aiReq(endpoint, { model }), { endpoint });
          const json = (await res.json()) as { code: string };

          expect(res.status).toBe(403);
          expect(json.code).toBe('no_api_key');
          expect(mocks.forwardToGroq).not.toHaveBeenCalled();
        }
      ),
      { numRuns: 100 }
    );
  });
});

// =============================================================================
// Task 7.5 — Property 12: Premium models are gated from Free_Plan users (P14)
// Validates: Requirements 6.1, 6.5
// =============================================================================
describe('handleAiProxy — premium gating', () => {
  // Feature: ai-proxy-key-vault, Property 12: Premium models are gated from Free_Plan users (P14)
  it('a premium model from a Free_Plan user gets 403 premium_required and never reaches a premium provider (incl. after downgrade)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ENDPOINTS),
        premiumModelArb,
        fc.boolean(),
        fc.boolean(),
        async (endpoint, model, downgraded, hasKey) => {
          resetState();
          // PREMIUM_MODELS is empty by default — inject this model id as premium.
          mocks.state.premiumModels.add(model);
          mocks.state.keyRow = hasKey ? keyRow() : null;

          if (downgraded) {
            // Plan_Downgrade: the plan column transitioned premium -> free; the
            // gate is re-evaluated per request, so the post-downgrade state is
            // a free plan.
            mocks.state.plan = 'premium';
            mocks.state.plan = 'free';
          } else {
            mocks.state.plan = 'free';
          }

          const res = await handleAiProxy(aiReq(endpoint, { model }), { endpoint });
          const json = (await res.json()) as { code: string };

          expect(res.status).toBe(403);
          expect(json.code).toBe('premium_required');
          expect(mocks.forwardToGroq).not.toHaveBeenCalled();
        }
      ),
      { numRuns: 100 }
    );
  });
});

// =============================================================================
// Task 7.6 — Property 13: Per-day cap honors NULL-as-unlimited (P16)
// Validates: Requirements 6.3, 6.4
// =============================================================================
describe('handleAiProxy — per-day cap enforcement', () => {
  // Feature: ai-proxy-key-vault, Property 13: Per-day cap enforcement honors NULL-as-unlimited (P16)
  it('rejects 429 plan_limit_exceeded iff cap is non-NULL and count >= cap; NULL never rejects', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 20 })),
        fc.integer({ min: 0, max: 20 }),
        async (cap, count) => {
          resetState();
          mocks.state.plan = 'free';
          mocks.state.cap = cap;
          mocks.state.todayCount = count;
          // A stored key + 200 upstream so the non-capped path resolves to 200.
          mocks.state.keyRow = keyRow();
          mocks.state.forwardImpl = async () => ({
            status: 200,
            body: enc('{}'),
            usage: null,
          });

          const res = await handleAiProxy(aiReq('chat', { model: 'llama' }), {
            endpoint: 'chat',
          });

          const shouldReject = cap !== null && count >= cap;
          if (shouldReject) {
            const json = (await res.json()) as { code: string };
            expect(res.status).toBe(429);
            expect(json.code).toBe('plan_limit_exceeded');
            expect(mocks.forwardToGroq).not.toHaveBeenCalled();
          } else {
            expect(res.status).toBe(200);
            expect(mocks.forwardToGroq).toHaveBeenCalledTimes(1);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// =============================================================================
// Task 7.7 — Property 17: Every proxied call logs exactly one bounded usage row
// Validates: Requirements 3.8, 10.5
// =============================================================================
describe('handleAiProxy — usage logging shape', () => {
  // Feature: ai-proxy-key-vault, Property 17: Every proxied call logs exactly one bounded usage row
  it('inserts exactly one api_usage row with only the seven allowed columns across success/error/timeout', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ENDPOINTS),
        fc.constantFrom('success', 'error', 'timeout'),
        fc.record({ p: fc.nat(5000), c: fc.nat(5000) }),
        async (endpoint, outcome, toks) => {
          resetState();
          mocks.state.keyRow = keyRow(); // reach the upstream forward step

          if (outcome === 'success') {
            mocks.state.forwardImpl = async () => ({
              status: 200,
              body: enc(JSON.stringify({ ok: true })),
              usage: {
                prompt_tokens: toks.p,
                completion_tokens: toks.c,
                total_tokens: toks.p + toks.c,
              },
            });
          } else if (outcome === 'error') {
            mocks.state.forwardImpl = async () => ({
              status: 500,
              body: enc('{}'),
              usage: null,
            });
          } else {
            mocks.state.forwardImpl = async () => {
              throw new Error('aborted');
            };
          }

          const res = await handleAiProxy(aiReq(endpoint, { model: 'llama' }), {
            endpoint,
          });

          // Exactly one usage row, with ONLY the allowed columns.
          expect(mocks.state.usageInserts).toHaveLength(1);
          const row = mocks.state.usageInserts[0];
          expect(Object.keys(row).sort()).toEqual(ALLOWED_USAGE_KEYS);

          expect(row.endpoint).toBe(endpoint);
          expect(typeof row.latency_ms).toBe('number');
          expect(row.latency_ms as number).toBeGreaterThanOrEqual(0);
          expect(row.status_code).toBe(res.status);

          if (outcome === 'success') {
            expect(res.status).toBe(200);
            expect(row.prompt_tokens).toBe(toks.p);
            expect(row.completion_tokens).toBe(toks.c);
            expect(row.total_tokens).toBe(toks.p + toks.c);
          } else {
            // Token counts default to 0 when the upstream returns none.
            expect(row.prompt_tokens).toBe(0);
            expect(row.completion_tokens).toBe(0);
            expect(row.total_tokens).toBe(0);
            expect(res.status).toBe(outcome === 'timeout' ? 502 : 500);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// =============================================================================
// Task 7.8 — Property 7 (P8) + Property 18 (proxy path)
// Validates: Requirements 3.9, 8.4, 10.1, 10.2, 10.3, 10.4
// =============================================================================
describe('handleAiProxy — no secret leak + row unchanged on failure', () => {
  // Feature: ai-proxy-key-vault, Property 7: No secret ever leaks (P8)
  // Feature: ai-proxy-key-vault, Property 18: Failures leave the Key_Vault row unchanged
  it('never leaks the decrypted key across success/key_decrypt_failed/upstream_unavailable, and leaves the vault row unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ENDPOINTS),
        fc.constantFrom('success', 'key_decrypt_failed', 'upstream_unavailable'),
        secretArb,
        async (endpoint, outcome, secret) => {
          resetState();
          mocks.state.keyRow = keyRow();
          mocks.state.decryptValue = secret;
          const rowBefore = JSON.stringify(mocks.state.keyRow);

          if (outcome === 'success') {
            mocks.state.forwardImpl = async () => ({
              status: 200,
              body: enc(JSON.stringify({ choices: [{ text: 'hello' }] })),
              usage: null,
            });
          } else if (outcome === 'key_decrypt_failed') {
            mocks.state.decryptFails = true;
          } else {
            mocks.state.forwardImpl = async () => {
              throw new Error('aborted');
            };
          }

          const res = await handleAiProxy(aiReq(endpoint, { model: 'llama' }), {
            endpoint,
          });

          const sinks: string[] = [];
          sinks.push(await res.text());
          sinks.push(headerString(res));
          sinks.push(logLines());
          sinks.push(JSON.stringify(mocks.state.usageInserts));

          for (const sink of sinks) {
            expect(sink.includes(secret)).toBe(false);
            expect(leaks(sink, secret)).toBe(false);
          }

          // Property 18 — the Key_Vault row is never mutated by the proxy.
          expect(JSON.stringify(mocks.state.keyRow)).toBe(rowBefore);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// =============================================================================
// Task 7.9 — unit tests: forward pass-through, 60s timeout, 401 paths
// Requirements: 3.3, 3.6, 3.7
// =============================================================================
describe('handleAiProxy — forwarding + auth unit tests', () => {
  it('returns the upstream status and bytes verbatim (Req 3.6)', async () => {
    resetState();
    mocks.state.keyRow = keyRow();
    const upstreamBytes = new TextEncoder().encode(
      JSON.stringify({ choices: [1, 2, 3], usage: null })
    );
    mocks.state.forwardImpl = async () => ({
      status: 200,
      body: upstreamBytes.buffer as ArrayBuffer,
      usage: null,
    });

    const res = await handleAiProxy(aiReq('chat', { model: 'llama' }), {
      endpoint: 'chat',
    });

    expect(res.status).toBe(200);
    const got = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(got)).toEqual(Array.from(upstreamBytes));
  });

  it('maps an upstream timeout/abort to 502 upstream_unavailable (Req 3.7)', async () => {
    resetState();
    mocks.state.keyRow = keyRow();
    mocks.state.forwardImpl = async () => {
      // Simulates the 60s AbortController firing / a transport failure.
      throw new Error('The operation was aborted');
    };

    const res = await handleAiProxy(aiReq('chat', { model: 'llama' }), {
      endpoint: 'chat',
    });
    const json = (await res.json()) as { code: string };

    expect(res.status).toBe(502);
    expect(json.code).toBe('upstream_unavailable');
  });

  it('returns 401 not_authenticated with no bearer and never forwards (Req 3.3)', async () => {
    resetState();
    const res = await handleAiProxy(aiReq('chat', { model: 'llama' }, { auth: false }), {
      endpoint: 'chat',
    });
    const json = (await res.json()) as { code: string };

    expect(res.status).toBe(401);
    expect(json.code).toBe('not_authenticated');
    expect(mocks.forwardToGroq).not.toHaveBeenCalled();
  });

  it('returns 401 not_authenticated on an invalid access token and never forwards (Req 3.3)', async () => {
    resetState();
    mocks.state.verifyResult = null;
    const res = await handleAiProxy(aiReq('chat', { model: 'llama' }), {
      endpoint: 'chat',
    });
    const json = (await res.json()) as { code: string };

    expect(res.status).toBe(401);
    expect(json.code).toBe('not_authenticated');
    expect(mocks.forwardToGroq).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Decommissioned-model remap — the proxy rewrites dead model ids to the current
// supported Groq model BEFORE forwarding upstream (src/lib/ai/models.ts
// `resolveModel`, kept real in these tests). This is what keeps already-
// installed desktop apps — which bake the old id into their config — working.
// =============================================================================
describe('handleAiProxy — decommissioned model remap', () => {
  it("remaps the dead Llama-4 vision id to 'qwen/qwen3.6-27b' before forwarding", async () => {
    resetState();
    mocks.state.keyRow = keyRow(); // reach the upstream forward step
    let forwardedModel: unknown;
    mocks.state.forwardImpl = async (...args: unknown[]) => {
      forwardedModel = (args[1] as { model?: unknown })?.model;
      return { status: 200, body: enc('{}'), usage: null };
    };

    const res = await handleAiProxy(
      aiReq('vision', { model: 'meta-llama/llama-4-scout-17b-16e-instruct' }),
      { endpoint: 'vision' }
    );

    expect(res.status).toBe(200);
    expect(mocks.forwardToGroq).toHaveBeenCalledTimes(1);
    // The payload forwarded upstream carries the CURRENT vision model, not the
    // decommissioned one the client sent.
    expect(forwardedModel).toBe('qwen/qwen3.6-27b');
    // And the usage row records the effective (remapped) model.
    expect(mocks.state.usageInserts).toHaveLength(1);
    expect(mocks.state.usageInserts[0].model).toBe('qwen/qwen3.6-27b');
  });

  it("remaps the retired chat id 'llama-3.3-70b-versatile' to the current chat model", async () => {
    // This test previously asserted the OPPOSITE — that the id forwarded
    // unchanged — which encoded the assumption that the model was still live.
    // Groq retired it for free/developer tiers with a 2026-08-16 shutdown, and
    // because the id is baked into every installed desktop config.ini, an
    // unmapped id means those installs get a 404 on every question. The remap is
    // the only fix that reaches already-shipped clients.
    resetState();
    mocks.state.keyRow = keyRow();
    let forwardedModel: unknown;
    mocks.state.forwardImpl = async (...args: unknown[]) => {
      forwardedModel = (args[1] as { model?: unknown })?.model;
      return { status: 200, body: enc('{}'), usage: null };
    };

    const res = await handleAiProxy(
      aiReq('chat', { model: 'llama-3.3-70b-versatile' }),
      { endpoint: 'chat' }
    );

    expect(res.status).toBe(200);
    expect(mocks.forwardToGroq).toHaveBeenCalledTimes(1);
    expect(forwardedModel).toBe('openai/gpt-oss-120b');
    // The usage row records the effective (remapped) model, not what was sent.
    expect(mocks.state.usageInserts[0].model).toBe('openai/gpt-oss-120b');
  });

  it('uses include_reasoning for GPT-OSS, NOT reasoning_effort', async () => {
    // The parameter is model-specific and the wrong one is a 400, not a no-op:
    // `reasoning_effort` accepts 'none' only on Qwen, while GPT-OSS accepts only
    // low/medium/high and instead honours `include_reasoning: false`. Reusing
    // the Qwen path for the chat migration would have sent an invalid value on
    // every request.
    resetState();
    mocks.state.keyRow = keyRow();
    let forwardedPayload: Record<string, unknown> | undefined;
    mocks.state.forwardImpl = async (...args: unknown[]) => {
      forwardedPayload = args[1] as Record<string, unknown>;
      return { status: 200, body: enc('{}'), usage: null };
    };

    const res = await handleAiProxy(
      aiReq('chat', { model: 'llama-3.3-70b-versatile' }),
      { endpoint: 'chat' }
    );

    expect(res.status).toBe(200);
    expect(forwardedPayload?.model).toBe('openai/gpt-oss-120b');
    expect(forwardedPayload?.include_reasoning).toBe(false);
    expect(forwardedPayload?.reasoning_effort).toBeUndefined();
  });

  it("suppresses reasoning for the qwen3 vision model (reasoning_effort: 'none')", async () => {
    resetState();
    mocks.state.keyRow = keyRow();
    let forwardedPayload: Record<string, unknown> | undefined;
    mocks.state.forwardImpl = async (...args: unknown[]) => {
      forwardedPayload = args[1] as Record<string, unknown>;
      return { status: 200, body: enc('{}'), usage: null };
    };

    const res = await handleAiProxy(
      aiReq('vision', { model: 'meta-llama/llama-4-scout-17b-16e-instruct' }),
      { endpoint: 'vision' }
    );

    expect(res.status).toBe(200);
    // Remapped to the current vision model AND reasoning disabled so the app
    // gets only the final answer, faster.
    expect(forwardedPayload?.model).toBe('qwen/qwen3.6-27b');
    expect(forwardedPayload?.reasoning_effort).toBe('none');
  });

  it('forwards a supported model unchanged', async () => {
    resetState();
    mocks.state.keyRow = keyRow();
    let forwardedModel: unknown;
    mocks.state.forwardImpl = async (...args: unknown[]) => {
      forwardedModel = (args[1] as { model?: unknown })?.model;
      return { status: 200, body: enc('{}'), usage: null };
    };

    const res = await handleAiProxy(
      aiReq('chat', { model: 'openai/gpt-oss-120b' }),
      { endpoint: 'chat' }
    );

    expect(res.status).toBe(200);
    expect(forwardedModel).toBe('openai/gpt-oss-120b');
  });
});
