import { NextResponse } from 'next/server';

import { type SupabaseClient } from '@supabase/supabase-js';

import { verifyAccessToken } from '@/lib/auth/desktop-tokens';
import {
  decrypt,
  KeyDecryptError,
  type KeyEnvelope,
} from '@/lib/crypto/key-vault';
import { env } from '@/lib/env';
import { forwardToGroq, type GroqUsage } from '@/lib/groq/client';
import {
  getEndpointCapConfig,
  isPremiumModel,
  resolveModel,
  type AiEndpoint,
  type EndpointCapConfig,
} from '@/lib/ai/models';
import { extractBearer, jsonError, logSafe } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase/admin';

// -----------------------------------------------------------------------------
// Shared AI proxy handler — POST /api/ai/{chat,transcribe,vision}
// -----------------------------------------------------------------------------
//
// `handleAiProxy` is the single security-critical pipeline behind all three AI
// proxy endpoints (design §3.3). The three route wrappers (task 7.3) are thin
// shells that name their endpoint and delegate here.
//
// Pipeline (each step cites the requirement it satisfies):
//   1. Auth (Req 3.2, 3.3) — verify the bearer Access_Token; 401
//      `not_authenticated` on missing/invalid token, BEFORE any upstream call.
//      `userId = claims.sub`.
//   2. Parse the request body and extract the requested model.
//   3. Plan (Req 6.1, 6.2) — read `profiles.plan`, defaulting to `free`.
//   4. Premium gate (Req 6.1, 6.2, 6.5) — a premium model from a free user is
//      rejected `403 premium_required` with no upstream call; a premium model
//      from a premium user forwards with the platform `GROQ_API_KEY`.
//   5. Per-day cap (Req 6.3, 6.4, P16) — a NULL cap is unlimited (never
//      rejects); a non-NULL cap rejects `429 plan_limit_exceeded` once the
//      day's usage `>= cap`. The day window is UTC-pinned to match
//      `public.utc_date()`.
//   6. Key resolution (Req 3.4, 4.1, 6.6, 6.7, P13) — for a non-premium
//      request, read the caller's `user_api_keys` row; no row → `403
//      no_api_key` with no upstream call; otherwise `decrypt()` it.
//   7. Decrypt failure (Req 3.5, 8.3, 8.4) — `KeyDecryptError` → `500
//      key_decrypt_failed`, no upstream call, the vault row left unchanged, no
//      key material in the response.
//   8. Forward (Req 3.6, 3.7) — `forwardToGroq` under a 60s AbortController;
//      timeout/transport failure → `502 upstream_unavailable`; otherwise the
//      upstream payload is returned verbatim.
//   9. Log (Req 3.8, 10.5) — a `finally` block ALWAYS inserts exactly one
//      `api_usage` row with only the seven allowed columns (token counts
//      default 0, `latency_ms` = receipt→response wall clock). No prompt,
//      response, audio, or secret content is ever recorded.
//
// The decrypted Groq key lives only in a local variable for the duration of a
// single request; it is never written to a response body, header, or redirect
// (Req 3.9, P8) and never logged (logging goes through `logSafe`).
// -----------------------------------------------------------------------------

/** Upstream forward timeout (Req 3.7). */
const UPSTREAM_TIMEOUT_MS = 60_000;

/** Options supplied by each route wrapper (task 7.3). */
export interface HandleAiProxyOptions {
  /** Which AI proxy endpoint is being served. Selects the cap column. */
  endpoint: AiEndpoint;
  /**
   * Extract the requested model id from the parsed request payload. Each
   * wrapper knows the shape of its own payload (JSON body for chat/vision,
   * multipart FormData for transcribe). Defaults to reading `payload.model`.
   */
  extractModel?: (payload: unknown) => string | undefined;
}

/** The subset of a `user_api_keys` row needed to decrypt the stored key. */
interface KeyVaultRow {
  key_ciphertext: string;
  key_nonce: string;
  key_auth_tag: string;
  key_version: number;
}

/**
 * Serve an AI proxy request. Returns the upstream payload verbatim on success,
 * or a machine-readable error envelope on failure (design §3.3 error table).
 */
