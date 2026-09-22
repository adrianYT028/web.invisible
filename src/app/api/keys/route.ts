import { NextResponse } from 'next/server';

import { createSupabaseRouteClient } from '@/lib/supabase/route';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { jsonError, logSafe } from '@/lib/http';
import { rateLimitKeySubmitByUser } from '@/lib/ratelimit';
import { validateProviderKey } from '@/lib/ai/upstream';
import {
  findProvider,
  keyPrefixLooksRight,
  type ProviderId,
} from '@/lib/ai/providers';
import { setPreferredProvider } from '@/lib/ai/user-keys';
import { encrypt, lastFour } from '@/lib/crypto/key-vault';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// /api/keys — per-user AI provider key management for the website /account page.
//
// Cookie/session authenticated via createSupabaseRouteClient() (this is the
// /account surface, NOT the desktop bearer path). The caller's user.id is
// resolved from the Supabase session and every read/write is additionally
// filtered by `user_id = user.id` (defence in depth alongside RLS).
//
//   POST   add or replace a key for one provider  -> 200 { ok, provider, last_four }
//   PATCH  nominate the default provider          -> 200 { ok, preferred }
//   DELETE remove one provider's key              -> 200 { ok, provider }
//   GET    all saved keys, for rendering /account -> 200 { has_key, keys: [...] }
//
// The plaintext key, Key_Ciphertext, Key_Nonce, and Key_Auth_Tag are NEVER
// returned to any client and NEVER logged (Req 2.2, 10.1).
//
// ---------------------------------------------------------------------------
// BACKWARDS COMPATIBILITY
//   Migration 016 moved the vault primary key to `(user_id, provider)`, so a user
//   may hold several keys. `provider` is OPTIONAL on every method here and
//   defaults to `groq` — the only provider that existed when the previous
//   contract was written, and therefore the only thing any existing caller or
//   stored row can have meant.
//
//   GET previously used `.maybeSingle()`, which ERRORS on multiple matches rather
//   than returning the first. It now returns a list, so the first user to save a
//   second key does not break their own account page.
// -----------------------------------------------------------------------------

const MAX_KEY_LENGTH = 512;
const TABLE = 'user_api_keys';

/**
 * Resolve the target provider from a request, defaulting to Groq.
 *
 * Returns null for a value that is present but not a provider we can call —
 * distinct from absent, because storing a key we can never send anywhere is
 * worse than refusing it.
 */
function resolveTargetProvider(value: unknown): ProviderId | null {
  if (value === undefined || value === null || value === '') return 'groq';
  return findProvider(value)?.id ?? null;
}

// -----------------------------------------------------------------------------
// POST — validate, encrypt and store a key for one provider (Req 1.*).
// -----------------------------------------------------------------------------
export async function POST(request: Request) {
  const sb = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return jsonError(401, 'not_authenticated'); // Req 2.7

  // 1. Parse + trim-validate input BEFORE any upstream call or DB write (Req 1.2).
  const body = (await request.json().catch(() => null)) as
    | { api_key?: unknown; provider?: unknown }
    | null;

  const provider = resolveTargetProvider(body?.provider);
  if (provider === null) {
    return jsonError(
      400,
      'unknown_provider',
      'We cannot use keys from that provider yet.'
    );
  }

  const raw = typeof body?.api_key === 'string' ? body.api_key : '';
  const apiKey = raw.trim();
  if (apiKey.length === 0 || apiKey.length > MAX_KEY_LENGTH) {
    // Empty, whitespace-only, or over-length: reject WITHOUT validating and
    // WITHOUT writing anything to the vault (Req 1.2).
    return jsonError(400, 'invalid_groq_key');
  }

  // 2. Per-user rate limit (design §3.3 step 3).
  const rl = await rateLimitKeySubmitByUser(user.id);
  if (!rl.ok) return jsonError(429, 'rate_limited');

  // 3. Shape hint — recorded, NOT enforced.
  //
  // An earlier draft rejected a prefix mismatch outright. That was wrong: the
  // live probe below already catches a key pasted under the wrong provider (it
  // comes back 401), so the prefix adds no security — while a hard rule would
  // reject VALID keys the moment a provider changes its format, which they do
  // (OpenAI added `sk-proj-` alongside `sk-`). Locking users out of a working key
  // to improve an error message is the wrong trade.
  //
  // So it is kept only to explain a failure that has already happened.
  const prefixLooksWrong = !keyPrefixLooksRight(provider, apiKey);

  // 4. Validate against the provider (Req 1.3) — 10s timeout inside the client.
  const validation = await validateProviderKey(provider, apiKey);
  if (!validation.ok) {
    if (validation.reason === 'invalid_key') {
      // Req 1.4. When the shape also looks wrong, say the more useful thing:
      // "you picked the wrong provider" rather than "your key is bad", which
      // would send them off to regenerate a key that was fine all along.
      return jsonError(
        400,
        'invalid_groq_key',
        prefixLooksWrong
          ? `That does not look like a ${provider} key — check you picked the right provider.`
          : undefined
      );
    }
    return jsonError(503, 'validation_unavailable'); // Req 1.5
  }

  // 5. Encrypt (Req 1.6, 1.7) and upsert on (user_id, provider), replacing any
  //    existing key for THAT provider only (Req 1.8, 1.11). Only
  //    ciphertext/nonce/tag/version/last_four are stored — never plaintext
  //    (Req 1.9).
  const env = encrypt(apiKey);
  const last_four = lastFour(apiKey);

  const admin = supabaseAdmin();
  const { error } = await admin.from(TABLE).upsert(
    {
      user_id: user.id,
      provider,
      key_ciphertext: env.ciphertext,
      key_nonce: env.iv,
      key_auth_tag: env.authTag,
      key_version: env.version,
      last_four,
    },
    // Must match the composite primary key from migration 016. Conflicting on
    // `user_id` alone would make a second provider's key REPLACE the first
    // instead of sitting alongside it.
    { onConflict: 'user_id,provider' }
  );

  if (error) {
    logSafe('keys_post_store_failed', {
      user_id: user.id,
      provider,
      error: error.message,
    });
    return jsonError(500, 'internal_error');
  }

  logSafe('keys_post_stored', { user_id: user.id, provider, last_four });
  // 6. Success — return only the provider and last_four (Req 1.12).
  return NextResponse.json({ ok: true, provider, last_four });
}

