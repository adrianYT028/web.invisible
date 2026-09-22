import {
  SERVICE_LABELS,
  type PlatformService,
} from '@/lib/plans/services';
import {
  FULL_ACCESS_PRICE,
  formatInr,
  formatPriceDisclosure,
} from '@/lib/payments/pricing';

/**
 * `<ServicePaywall />` — what a signed-in user without full access sees in place
 * of a gated service.
 *
 * Renders instead of redirecting to `/pricing`. A redirect loses the context of
 * what the person was trying to do and reads as a dead end; naming the specific
 * thing they wanted, and what it does, is both more honest and more likely to
 * convert. It is also the difference between "this page is broken" and "this
 * page costs money".
 *
 * The API is gated independently (`requireService`), so this component is purely
 * presentational — nothing here is load-bearing for access control.
 */
export function ServicePaywall({
  service,
  blurb,
}: {
  service: PlatformService;
  /** One line on what the user is missing, in their terms. */
  blurb: string;
}) {
  const price = FULL_ACCESS_PRICE;

  return (
    <div className="account-block">
      <p className="eyebrow">Full access needed</p>
      <h2>{SERVICE_LABELS[service]}</h2>
      <p className="lede">{blurb}</p>
      <p className="lede">
        This is part of Unviewable full access — a single payment of{' '}
        <strong>{formatInr(price.totalAmountPaise)}</strong>, no subscription.
      </p>
      <p className="account-actions">
        <a className="cta cta-primary" href="/pricing">
          See what full access includes
        </a>
      </p>
      <p className="price-note">{formatPriceDisclosure(price)}</p>
      <p className="download-note">
        Already paid on another account? Check which one you are signed in as on{' '}
        <a href="/account">your account page</a>.
      </p>
    </div>
  );
}

export default ServicePaywall;
