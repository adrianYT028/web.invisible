import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/supabase/admin';
import { jsonError, logSafe } from '@/lib/http';
import { isRazorpayWebhookConfigured } from '@/lib/env';
import {
  parseWebhookBody,
  verifyWebhookSignature,
  type WebhookPaymentEntity,
} from '@/lib/payments/razorpay';
import {
  DOWNLOAD_LICENSE_PRODUCT,
  derivePriceFromTotal,
} from '@/lib/payments/pricing';
import {
  grantDownloadAccess,
  revokeDownloadAccess,
} from '@/lib/payments/entitlements';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// POST /api/payments/razorpay/webhook — the AUTHORITY on entitlement.
//
// This route, not the browser, decides who owns the download. The client-side
// /verify route exists only to make the UI feel instant; a user who pays and
// immediately closes the tab must still receive access, and only a
// server-to-server webhook guarantees that.
//
// UNAUTHENTICATED BY DESIGN. Razorpay sends no cookie and no bearer token. The
// signature IS the authentication. `proxy.ts` lets all /api/* through to the
// handler, so this file is solely responsible for rejecting forged calls.
//
// ===== THE RAW BODY RULE =====
// The signature is an HMAC over the EXACT BYTES Razorpay sent. We must read
// `await request.text()` and verify that string. Calling `request.json()` first
// and re-serialising changes key order and whitespace, producing a different
// digest and rejecting every legitimate webhook. If deliveries ever start
// failing wholesale, this is the first thing to check.
//
// ===== STATUS CODE CONTRACT =====
// Razorpay retries non-2xx deliveries with backoff. So:
//   200 - processed, OR permanently un-processable (malformed, unknown event,
//         unidentifiable buyer). Retrying those forever helps nobody.
//   400 - bad signature. Never retried, and shouldn't be.
//   500 - OUR failure (database down). We WANT the retry.
// Returning 200 on a transient database error would silently lose a paid
// customer's entitlement, so the DB failure paths below deliberately 500.
// -----------------------------------------------------------------------------

const PAYMENTS_TABLE = 'payments';

interface PaymentRow {
  id: string;
  user_id: string;
  status: string;
  total_amount_paise: number;
  gst_bps: number;
}

async function findPaymentByOrderId(orderId: string): Promise<PaymentRow | null> {
  const { data, error } = await supabaseAdmin()
    .from(PAYMENTS_TABLE)
    .select('id, user_id, status, total_amount_paise, gst_bps')
    .eq('razorpay_order_id', orderId)
    .maybeSingle();

  if (error) {
    logSafe('webhook_payment_lookup_failed', {
      order_id: orderId,
      error: error.message,
    });
    throw new Error('payment_lookup_failed');
  }
  return (data as PaymentRow | null) ?? null;
}

/**
 * Grant the license for a captured payment.
 *
 * Idempotent at three layers: the UPDATE writes the same values on redelivery,
 * `grantDownloadAccess` upserts on the user_id primary key, and the partial
 * unique index on `razorpay_payment_id` makes a duplicate row impossible.
 */
