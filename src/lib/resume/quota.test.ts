import { describe, expect, it } from 'vitest';

import {
  BASE_AMOUNT_PAISE,
  STUDENT_PRO_PLAN,
  FULL_ACCESS_PRICE,
  formatInr,
  formatPriceDisclosure,
} from '@/lib/payments/pricing';
import { PLATFORM_FUNDED_PLANS } from '@/lib/ai/plans';

import { checkResumeQuota, utcDayWindow } from './quota';

// -----------------------------------------------------------------------------
// Resume quota + Student Pro pricing
//
// The quota is the only thing bounding platform-funded inference, so its edge
// cases are worth pinning: NULL means unlimited, and a database failure must fail
// OPEN rather than telling a paying subscriber their allowance is gone.
// -----------------------------------------------------------------------------

/**
 * Minimal fake of the Supabase query builder, covering only the two shapes this
 * module uses: a `maybeSingle()` read of feature_limits and a head/count read of
 * resumes/resume_scans.
 */
function fakeAdmin(options: {
  plan?: string;
  cap?: number | null;
  capError?: boolean;
  count?: number;
  countError?: boolean;
  capColumnMissing?: boolean;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin: any = {
    from(table: string) {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { plan: options.plan ?? 'free' },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'feature_limits') {
        return {
          select: (column: string) => ({
            eq: () => ({
              maybeSingle: async () =>
                options.capError
                  ? { data: null, error: { message: 'boom' } }
                  : {
                      data: options.capColumnMissing
                        ? {}
                        : { [column]: options.cap ?? null },
                      error: null,
                    },
            }),
          }),
        };
      }
      // resumes / resume_scans
      return {
        select: () => ({
          eq: () => ({
            gte: () => ({
              lt: async () =>
                options.countError
                  ? { count: null, error: { message: 'boom' } }
                  : { count: options.count ?? 0, error: null },
            }),
          }),
        }),
      };
    },
  };
  return admin;
}

describe('checkResumeQuota', () => {
  it('treats a NULL cap as unlimited', async () => {
    // The `feature_limits` convention. Getting this backwards would either ship
    // the paid feature free or lock everyone out.
    const verdict = await checkResumeQuota(
      fakeAdmin({ cap: null }),
      'u1',
      'scan',
      'student_pro'
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.cap).toBeNull();
  });

  it('treats a missing cap COLUMN as unlimited too', async () => {
    const verdict = await checkResumeQuota(
      fakeAdmin({ capColumnMissing: true }),
      'u1',
      'scan',
      'free'
    );
    expect(verdict.allowed).toBe(true);
  });

  it('allows a request below the cap', async () => {
    const verdict = await checkResumeQuota(
      fakeAdmin({ cap: 1, count: 0 }),
      'u1',
      'scan',
      'free'
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.cap).toBe(1);
    expect(verdict.used).toBe(0);
  });

  it('denies once usage reaches the cap', async () => {
    // The free taster is one scan a day; the second must be refused.
    const verdict = await checkResumeQuota(
      fakeAdmin({ cap: 1, count: 1 }),
      'u1',
      'scan',
      'free'
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.used).toBe(1);
  });

  it('denies when usage somehow exceeds the cap', async () => {
    const verdict = await checkResumeQuota(
      fakeAdmin({ cap: 1, count: 5 }),
      'u1',
      'scan',
      'free'
    );
    expect(verdict.allowed).toBe(false);
  });

  it('fails OPEN when the cap lookup errors', async () => {
    // Deliberate trade: briefly costing us inference beats telling a paying
    // subscriber their quota is exhausted when it is not. The hard ceiling behind
    // this is the provider rate limit, which fails closed on its own.
    const verdict = await checkResumeQuota(
      fakeAdmin({ capError: true }),
      'u1',
      'scan',
      'student_pro'
    );
    expect(verdict.allowed).toBe(true);
  });

  it('fails OPEN when the usage count errors', async () => {
    const verdict = await checkResumeQuota(
      fakeAdmin({ cap: 1, countError: true }),
      'u1',
      'scan',
      'free'
    );
    expect(verdict.allowed).toBe(true);
  });

  it('resolves the plan itself when not supplied', async () => {
    const verdict = await checkResumeQuota(
      fakeAdmin({ plan: 'student_pro', cap: null }),
      'u1',
      'upload'
    );
    expect(verdict.plan).toBe('student_pro');
  });
});

