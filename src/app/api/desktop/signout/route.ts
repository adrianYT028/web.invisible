import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/supabase/admin';
import { sha256Hex } from '@/lib/auth/desktop-tokens';
import { jsonError } from '@/lib/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// POST /api/desktop/signout
//
// Open desktop route. Idempotent: always returns 200, even for tokens that
// don't match anything or are already revoked. The desktop locally clears
// state regardless of the response.
//
// Request:  { refresh_token: string }
// Response: 200 { ok: true }
// Errors:   400 invalid_input
// -----------------------------------------------------------------------------

interface SignoutBody {
  refresh_token?: unknown;
}

export async function POST(req: Request) {
  let body: SignoutBody;
  try {
    body = (await req.json()) as SignoutBody;
  } catch {
    return jsonError(400, 'invalid_input', 'Body is not valid JSON.');
  }
  if (typeof body.refresh_token !== 'string' || body.refresh_token.length === 0) {
    return jsonError(400, 'invalid_input', 'refresh_token is required.');
  }

  const refreshHash = sha256Hex(body.refresh_token);
  const admin = supabaseAdmin();

  await admin
    .from('desktop_sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('refresh_token_hash', refreshHash)
    .is('revoked_at', null);

  // Always 200 — never reveal whether the token matched a row.
  return NextResponse.json({ ok: true });
}
