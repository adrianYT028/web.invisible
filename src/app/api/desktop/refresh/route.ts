import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  issueAccessToken,
  sha256Hex,
  TTL,
} from '@/lib/auth/desktop-tokens';
import { jsonError } from '@/lib/http';
import { rateLimitRefreshByHash } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// POST /api/desktop/refresh
//
// Open desktop route. Rate-limited 60/min per refresh_token_hash so an
// attacker who steals one token cannot brute force adjacent tokens through
// this endpoint.
//
// Request:  { refresh_token: string }
// Response: 200 { access_token, access_token_expires_in, plan }
// Errors:   400 invalid_input
//           401 invalid_refresh_token | session_revoked | expired_refresh_token
//           429 rate_limited
//           500 internal_error
// -----------------------------------------------------------------------------

interface RefreshBody {
  refresh_token?: unknown;
}

export async function POST(req: Request) {
  let body: RefreshBody;
  try {
    body = (await req.json()) as RefreshBody;
  } catch {
    return jsonError(400, 'invalid_input', 'Body is not valid JSON.');
  }
  if (typeof body.refresh_token !== 'string' || body.refresh_token.length === 0) {
    return jsonError(400, 'invalid_input', 'refresh_token is required.');
  }

  const refreshHash = sha256Hex(body.refresh_token);

  // Rate limit per token hash (binds bursts to one specific refresh value).
  const rl = await rateLimitRefreshByHash(refreshHash);
  if (!rl.ok) {
    return jsonError(429, 'rate_limited', `Try again in ${rl.resetSec}s.`);
  }

  const admin = supabaseAdmin();
  const { data: row, error } = await admin
    .from('desktop_sessions')
    .select('user_id, device_id, revoked_at, expires_at')
    .eq('refresh_token_hash', refreshHash)
    .maybeSingle();

  if (error) return jsonError(500, 'internal_error', error.message);
  if (!row) return jsonError(401, 'invalid_refresh_token');
  if (row.revoked_at) return jsonError(401, 'session_revoked');
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return jsonError(401, 'expired_refresh_token');
  }

  // Update last_used_at without rotating the refresh token (rotation would
  // require the desktop to write a new session.dat on every refresh, which
  // doubles disk I/O; we accept the longer-lived hash).
  await admin
    .from('desktop_sessions')
    .update({ last_used_at: new Date().toISOString() })
    .eq('refresh_token_hash', refreshHash);

  const accessToken = await issueAccessToken(row.user_id, row.device_id);
  const { data: profile } = await admin
    .from('profiles')
    .select('plan')
    .eq('id', row.user_id)
    .maybeSingle();

  return NextResponse.json({
    access_token: accessToken,
    access_token_expires_in: TTL.ACCESS_TTL_SEC,
    plan: profile?.plan ?? 'free',
  });
}
