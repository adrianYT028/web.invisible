import { NextResponse } from 'next/server';

import { createSupabaseRouteClient } from '@/lib/supabase/route';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const supabase = await createSupabaseRouteClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as
    | { rating?: unknown; review?: unknown }
    | null;

  const rating = Number(body?.rating);
  const review = typeof body?.review === 'string' ? body?.review.trim() : '';

  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    return NextResponse.json({ error: 'Invalid rating' }, { status: 400 });
  }

  if (review.length < 7) {
    return NextResponse.json({ error: 'Review too short' }, { status: 400 });
  }

  const email = (user.email || '').toLowerCase();
  if (!email) {
    return NextResponse.json({ error: 'Missing email' }, { status: 400 });
  }

  const { error } = await supabase.from('reviews').insert({
    email,
    user_id: user.id,
    rating,
    review,
    source: 'review',
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
