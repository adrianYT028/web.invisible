import type { Metadata } from 'next';
import Link from 'next/link';

import { SiteShell } from '@/components/chrome/SiteShell';

export const metadata: Metadata = {
  title: 'Email preferences',
  robots: { index: false },
};

interface PageProps {
  searchParams: Promise<{ done?: string; error?: string }>;
}

const DONE_COPY: Record<string, string> = {
  reminders: 'You will no longer get follow-up reminders.',
  digest: 'You will no longer get the weekly jobs email.',
  all: 'You will no longer get any emails from us, apart from receipts for payments you make.',
};

export default async function UnsubscribedPage({ searchParams }: PageProps) {
  const { done, error } = await searchParams;
  return (
    <SiteShell>
      <section className="account-section">
        <div className="account-inner">
          <p className="eyebrow">Email preferences</p>
          {error ? (
            <>
              <h1>That link did not work.</h1>
              <p className="lede">
                It may have been copied incompletely. Reply to any of our emails
                and we will unsubscribe you by hand.
              </p>
            </>
          ) : (
            <>
              <h1>You are unsubscribed.</h1>
              <p className="lede">{DONE_COPY[done ?? 'all'] ?? DONE_COPY.all}</p>
            </>
          )}
          <p className="lede">
            <Link href="/">Back to Unviewable</Link>
          </p>
        </div>
      </section>
    </SiteShell>
  );
}
