import type { Metadata } from 'next';

import { SiteShell } from '@/components/chrome/SiteShell';
import { HeroSection } from '@/components/hero/HeroSection';
import { SITE_META } from '@/components/constants/site-meta';

export const metadata: Metadata = {
  title: 'Download Unviewable for Windows',
  description:
    'Download the latest version of Unviewable — a stealth AI overlay for meetings and interviews. Free for Windows 10+. No traces, no detection.',
  alternates: { canonical: '/downloads' },
  openGraph: {
    title: 'Download Unviewable for Windows',
    description:
      'Download the latest version of Unviewable — a stealth AI overlay for meetings and interviews.',
    url: '/downloads',
  },
};

/**
 * Downloads page — single-CTA hero plus a tokenized `.surface` card listing
 * the system requirements.
 *
 * Server component (no `'use client'`). The hero ships zero JavaScript on
 * this route: the spotlight prop is intentionally omitted, so
 * <HeroSpotlight /> never mounts and the pointer-tracking client bundle
 * never reaches `/downloads` (Req 2.5). The download CTA is a plain
 * native `<a download>` rendered by `<CtaButton variant="primary">`, so
 * activating it triggers the browser's file-save flow with no JS in
 * between.
 *
 * Layout (Req 9.2, 12.1):
 *   - The system-requirements block is the redesign's tokenized `.surface`
 *     replacement for the legacy `.glass-panel` blur card. Visuals come
 *     entirely from `:root[data-theme]` tokens (background
 *     `var(--surface-raised)`, 1px `var(--border)`, `var(--radius-card)`
 *     corners) — no gradients, no drop shadows, no ambient glow, no
 *     backdrop-filter.
 *   - The `<h2>` sits outside the `.surface` so the heading reads against
 *     the page background and the surface card carries only the bullet
 *     list, mirroring the rhythm used by the other section surfaces in
 *     the redesign.
 *   - A final mono `<p>` line restates the `Current version v{…}` so the
 *     version text appears in the same typographic family as the version
 *     pill that trails the hero CTA — a paint-only confirmation, not a
 *     separate card.
 *
 * The version pill that trails the hero CTA is rendered inline as
 * `<span class="cta-version">` so it inherits the CTA's flex row gap and
 * reads as part of the same action. The same `.cta-version` class is
 * reused in the body copy below so the version label keeps a consistent
 * shape on the page.
 */
export default function DownloadsPage() {
  return (
    <SiteShell>
      <HeroSection
        eyebrow="Download"
        headline={
          <>
            Get Unviewable
            <br />
            for <em>Windows</em>
          </>
        }
        sub="Free download. No subscription, no telemetry, no traces. Requires Windows 10 version 2004 or later."
        primary={{
          // Login-gated dispatcher (src/app/download/route.ts). The page is
          // public for indexing; the file itself requires a signed-in user.
          label: 'Download for Windows',
          href: '/download',
          variant: 'primary',
          trailing: (
            <span className="cta-version">v{SITE_META.softwareVersion}</span>
          ),
        }}
      />

      <section className="downloads-requirements" aria-label="System requirements">
        <p className="eyebrow">Spec sheet</p>
        <h2>
          System <em>requirements</em>
        </h2>
        <div className="surface">
          <ul>
            <li>Windows 10 version 2004 or later</li>
            <li>4 GB RAM minimum (8 GB recommended)</li>
            <li>50 MB disk space</li>
            <li>Active internet connection for AI features</li>
            <li>
              Compatible with Zoom, Teams, Google Meet, Discord, OBS, and all
              DXGI-based capture tools
            </li>
          </ul>
        </div>
        <p>
          Current version{' '}
          <span className="cta-version">v{SITE_META.softwareVersion}</span>
        </p>
      </section>
    </SiteShell>
  );
}
