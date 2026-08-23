// -----------------------------------------------------------------------------
// Pricing — the single source of truth for what we charge.
//
// PRICE MODEL (decided 2026-08): GST-EXCLUSIVE.
//   The advertised price is ₹99. GST at 18% is added ON TOP at checkout, so
//   the customer's card/UPI is debited ₹116.82. Every customer-facing surface
//   MUST say "₹99 + 18% GST" or show the ₹116.82 total — never a bare "₹99"
//   next to a Pay button, because the amount Razorpay collects is higher and
//   a surprise delta at the payment sheet is the single most common cause of
//   drop-off and chargeback disputes.
//
// EVERYTHING IS INTEGER PAISE.
//   ₹116.82 has no exact binary floating-point representation. Doing this math
//   in rupees with floats produces 116.82000000000001-class errors, which then
//   disagree with the integer paise amount Razorpay echoes back in the webhook,
//   which makes the ledger unreconcilable. There is no `number` in this module
//   that is not a whole count of paise or a basis-point rate.
//
// This module is intentionally DEPENDENCY-FREE and server/client agnostic: the
// checkout button renders the breakdown, and the order route validates against
// it. Do not import `env`, `node:*`, or any Supabase client here or the price
// display will break the client bundle.
// -----------------------------------------------------------------------------

/** Advertised, GST-exclusive price of the one-time download license: ₹99. */
export const BASE_AMOUNT_PAISE = 9_900;

/** Indian GST on digital goods/services, in basis points. 1800 = 18.00%. */
export const GST_BPS = 1_800;

/** India-only launch. Razorpay international is not enabled. */
export const CURRENCY = 'INR' as const;

/** Product identifier persisted on `payments.product`. */
export const DOWNLOAD_LICENSE_PRODUCT = 'download_license' as const;

export interface PriceBreakdown {
  /** Advertised price before tax, in paise. */
  baseAmountPaise: number;
  /** Tax rate applied, in basis points. */
  gstBps: number;
  /** Tax component, in paise. */
  gstAmountPaise: number;
  /** What the payment provider actually charges, in paise. */
  totalAmountPaise: number;
  currency: typeof CURRENCY;
}

function assertWholePaise(label: string, value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `pricing: ${label} must be a safe integer number of paise, got ${value}. ` +
        'Never pass rupees or a float into this module.'
    );
  }
}

/**
 * Derive the full GST-exclusive breakdown from a base amount.
 *
 * Rounding policy: the GST component is rounded HALF-UP to the nearest paise.
 * With the current ₹99 / 18% inputs the division is exact
 * (9900 * 1800 / 10000 = 1782), so rounding is a no-op today — it exists so a
 * future price like ₹149 (gst 2682) or an odd rate cannot silently produce a
 * fractional paise that fails the `payments_total_is_base_plus_gst` check
 * constraint on insert.
 */
export function computePrice(
  baseAmountPaise: number = BASE_AMOUNT_PAISE,
  gstBps: number = GST_BPS
): PriceBreakdown {
  assertWholePaise('baseAmountPaise', baseAmountPaise);
  assertWholePaise('gstBps', gstBps);

  if (baseAmountPaise <= 0) {
    throw new Error(`pricing: baseAmountPaise must be > 0, got ${baseAmountPaise}`);
  }
  if (gstBps < 0 || gstBps > 10_000) {
    throw new Error(`pricing: gstBps must be within 0..10000, got ${gstBps}`);
  }

  const gstAmountPaise = Math.round((baseAmountPaise * gstBps) / 10_000);
  const totalAmountPaise = baseAmountPaise + gstAmountPaise;

  return {
    baseAmountPaise,
    gstBps,
    gstAmountPaise,
    totalAmountPaise,
    currency: CURRENCY,
  };
}

/**
 * The live price of the download license. Frozen so a caller cannot mutate the
 * shared breakdown and have a different amount reach Razorpay than the one we
 * recorded on the `payments` row.
 */
export const DOWNLOAD_LICENSE_PRICE: Readonly<PriceBreakdown> = Object.freeze(
  computePrice()
);

/**
 * Inverse of `computePrice`: split a GST-INCLUSIVE total back into base + tax.
 *
 * Used only on the webhook recovery path. If Razorpay created an order but our
 * `payments` insert failed afterwards, a `payment.captured` arrives for an order
 * we have no row for. We still want an auditable ledger entry, and the row must
 * satisfy the `payments_total_is_base_plus_gst` check constraint — so the base
 * is derived and the tax is taken as the REMAINDER rather than computed
 * independently. That makes `base + gst === total` true by construction for any
 * total, with the rounding residue absorbed into the tax component.
 *
 * Do not use this for pricing anything. The forward direction is authoritative.
 */
export function derivePriceFromTotal(
  totalAmountPaise: number,
  gstBps: number = GST_BPS
): PriceBreakdown {
  assertWholePaise('totalAmountPaise', totalAmountPaise);
  assertWholePaise('gstBps', gstBps);

  if (totalAmountPaise <= 0) {
    throw new Error(
      `pricing: totalAmountPaise must be > 0, got ${totalAmountPaise}`
    );
  }

  const baseAmountPaise = Math.round(
    (totalAmountPaise * 10_000) / (10_000 + gstBps)
  );

  return {
    baseAmountPaise,
    gstBps,
    gstAmountPaise: totalAmountPaise - baseAmountPaise,
    totalAmountPaise,
    currency: CURRENCY,
  };
}

/** `1800` -> `'18%'`; `1850` -> `'18.5%'`. */
export function formatGstRate(gstBps: number = GST_BPS): string {
  const percent = gstBps / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2).replace(/0$/, '')}%`;
}

/**
 * Paise -> display string, always two decimals: `11682` -> `'₹116.82'`.
 * Uses integer division so the rupee and paise parts are computed without ever
 * creating a fractional intermediate.
 */
export function formatInr(paise: number): string {
  assertWholePaise('paise', paise);
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const rupees = Math.trunc(abs / 100);
  const remainder = abs % 100;
  return `${sign}₹${rupees.toLocaleString('en-IN')}.${String(remainder).padStart(2, '0')}`;
}

/**
 * Like `formatInr` but drops a zero paise remainder: `9900` -> `'₹99'`.
 * Use for the advertised base price; use `formatInr` for the amount charged.
 */
export function formatInrCompact(paise: number): string {
  assertWholePaise('paise', paise);
  return Math.abs(paise) % 100 === 0
    ? `${paise < 0 ? '-' : ''}₹${Math.trunc(Math.abs(paise) / 100).toLocaleString('en-IN')}`
    : formatInr(paise);
}

/**
 * One-line disclosure for buttons and legal copy:
 * `'₹99 + 18% GST = ₹116.82'`.
 */
export function formatPriceDisclosure(
  price: Readonly<PriceBreakdown> = DOWNLOAD_LICENSE_PRICE
): string {
  return (
    `${formatInrCompact(price.baseAmountPaise)} + ${formatGstRate(price.gstBps)} GST` +
    ` = ${formatInr(price.totalAmountPaise)}`
  );
}
