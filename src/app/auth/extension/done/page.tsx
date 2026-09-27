import type { Metadata } from 'next';

import { SiteShell } from '@/components/chrome/SiteShell';

/**
 * `/auth/extension/done` — landing page after the user approves the extension.
 *
 * The extension watches the tab it opened for this URL and then redeems its
 * device code; this page only has to tell the human what happened. It holds no
 * secret and does nothing on load. `?status=error` is set by the approve action
 * when the link code could not be stored.
 */

export const metadata: Metadata = {
  title: 'Extension connected',
  robots: { index: false },
};

interface PageProps {
  searchParams: Promise<{ status?: string }>;
}

export default async function ExtensionDonePage({ searchParams }: PageProps) {
  const { status } = await searchParams;
  const failed = status === 'error';

  return (
    <SiteShell hideFooter>
      <section className="account-section">
        <div className="account-inner">
          <p className="eyebrow">Browser extension</p>
          {failed ? (
            <>
              <h1>That did not go through.</h1>
              <p className="lede">
                Close this tab and click <em>Connect</em> in the extension again.
              </p>
            </>
          ) : (
            <>
              <h1>Extension connected.</h1>
              <p className="lede">
                You can close this tab. Open any job posting and click the
                Unviewable icon to save it to your tracker.
              </p>
            </>
          )}
        </div>
      </section>
    </SiteShell>
  );
}
