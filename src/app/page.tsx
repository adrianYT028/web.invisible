/**
 * Home — the marketing surface at `/`.
 *
 * This file is a server component (note the absence of `'use client'`) and
 * is purely structural: it composes the redesigned section components in
 * order under <SiteShell>. None of the legacy ambient layer (the canvas
 * particle field, the texture/scan overlays, the hero glow band, the
 * IntersectionObserver-driven reveal hooks, and the decorative section
 * separator sentinels) and none of the legacy chrome (inline `<header>` /
 * `<footer>`) live here anymore.
 *
 * Why this is a server component:
 *   - The hero <h1> is the LCP candidate and must paint server-side
 *     without waiting on JS (Req 1.1).
 *   - All five public sections (hero, trust strip, features, how-it-works,
 *     guide cards) render deterministic markup. The only client islands
 *     mounted from this tree are <HeroSpotlight> (inside HeroSection,
 *     gated on the `spotlight` prop), <Header> + <ThemeToggle> +
 *     <MobileMenu> (inside SiteShell), and <HomeClient> (the auth-gated
 *     review-form lazy island below). Anonymous visitors never download
 *     the review-form chunk because <HomeClient> short-circuits to `null`
 *     until `supabase.auth.getUser()` resolves with a signed-in user
 *     (Req 13.7).
 *
 * Hero copy (preserved positioning, restyled chrome — Req 1.1, 6.1, 6.2):
 *   - eyebrow         → "Stealth-mode AI overlay"
 *   - headline        → "The intelligence / they can't see." (the manual
 *                       <br/> mirrors the legacy two-line break the design
 *                       calls for; the headline ships server-rendered so
 *                       it remains the LCP candidate).
 *   - sub             → one-sentence positioning copy ≤160 chars.
 *   - primary CTA     → Windows download URL from `SITE_META.downloadUrl`,
 *                       `download={true}` to preserve the legacy native
 *                       anchor download semantics, `trailing` carries the
 *                       version pill so the CTA reads "Download for
 *                       Windows v2.0.0" (Req 6.7).
 *   - secondary CTA   → `state: 'coming-soon'` so the Mac action is the
 *                       inert disabled variant — it never navigates,
 *                       never downloads, and reports `aria-disabled=true`
 *                       to assistive tech (Req 6.2). The trailing
 *                       "Coming Soon" pill mirrors the legacy badge.
 *
 * What was deleted from the legacy `page.tsx`:
 *   - The two ambient-layer custom hooks that drove the canvas particle
 *     field and the IntersectionObserver-driven reveal animations
 *     (Req 2.1, 15.2, 15.7).
 *   - The `<canvas id="particles">`, the texture overlay, the scan
 *     overlay, the hero glow band, and every decorative section
 *     separator sentinel.
 *   - Every legacy entrance-reveal className that the deleted hooks
 *     applied (Req 15.2).
 *   - The inline `onMouseMove` handler on every `.feature-card` that set
 *     the cursor-tracking glass-panel gradient (Req 7.4).
 *   - The inline `<header className="site-header">` and
 *     `<footer className="site-footer">` (now in <SiteShell>).
 *   - The auth-conditional `<section className="reviews">` and
 *     `<section className="video-section" id="account">` blocks (the
 *     review form moved into <HomeClient> per task 6.1; the dedicated
 *     `/account` route owns the account surface per the design's routing
 *     map).
 *
 * What was preserved (the redesign is purely presentational):
 *   - All feature copy (Stealth Execution, Audio Loopback, Vision
 *     Context — now inside <FeatureGrid>).
 *   - All step copy and the compatibility callout (now inside
 *     <HowItWorks>).
 *   - The CTA download URL (`SITE_META.downloadUrl`) and the version
 *     label (`v{SITE_META.softwareVersion}`).
 *   - The review form fields, validation rules, error strings, and the
 *     `/api/reviews` POST body shape — now inside <ReviewForm>, mounted
 *     by <HomeClient> only for authenticated visitors.
 *
 * No `metadata` export here — the legacy `page.tsx` never declared one,
 * and the page title + description still come from the defaults set in
 * `app/layout.tsx`.
 */

import { SiteShell } from '@/components/chrome/SiteShell';
import { HeroSection } from '@/components/hero/HeroSection';
import { TrustStrip } from '@/components/sections/TrustStrip';
import { FeatureGrid } from '@/components/sections/FeatureGrid';
import { HowItWorks } from '@/components/sections/HowItWorks';
import { GuideCards } from '@/components/sections/GuideCards';
import { SITE_META } from '@/components/constants/site-meta';
import { Reveal } from '@/components/motion/Reveal';

import { HomeClient } from './HomeClient';

export default function HomePage() {
  return (
    <SiteShell>
      <HeroSection
        eyebrow="Stealth-mode AI overlay"
        headline={
          <>
            The intelligence
            <br />
            they can&apos;t see.
          </>
        }
        sub="A 100% unviewable AI assistant for high-stakes interviews and meetings. Bypasses every screen-capture pipeline."
        primary={{
          label: 'Download for Windows',
          href: SITE_META.downloadUrl,
          variant: 'primary',
          download: true,
          trailing: (
            <span className="cta-version">v{SITE_META.softwareVersion}</span>
          ),
        }}
        secondary={{
          label: 'Mac',
          state: 'coming-soon',
          trailing: <span className="cta-version">Coming soon</span>,
        }}
        spotlight
      />
      <Reveal><TrustStrip /></Reveal>
      <Reveal><FeatureGrid /></Reveal>
      <Reveal><HowItWorks /></Reveal>
      <Reveal><GuideCards /></Reveal>
      <HomeClient />
    </SiteShell>
  );
}