// -----------------------------------------------------------------------------
// PATCH — nominate which key is the default.
// -----------------------------------------------------------------------------
//
// Only consulted when a request names a model we cannot attribute to a specific
// provider AND the user holds more than one usable key. See
// src/lib/ai/model-routing.ts.
export async function PATCH(request: Request) {
  const sb = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return jsonError(401, 'not_authenticated');

  const body = (await request.json().catch(() => null)) as
    | { provider?: unknown }
    | null;

  const provider = findProvider(body?.provider)?.id;
  if (!provider) {
    return jsonError(
      400,
      'unknown_provider',
      'Choose one of the providers you have saved a key for.'
    );
  }

  const admin = supabaseAdmin();

  // Only a provider the user actually holds may be nominated: a preference for a
  // key that does not exist would be silently ignored at request time, which
  // looks like the setting not working.
  const { data: existing, error: lookupError } = await admin
    .from(TABLE)
    .select('provider')
    .eq('user_id', user.id)
    .eq('provider', provider)
    .maybeSingle();

  if (lookupError) {
    logSafe('keys_patch_lookup_failed', {
      user_id: user.id,
      provider,
      error: lookupError.message,
    });
    return jsonError(500, 'internal_error');
  }
  if (!existing) {
    return jsonError(
      400,
      'unknown_provider',
      `You have not saved a ${provider} key.`
    );
  }

  const ok = await setPreferredProvider(admin, user.id, provider);
  if (!ok) return jsonError(500, 'internal_error');

  return NextResponse.json({ ok: true, preferred: provider });
}

// -----------------------------------------------------------------------------
// DELETE — remove one provider's key (Req 2.4–2.6, 2.8).
// -----------------------------------------------------------------------------
//
// The provider may come from `?provider=` or a JSON body, and defaults to Groq so
// the previous bodyless contract keeps working unchanged.
export async function DELETE(request: Request) {
  const sb = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return jsonError(401, 'not_authenticated'); // Req 2.7

  const fromQuery = new URL(request.url).searchParams.get('provider');
  const body = (await request.json().catch(() => null)) as
    | { provider?: unknown }
    | null;

  const provider = resolveTargetProvider(fromQuery ?? body?.provider);
  if (provider === null) {
    return jsonError(400, 'unknown_provider');
  }

  const admin = supabaseAdmin();
  const { error } = await admin
    .from(TABLE)
    .delete()
    .eq('user_id', user.id)
    // Scoped to one provider. Without this filter, removing one key would wipe
    // every key the user had.
    .eq('provider', provider);

  if (error) {
    // Deletion failed — leave the existing row unchanged (Req 2.8).
    logSafe('keys_delete_failed', {
      user_id: user.id,
      provider,
      error: error.message,
    });
    return jsonError(500, 'removal_failed');
  }

  // Success whether or not a row existed (Req 2.4–2.6).
  logSafe('keys_deleted', { user_id: user.id, provider });
  return NextResponse.json({ ok: true, provider, has_key: false });
}

// -----------------------------------------------------------------------------
// GET — saved keys, for rendering /account (Req 2.1, 2.3).
// -----------------------------------------------------------------------------
//
// Selects ONLY provider, last_four and is_preferred; never reads or returns
// ciphertext/nonce/tag (Req 2.2).
export async function GET() {
  const sb = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return jsonError(401, 'not_authenticated'); // Req 2.7

  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from(TABLE)
    .select('provider, last_four, is_preferred')
    .eq('user_id', user.id);

  if (error) {
    logSafe('keys_get_failed', { user_id: user.id, error: error.message });
    return jsonError(500, 'internal_error');
  }

  const rows = Array.isArray(data) ? data : [];
  const keys = rows.map((row) => {
    const r = row as {
      provider?: unknown;
      last_four?: unknown;
      is_preferred?: unknown;
    };
    return {
      provider: typeof r.provider === 'string' ? r.provider : null,
      last_four: typeof r.last_four === 'string' ? r.last_four : null,
      is_preferred: r.is_preferred === true,
    };
  });

  return NextResponse.json({
    has_key: keys.length > 0,
    keys,
    // Retained so the pre-multi-provider account UI keeps rendering while it is
    // updated. It reports the Groq key when there is one, because that is what
    // this field has always meant.
    last_four: keys.find((k) => k.provider === 'groq')?.last_four ?? null,
  });
}
