import { PageSkeleton } from '@/components/chrome/PageSkeleton';

// The account page reads the profile, the entitlement and the key vault. It uses
// the wide container (`.account-inner--wide`) — note that class is explicit rather
// than a `:has()` rule, because `:has()` selectors are dropped by this project's
// CSS compilation and never reach the browser.
export default function Loading() {
  return <PageSkeleton wide rows={3} />;
}
