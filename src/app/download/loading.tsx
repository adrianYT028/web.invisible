import { PageSkeleton } from '@/components/chrome/PageSkeleton';

// Reads the entitlement and the latest release row before it can decide between
// a download button and a buy button.
export default function Loading() {
  return <PageSkeleton rows={2} />;
}
