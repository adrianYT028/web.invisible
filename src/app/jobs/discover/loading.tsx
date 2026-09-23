import { PageSkeleton } from '@/components/chrome/PageSkeleton';

// Discover queries the shared posting index, which is the largest table in the
// database (1,663 rows at the time of writing), so this is worth having.
export default function Loading() {
  return <PageSkeleton wide rows={5} />;
}
