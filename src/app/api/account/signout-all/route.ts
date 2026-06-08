import { NextResponse } from 'next/server';

import { createSupabaseRouteClient } from '@/lib/supabase/route';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { jsonError } from '@/lib/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// POST /api/account/signout-all
//
// Cookie-protected. Revokes every active desktop session for the calling
// user. Existing access tokens still work until they expire (max 1h), but
// the next refresh attempt will return session_revoked.
//
// Response: 200 { ok: true, revoked_count: number }
// Errors:   401 not_authenticated
//           500 internal_error
// -----------------------------------------------------------------------------

export async function POST() {
  const sb = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return jsonError(401, 'not_authenticated');

  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from('desktop_sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('user_id', user.id)
    .is('revoked_at', null)
    .select('id');

  if (error) return jsonError(500, 'internal_error', error.message);

  return NextResponse.json({ ok: true, revoked_count: data?.length ?? 0 });
}
