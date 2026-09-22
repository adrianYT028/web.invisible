import { NextResponse, after } from 'next/server';

import { type SupabaseClient } from '@supabase/supabase-js';

import { verifyAccessToken } from '@/lib/auth/desktop-tokens';
// Only the error type: decryption itself now happens inside
// `@/lib/ai/user-keys`, which is the single reader of the vault.
import { KeyDecryptError } from '@/lib/crypto/key-vault';
import { env } from '@/lib/env';
import {
  getEndpointCapConfig,
  getReasoningSuppression,
  isPremiumModel,
  resolveModel,
  type AiEndpoint,
  type EndpointCapConfig,
} from '@/lib/ai/models';
import {
  applyPromptPolicy,
  PROMPT_POLICY_VERSION,
} from '@/lib/ai/prompt-policy';
import {
  DEFAULT_PLAN,
  planAllowsPremiumModels,
  planFundsInference,
} from '@/lib/ai/plans';
import { readEffectivePlan as readPlan } from '@/lib/plans/read-plan';
import { resolveProvider } from '@/lib/ai/model-routing';
import type { ProviderId } from '@/lib/ai/providers';
import { forwardToProvider, type UpstreamUsage } from '@/lib/ai/upstream';
import {
  listVaultedProviders,
  readProviderKey,
} from '@/lib/ai/user-keys';
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
//      request, decide which PROVIDER serves it (`resolveProvider`, from the
//      model plus the providers the caller has vaulted), then read and decrypt
//      that provider's key. No usable key → `403 no_api_key` with no upstream
//      call; a provider that cannot serve the endpoint at all → `400
//      endpoint_unsupported`.
//   7. Decrypt failure (Req 3.5, 8.3, 8.4) — `KeyDecryptError` → `500
//      key_decrypt_failed`, no upstream call, the vault row left unchanged, no
//      key material in the response.
//   8. Forward (Req 3.6, 3.7) — `forwardToProvider` under a 60s AbortController;
//      timeout/transport failure → `502 upstream_unavailable`; otherwise the
//      upstream payload is returned verbatim. Verbatim matters: shipped desktop
//      builds parse replies by scanning for `"content":`, so only providers that
//      speak the OpenAI shape may be registered.
//   9. Log (Req 3.8, 10.5) — a `finally` block ALWAYS inserts exactly one
//      `api_usage` row with only the seven allowed columns (token counts
//      default 0, `latency_ms` = receipt→response wall clock). No prompt,
//      response, audio, or secret content is ever recorded.
//
// The decrypted provider key lives only in a local variable for the duration of a
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
  let usage: UpstreamUsage | null = null;
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
    const isJsonPayload =
      payload !== null &&
      typeof payload === 'object' &&
      !(payload instanceof FormData);
    if (effectiveModel && effectiveModel !== requestedModel && isJsonPayload) {
      // Rewrite the outbound payload so the forwarded request uses the resolved
      // model, not the dead one the client sent.
      (payload as Record<string, unknown>).model = effectiveModel;
    }
    // Suppress "thinking" for reasoning-capable models so the app receives only
    // the final answer and responds faster.
    //
    // The PARAMETER IS MODEL-SPECIFIC and sending the wrong one is a 400, not a
    // no-op: `reasoning_effort: "none"` works on Qwen but is an invalid value on
    // GPT-OSS (which accepts only low/medium/high and instead honours
    // `include_reasoning: false`). `getReasoningSuppression` owns that mapping —
    // see src/lib/ai/models.ts. Only set it when the client hasn't already
    // specified the same parameter.
    const reasoningSuppression = getReasoningSuppression(effectiveModel);
    if (
      reasoningSuppression &&
      isJsonPayload &&
      (payload as Record<string, unknown>)[reasoningSuppression.param] === undefined
    ) {
      (payload as Record<string, unknown>)[reasoningSuppression.param] =
        reasoningSuppression.value;
    }

    // Apply the server-side prompt policy (src/lib/ai/prompt-policy.ts).
    //
    // The desktop client's prompts are compiled into the binary, so prompt
    // quality cannot be fixed by shipping config — it needs a new installer,
    // and every existing install stays broken until the user updates.
    // Rewriting the payload here fixes all installed copies on their next
    // request, the same reason the model rewrite above exists.
    //
    // This addresses three specific pieces of user feedback:
    //   - code output littered with comments (client prompts never mentioned
    //     comments),
    //   - answers that aren't the optimal solution first time (never mentioned
    //     efficiency, edge cases, or hidden tests; chat ran at temperature
    //     0.7),
    //   - unclear MCQ formatting (chat said nothing; vision demanded an
    //     explanation and never asked for a bold option).
    //
    // Vision is the important case: it sends NO system message at all, so its
    // answers previously ignored every formatting rule.
    if (isJsonPayload) {
      const promptPolicy = applyPromptPolicy(options.endpoint, payload);
      if (promptPolicy.applied) {
        logSafe('ai_proxy_prompt_policy_applied', {
          endpoint: options.endpoint,
          action: promptPolicy.action,
          temperature_clamped: promptPolicy.temperatureClamped,
          policy_version: PROMPT_POLICY_VERSION,
        });
      }
    }

    model = effectiveModel ?? null;
    const premium = model != null && isPremiumModel(model);

    // --- 3. Plan ------------------------------------------------------------
    const plan = await readPlan(admin, userId);

    // --- 4. Premium gate (Req 6.1, 6.2, 6.5, P14) ---------------------------
    if (premium && !planAllowsPremiumModels(plan)) {
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
    //
    // Two funding models (see src/lib/ai/plans.ts):
    //
    //   PLATFORM FUNDED — a premium model (Req 6.2), or ANY request from a plan
    //     that includes inference. The second condition is what makes the
    //     subscription tier possible: a Student Pro subscriber has already paid
    //     for inference, so they must never be asked for a Groq key, and their own
    //     key must never be spent on what they bought from us.
    //
    //   BRING YOUR OWN KEY — everyone else. Marginal cost stays zero, which is
    //     what keeps the one-time desktop licence viable.
    //
    // Gating on the PLAN rather than only on the model is what lets a subscriber
    // use the desktop app without ever holding a key of their own.
    //
    // -----------------------------------------------------------------------
    // WHY A PLAN-FUNDED USER'S OWN KEY IS STILL PREFERRED WHEN THEY HAVE ONE
    //
    // The three endpoints in this module are the DESKTOP app's (chat, transcribe,
    // vision). The resume analyser does not come through here — it calls the
    // platform key directly in src/lib/resume/ai/client.ts.
    //
    // So "plan funds inference" used unconditionally would move every paying
    // desktop user off their own Groq account and onto ours. Measured against
    // production usage before making this change: a single active desktop session
    // peaked at 6,599 tokens in one minute, and the whole account's observed peak
    // was 10,474. Our Groq tier allows 8,000 tokens per minute IN TOTAL.
    //
    // Today each of those users spends their own key and therefore their own
    // 8,000/min. Pooling ten of them into one 8,000/min bucket means the second
    // concurrent meeting starts getting 429s — so honouring the funding promise
    // literally would have made the product worse for the people who paid for it,
    // and would have spent the budget the resume analyser needs.
    //
    // Hence: their key first, our key only when they have none that can serve the
    // request. The promise that matters to a paying user is "this works without
    // you configuring anything", and the fallback is what delivers it — one
    // production customer has paid and never added a key, and is currently
    // getting 403s. Revisit this once the Groq tier is raised.
    const planFunded = planFundsInference(plan);

    let apiKey: string;
    // Which provider this request is sent to. On the platform-funded path it is
    // always Groq, because that is the account we hold. On the bring-your-own-key
    // path it is decided by `resolveProvider` from the model plus what the user has
    // vaulted — see src/lib/ai/model-routing.ts.
    let provider: ProviderId;

    if (premium) {
      // A premium model always runs on our account, whatever the user has
      // vaulted: premium is the thing we are selling, not a passthrough.
      provider = 'groq';
      const platformKey = env.groqApiKey;
      if (!platformKey) {
        logSafe('ai_proxy_platform_key_missing', {
          endpoint: options.endpoint,
          reason: 'premium_model',
        });
        response = jsonError(500, 'internal_error');
        return response;
      }
      apiKey = platformKey;
    } else {
      // Bring your own key. The user may now hold one key per provider, so this
      // is two steps: decide WHICH provider serves this request, then read that
      // provider's key.
      const vaulted = await listVaultedProviders(admin, userId);
      const routing = resolveProvider({
        endpoint: options.endpoint,
        model: effectiveModel,
        vaulted,
      });

      if (!routing.ok && planFunded) {
        // They have paid, and hold no key that can serve this request. We cover
        // it rather than refusing them something they bought.
        provider = 'groq';
        const platformKey = env.groqApiKey;
        if (!platformKey) {
          // A PAYING subscriber is being turned away. That is a billing
          // incident, not a config nit, and the log says so.
          logSafe('ai_proxy_platform_key_missing', {
            endpoint: options.endpoint,
            reason: 'plan_funded_fallback',
          });
          response = jsonError(500, 'internal_error');
          return response;
        }
        logSafe('ai_proxy_plan_funded_fallback', {
          endpoint: options.endpoint,
          failure: routing.failure,
          vaulted_count: vaulted.length,
        });
        apiKey = platformKey;
      } else if (!routing.ok) {
        logSafe('ai_proxy_routing_failed', {
          endpoint: options.endpoint,
          failure: routing.failure,
          // Which provider was implicated, when one was. Never the key.
          provider: routing.provider,
          vaulted_count: vaulted.length,
        });

        if (routing.failure === 'endpoint_unsupported') {
          // They hold a key, it just cannot do this. Saying `no_api_key` here
          // would send them to add a key they already have.
          response = jsonError(
            400,
            'endpoint_unsupported',
            routing.provider === null
              ? 'None of your saved AI keys support this feature.'
              : `Your ${routing.provider} key cannot be used for this feature.`
          );
          return response;
        }

        // Both `no_api_key` and `provider_key_missing` mean "we need a key we do
        // not have". They share the 403 `no_api_key` code deliberately: shipped
        // desktop builds special-case exactly that code and show an actionable
        // "add your key" prompt, whereas an unrecognised code falls through to a
        // generic failure message. The `message` carries the precise detail for
        // clients that render it.
        //
        // Req 4.1, 6.7, P13 — AI is disabled until a key is present. No upstream
        // provider is reached.
        response = jsonError(
          403,
          'no_api_key',
          routing.failure === 'provider_key_missing' && routing.provider !== null
            ? `This model runs on ${routing.provider}. Add a ${routing.provider} key to use it.`
            : undefined
        );
        return response;
      } else {
        // Routing succeeded: spend the user's own key for the provider it chose.
        provider = routing.provider;

        try {
          const vaultedKey = await readProviderKey(admin, userId, provider);
          if (vaultedKey === null) {
            // `listVaultedProviders` said this provider was present and the row read
            // then found nothing — a delete raced this request, or the read failed.
            logSafe('ai_proxy_vault_row_vanished', {
              endpoint: options.endpoint,
              provider,
            });
            response = jsonError(403, 'no_api_key');
            return response;
          }
          apiKey = vaultedKey;
        } catch (err) {
          // Req 3.5, 8.3, 8.4 — unknown master-key version or auth-tag failure.
          // No upstream call, the vault row is left unchanged, and no key
          // material is surfaced (KeyDecryptError messages carry none).
          //
          // NOT dropped to the platform key for a plan-funded user, even though
          // that would unblock them: a decrypt failure means we hold a key we can
          // no longer read, which is a fault in our own key management. Papering
          // over it here would hide a crypto regression behind a working product.
          // "No usable key" and "key we cannot decrypt" are different problems.
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
    }

    // --- 7. Forward under a 60s timeout (Req 3.6, 3.7) ----------------------
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const forwarded = await forwardToProvider(
        provider,
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
    //
    // DEFERRED WITH `after()`, NOT AWAITED.
    //
    // This used to `await` a Supabase INSERT before the response was returned,
    // so every AI call — including every transcription — paid a full database
    // round trip that the caller was waiting on. Nothing in the response depends
    // on the row existing: it is billing and observability, read later by the
    // quota checker on the NEXT request, never by this one.
    //
    // `after()` (Next 15+) runs the callback once the response has been flushed
    // while keeping the serverless invocation alive. That last part is why this is
    // not simply a floating promise: an un-awaited promise on Vercel races the
    // function being frozen after the response, which would drop usage rows
    // silently and under-count exactly the heaviest users.
    //
    // The latency is still measured to the moment the response was ready, not to
    // when the row was written, so the recorded number remains what the user
    // actually experienced.
    const latencyMs = Date.now() - startedAt;
    const statusCode = response.status;
    const write = () =>
      insertUsage(admin, {
        userId,
        endpoint: options.endpoint,
        model,
        usage,
        latencyMs,
        statusCode,
      });

    try {
      after(write);
    } catch {
      // `after()` throws when there is no request scope, which is the case when
      // `handleAiProxy` is called directly rather than through a route handler —
      // i.e. from the unit tests. Falling back to awaiting keeps the usage row
      // written in that context instead of silently skipping it, so the tests
      // still assert on real logging behaviour.
      //
      // Deliberately NOT a bare floating promise here: unhandled, it would reject
      // into nothing, and this branch is the one running in tests where a swallowed
      // failure is exactly what hides a regression.
      await write();
    }
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

// The plan lookup lives in `@/lib/plans/read-plan` (imported as `readPlan`
// above). It used to be a private copy here, byte-identical to the one in
// `src/lib/resume/quota.ts` — which is precisely how the expiry rule would have
// been applied to resume quotas and silently skipped for inference funding.

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

// The vaulted-key read used to live here as `readKeyRow`, selecting without a
// provider filter and calling `.maybeSingle()`. Migration 016 allows a user more
// than one key, and `.maybeSingle()` ERRORS on multiple matches — so that
// function would have broken the AI proxy for the first user to add a second key.
// It now lives in `@/lib/ai/user-keys`, filtered by the provider that
// `resolveProvider` chose.

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
    usage: UpstreamUsage | null;
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
