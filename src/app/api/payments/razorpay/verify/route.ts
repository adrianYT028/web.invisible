import { NextResponse } from 'next/server';

import { createSupabaseRouteClient } from '@/lib/supabase/route';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { jsonError, logSafe } from '@/lib/http';
import { isRazorpayConfigured } from '@/lib/env';
import { verifyCheckoutSignature } from '@/lib/payments/razorpay';
import { grantDownloadAccess } from '@/lib/payments/entitlements';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// POST /api/payments/razorpay/verify — optimistic, client-driven confirmation.
//
// Razorpay Checkout hands the browser back {order_id, payment_id, signature} on
// success. This route verifies that triple and grants immediately so the user
// sees their download button without waiting on webhook delivery.
//
// THIS IS NOT THE AUTHORITY. The webhook is. A client can always fail to call
// back (closed tab, dead network, blocked JS), so entitlement cannot depend on
// this route existing. Both paths call the same idempotent
// `grantDownloadAccess`, so whichever arrives first wins and the second is a
// no-op.
//
// ===== WHY THE OWNERSHIP CHECK MATTERS =====
// A valid checkout signature proves *a* payment was made against *an* order. It
// says nothing about WHO is currently logged in. Without verifying that the
// order belongs to the authenticated user, anyone who obtained a valid triple
// (a shared screen, a screenshot, a copied network log) could replay it to
// license their own account off someone else's payment. So we require
// `payments.user_id === session user id` and 404 otherwise.
//
// Signed with KEY_SECRET, not WEBHOOK_SECRET.
// -----------------------------------------------------------------------------

const PAYMENTS_TABLE = 'payments';

/** Razorpay ids are short opaque strings; reject anything oversized outright. */
const MAX_ID_LENGTH = 128;
const MAX_SIGNATURE_LENGTH = 256;

function readString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return null;
  return trimmed;
}

export async function POST(request: Request) {
  const sb = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return jsonError(401, 'not_authenticated');

  if (!isRazorpayConfigured()) {
    return jsonError(503, 'payment_not_configured');
  }

  const body = (await request.json().catch(() => null)) as
    | {
        razorpay_order_id?: unknown;
        razorpay_payment_id?: unknown;
        razorpay_signature?: unknown;
      }
    | null;

  const orderId = readString(body?.razorpay_order_id, MAX_ID_LENGTH);
  const paymentId = readString(body?.razorpay_payment_id, MAX_ID_LENGTH);
  const signature = readString(body?.razorpay_signature, MAX_SIGNATURE_LENGTH);

  if (!orderId || !paymentId || !signature) {
    return jsonError(400, 'invalid_input');
  }

  // Verify BEFORE touching the database, so an unsigned guess costs one HMAC
  // and no queries.
  if (!verifyCheckoutSignature({ orderId, paymentId, signature })) {
    logSafe('verify_signature_invalid', {
      user_id: user.id,
      order_id: orderId,
      payment_id: paymentId,
    });
    return jsonError(400, 'invalid_signature');
  }

  const admin = supabaseAdmin();
  const { data: row, error: lookupError } = await admin
    .from(PAYMENTS_TABLE)
    .select('id, user_id, status, total_amount_paise')
    .eq('razorpay_order_id', orderId)
    .maybeSingle();

  if (lookupError) {
    logSafe('verify_lookup_failed', {
      user_id: user.id,
      order_id: orderId,
      error: lookupError.message,
    });
    return jsonError(500, 'internal_error');
  }

  // Unknown order, or an order belonging to somebody else. Same response for
  // both so this cannot be used to probe which order ids exist.
  if (!row || row.user_id !== user.id) {
    logSafe('verify_order_not_owned', {
      user_id: user.id,
      order_id: orderId,
      row_exists: row !== null,
    });
    return jsonError(404, 'release_not_found', 'No matching order was found.');
  }

  const { error: updateError } = await admin
    .from(PAYMENTS_TABLE)
    .update({
      status: 'paid',
      razorpay_payment_id: paymentId,
      paid_at: new Date().toISOString(),
      failure_reason: null,
    })
    .eq('id', row.id)
    // Don't clobber a row the webhook already finalised, and never resurrect a
    // refunded row into 'paid'.
    .in('status', ['created', 'failed']);

  if (updateError) {
    logSafe('verify_mark_paid_failed', {
      user_id: user.id,
      order_id: orderId,
      error: updateError.message,
    });
    return jsonError(500, 'internal_error');
  }

  const granted = await grantDownloadAccess(user.id, row.id as string);
  if (!granted) {
    // The webhook will retry the grant, so this is recoverable — but tell the
    // client to keep polling rather than claiming success.
    return jsonError(503, 'download_unavailable');
  }

  logSafe('verify_succeeded', {
    user_id: user.id,
    order_id: orderId,
    payment_id: paymentId,
  });

  return NextResponse.json({ ok: true, download_access: true });
}
