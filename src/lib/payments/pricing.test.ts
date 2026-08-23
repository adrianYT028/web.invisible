// @vitest-environment node
//
// Money math for the ₹99 + 18% GST download licence.
//
// These tests exist because the price is GST-EXCLUSIVE, which means the number
// we advertise (₹99) is NOT the number we charge (₹116.82). Every amount is an
// integer count of paise: ₹116.82 has no exact binary floating-point
// representation, so doing this in rupees with floats produces values that
// disagree with the integer paise Razorpay echoes back in the webhook — and an
// unreconcilable ledger.
//
// The property tests below encode the two invariants the database also enforces
// (`payments_total_is_base_plus_gst`, positivity), so a rounding change that
// would start failing inserts in production fails here first.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  BASE_AMOUNT_PAISE,
  CURRENCY,
  DOWNLOAD_LICENSE_PRICE,
  GST_BPS,
  computePrice,
  derivePriceFromTotal,
  formatGstRate,
  formatInr,
  formatInrCompact,
  formatPriceDisclosure,
} from './pricing';

// -----------------------------------------------------------------------------
// The exact launch numbers. If any of these change, it is a pricing decision,
// not a refactor — which is why they are asserted literally.
// -----------------------------------------------------------------------------
describe('launch pricing constants', () => {
  it('is ₹99 base, 18% GST, ₹116.82 charged', () => {
    expect(BASE_AMOUNT_PAISE).toBe(9900);
    expect(GST_BPS).toBe(1800);
    expect(CURRENCY).toBe('INR');

    expect(DOWNLOAD_LICENSE_PRICE).toEqual({
      baseAmountPaise: 9900,
      gstBps: 1800,
      gstAmountPaise: 1782,
      totalAmountPaise: 11682,
      currency: 'INR',
    });
  });

  it('divides exactly at the launch numbers, so rounding is a no-op', () => {
    // 9900 * 1800 / 10000 = 1782 with no remainder.
    expect((BASE_AMOUNT_PAISE * GST_BPS) % 10_000).toBe(0);
  });

  it('is frozen so a caller cannot mutate the shared breakdown', () => {
    expect(Object.isFrozen(DOWNLOAD_LICENSE_PRICE)).toBe(true);
  });

  it('charges MORE than the advertised base (GST is exclusive, not inclusive)', () => {
    // Guards against someone "fixing" this into a GST-inclusive model without
    // also changing the customer-facing disclosure.
    expect(DOWNLOAD_LICENSE_PRICE.totalAmountPaise).toBeGreaterThan(
      DOWNLOAD_LICENSE_PRICE.baseAmountPaise
    );
  });
});

// -----------------------------------------------------------------------------
// Invariants that the DB check constraints also enforce.
// -----------------------------------------------------------------------------
describe('computePrice invariants', () => {
  it('always yields total = base + gst, for any base and rate', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        (base, bps) => {
          const p = computePrice(base, bps);
          expect(p.totalAmountPaise).toBe(p.baseAmountPaise + p.gstAmountPaise);
        }
      )
    );
  });

  it('only ever produces whole paise', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        (base, bps) => {
          const p = computePrice(base, bps);
          expect(Number.isSafeInteger(p.baseAmountPaise)).toBe(true);
          expect(Number.isSafeInteger(p.gstAmountPaise)).toBe(true);
          expect(Number.isSafeInteger(p.totalAmountPaise)).toBe(true);
        }
      )
    );
  });

  it('never produces negative tax', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        (base, bps) => {
          expect(computePrice(base, bps).gstAmountPaise).toBeGreaterThanOrEqual(0);
        }
      )
    );
  });

  it('rejects fractional, negative, and non-integer input rather than coercing', () => {
    // A float here means someone passed rupees. Failing loudly beats silently
    // charging the wrong amount.
    expect(() => computePrice(99.5)).toThrow(/safe integer/i);
    expect(() => computePrice(Number.NaN)).toThrow(/safe integer/i);
    expect(() => computePrice(0)).toThrow(/> 0/);
    expect(() => computePrice(-1)).toThrow(/> 0/);
    expect(() => computePrice(9900, -1)).toThrow(/0\.\.10000/);
    expect(() => computePrice(9900, 10_001)).toThrow(/0\.\.10000/);
  });
});

