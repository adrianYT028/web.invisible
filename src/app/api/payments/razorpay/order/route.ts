import { NextResponse } from 'next/server';

import { createSupabaseRouteClient } from '@/lib/supabase/route';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { jsonError, logSafe } from '@/lib/http';
import { env, isRazorpayConfigured } from '@/lib/env';
import { rateLimitOrderByUser } from '@/lib/ratelimit';
import {
  DOWNLOAD_LICENSE_PRICE,
  DOWNLOAD_LICENSE_PRODUCT,
} from '@/lib/payments/pricing';
import { createRazorpayOrder, RazorpayError } from '@/lib/payments/razorpay';
import { hasDownloadAccess } from '@/lib/payments/entitlements';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// POST /api/payments/razorpay/order — start a purchase.
//
// Cookie/session authenticated (this is a website surface, not a desktop bearer
// path). Creates a Razorpay order and records it as `status = 'created'` BEFORE
// the browser opens Checkout, so the webhook always has a row to reconcile
// against even if the user closes the tab mid-payment.
//
// THE AMOUNT IS NEVER TAKEN FROM THE REQUEST BODY. It is derived server-side
// from DOWNLOAD_LICENSE_PRICE. A client-supplied amount is the classic
// pay-what-you-want vulnerability: the browser would just ask for an order of
// ₹1. This route accepts no body at all.
// -----------------------------------------------------------------------------

/** Reuse an abandoned order for this long before minting a new one. */
const ORDER_REUSE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Razorpay caps `receipt` at 40 characters. `uvw_` + 8 hex of the user id + a
 * base36 timestamp lands around 22, leaving headroom.
 */
function buildReceipt(userId: string): string {
  return `uvw_${userId.replace(/-/g, '').slice(0, 8)}_${Date.now().toString(36)}`;
}

export async function POST() {
  const sb = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return jsonError(401, 'not_authenticated');

  // Razorpay not wired up yet: degrade this route only. Every other route on
  // the site keeps working (see the note on the optional() getters in env.ts).
  if (!isRazorpayConfigured()) {
    logSafe('order_razorpay_not_configured', { user_id: user.id });
    return jsonError(503, 'payment_not_configured');
  }

  // Already owns it — don't let someone pay twice for a lifetime license.
  if (await hasDownloadAccess(user.id)) {
    return jsonError(409, 'already_purchased');
  }

  const rl = await rateLimitOrderByUser(user.id);
  if (!rl.ok) return jsonError(429, 'rate_limited');

  const price = DOWNLOAD_LICENSE_PRICE;
  const admin = supabaseAdmin();

  // Reuse a recent unpaid order rather than minting a fresh one on every click.
  // Without this, a user who opens Checkout, changes their mind, and comes back
  // leaves a trail of dead orders that makes the ledger hard to reconcile. The
  // amount must match exactly, so a price change always produces a new order.
  const reuseCutoffIso = new Date(Date.now() - ORDER_REUSE_WINDOW_MS).toISOString();
  const { data: existing } = await admin
    .from('payments')
    .select('razorpay_order_id, total_amount_paise')
    .eq('user_id', user.id)
    .eq('status', 'created')
    .eq('total_amount_paise', price.totalAmountPaise)
    .gte('created_at', reuseCutoffIso)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing?.razorpay_order_id) {
    logSafe('order_reused', {
      user_id: user.id,
      order_id: existing.razorpay_order_id,
    });
    return NextResponse.json({
      order_id: existing.razorpay_order_id,
      key_id: env.razorpayKeyId,
      amount_paise: price.totalAmountPaise,
      currency: price.currency,
      price: {
        base_amount_paise: price.baseAmountPaise,
        gst_bps: price.gstBps,
        gst_amount_paise: price.gstAmountPaise,
        total_amount_paise: price.totalAmountPaise,
      },
      prefill_email: user.email ?? null,
      reused: true,
    });
  }

  const receipt = buildReceipt(user.id);

  let order;
  try {
    order = await createRazorpayOrder({
      amountPaise: price.totalAmountPaise,
      currency: price.currency,
      receipt,
      // `user_id` in notes is the webhook's recovery path: if the DB insert
      // below fails after Razorpay has already created the order, the webhook
      // can still identify the buyer from the order it receives.
      notes: {
        user_id: user.id,
        product: DOWNLOAD_LICENSE_PRODUCT,
      },
    });
  } catch (err) {
    const isRzp = err instanceof RazorpayError;
    logSafe('order_create_failed', {
      user_id: user.id,
      provider_status: isRzp ? err.statusCode : undefined,
      provider_code: isRzp ? err.providerCode : undefined,
      error: err instanceof Error ? err.message : 'unknown',
    });
    return jsonError(502, 'order_create_failed');
  }

  const { data: inserted, error: insertError } = await admin
    .from('payments')
    .insert({
      user_id: user.id,
      provider: 'razorpay',
      product: DOWNLOAD_LICENSE_PRODUCT,
      razorpay_order_id: order.id,
      base_amount_paise: price.baseAmountPaise,
      gst_bps: price.gstBps,
      gst_amount_paise: price.gstAmountPaise,
      total_amount_paise: price.totalAmountPaise,
      currency: price.currency,
      status: 'created',
      receipt,
      notes: { user_id: user.id, product: DOWNLOAD_LICENSE_PRODUCT },
    })
    .select('id')
    .maybeSingle();

  if (insertError) {
    // The Razorpay order now exists but we failed to record it. Refuse to open
    // Checkout: letting the user pay against an order we cannot reconcile is
    // worse than making them retry. The order is harmless if never paid, and
    // if it somehow is, the webhook recovers the buyer from notes.user_id.
    logSafe('order_persist_failed', {
      user_id: user.id,
      order_id: order.id,
      error: insertError.message,
    });
    return jsonError(502, 'order_create_failed');
  }

  logSafe('order_created', {
    user_id: user.id,
    order_id: order.id,
    payment_row_id: inserted?.id ?? null,
    total_amount_paise: price.totalAmountPaise,
  });

  return NextResponse.json({
    order_id: order.id,
    key_id: env.razorpayKeyId,
    amount_paise: price.totalAmountPaise,
    currency: price.currency,
    price: {
      base_amount_paise: price.baseAmountPaise,
      gst_bps: price.gstBps,
      gst_amount_paise: price.gstAmountPaise,
      total_amount_paise: price.totalAmountPaise,
    },
    prefill_email: user.email ?? null,
    reused: false,
  });
}
