'use client';

import { useEffect, useRef } from 'react';

/**
 * DownloadStarter — kicks off the actual file download from the
 * `/download` interstitial without navigating away.
 *
 * The release asset (`url`) is served with Content-Disposition: attachment,
 * so assigning `window.location` to it begins a download and leaves this
 * page on screen — which is exactly what we want after the OAuth round-trip
 * (no more being stranded on Google's account chooser).
 *
 * A short delay lets the confirmation copy paint first. The `started` ref
 * guards against React StrictMode's double-invoke in development so the
 * download is only triggered once. The visible button is the manual
 * fallback in case the browser blocks the automatic start.
 */
export function DownloadStarter({ url }: { url: string }) {
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const timer = setTimeout(() => {
      window.location.href = url;
    }, 600);

    return () => clearTimeout(timer);
  }, [url]);

  return (
    <div className="account-actions">
      <a className="cta cta-primary" href={url}>
        Download manually
      </a>
    </div>
  );
}

export default DownloadStarter;
