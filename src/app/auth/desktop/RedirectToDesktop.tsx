'use client';

import { useEffect } from 'react';

/**
 * Tiny client island that performs the `window.location.href = 'unviewable://...'`
 * redirect. Server-rendered redirect() can't emit a custom protocol URL.
 *
 * Best-effort UX:
 *   - Issues the redirect automatically right after first render.
 *   - Shows an "Open Unviewable Desktop" link from the start. Chrome can
 *     silently block a protocol launch that isn't tied to a user gesture (the
 *     automatic attempt runs from a timer), so a click on this link is the
 *     reliable path to the browser's "Open Unviewable?" prompt.
 */
export default function RedirectToDesktop({
  deviceCode,
}: {
  deviceCode: string;
}) {
  const target = `unviewable://auth/callback?device_code=${encodeURIComponent(
    deviceCode
  )}`;

  useEffect(() => {
    // Defer one frame so React flushes the render before navigating away;
    // some browsers cancel the protocol prompt if it fires during render.
    const tid = window.setTimeout(() => {
      window.location.href = target;
    }, 50);
    return () => {
      window.clearTimeout(tid);
    };
  }, [target]);

  return (
    // PRIMARY: the link is the only control on the page and its whole purpose.
    // It is visible immediately because a user click is what lets the browser
    // open the app when the automatic attempt is blocked.
    <div className="account-actions" style={{ marginTop: '1.5rem' }}>
      <a className="cta cta-primary" href={target}>
        Open Unviewable Desktop
      </a>
    </div>
  );
}
