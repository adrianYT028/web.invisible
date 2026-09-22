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

// -----------------------------------------------------------------------------
// ONE PRICE, ONE PRODUCT, ALL FOUR SERVICES
// -----------------------------------------------------------------------------
//
// ₹99 + 18% GST = ₹116.82 buys everything: the desktop app, the resume analyser,
// the job tracker and openings, and the auto-apply/cold-mail flow.
//
// ---------------------------------------------------------------------------
// WHY THE SEPARATE ₹299 BUNDLE WAS REMOVED (decided 2026-09)
//
// There were briefly two products: a ₹99 `download_license` for the desktop app
// and a ₹299 `platform_bundle` for the four services. That created a problem with
// no good answer: someone who had already bought the licence and then wanted the
// services paid ₹398 for what a new customer got for ₹299. Every fix for that —
// a credit, a discount code, a proration — is machinery in the payments path,
// which is the last place that should carry avoidable complexity.
//
// Collapsing to a single ₹99 product deletes the problem rather than managing it.
// There is one price, so there is no upgrade path to get wrong, no second
// fulfilment branch, and nothing to explain on the pricing page.
//
// THE LEDGER ID IS STILL `download_license`, DELIBERATELY.
// `platform_bundle` was never sold — the ledger contains 12 `download_license`
// rows and zero bundle rows — so there is nothing to migrate, and renaming the
// surviving id would make those 12 historical rows reference a product string
// this code no longer knows. `payments.product` is the one field that has to stay
// literally true about what happened, so the id is frozen and only the
// customer-facing LABEL says "full access".
//
// ---------------------------------------------------------------------------
// ONE-TIME, NOT MONTHLY
//
// A ₹99/month subscription was considered, on the reasoning that the platform
// pays for inference on this tier (the user brings no Groq key of their own — see
// src/lib/resume/ai/client.ts) and a recurring cost needs recurring revenue. The
// decision went the other way: a one-time unlock is what is being sold.
//
// The consequence to keep in view: a buyer holds platform-funded inference
// forever for a single ₹99 payment. What bounds that is NOT the price, it is the
// per-day caps in `feature_limits` (migration 011: 20 uploads, 40 scans a day)
// and the provider's own per-minute ceiling. Those caps are the liability
// control, so raising them is a pricing decision, not a generosity one.
//
// At ₹99 that liability is roughly 4x tighter per rupee than it was at ₹299, and
// the caps have NOT been lowered to compensate. That is a deliberate, revisitable
// choice — but it means the Groq tier and those caps are now the only thing
// standing between one payment and unbounded inference. Watch them together.
//
// The plan keeps no expiry — `profiles.plan_expires_at` stays NULL, which
// migration 015 defines as perpetual. Nothing here has to change if a recurring
// tier is added later: it would set an expiry, and `resolveEffectivePlan` already
// handles both.
//
// For context on the number: the incumbents charge far more, and monthly. Jobscan
// is around $49.95/month, Rezi $29/month, Kickresume $19/month. ₹99 is roughly
// $1.15 once.

/**
 * The single purchasable product, and the single price.
 *
 * Aliases of the licence constants rather than new values, so there is exactly
 * one number and one id in this module and they cannot drift apart. Prefer these
 * names in new code: `DOWNLOAD_LICENSE_*` now describes only the ledger key's
 * history, not what is being sold.
 */
export const FULL_ACCESS_PRODUCT = DOWNLOAD_LICENSE_PRODUCT;

/**
 * The plan name written to `profiles.plan` when the bundle is purchased.
 *
 * Still `student_pro`: the tier already has its per-day caps seeded in
 * `feature_limits` and is already named in `PLATFORM_FUNDED_PLANS`, so renaming
 * it would mean re-seeding caps and leaving a tier that funds inference but
 * unlocks nothing. See BUNDLE_PLAN in src/lib/plans/services.ts, which a test
 * pins to this value.
 */
export const STUDENT_PRO_PLAN = 'student_pro' as const;

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
 * The live price of full access: ₹99 + 18% GST = ₹116.82.
 *
 * The SAME frozen object as `DOWNLOAD_LICENSE_PRICE`, not a second computation —
 * two independently computed prices for one product is how a checkout button and
 * an order route end up disagreeing by a rupee and the ledger stops reconciling.
 */
export const FULL_ACCESS_PRICE: Readonly<PriceBreakdown> = DOWNLOAD_LICENSE_PRICE;

// -----------------------------------------------------------------------------
// The product catalogue
// -----------------------------------------------------------------------------
//
// Everything purchasable, and what each purchase is worth. This exists so the
// order route can accept a product from the client WITHOUT ever accepting an
// amount: the client names a product, the server looks up the price here.
//
// That distinction is the whole security property. The route previously took no
// body at all precisely to avoid the pay-what-you-want hole, and supporting a
// second product must not reopen it. A product id is a closed set of two opaque
// strings; an amount is arbitrary attacker-controlled arithmetic.

/**
 * What a completed purchase grants.
 *
 * One member, because there is one product. Kept as a union rather than inlined
 * so the fulfilment dispatcher still switches on an explicit value: if a second
 * product is ever added, the compiler flags every branch that has to handle it
 * instead of silently granting full access to it.
 */
export type ProductFulfilment = 'full_access';

export interface ProductDefinition {
  /** Value stored in `payments.product`. */
  id: string;
  /** Server-derived price. Never taken from a request. */
  price: Readonly<PriceBreakdown>;
  /** Customer-facing name, for checkout and receipts. */
  label: string;
  /** Which grant runs when this is paid for. */
  fulfilment: ProductFulfilment;
}

export const PRODUCTS: Readonly<Record<string, ProductDefinition>> =
  Object.freeze({
    [FULL_ACCESS_PRODUCT]: {
      id: FULL_ACCESS_PRODUCT,
      price: FULL_ACCESS_PRICE,
      // Customer-facing, and deliberately NOT the id. The id says
      // `download_license` for ledger continuity; this is what the buyer is
      // actually getting, and it is what appears on the Razorpay payment sheet
      // and the receipt.
      label: 'Unviewable full access',
      fulfilment: 'full_access',
    },
  });

/**
 * Look up a product by the identifier a client supplied.
 *
 * Returns null for anything not in the catalogue, so an unrecognised product is
 * a 400 rather than a silent fallback to the cheaper item — which would let a
 * client buy the bundle at the licence price by misspelling it.
 */
export function findProduct(id: unknown): ProductDefinition | null {
  if (typeof id !== 'string') return null;
  return PRODUCTS[id] ?? null;
}

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
