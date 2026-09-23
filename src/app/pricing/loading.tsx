import { PageSkeleton } from '@/components/chrome/PageSkeleton';

// Measured at 390-450ms on production against ~175ms for a static page, because
// it reads the plan and the entitlement to decide whether to show a buy button or
// "you already own this". One card, wide container.
export default function Loading() {
  return <PageSkeleton wide rows={1} />;
}
