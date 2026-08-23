import type { ReactNode } from 'react';

import { SiteShell } from '@/components/chrome/SiteShell';
import { findBusinessInfoPlaceholders } from '@/components/constants/business-info';

/**
 * Shared frame for the five policy pages (/about, /contact, /terms, /privacy,
 * /refund).
 *
 * Server component, zero JS. Reuses the existing `account-section` /
 * `account-inner` / `eyebrow` / `lede` / `surface` token classes so the legal
 * pages inherit the site's type scale and spacing without new CSS.
 *
 * The placeholder notice renders ONLY outside production. Its job is to stop a
 * half-filled Contact page reaching Razorpay's reviewer during development; it
 * is deliberately invisible in production so a missed value never renders a
 * scary banner to a paying customer. That also means it is not a safety net —
 * check `findBusinessInfoPlaceholders()` before you submit for activation.
 */
export function LegalShell({
  eyebrow,
  title,
  lede,
  lastUpdated,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  lede?: ReactNode;
  lastUpdated: string;
  children: ReactNode;
}) {
  const missing =
    process.env.NODE_ENV === 'production' ? [] : findBusinessInfoPlaceholders();

  return (
    <SiteShell>
      <section className="account-section">
        <div className="account-inner legal-body">
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          {lede ? <p className="lede">{lede}</p> : null}

          {missing.length > 0 ? (
            <div className="surface legal-placeholder-notice" role="alert">
              <p>
                <strong>Development notice — not shown in production.</strong>{' '}
                {missing.length} business detail
                {missing.length === 1 ? '' : 's'} still unset in{' '}
                <code>src/components/constants/business-info.ts</code>:{' '}
                <code>{missing.join(', ')}</code>. Razorpay activation will fail
                until these are real, verifiable values.
              </p>
            </div>
          ) : null}

          {children}

          <p className="legal-updated">Last updated: {lastUpdated}</p>
        </div>
      </section>
    </SiteShell>
  );
}

export default LegalShell;
