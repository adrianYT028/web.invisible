import { NextResponse } from 'next/server';

import { createSupabaseRouteClient } from '@/lib/supabase/route';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { jsonError, logSafe } from '@/lib/http';
import { rateLimitKeySubmitByUser } from '@/lib/ratelimit';
import { validateGroqKey } from '@/lib/groq/client';
import { encrypt, lastFour } from '@/lib/crypto/key-vault';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// /api/keys — per-user Groq key management for the website /account page.
//
// Cookie/session authenticated via createSupabaseRouteClient() (this is the
// /account surface, NOT the desktop bearer path). The caller's user.id is
// resolved from the Supabase session and every read/write is additionally
// filtered by `user_id = user.id` (defense in depth alongside RLS).
//
//   POST   add or replace the caller's Groq key   -> 200 { ok: true, last_four }
//   DELETE remove the caller's key                -> 200 { ok: true, has_key: false }
//   GET    key status for rendering /account       -> 200 { has_key, last_four }
//
// The plaintext Groq_Key, Key_Ciphertext, Key_Nonce, and Key_Auth_Tag are
// NEVER returned to any client and NEVER logged (Req 2.2, 10.1).
// -----------------------------------------------------------------------------

const MAX_KEY_LENGTH = 512;
const TABLE = 'user_api_keys';

// -----------------------------------------------------------------------------
// POST — submit and store an encrypted Groq key (Req 1.*).
// -----------------------------------------------------------------------------
export async function POST(request: Request) {
  const sb = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return jsonError(401, 'not_authenticated'); // Req 2.7

  // 1. Parse + trim-validate input BEFORE any Groq call or DB write (Req 1.2).
  const body = (await request.json().catch(() => null)) as
    | { api_key?: unknown }
    | null;
  const raw = typeof body?.api_key === 'string' ? body.api_key : '';
  const apiKey = raw.trim();
  if (apiKey.length === 0 || apiKey.length > MAX_KEY_LENGTH) {
    // Empty, whitespace-only, or over-length: reject WITHOUT validating and
    // WITHOUT writing anything to the Key_Vault (Req 1.2).
    return jsonError(400, 'invalid_groq_key');
  }

  // 2. Per-user rate limit (design §3.3 step 3).
  const rl = await rateLimitKeySubmitByUser(user.id);
  if (!rl.ok) return jsonError(429, 'rate_limited');

  // 3. Validate against Groq (Req 1.3) — 10s timeout enforced inside the client.
  const validation = await validateGroqKey(apiKey);
  if (!validation.ok) {
    if (validation.reason === 'invalid_key') {
      return jsonError(400, 'invalid_groq_key'); // Req 1.4
    }
    return jsonError(503, 'validation_unavailable'); // Req 1.5
  }

  // 4. Encrypt (Req 1.6, 1.7) and upsert on user_id, replacing any existing
  //    row (Req 1.8, 1.11). Only ciphertext/nonce/tag/version/last_four are
  //    stored — never the plaintext (Req 1.9).
  const env = encrypt(apiKey);
  const last_four = lastFour(apiKey);

  const admin = supabaseAdmin();
  const { error } = await admin.from(TABLE).upsert(
    {
      user_id: user.id,
      key_ciphertext: env.ciphertext,
      key_nonce: env.iv,
      key_auth_tag: env.authTag,
      key_version: env.version,
      last_four,
    },
    { onConflict: 'user_id' }
  );

  if (error) {
    logSafe('keys_post_store_failed', { user_id: user.id, error: error.message });
    return jsonError(500, 'internal_error');
  }

  logSafe('keys_post_stored', { user_id: user.id, last_four });
  // 5. Success — return only last_four (Req 1.12). Never return key material.
  return NextResponse.json({ ok: true, last_four });
}

// -----------------------------------------------------------------------------
// DELETE — remove the caller's key (Req 2.4–2.6, 2.8).
// -----------------------------------------------------------------------------
export async function DELETE() {
  const sb = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return jsonError(401, 'not_authenticated'); // Req 2.7

  const admin = supabaseAdmin();
  const { error } = await admin.from(TABLE).delete().eq('user_id', user.id);

  if (error) {
    // Deletion failed — leave the existing row unchanged (Req 2.8).
    logSafe('keys_delete_failed', { user_id: user.id, error: error.message });
    return jsonError(500, 'removal_failed');
  }

  // Success whether or not a row existed (Req 2.4–2.6).
  logSafe('keys_deleted', { user_id: user.id });
  return NextResponse.json({ ok: true, has_key: false });
}

// -----------------------------------------------------------------------------
// GET — key status for rendering /account (Req 2.1, 2.3). Selects ONLY
// last_four; never reads or returns ciphertext/nonce/tag (Req 2.2).
// -----------------------------------------------------------------------------
export async function GET() {
  const sb = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return jsonError(401, 'not_authenticated'); // Req 2.7

  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from(TABLE)
    .select('last_four')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) {
    logSafe('keys_get_failed', { user_id: user.id, error: error.message });
    return jsonError(500, 'internal_error');
  }

  const last_four = data?.last_four ?? null;
  return NextResponse.json({ has_key: last_four !== null, last_four });
}