export async function handleAiProxy(
  request: Request,
  options: HandleAiProxyOptions
): Promise<Response> {
  const startedAt = Date.now();

  // --- 1. Auth (Req 3.2, 3.3) -----------------------------------------------
  // No upstream call and no usage row is written before the caller is known.
  const token = extractBearer(request);
  if (!token) return jsonError(401, 'not_authenticated');
  const claims = await verifyAccessToken(token);
  if (!claims) return jsonError(401, 'not_authenticated');
  const userId = claims.sub;

  const admin = supabaseAdmin();
  const extractModel = options.extractModel ?? defaultExtractModel;

  // These are captured for the guaranteed usage-log in the `finally` block.
  let model: string | null = null;
  let usage: GroqUsage | null = null;
  let response: Response = jsonError(500, 'internal_error');

  try {
    // --- 2. Parse the body + extract the model ------------------------------
    let payload: unknown;
    try {
      payload = await readPayload(request);
    } catch {
      response = jsonError(400, 'invalid_input');
      return response;
    }
    const extracted = extractModel(payload);
    const requestedModel = typeof extracted === 'string' ? extracted : undefined;
    // Remap decommissioned vision model ids (e.g. the Llama-4 vision models that
    // now 404) to the current supported Groq vision model. This fixes already-
    // installed desktop apps that still send the old id in their payload.
    const effectiveModel = resolveModel(options.endpoint, requestedModel);
    if (
      effectiveModel &&
      effectiveModel !== requestedModel &&
      payload !== null &&
      typeof payload === 'object' &&
      !(payload instanceof FormData)
    ) {
      // Rewrite the outbound payload so the forwarded request uses the resolved
      // model, not the dead one the client sent.
      (payload as Record<string, unknown>).model = effectiveModel;
    }
    model = effectiveModel ?? null;
    const premium = model != null && isPremiumModel(model);

    // --- 3. Plan ------------------------------------------------------------
    const plan = await readPlan(admin, userId);
    const isFree = plan === 'free';

    // --- 4. Premium gate (Req 6.1, 6.2, 6.5, P14) ---------------------------
    if (premium && isFree) {
      response = jsonError(403, 'premium_required');
      return response;
    }

    // --- 5. Per-day cap (Req 6.3, 6.4, P16) ---------------------------------
    const capConfig = getEndpointCapConfig(options.endpoint);
    const cap = await readCap(admin, plan, capConfig.capColumn);
    if (cap !== null) {
      const used = await countDailyUsage(admin, userId, options.endpoint);
      if (used >= cap) {
        response = jsonError(429, 'plan_limit_exceeded');
        return response;
      }
    }

    // --- 6. Resolve the upstream key ----------------------------------------
    let apiKey: string;
    if (premium) {
      // Premium request on a premium plan: forward with the platform key
      // (Req 6.2), never the user's vaulted key.
      const platformKey = env.groqApiKey;
      if (!platformKey) {
        logSafe('ai_proxy_platform_key_missing', {
          endpoint: options.endpoint,
        });
        response = jsonError(500, 'internal_error');
        return response;
      }
      apiKey = platformKey;
    } else {
      // Non-premium request: the caller's own vaulted Groq key.
      const row = await readKeyRow(admin, userId);
      if (!row) {
        // Req 4.1, 6.7, P13 — AI is disabled until a key is present. This is a
        // single indexed lookup, comfortably within the 2s budget, and never
        // reaches an upstream provider.
        response = jsonError(403, 'no_api_key');
        return response;
      }
      try {
        const envelope: KeyEnvelope = {
          ciphertext: row.key_ciphertext,
          iv: row.key_nonce,
          authTag: row.key_auth_tag,
          version: row.key_version,
        };
        apiKey = decrypt(envelope);
      } catch (err) {
        // Req 3.5, 8.3, 8.4 — unknown master-key version or auth-tag failure.
        // No upstream call, the vault row is left unchanged, and no key
        // material is surfaced (KeyDecryptError messages carry none).
        if (err instanceof KeyDecryptError) {
          logSafe('ai_proxy_key_decrypt_failed', {
            endpoint: options.endpoint,
          });
          response = jsonError(500, 'key_decrypt_failed');
          return response;
        }
        throw err;
      }
    }

    // --- 7. Forward under a 60s timeout (Req 3.6, 3.7) ----------------------
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const forwarded = await forwardToGroq(
        options.endpoint,
        payload,
        apiKey,
        controller.signal
      );
      usage = forwarded.usage;
      // Return the upstream payload verbatim (Req 3.6). The decrypted key is
      // never attached to the response (Req 3.9, P8).
      response = new NextResponse(forwarded.body, {
        status: forwarded.status,
        headers: { 'content-type': 'application/json' },
      });
      return response;
    } catch {
      // Abort (>60s) or transport failure (Req 3.7).
      logSafe('ai_proxy_upstream_unavailable', { endpoint: options.endpoint });
      response = jsonError(502, 'upstream_unavailable');
      return response;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // Req 10.2 — any unhandled failure returns a generic code with no detail.
    logSafe('ai_proxy_internal_error', {
      endpoint: options.endpoint,
      error: err instanceof Error ? err.name : 'unknown',
    });
    response = jsonError(500, 'internal_error');
    return response;
  } finally {
    // --- 9. Usage log (Req 3.8, 10.5) -------------------------------------
    // ALWAYS runs exactly once for an authenticated request — success or
    // failure — and records ONLY the seven allowed columns. No prompt,
    // response, audio, or secret content.
    const latencyMs = Date.now() - startedAt;
    await insertUsage(admin, {
      userId,
      endpoint: options.endpoint,
      model,
      usage,
      latencyMs,
      statusCode: response.status,
    });
  }
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

/** Default model extractor: reads `model` from a JSON object or FormData. */
function defaultExtractModel(payload: unknown): string | undefined {
  if (payload instanceof FormData) {
    const m = payload.get('model');
    return typeof m === 'string' ? m : undefined;
  }
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    const m = (payload as Record<string, unknown>).model;
    return typeof m === 'string' ? m : undefined;
  }
  return undefined;
}

