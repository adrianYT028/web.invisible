/**
 * Business identity used by the Razorpay-required legal pages.
 *
 * ===========================================================================
 * HOW TO EDIT THIS FILE
 *
 * Every value is a PLAIN QUOTED STRING. Replace the whole string, quotes
 * included:
 *
 *     entityType: 'Sole Proprietorship',            <-- correct
 *
 * An earlier version of this file used template literals like
 * `${PLACEHOLDER_PREFIX} entity type`, which invited people to paste their
 * value into the `${...}` slot and produced a syntax error that broke all five
 * legal pages with a 500. Plain strings make that impossible. Do not
 * reintroduce backticks or `${}` here.
 *
 * ===========================================================================
 * WHAT RAZORPAY CHECKS
 *
 * Activation review cross-checks the registered name, address, phone, and
 * email on /contact against your KYC submission. Approximations fail review.
 * Anything still prefixed with 'TODO ' is not yet good enough to submit — grep
 * for it:
 *
 *     grep -n "TODO " src/components/constants/business-info.ts
 *
 * While any remain, a warning banner renders on the legal pages in development
 * only (never in production, so don't rely on it as a safety net).
 * ===========================================================================
 */

/**
 * Sentinel marking a value that still needs work. A plain prefix inside the
 * string — not an interpolation — so an unfinished value can never be a syntax
 * error.
 */
export const TODO_PREFIX = 'TODO ' as const;

export const BUSINESS_INFO = {
  /** Trading / brand name shown to customers. */
  tradingName: 'Unviewable',

  /**
   * Registered legal entity name, exactly as on your PAN/GST registration.
   *
   * TODO: For a Sole Proprietorship, Razorpay's KYC is in the PROPRIETOR'S
   * legal name, not the brand. 'Unviewable' is the trading name. This should
   * read something like 'Adrian <Surname>, trading as Unviewable' — matching
   * the name on the PAN you gave Razorpay, or activation will be rejected for
   * a name mismatch.
   */
  legalName: 'TODO proprietor legal name (as on PAN), trading as Unviewable',

  /** e.g. 'Sole Proprietorship', 'Private Limited Company', 'LLP'. */
  entityType: 'Sole Proprietorship',

  /**
   * Full registered address including PIN code. Must be findable on Google.
   *
   * TODO: '201013' is only a PIN code. Razorpay requires a complete,
   * externally verifiable address — building/flat, street, locality, city,
   * state, PIN.
   */
  registeredAddress:
    'TODO full address: building, street, locality, Noida, Uttar Pradesh 201013',

  /**
   * Operating address. Set equal to registeredAddress if identical.
   *
   * TODO: 'NCR, Noida' is too vague to verify. Use the same full-address
   * format as above.
   */
  operatingAddress:
    'TODO full operating address: building, street, locality, Noida, Uttar Pradesh 201013',

  /**
   * Reachable phone number including country code.
   *
   * Formatted with the +91 country code so the `tel:` link on /contact dials
   * correctly from outside India. Verify this is the number on your Razorpay
   * KYC — a mismatch is a common rejection reason.
   */
  phone: '+91 60064 64887',

  /** Support email. Matches SITE_META.contactEmail. */
  email: 'join.invisibleai@gmail.com',

  /**
   * GSTIN if registered, otherwise null.
   *
   * Note: you are charging 18% GST on top of ₹99. If you collect GST you
   * generally need to be registered and to show the GSTIN on invoices. Confirm
   * with a CA, then put the GSTIN here so it renders on /contact.
   */
  gstin: null as string | null,

  /**
   * Jurisdiction for the governing-law clause in /terms.
   *
   * A governing-law clause names a city AND state, so this is 'Noida, Uttar
   * Pradesh' rather than just 'Noida'.
   */
  jurisdiction: 'Noida, Uttar Pradesh',

  /** Support turnaround quoted in the legal copy. */
  supportResponseDays: 3,

  /** Refund window, in days from purchase. See /refund. */
  refundWindowDays: 7,
} as const;

export type BusinessInfo = typeof BUSINESS_INFO;

/**
 * Keys whose values still need work. Empty array means ready to submit to
 * Razorpay.
 */
export function findBusinessInfoPlaceholders(): string[] {
  return Object.entries(BUSINESS_INFO)
    .filter(
      ([, value]) => typeof value === 'string' && value.startsWith(TODO_PREFIX)
    )
    .map(([key]) => key);
}

export function isBusinessInfoComplete(): boolean {
  return findBusinessInfoPlaceholders().length === 0;
}
