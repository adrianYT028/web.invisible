'use client';

import { useEffect, useState } from 'react';

/**
 * Tiny client island that performs the `window.location.href = 'unviewable://...'`
 * redirect. Server-rendered redirect() can't emit a custom protocol URL.
 *
 * Best-effort UX:
 *   - Issues the redirect on first render.
 *   - After 3 seconds, shows a "Try again" button that re-issues the
 *     redirect (helpful if the user clicked away from the protocol prompt).
 */
export default function RedirectToDesktop({
  deviceCode,
}: {
  deviceCode: string;
}) {
  const [showRetry, setShowRetry] = useState(false);
  const target = `unviewable://auth/callback?device_code=${encodeURIComponent(
    deviceCode
  )}`;

  useEffect(() => {
    // Defer one frame so React flushes the render before navigating away;
    // some browsers cancel the protocol prompt if it fires during render.
    const tid = window.setTimeout(() => {
      window.location.href = target;
    }, 50);
    const retryTid = window.setTimeout(() => setShowRetry(true), 3000);
    return () => {
      window.clearTimeout(tid);
      window.clearTimeout(retryTid);
    };
  }, [target]);

  if (!showRetry) return null;

  return (
    // PRIMARY: this only renders after the automatic hand-off has already failed
    // for three seconds. At that point it is the sole control on the screen and the
    // entire purpose of the page, so there is nothing for it to be secondary TO.
    <div className="account-actions" style={{ marginTop: '1.5rem' }}>
      <a className="cta cta-primary" href={target}>
        Open Unviewable Desktop
      </a>
    </div>
  );
}