async function handlePaymentCaptured(
  payment: WebhookPaymentEntity
): Promise<{ status: number; body: Record<string, unknown> }> {
  const admin = supabaseAdmin();
  const nowIso = new Date().toISOString();

  if (!payment.orderId) {
    // Captured payment with no order reference. Nothing to reconcile against
    // and no way to identify the buyer beyond notes; log and stop retrying.
    logSafe('webhook_captured_without_order', { payment_id: payment.id });
    return { status: 200, body: { ok: true, ignored: 'missing_order_id' } };
  }

  const row = await findPaymentByOrderId(payment.orderId);
  const notesUserId = payment.notes?.user_id ?? null;
  const userId = row?.user_id ?? notesUserId;

  if (!userId) {
    // Neither our ledger nor the order notes identify a buyer. This should be
    // unreachable; it means the order was created outside this codebase.
    logSafe('webhook_captured_unidentifiable_buyer', {
      payment_id: payment.id,
      order_id: payment.orderId,
    });
    return { status: 200, body: { ok: true, ignored: 'unknown_buyer' } };
  }

  // Amount check. Razorpay ties a payment to its order's amount, so a mismatch
  // means either a partial capture or tampering. Refuse to grant and flag for
  // manual review rather than handing out a license for an unknown sum.
  if (
    row &&
    payment.amountPaise !== null &&
    payment.amountPaise !== row.total_amount_paise
  ) {
    logSafe('webhook_amount_mismatch', {
      payment_id: payment.id,
      order_id: payment.orderId,
      user_id: userId,
      expected_paise: row.total_amount_paise,
      received_paise: payment.amountPaise,
    });
    return { status: 200, body: { ok: true, ignored: 'amount_mismatch' } };
  }

  if (row) {
    const { error } = await admin
      .from(PAYMENTS_TABLE)
      .update({
        status: 'paid',
        razorpay_payment_id: payment.id,
        paid_at: nowIso,
        failure_reason: null,
      })
      .eq('id', row.id);

    if (error) {
      logSafe('webhook_mark_paid_failed', {
        payment_id: payment.id,
        order_id: payment.orderId,
        user_id: userId,
        error: error.message,
      });
      // Our failure — ask Razorpay to retry.
      return { status: 500, body: { code: 'internal_error' } };
    }
  } else {
    // RECOVERY PATH: Razorpay created the order but our insert failed, so the
    // customer paid against an order we never recorded. They are still owed the
    // license. Reconstruct an auditable row from the captured total — the
    // derived split satisfies `total = base + gst` by construction.
    const total = payment.amountPaise;
    if (total === null) {
      logSafe('webhook_recovery_missing_amount', {
        payment_id: payment.id,
        order_id: payment.orderId,
        user_id: userId,
      });
      return { status: 200, body: { ok: true, ignored: 'missing_amount' } };
    }

    const price = derivePriceFromTotal(total);
    const { error } = await admin.from(PAYMENTS_TABLE).insert({
      user_id: userId,
      provider: 'razorpay',
      product: DOWNLOAD_LICENSE_PRODUCT,
      razorpay_order_id: payment.orderId,
      razorpay_payment_id: payment.id,
      base_amount_paise: price.baseAmountPaise,
      gst_bps: price.gstBps,
      gst_amount_paise: price.gstAmountPaise,
      total_amount_paise: price.totalAmountPaise,
      currency: 'INR',
      status: 'paid',
      paid_at: nowIso,
      notes: { recovered_by_webhook: 'true', user_id: userId },
    });

    // A unique-violation here means a concurrent delivery already inserted it,
    // which is success, not failure.
    if (error && !/duplicate key|unique constraint/i.test(error.message)) {
      logSafe('webhook_recovery_insert_failed', {
        payment_id: payment.id,
        order_id: payment.orderId,
        user_id: userId,
        error: error.message,
      });
      return { status: 500, body: { code: 'internal_error' } };
    }

    logSafe('webhook_recovered_orphan_payment', {
      payment_id: payment.id,
      order_id: payment.orderId,
      user_id: userId,
      total_amount_paise: total,
    });
  }

  const granted = await grantDownloadAccess(userId, row?.id ?? null);
  if (!granted) {
    // The payment is recorded but the entitlement write failed. Retry: the
    // customer has paid and currently cannot download.
    return { status: 500, body: { code: 'internal_error' } };
  }

  logSafe('webhook_payment_captured', {
    payment_id: payment.id,
    order_id: payment.orderId,
    user_id: userId,
  });
  return { status: 200, body: { ok: true, granted: true } };
}

async function handlePaymentFailed(
  payment: WebhookPaymentEntity
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!payment.orderId) {
    return { status: 200, body: { ok: true, ignored: 'missing_order_id' } };
  }

  // Only move `created` -> `failed`. A paid row must never be downgraded by a
  // late-arriving failure for an earlier attempt on the same order.
  const { error } = await supabaseAdmin()
    .from(PAYMENTS_TABLE)
    .update({
      status: 'failed',
      failed_at: new Date().toISOString(),
      failure_reason: payment.errorDescription?.slice(0, 500) ?? 'unknown',
    })
    .eq('razorpay_order_id', payment.orderId)
    .eq('status', 'created');

  if (error) {
    logSafe('webhook_mark_failed_failed', {
      payment_id: payment.id,
      order_id: payment.orderId,
      error: error.message,
    });
    return { status: 500, body: { code: 'internal_error' } };
  }

  logSafe('webhook_payment_failed', {
    payment_id: payment.id,
    order_id: payment.orderId,
  });
  return { status: 200, body: { ok: true } };
}

