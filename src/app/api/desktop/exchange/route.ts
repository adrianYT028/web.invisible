import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  isValidDeviceCode,
  issueAccessToken,
  newRefreshToken,
  sha256Hex,
  TTL,
} from '@/lib/auth/desktop-tokens';
import { jsonError } from '@/lib/http';
import { getRequestIp, rateLimitExchangeByIp } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// POST /api/desktop/exchange
//
// Open desktop route (no Bearer required — the desktop has no token yet).
// Rate-limited 10/min per source IP.
//
// Atomically consumes a single-use device_code and issues a refresh + access
// token bound to (user_id, device_id).
//
// Request:  { device_code: string }
// Response: 200 { refresh_token, access_token, access_token_expires_in,
//                 user_email, plan }
// Errors:   400 invalid_input | code_already_consumed | code_expired | unknown_code
//           429 rate_limited
//           500 internal_error
// -----------------------------------------------------------------------------

interface ExchangeBody {
  device_code?: unknown;
}

export async function POST(req: Request) {
  // Rate limit by source IP first.
  const ip = getRequestIp(req);
  const rl = await rateLimitExchangeByIp(ip);
  if (!rl.ok) {
    return jsonError(429, 'rate_limited', `Try again in ${rl.resetSec}s.`);
  }

  let body: ExchangeBody;
  try {
    body = (await req.json()) as ExchangeBody;
  } catch {
    return jsonError(400, 'invalid_input', 'Body is not valid JSON.');
  }
  if (!isValidDeviceCode(body.device_code)) {
    return jsonError(400, 'invalid_input', 'device_code is malformed.');
  }

  const codeHash = sha256Hex(body.device_code);
  const admin = supabaseAdmin();

  // Atomic single-use: only consume rows that are still pending and not expired.
  const { data: consumedRows, error: updateErr } = await admin
    .from('desktop_link_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('device_code_hash', codeHash)
    .is('consumed_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('user_id, device_id');

  if (updateErr) {
    return jsonError(500, 'internal_error', updateErr.message);
  }

  if (!consumedRows || consumedRows.length === 0) {
    // Disambiguate: was it already-consumed, expired, or unknown?
    const { data: probe } = await admin
      .from('desktop_link_codes')
      .select('consumed_at, expires_at')
      .eq('device_code_hash', codeHash)
      .maybeSingle();
    if (!probe) return jsonError(400, 'unknown_code');
    if (probe.consumed_at) return jsonError(400, 'code_already_consumed');
    return jsonError(400, 'code_expired');
  }

  const { user_id, device_id } = consumedRows[0];

  // Issue refresh + access tokens.
  const refreshToken = newRefreshToken();
  const refreshHash = sha256Hex(refreshToken);
  const refreshExpires = new Date(
    Date.now() + TTL.REFRESH_TTL_SEC * 1000
  ).toISOString();

  const userAgent = req.headers.get('user-agent') ?? '';

  const { error: sessionErr } = await admin.from('desktop_sessions').insert({
    user_id,
    device_id,
    refresh_token_hash: refreshHash,
    expires_at: refreshExpires,
    ip_at_issue: ip,
    user_agent: userAgent.slice(0, 500),
  });
  if (sessionErr) {
    return jsonError(500, 'internal_error', sessionErr.message);
  }

  // Upsert the device row so /account can show "Your devices" later.
  await admin.from('devices').upsert(
    {
      user_id,
      device_id,
      os: 'windows',
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,device_id', ignoreDuplicates: false }
  );

  // Look up email + plan for the response so the desktop can render the
  // signed-in panel without an extra round-trip.
  const [{ data: profile }, { data: authUser }] = await Promise.all([
    admin.from('profiles').select('plan').eq('id', user_id).maybeSingle(),
    admin.auth.admin.getUserById(user_id),
  ]);

  const accessToken = await issueAccessToken(user_id, device_id);

  return NextResponse.json({
    refresh_token: refreshToken,
    access_token: accessToken,
    access_token_expires_in: TTL.ACCESS_TTL_SEC,
    user_email: authUser?.user?.email ?? '',
    plan: profile?.plan ?? 'free',
  });
}
