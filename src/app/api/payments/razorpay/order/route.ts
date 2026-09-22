import { NextResponse } from 'next/server';

import { createSupabaseRouteClient } from '@/lib/supabase/route';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { jsonError, logSafe } from '@/lib/http';
import { env, isRazorpayConfigured } from '@/lib/env';
import { rateLimitOrderByUser } from '@/lib/ratelimit';
import {
  DOWNLOAD_LICENSE_PRODUCT,
  findProduct,
} from '@/lib/payments/pricing';
import { createRazorpayOrder, RazorpayError } from '@/lib/payments/razorpay';
import { hasDownloadAccess } from '@/lib/payments/entitlements';
import { readEffectivePlan } from '@/lib/plans/read-plan';
import { isBundlePlan } from '@/lib/plans/services';

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
// THE AMOUNT IS NEVER TAKEN FROM THE REQUEST BODY. A client-supplied amount is
// the classic pay-what-you-want vulnerability: the browser would just ask for an
// order of ₹1.
//
// This route originally accepted no body at all, which was the simplest way to
// guarantee that. It now accepts exactly one field — `product` — and that
// distinction is load-bearing: a product is a NAME resolved against a closed
// catalogue (`PRODUCTS` in pricing.ts) which yields the price server-side, so the
// client chooses WHAT to buy and never HOW MUCH it costs. An unrecognised name is
// a 400, never a fallback to the cheaper item.
//
// `product` is optional and defaults to the desktop licence, so the existing
// checkout — which sends no body — behaves exactly as it did.
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

/**
 * Whether the user already owns this product, so they cannot pay twice for a
 * perpetual unlock.
 *
 * ---------------------------------------------------------------------------
 * EITHER MARKER MEANS OWNERSHIP, AND THAT IS NOT REDUNDANT
 *
 * Full access is recorded in two places — `entitlements.download_access` for the
 * perpetual licence and `profiles.plan` for the services — so ownership has to be
 * the OR of the two, not the AND, and not just one.
 *
 * The licence check is what protects EXISTING customers. Eight accounts bought the
 * ₹99 desktop licence when that was all ₹99 bought; they hold
 * `download_access = true` and `plan = 'free'`. Now that ₹99 buys everything, they
 * already own the whole product. Checking only `profiles.plan` would read them as
 * non-owners and happily charge them a second ₹99 for something they have already
 * paid for — which is a refund and a complaint, not a sale.
 *
 * The plan check covers the mirror case: a grant where the licence write failed
 * but the plan write succeeded must not be re-sold either.
 *
 * Takes no product argument: there is one product, and both markers describe it.
 * If a second product is ever added this needs the product back, and the
 * `sells exactly one product` test in fulfilment.test.ts is what will say so.
 */
async function alreadyOwns(userId: string): Promise<boolean> {
  if (await hasDownloadAccess(userId)) return true;
  return isBundlePlan(await readEffectivePlan(supabaseAdmin(), userId));
}

export async function POST(request: Request) {
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

  // A missing or unparseable body is not an error: it means the desktop licence,
  // which is what the pre-existing checkout sends.
  const body = (await request.json().catch(() => null)) as
    | { product?: unknown }
    | null;
  const requestedProduct = body?.product ?? DOWNLOAD_LICENSE_PRODUCT;

  const product = findProduct(requestedProduct);
  if (!product) {
    logSafe('order_unknown_product', {
      user_id: user.id,
      requested:
        typeof requestedProduct === 'string'
          ? requestedProduct.slice(0, 64)
          : 'non_string',
    });
    return jsonError(400, 'unknown_product');
  }

  // Already owns it — don't let someone pay twice for a lifetime license.
  if (await alreadyOwns(user.id)) {
    return jsonError(409, 'already_purchased');
  }

  const rl = await rateLimitOrderByUser(user.id);
  if (!rl.ok) return jsonError(429, 'rate_limited');

  // Server-derived. The client named the product; it did not name this number.
  const price = product.price;
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
    // Matched on product AND amount. The amount alone was sufficient with one
    // product; with two it would silently hand back a licence order to someone
    // buying the bundle the moment the two prices ever coincide.
    .eq('product', product.id)
    .eq('total_amount_paise', price.totalAmountPaise)
    .gte('created_at', reuseCutoffIso)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing?.razorpay_order_id) {
    logSafe('order_reused', {
      user_id: user.id,
      order_id: existing.razorpay_order_id,
      product: product.id,
    });
    return NextResponse.json({
      order_id: existing.razorpay_order_id,
      key_id: env.razorpayKeyId,
      amount_paise: price.totalAmountPaise,
      currency: price.currency,
      product: product.id,
      product_label: product.label,
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
        product: product.id,
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
      product: product.id,
      razorpay_order_id: order.id,
      base_amount_paise: price.baseAmountPaise,
      gst_bps: price.gstBps,
      gst_amount_paise: price.gstAmountPaise,
      total_amount_paise: price.totalAmountPaise,
      currency: price.currency,
      status: 'created',
      receipt,
      notes: { user_id: user.id, product: product.id },
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
    product: product.id,
    total_amount_paise: price.totalAmountPaise,
  });

  return NextResponse.json({
    order_id: order.id,
    key_id: env.razorpayKeyId,
    amount_paise: price.totalAmountPaise,
    currency: price.currency,
    product: product.id,
    product_label: product.label,
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