// -----------------------------------------------------------------------------
// The webhook recovery path depends on this inverse holding exactly.
// -----------------------------------------------------------------------------
describe('derivePriceFromTotal (webhook recovery)', () => {
  it('recovers the launch breakdown from the charged total', () => {
    expect(derivePriceFromTotal(11682)).toEqual({
      baseAmountPaise: 9900,
      gstBps: 1800,
      gstAmountPaise: 1782,
      totalAmountPaise: 11682,
      currency: 'INR',
    });
  });

  it('preserves total = base + gst for ANY total', () => {
    // This is the property that matters: a recovered `payments` row must
    // satisfy the payments_total_is_base_plus_gst constraint or the insert
    // fails and a paying customer silently loses their licence.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000_000 }), (total) => {
        const p = derivePriceFromTotal(total);
        expect(p.totalAmountPaise).toBe(total);
        expect(p.baseAmountPaise + p.gstAmountPaise).toBe(total);
        expect(Number.isSafeInteger(p.baseAmountPaise)).toBe(true);
        expect(Number.isSafeInteger(p.gstAmountPaise)).toBe(true);
      })
    );
  });

  it('round-trips computePrice within one paise of rounding residue', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000_000 }), (base) => {
        const forward = computePrice(base);
        const back = derivePriceFromTotal(forward.totalAmountPaise);
        expect(Math.abs(back.baseAmountPaise - base)).toBeLessThanOrEqual(1);
      })
    );
  });

  it('rejects invalid totals', () => {
    expect(() => derivePriceFromTotal(0)).toThrow(/> 0/);
    expect(() => derivePriceFromTotal(1.5)).toThrow(/safe integer/i);
  });
});

// -----------------------------------------------------------------------------
// Formatters. These strings appear on the pay button, so a wrong one is a
// consumer-disclosure problem, not a cosmetic one.
// -----------------------------------------------------------------------------
describe('formatters', () => {
  it('formatInr always shows two decimal places', () => {
    expect(formatInr(11682)).toBe('₹116.82');
    expect(formatInr(9900)).toBe('₹99.00');
    expect(formatInr(1782)).toBe('₹17.82');
    expect(formatInr(5)).toBe('₹0.05');
    expect(formatInr(0)).toBe('₹0.00');
    expect(formatInr(-11682)).toBe('-₹116.82');
  });

  it('formatInr groups in the Indian numbering system', () => {
    // 10,00,000 paise = ₹10,000.00 — lakh/crore grouping, not thousands.
    expect(formatInr(100_000_000)).toBe('₹10,00,000.00');
  });

  it('formatInrCompact drops a zero paise remainder', () => {
    expect(formatInrCompact(9900)).toBe('₹99');
    expect(formatInrCompact(11682)).toBe('₹116.82');
    expect(formatInrCompact(100)).toBe('₹1');
  });

  it('formatGstRate renders whole percentages cleanly', () => {
    expect(formatGstRate(1800)).toBe('18%');
    expect(formatGstRate(0)).toBe('0%');
    expect(formatGstRate(500)).toBe('5%');
  });

  it('formatPriceDisclosure states base, rate, and total together', () => {
    // The customer must be able to see WHY the button says ₹116.82 when the
    // marketing says ₹99.
    expect(formatPriceDisclosure()).toBe('₹99 + 18% GST = ₹116.82');
  });

  it('formatters reject rupee floats', () => {
    expect(() => formatInr(116.82)).toThrow(/safe integer/i);
  });
});