async function handleRefundProcessed(
  payment: WebhookPaymentEntity
): Promise<{ status: number; body: Record<string, unknown> }> {
  const admin = supabaseAdmin();

  // Refunds identify the payment, not the order.
  const { data, error: lookupError } = await admin
    .from(PAYMENTS_TABLE)
    .select('id, user_id')
    .eq('razorpay_payment_id', payment.id)
    .maybeSingle();

  if (lookupError) {
    logSafe('webhook_refund_lookup_failed', {
      payment_id: payment.id,
      error: lookupError.message,
    });
    return { status: 500, body: { code: 'internal_error' } };
  }
  if (!data) {
    logSafe('webhook_refund_unknown_payment', { payment_id: payment.id });
    return { status: 200, body: { ok: true, ignored: 'unknown_payment' } };
  }

  const { error: updateError } = await admin
    .from(PAYMENTS_TABLE)
    .update({ status: 'refunded', refunded_at: new Date().toISOString() })
    .eq('id', data.id);

  if (updateError) {
    logSafe('webhook_mark_refunded_failed', {
      payment_id: payment.id,
      user_id: data.user_id,
      error: updateError.message,
    });
    return { status: 500, body: { code: 'internal_error' } };
  }

  // Money returned, so access goes away. Re-purchasing clears `revoked_at`.
  const revoked = await revokeDownloadAccess(
    data.user_id as string,
    `refund:${payment.id}`
  );
  if (!revoked) {
    return { status: 500, body: { code: 'internal_error' } };
  }

  logSafe('webhook_refund_processed', {
    payment_id: payment.id,
    user_id: data.user_id,
  });
  return { status: 200, body: { ok: true, revoked: true } };
}

export async function POST(request: Request) {
  if (!isRazorpayWebhookConfigured()) {
    // Misconfiguration, not a client error. 500 so Razorpay retries after the
    // secret is set rather than dropping a real payment on the floor.
    logSafe('webhook_secret_not_configured', {});
    return jsonError(500, 'payment_not_configured');
  }

  // MUST be the raw body. See the header note.
  const rawBody = await request.text();
  const signature = request.headers.get('x-razorpay-signature');

  if (!verifyWebhookSignature(rawBody, signature)) {
    logSafe('webhook_signature_invalid', {
      has_signature_header: signature !== null,
      body_bytes: rawBody.length,
    });
    return jsonError(400, 'invalid_signature');
  }

  const parsed = parseWebhookBody(rawBody);
  if (!parsed) {
    logSafe('webhook_body_unparseable', { body_bytes: rawBody.length });
    // Signed but unreadable: retrying cannot help.
    return jsonError(400, 'invalid_input');
  }

  try {
    if (!parsed.payment) {
      logSafe('webhook_event_without_payment', { razorpay_event: parsed.event });
      return NextResponse.json({ ok: true, ignored: 'no_payment_entity' });
    }

    let result: { status: number; body: Record<string, unknown> };
    switch (parsed.event) {
      case 'payment.captured':
        result = await handlePaymentCaptured(parsed.payment);
        break;
      case 'payment.failed':
        result = await handlePaymentFailed(parsed.payment);
        break;
      case 'refund.processed':
        result = await handleRefundProcessed(parsed.payment);
        break;
      default:
        // Subscribed to an event we don't act on. Acknowledge so Razorpay
        // stops retrying.
        logSafe('webhook_event_ignored', { razorpay_event: parsed.event });
        result = { status: 200, body: { ok: true, ignored: parsed.event } };
    }

    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    logSafe('webhook_handler_threw', {
      razorpay_event: parsed.event,
      error: err instanceof Error ? err.message : 'unknown',
    });
    // Unknown failure on our side — let Razorpay retry.
    return jsonError(500, 'internal_error');
  }
}
