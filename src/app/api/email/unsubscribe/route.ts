import { NextResponse } from 'next/server';

import { verifyUnsubscribe } from '@/lib/email/unsubscribe';
import { logSafe } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// /api/email/unsubscribe?u=<user>&s=<scope>&t=<signature>
//
//   GET   a person clicking the link in an email -> unsubscribe, then show /unsubscribed
//   POST  Gmail/Yahoo "one-click" unsubscribe (RFC 8058) -> unsubscribe, 200
//
// No sign-in: one-click unsubscribe must work from the inbox. The HMAC in the
// link is what stops anyone unsubscribing someone else.
// -----------------------------------------------------------------------------

async function apply(params: URLSearchParams): Promise<boolean> {
  const verified = verifyUnsubscribe(params);
  if (!verified) return false;
  const { userId, scope } = verified;

  const row: Record<string, unknown> = { user_id: userId, updated_at: new Date().toISOString() };
  if (scope === 'reminders') row.reminders = false;
  if (scope === 'digest') row.digest = false;
  if (scope === 'all') {
    row.reminders = false;
    row.digest = false;
    row.unsubscribed_at = new Date().toISOString();
  }

  const { error } = await supabaseAdmin().from('email_prefs').upsert(row, { onConflict: 'user_id' });
  if (error) {
    logSafe('email_unsubscribe_failed', { error: error.message });
    return false;
  }
  logSafe('email_unsubscribed', { scope });
  return true;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const ok = await apply(url.searchParams);
  const scope = url.searchParams.get('s') ?? 'all';
  return NextResponse.redirect(
    new URL(`/unsubscribed?${ok ? `done=${encodeURIComponent(scope)}` : 'error=1'}`, url.origin),
    303
  );
}

export async function POST(request: Request) {
  const ok = await apply(new URL(request.url).searchParams);
  return NextResponse.json({ ok }, { status: ok ? 200 : 400 });
}
