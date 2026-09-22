// -----------------------------------------------------------------------------
// Fulfilment — turning a paid `payments` row into access
// -----------------------------------------------------------------------------
//
// There are two products and three call sites that have to act on a payment:
//
//   POST /api/payments/razorpay/verify    optimistic, client-driven, instant UI
//   POST /api/payments/razorpay/webhook   authoritative, may retry
//   ...and the same webhook's refund branch, in reverse
//
// Before this module the grant was a direct call to `grantDownloadAccess` in each
// place. With one product that was fine. With two it is the setup for the worst
// class of payment bug: a product handled in the webhook but not in verify, so
// the customer's access depends on whether their browser completed a callback.
// They would be charged either way.
//
// So the mapping from product to grant lives here, once, and the routes call
// `fulfilPayment` / `reversePayment` without knowing what was bought.
//
// UNRECOGNISED PRODUCTS FAIL, THEY DO NOT DEFAULT.
//   `payments.product` is free text (migration 009 has no CHECK on it), so a row
//   can name a product this code does not know. Defaulting such a row to the
//   desktop licence would grant the cheap thing for whatever was actually paid,
//   and defaulting it to the bundle would give away the expensive thing. Both are
//   wrong, so an unknown product is an explicit failure that the caller reports
//   as retryable — a human then decides.

import { logSafe } from '@/lib/http';
import {
  findProduct,
  type ProductFulfilment,
  DOWNLOAD_LICENSE_PRODUCT,
} from '@/lib/payments/pricing';

import { grantFullAccess, revokeFullAccess } from './entitlements';

/**
 * Resolve what a stored `payments.product` value should grant.
 *
 * A NULL/absent product is read as the desktop licence. That is not a general
 * fallback — it is a migration concession: rows created before the catalogue
 * existed have `product` defaulted to `'download_license'` by the column
 * default, and a handful of webhook-recovery rows may carry nothing useful.
 * Every such row predates the bundle, so the licence is the only thing it can
 * be.
 */
export function fulfilmentFor(product: unknown): ProductFulfilment | null {
  if (product === null || product === undefined || product === '') {
    return 'full_access';
  }
  const definition = findProduct(product);
  if (definition) return definition.fulfilment;
  // A product string we do not recognise. Deliberately not defaulted.
  return null;
}

export interface FulfilmentResult {
  ok: boolean;
  /** What was granted, for logging. Null when the product was unrecognised. */
  fulfilment: ProductFulfilment | null;
}

/**
 * Grant whatever this payment bought. Idempotent, because both callers can fire
 * for the same payment and the webhook can be delivered more than once.
 */
export async function fulfilPayment(args: {
  userId: string;
  product: unknown;
  paymentRowId: string | null;
}): Promise<FulfilmentResult> {
  const fulfilment = fulfilmentFor(args.product);

  if (fulfilment === null) {
    logSafe('fulfilment_unknown_product', {
      user_id: args.userId,
      payment_row_id: args.paymentRowId,
      // The value is ours, not user input, so it is safe to record.
      product: typeof args.product === 'string' ? args.product : 'non_string',
    });
    return { ok: false, fulfilment: null };
  }

  const ok = await grantFullAccess(args.userId, args.paymentRowId);

  return { ok, fulfilment };
}

/**
 * Undo a fulfilment after a refund.
 *
 * Same dispatch as the grant so a refunded bundle cannot leave the plan in place
 * just because the refund branch only ever learned about the licence.
 */
export async function reversePayment(args: {
  userId: string;
  product: unknown;
  reason: string;
}): Promise<FulfilmentResult> {
  const fulfilment = fulfilmentFor(args.product);

  if (fulfilment === null) {
    logSafe('reversal_unknown_product', {
      user_id: args.userId,
      reason: args.reason,
      product: typeof args.product === 'string' ? args.product : 'non_string',
    });
    return { ok: false, fulfilment: null };
  }

  const ok = await revokeFullAccess(args.userId, args.reason);

  return { ok, fulfilment };
}

/** Re-exported so callers do not need a second pricing import for the default. */
export { DOWNLOAD_LICENSE_PRODUCT };
