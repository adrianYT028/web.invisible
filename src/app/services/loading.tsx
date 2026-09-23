import { PageSkeleton } from '@/components/chrome/PageSkeleton';

// `/services` is the slowest page in the app: nine database call sites before it
// returns any markup (plan, entitlement, and both resume quotas). Four rows,
// matching the four service bands, and the wide container the real page uses.
export default function Loading() {
  return <PageSkeleton wide rows={4} />;
}
