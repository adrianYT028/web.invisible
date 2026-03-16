import { NextResponse } from 'next/server';

import { createSupabaseRouteClient } from '@/lib/supabase/route';

export async function POST() {
  const supabase = await createSupabaseRouteClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const email = (user.email || '').toLowerCase();
  const name =
    (user.user_metadata?.full_name || user.user_metadata?.name || email || 'User')
      .toString()
      .split('@')[0];

  if (!email) {
    return NextResponse.json({ error: 'Missing email' }, { status: 400 });
  }

  const { error } = await supabase
    .from('signups')
    .upsert(
      {
        name: name || 'User',
        email,
        user_id: user.id,
      },
      { onConflict: 'email' }
    );

  if (error) {
    // Non-critical: log server-side but don't return 400 to avoid console noise
    console.warn('[signups/ensure] upsert error:', error.message);
    return NextResponse.json({ ok: false, detail: error.message });
  }

  return NextResponse.json({ ok: true });
}
