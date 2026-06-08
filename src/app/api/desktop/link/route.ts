import { NextResponse } from 'next/server';

import { createSupabaseRouteClient } from '@/lib/supabase/route';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  isValidDeviceCode,
  isValidUuid,
  sha256Hex,
} from '@/lib/auth/desktop-tokens';
import { jsonError } from '@/lib/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// POST /api/desktop/link
//
// Cookie-protected. Called server-side from /auth/desktop after the user
// completes Supabase sign-in. Records a hashed device_code so the desktop
// can later redeem it via /api/desktop/exchange.
//
// Request:  { device_code: string (43-char base64url),
//             device_id:   string (UUIDv4) }
// Response: 200 { ok: true }
// Errors:   400 invalid_input
//           401 not_authenticated
// -----------------------------------------------------------------------------

interface LinkBody {
  device_code?: unknown;
  device_id?: unknown;
}

export async function POST(req: Request) {
  let body: LinkBody;
  try {
    body = (await req.json()) as LinkBody;
  } catch {
    return jsonError(400, 'invalid_input', 'Body is not valid JSON.');
  }

  if (!isValidDeviceCode(body.device_code)) {
    return jsonError(400, 'invalid_input', 'device_code is malformed.');
  }
  if (!isValidUuid(body.device_id)) {
    return jsonError(400, 'invalid_input', 'device_id is malformed.');
  }

  const sb = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) {
    return jsonError(401, 'not_authenticated');
  }

  const admin = supabaseAdmin();
  const codeHash = sha256Hex(body.device_code);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const { error } = await admin.from('desktop_link_codes').insert({
    user_id: user.id,
    device_code_hash: codeHash,
    device_id: body.device_id,
    expires_at: expiresAt,
  });

  if (error) {
    return jsonError(500, 'internal_error', error.message);
  }

  return NextResponse.json({ ok: true });
}
