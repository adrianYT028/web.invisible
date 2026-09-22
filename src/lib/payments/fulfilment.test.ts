import { beforeEach, describe, expect, it, vi } from 'vitest';

const grantFullAccess = vi.fn(async () => true);
const revokeFullAccess = vi.fn(async () => true);

vi.mock('./entitlements', () => ({
  grantFullAccess: (...a: unknown[]) => grantFullAccess(...(a as [])),
  revokeFullAccess: (...a: unknown[]) => revokeFullAccess(...(a as [])),
}));

vi.mock('@/lib/http', () => ({ logSafe: () => {} }));

import { DOWNLOAD_LICENSE_PRODUCT, FULL_ACCESS_PRODUCT } from './pricing';
import { fulfilPayment, fulfilmentFor, reversePayment } from './fulfilment';

// -----------------------------------------------------------------------------
// Fulfilment, after the collapse to a single ₹99 product
//
// There used to be two products and a dispatch between two grants. The ₹299
// bundle is gone — ₹99 now buys everything — so the dispatcher has one branch.
// It is kept as a dispatcher rather than inlined precisely so these tests keep
// asserting that an UNRECOGNISED product grants nothing: `payments.product` is
// free text with no CHECK constraint, so an unknown value is reachable, and
// defaulting it to full access would hand the whole product to any row with a
// typo in it.
// -----------------------------------------------------------------------------

beforeEach(() => {
  grantFullAccess.mockClear().mockResolvedValue(true);
  revokeFullAccess.mockClear().mockResolvedValue(true);
});

describe('fulfilmentFor', () => {
  it('maps the single catalogue product to full access', () => {
    expect(fulfilmentFor(FULL_ACCESS_PRODUCT)).toBe('full_access');
  });

  // The ledger id did not change when the product did: 12 historical rows say
  // `download_license`, and they must keep resolving to what ₹99 buys today.
  it('still resolves the historical download_license id', () => {
    expect(DOWNLOAD_LICENSE_PRODUCT).toBe(FULL_ACCESS_PRODUCT);
    expect(fulfilmentFor(DOWNLOAD_LICENSE_PRODUCT)).toBe('full_access');
  });

  // Rows written before the catalogue existed have `product` set by the column
  // default or left empty by webhook recovery.
  it('reads an absent product as full access', () => {
    expect(fulfilmentFor(null)).toBe('full_access');
    expect(fulfilmentFor(undefined)).toBe('full_access');
    expect(fulfilmentFor('')).toBe('full_access');
  });

  // Still the most important case. An unknown product must not be guessed at:
  // granting full access for an unrecognised row gives away everything on the
  // strength of a string nobody validated.
  it('refuses to guess at an unrecognised product', () => {
    expect(fulfilmentFor('student_pro_monthly')).toBeNull();
    expect(fulfilmentFor('platform_bundle')).toBeNull();
    expect(fulfilmentFor('platform_bundle_v2')).toBeNull();
    expect(fulfilmentFor('DOWNLOAD_LICENSE')).toBeNull();
    expect(fulfilmentFor(42)).toBeNull();
    expect(fulfilmentFor({})).toBeNull();
  });
});

describe('fulfilPayment', () => {
  it('grants full access', async () => {
    const result = await fulfilPayment({
      userId: 'u1',
      product: FULL_ACCESS_PRODUCT,
      paymentRowId: 'p1',
    });

    expect(result).toEqual({ ok: true, fulfilment: 'full_access' });
    expect(grantFullAccess).toHaveBeenCalledWith('u1', 'p1');
  });

  it('grants full access for a legacy row with no product', async () => {
    const result = await fulfilPayment({
      userId: 'u2',
      product: null,
      paymentRowId: 'p2',
    });

    expect(result).toEqual({ ok: true, fulfilment: 'full_access' });
    expect(grantFullAccess).toHaveBeenCalledWith('u2', 'p2');
  });

  it('reports failure when the grant fails, so the webhook retries', async () => {
    grantFullAccess.mockResolvedValue(false);

    const result = await fulfilPayment({
      userId: 'u3',
      product: FULL_ACCESS_PRODUCT,
      paymentRowId: null,
    });

    expect(result).toEqual({ ok: false, fulfilment: 'full_access' });
  });

  it('grants nothing for an unrecognised product', async () => {
    const result = await fulfilPayment({
      userId: 'u4',
      product: 'mystery_box',
      paymentRowId: 'p4',
    });

    expect(result).toEqual({ ok: false, fulfilment: null });
    expect(grantFullAccess).not.toHaveBeenCalled();
  });
});

describe('reversePayment', () => {
  it('revokes full access on a refund', async () => {
    const result = await reversePayment({
      userId: 'u1',
      product: FULL_ACCESS_PRODUCT,
      reason: 'refund:pay_1',
    });

    expect(result).toEqual({ ok: true, fulfilment: 'full_access' });
    expect(revokeFullAccess).toHaveBeenCalledWith('u1', 'refund:pay_1');
  });

  // A refund of one of the 12 historical rows has to reverse the same thing the
  // grant conferred, or a refunded customer keeps the product.
  it('revokes full access for a historical download_license row', async () => {
    const result = await reversePayment({
      userId: 'u2',
      product: DOWNLOAD_LICENSE_PRODUCT,
      reason: 'refund:pay_2',
    });

    expect(result).toEqual({ ok: true, fulfilment: 'full_access' });
    expect(revokeFullAccess).toHaveBeenCalledWith('u2', 'refund:pay_2');
  });

  it('reports failure when the revoke fails', async () => {
    revokeFullAccess.mockResolvedValue(false);

    const result = await reversePayment({
      userId: 'u3',
      product: FULL_ACCESS_PRODUCT,
      reason: 'refund:pay_3',
    });

    expect(result).toEqual({ ok: false, fulfilment: 'full_access' });
  });

  it('revokes nothing for an unrecognised product', async () => {
    const result = await reversePayment({
      userId: 'u4',
      product: 'mystery_box',
      reason: 'refund:pay_4',
    });

    expect(result).toEqual({ ok: false, fulfilment: null });
    expect(revokeFullAccess).not.toHaveBeenCalled();
  });
});

describe('catalogue coverage', () => {
  it('has a working grant for every product on sale', async () => {
    const { PRODUCTS } = await import('./pricing');

    for (const id of Object.keys(PRODUCTS)) {
      // A product that is purchasable but not fulfillable would take money and
      // give nothing.
      expect(fulfilmentFor(id)).not.toBeNull();
    }
  });

  // The collapse to one product is an intended state, not a coincidence, so it is
  // asserted: a second product appearing here needs its own fulfilment branch and
  // its own ownership check in the order route, and this test is where that
  // conversation starts.
  it('sells exactly one product', async () => {
    const { PRODUCTS } = await import('./pricing');

    expect(Object.keys(PRODUCTS)).toEqual([FULL_ACCESS_PRODUCT]);
  });
});