/**
 * Read the request body according to its content type. JSON bodies (chat /
 * vision) are parsed to objects; multipart / urlencoded bodies (transcribe)
 * are read as FormData so the model field and audio file survive; anything
 * else falls back to raw text. Throws on malformed JSON → `invalid_input`.
 */
async function readPayload(request: Request): Promise<unknown> {
  const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
  if (contentType.includes('application/json')) {
    return await request.json();
  }
  if (
    contentType.includes('multipart/form-data') ||
    contentType.includes('application/x-www-form-urlencoded')
  ) {
    return await request.formData();
  }
  // Unknown/empty content type: forward the raw text verbatim.
  return await request.text();
}

/** Read `profiles.plan`, defaulting to `free` when missing (Req 6.1). */
async function readPlan(
  admin: SupabaseClient,
  userId: string
): Promise<string> {
  const { data, error } = await admin
    .from('profiles')
    .select('plan')
    .eq('id', userId)
    .maybeSingle();
  if (error || !data) return 'free';
  const plan = (data as { plan?: unknown }).plan;
  return typeof plan === 'string' && plan.length > 0 ? plan : 'free';
}

/**
 * Read the cap value for a plan + column from `feature_limits`. A missing row
 * or a NULL column both mean "unlimited" and are returned as `null` (Req 6.3,
 * P16).
 */
async function readCap(
  admin: SupabaseClient,
  plan: string,
  capColumn: EndpointCapConfig['capColumn']
): Promise<number | null> {
  const { data, error } = await admin
    .from('feature_limits')
    .select(capColumn)
    .eq('plan', plan)
    .maybeSingle();
  if (error || !data) return null;
  const value = (data as Record<string, unknown>)[capColumn];
  return typeof value === 'number' ? value : null;
}

/**
 * Count the caller's usage for the current UTC day against an endpoint's cap
 * (Req 6.4). The day window [00:00:00.000, next 00:00:00.000) UTC matches the
 * `public.utc_date()` rollover used by the `api_usage` day index.
 *
 * The `api_usage` table records no per-row audio-minute column (Req 10.5
 * forbids audio content), so the `sum_minutes` strategy used by transcribe is
 * tallied as one charged minute per row — consistent with the resolved
 * decision to charge a default of 1 minute when a request's duration is
 * undeterminable.
 */
async function countDailyUsage(
  admin: SupabaseClient,
  userId: string,
  endpoint: AiEndpoint
): Promise<number> {
  const { start, end } = utcDayWindow(new Date());
  const { count, error } = await admin
    .from('api_usage')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('endpoint', endpoint)
    .gte('occurred_at', start)
    .lt('occurred_at', end);
  if (error || count == null) return 0;
  return count;
}

/** Read the caller's vaulted-key row, or `null` when none exists (Req 4.1). */
async function readKeyRow(
  admin: SupabaseClient,
  userId: string
): Promise<KeyVaultRow | null> {
  const { data, error } = await admin
    .from('user_api_keys')
    .select('key_ciphertext, key_nonce, key_auth_tag, key_version')
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data) return null;
  return data as KeyVaultRow;
}

/**
 * Insert exactly one `api_usage` row with ONLY the seven allowed columns
 * (Req 3.8, 10.5). Failures here are swallowed (and logged safely) so usage
 * logging never changes the response the caller receives.
 */
async function insertUsage(
  admin: SupabaseClient,
  args: {
    userId: string;
    endpoint: AiEndpoint;
    model: string | null;
    usage: GroqUsage | null;
    latencyMs: number;
    statusCode: number;
  }
): Promise<void> {
  try {
    const { error } = await admin.from('api_usage').insert({
      user_id: args.userId,
      endpoint: args.endpoint,
      model: args.model,
      prompt_tokens: args.usage?.prompt_tokens ?? 0,
      completion_tokens: args.usage?.completion_tokens ?? 0,
      total_tokens: args.usage?.total_tokens ?? 0,
      latency_ms: args.latencyMs,
      status_code: args.statusCode,
    });
    if (error) {
      logSafe('ai_proxy_usage_log_failed', {
        endpoint: args.endpoint,
        reason: error.message,
      });
    }
  } catch (err) {
    logSafe('ai_proxy_usage_log_failed', {
      endpoint: args.endpoint,
      reason: err instanceof Error ? err.name : 'unknown',
    });
  }
}

/**
 * The UTC day window for an instant, as ISO strings. `start` is 00:00:00.000Z
 * of that day; `end` is 00:00:00.000Z of the next day. Equivalent to
 * `public.utc_date(occurred_at) = public.utc_date(now())`.
 */
function utcDayWindow(now: Date): { start: string; end: string } {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}
