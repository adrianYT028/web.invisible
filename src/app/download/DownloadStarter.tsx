'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * DownloadStarter — kicks off the installer download from the `/download`
 * confirmation page without navigating away.
 *
 * `href` is ALWAYS our own entitlement-gated endpoint
 * (`/api/download/windows`), never a provider URL. That route checks
 * `entitlements.download_access`, then 302s to a Supabase Storage signed URL
 * that expires in five minutes. Previously this component received a public
 * GitHub Releases URL as a prop, which meant the installer link shipped inside
 * the client bundle — anyone could read it from page source and share it, so
 * the login gate protected nothing. Passing only a relative API path keeps the
 * real asset location server-side.
 *
 * Because the signed object is served with `Content-Disposition: attachment`,
 * assigning `window.location` follows the redirect and begins a file save while
 * leaving this page on screen — which is what we want after the OAuth
 * round-trip (no more being stranded on Google's account chooser).
 *
 * The `started` ref guards against React StrictMode's double-invoke in
 * development so the download only fires once. The visible button is the manual
 * fallback if the browser blocks the automatic start.
 */
export function DownloadStarter({
  href,
  fileName,
}: {
  href: string;
  fileName?: string;
}) {
  const started = useRef(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const timer = setTimeout(() => {
      try {
        window.location.href = href;
      } catch {
        setFailed(true);
      }
    }, 600);

    return () => clearTimeout(timer);
  }, [href]);

  return (
    <div className="account-actions">
      <a className="cta cta-primary" href={href}>
        {failed ? 'Start download' : 'Download manually'}
      </a>
      {fileName ? <p className="download-filename">{fileName}</p> : null}
    </div>
  );
}

export default DownloadStarter;
