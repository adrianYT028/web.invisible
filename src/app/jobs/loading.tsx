import { PageSkeleton } from '@/components/chrome/PageSkeleton';

// The tracker reads the access context and then the tracked-jobs list, so the
// row count here stands in for table rows rather than cards.
export default function Loading() {
  return <PageSkeleton wide rows={4} />;
}