describe('utcDayWindow', () => {
  it('spans midnight to midnight UTC', () => {
    const { start, end } = utcDayWindow(new Date('2026-08-25T18:42:11.123Z'));
    expect(start).toBe('2026-08-25T00:00:00.000Z');
    expect(end).toBe('2026-08-26T00:00:00.000Z');
  });

  it('uses UTC rather than local midnight', () => {
    // A user in IST (UTC+5:30) would otherwise get two allowances on the day the
    // two windows disagree.
    const lateIst = new Date('2026-08-25T20:30:00.000Z'); // 02:00 IST on the 26th
    expect(utcDayWindow(lateIst).start).toBe('2026-08-25T00:00:00.000Z');
  });

  it('handles a month boundary', () => {
    const { start, end } = utcDayWindow(new Date('2026-08-31T23:59:59.999Z'));
    expect(start).toBe('2026-08-31T00:00:00.000Z');
    expect(end).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('Full access pricing', () => {
  // ONE PRICE. The separate ₹299 bundle was removed: ₹99 now buys the desktop app
  // and all four services. That deleted the ₹398-to-upgrade problem rather than
  // building machinery to manage it.
  it('is ₹99 advertised and ₹116.82 charged', () => {
    // GST-exclusive. Every surface showing the price must disclose the total,
    // because the amount Razorpay debits is higher than the advertised figure and
    // a surprise at the payment sheet is the most common cause of drop-off.
    expect(FULL_ACCESS_PRICE.baseAmountPaise).toBe(9_900);
    expect(FULL_ACCESS_PRICE.gstAmountPaise).toBe(1_782);
    expect(FULL_ACCESS_PRICE.totalAmountPaise).toBe(11_682);
    expect(formatInr(FULL_ACCESS_PRICE.totalAmountPaise)).toBe('₹116.82');
  });

  // The two names must stay the same object, not two equal numbers: a second
  // independently computed price is how a button and an order route end up
  // disagreeing and the ledger stops reconciling.
  it('is the same price object as the historical licence constant', async () => {
    const { DOWNLOAD_LICENSE_PRICE } = await import('@/lib/payments/pricing');

    expect(FULL_ACCESS_PRICE).toBe(DOWNLOAD_LICENSE_PRICE);
  });

  it('keeps base + gst === total exactly, in integer paise', () => {
    // The invariant the `payments_total_is_base_plus_gst` CHECK enforces.
    expect(
      FULL_ACCESS_PRICE.baseAmountPaise + FULL_ACCESS_PRICE.gstAmountPaise
    ).toBe(FULL_ACCESS_PRICE.totalAmountPaise);
    for (const value of [
      FULL_ACCESS_PRICE.baseAmountPaise,
      FULL_ACCESS_PRICE.gstAmountPaise,
      FULL_ACCESS_PRICE.totalAmountPaise,
    ]) {
      expect(Number.isSafeInteger(value)).toBe(true);
    }
  });

  it('discloses the full breakdown in one line', () => {
    expect(formatPriceDisclosure(FULL_ACCESS_PRICE)).toBe(
      '₹99 + 18% GST = ₹116.82'
    );
  });

  it('derives the price from the declared base', () => {
    expect(FULL_ACCESS_PRICE.baseAmountPaise).toBe(
      BASE_AMOUNT_PAISE
    );
  });

  it('names the same plan the AI layer funds', () => {
    // If these drifted, a subscriber would be charged and then refused
    // platform-funded inference — billed for something they cannot use.
    expect(PLATFORM_FUNDED_PLANS.has(STUDENT_PRO_PLAN)).toBe(true);
  });
});
