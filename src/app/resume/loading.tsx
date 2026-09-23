import { PageSkeleton } from '@/components/chrome/PageSkeleton';

// Seven database call sites: plan, both quotas, and the recent scan list.
export default function Loading() {
  return <PageSkeleton wide rows={2} />;
}
