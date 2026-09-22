import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { SiteShell } from '@/components/chrome/SiteShell';
import { loadAccessContext } from '@/lib/plans/guard';
import {
  PLATFORM_SERVICES,
  SERVICE_LABELS,
  hasServiceAccess,
  isBundlePlan,
  type PlatformService,
} from '@/lib/plans/services';
import {
  FULL_ACCESS_PRICE,
  formatInr,
} from '@/lib/payments/pricing';
import { checkResumeQuota } from '@/lib/resume/quota';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseRouteClient } from '@/lib/supabase/route';

/**
 * `/services` — one place that shows all four services and whether this account
 * can use each of them.
 *
 * Until now the platform had four working services and no page that acknowledged
 * they existed: `/resume`, `/jobs`, `/jobs/discover` and `/prep` were reachable
 * only by typing the URL. A signed-in user had no way to discover the product
 * they had bought.
 *
 * ---------------------------------------------------------------------------
 * THE CARD LIST IS DERIVED
 *
 * Iterating `PLATFORM_SERVICES` rather than hand-listing four cards means a
 * service added to the registry appears here automatically, and one that is
 * removed cannot linger as a dead link. `SERVICE_ROUTES` below is the only
 * mapping this page owns, and its exhaustiveness is enforced by the
 * `Record<PlatformService, …>` type.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Your services',
  alternates: { canonical: '/services' },
  // Per-account state, not content.
  robots: { index: false },
};

interface ServiceCard {
  href: string;
  blurb: string;
  /** What the primary action says when the user has access. */
  action: string;
}

const SERVICE_ROUTES: Record<PlatformService, ServiceCard> = {
  resume: {
    href: '/resume',
    blurb:
      'Check whether a parser can read your resume at all, then score it against a job description and get a tailored rewrite.',
    action: 'Analyse a resume',
  },
  jobs: {
    href: '/jobs',
    blurb:
      'Every role you are pursuing, with its match score, stage and your notes. Exports to a spreadsheet.',
    action: 'Open your tracker',
  },
  outreach: {
    href: '/prep',
    blurb:
      'Prepare a batch of applications in one action: scored, rewritten, with a cold email drafted and the contact found.',
    action: 'Prepare applications',
  },
  desktop: {
    href: '/download',
    blurb:
      'The invisible overlay for Windows. Answers on screen, invisible to screen capture.',
    action: 'Get the download',
  },
};

export default async function ServicesPage() {
  const supabase = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login?redirectedFrom=%2Fservices');

  const ctx = await loadAccessContext(user.id);

  // The resume analyser is quota-bounded rather than gated (migration 011 gives
  // the free plan a deliberate one-a-day taster), so showing "locked" for it
  // would be wrong. Show what is actually left instead.
  const admin = supabaseAdmin();
  const [uploadQuota, scanQuota] = await Promise.all([
    checkResumeQuota(admin, user.id, 'upload', ctx.plan),
    checkResumeQuota(admin, user.id, 'scan', ctx.plan),
  ]);

  const full = isBundlePlan(ctx.plan);

  return (
    <SiteShell>
      <section className="account-section">
        <div className="account-inner account-inner--wide">
          <h1 className="section-serif-em">
            Everything on <em>one</em> account
          </h1>
          <p className="lede">
            {full
              ? 'You have full access. All four are unlocked.'
              : 'Signed in as ' + (user.email ?? 'your account') + '.'}
          </p>

          {/* ------------------------------------------------------------------
              ALTERNATING ROWS, patterned on the supplied services reference:
              each service gets a full-width band with its copy on one side and a
              visual on the other, sides swapping row to row.

              The visuals reuse the hero cube's mock-screen classes
              (`.cube-panel`, `.cube-bars`, `.cube-rows`, `.cube-mail-*`) rather
              than photography. The reference uses stock photos of designers at
              desks; there is no honest equivalent for software that has no
              physical form, and inventing one would say nothing about the
              product. Showing the actual output — a score breakdown, a ranked
              list, a drafted email — is both truthful and already in the site's
              visual language.
              ------------------------------------------------------------------ */}
          <div className="svc-rows">
            {PLATFORM_SERVICES.map((service) => {
              const card = SERVICE_ROUTES[service];
              const entitled = hasServiceAccess(ctx, service);
              const metered = service === 'resume';
              const open = metered || entitled;

              return (
                <section
                  key={service}
                  className="svc-row"
                  data-service={service}
                  data-open={open ? 'yes' : 'no'}
                >
                  <div className="svc-row-copy">
                    <h2 className="svc-row-title">{SERVICE_LABELS[service]}</h2>
                    <p className="svc-row-blurb">{card.blurb}</p>

                    <ul className="svc-row-points">
                      {SERVICE_POINTS[service].map((point) => (
                        <li key={point}>
                          <Chevron />
                          <span>{point}</span>
                        </li>
                      ))}
                    </ul>

                    {metered ? (
                      <p className="svc-row-meta">
                        {quotaLine('Uploads', uploadQuota.cap, uploadQuota.used)}
                        {' \u00b7 '}
                        {quotaLine('Scans', scanQuota.cap, scanQuota.used)}
                      </p>
                    ) : null}

                    {open ? (
                      <a className="cta cta-primary svc-row-cta" href={card.href}>
                        {card.action}
                      </a>
                    ) : (
                      /* No per-row buy button. One product, one payment, one buy
                         action — it lives in the banner at the end of the page. */
                      <p className="svc-row-locked">Included with full access</p>
                    )}
                  </div>

                  <div className="svc-row-visual" aria-hidden="true">
                    <div className="sim-window">
                      <div className="sim-titlebar">
                        <span className="sim-dots">
                          <i />
                          <i />
                          <i />
                        </span>
                        <span className="sim-url">{SERVICE_MOCK_TITLE[service]}</span>
                      </div>
                      <div className="sim-stage">{mockFor(service)}</div>
                    </div>
                  </div>
                </section>
              );
            })}
          </div>

          {full ? null : (
            <aside className="svc-upsell">
              <p className="svc-upsell-copy">
                <strong>
                  One payment of {formatInr(FULL_ACCESS_PRICE.totalAmountPaise)}
                </strong>{' '}
                unlocks all four, permanently. No subscription.
              </p>
              <a className="cta cta-primary svc-upsell-cta" href="/pricing">
                Get full access
              </a>
            </aside>
          )}
        </div>
      </section>
    </SiteShell>
  );
}

/**
 * The three concrete capabilities under each service.
 *
 * The reference lists sub-items beneath every service heading, and they do real
 * work here: "resume analyser" is a category, whereas "tells you if a parser can
 * read the file at all" is a reason to click. Typed against `PlatformService` so a
 * new service cannot ship without them.
 */
const SERVICE_POINTS: Record<PlatformService, readonly string[]> = {
  resume: [
    'Parse check — whether an ATS can read the file at all',
    'Requirement-by-requirement match against a real posting',
    'Tailored bullet rewrites, with no invented facts',
  ],
  jobs: [
    'Openings pulled from company boards, not aggregators',
    'Ranked against your parsed profile',
    'Pipeline stages, notes, and a spreadsheet export',
  ],
  outreach: [
    'A batch of applications prepared in one action',
    'Cold email drafted from the match report',
    'Contact taken only from what the posting publishes',
  ],
  desktop: [
    'Answers on screen during calls and interviews',
    'Invisible to screen capture and recording',
    'Yours permanently, on Windows',
  ],
};

/** Titlebar text for each service's mock screen. */
const SERVICE_MOCK_TITLE: Record<PlatformService, string> = {
  resume: 'resume — ats readiness',
  jobs: 'openings — matched to you',
  outreach: 'outreach — draft ready',
  desktop: 'meet — final-round interview',
};

/** Chevron for the capability lists. Drawn, not a "›" character. */
function Chevron() {
  return (
    <svg
      className="svc-chevron"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M6 3.5L10.5 8L6 12.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The mock screen beside each row.
 *
 * Illustrative sample values, not the signed-in user's data — the point is to show
 * the SHAPE of the output before you have any. Reusing the hero cube's classes
 * keeps one visual language for these mocks instead of a second parallel set.
 */
function mockFor(service: PlatformService) {
  if (service === 'resume') {
    const bars = [
      { label: 'Parse integrity', value: 100 },
      { label: 'Requirement coverage', value: 62 },
      { label: 'Keyword alignment', value: 77 },
      { label: 'Evidence quality', value: 63 },
    ];
    return (
      <div className="cube-panel">
        <p className="cube-score">
          <span className="cube-score-value">75</span>
          <span className="cube-score-max">/100 match</span>
        </p>
        <ul className="cube-bars">
          {bars.map((b) => (
            <li key={b.label}>
              <span className="cube-bar-label">{b.label}</span>
              <span className="cube-bar">
                <i style={{ width: `${b.value}%` }} />
              </span>
              <span className="cube-bar-value">{b.value}</span>
            </li>
          ))}
        </ul>
        <p className="cube-note">2 knockouts · 3 keywords missing</p>
      </div>
    );
  }

  if (service === 'jobs') {
    const roles = [
      { title: 'Backend Engineering Intern', org: 'Zenpay', fit: 78 },
      { title: 'Junior Platform Engineer', org: 'Zenpay · Remote', fit: 71 },
      { title: 'Data Analyst (Entry Level)', org: 'Lumen', fit: 66 },
      { title: 'Machine Learning Intern', org: 'Lumen', fit: 61 },
    ];
    return (
      <div className="cube-panel">
        <ul className="cube-rows">
          {roles.map((r) => (
            <li key={r.title}>
              <span className="cube-row-main">
                <strong>{r.title}</strong>
                <span className="cube-row-sub">{r.org}</span>
              </span>
              <span className="cube-fit">{r.fit}</span>
            </li>
          ))}
        </ul>
        <p className="cube-note">Example ranking</p>
      </div>
    );
  }

  if (service === 'outreach') {
    return (
      <div className="cube-panel">
        <p className="cube-mail-to">
          <span className="cube-mail-label">To</span> careers@zenpay.example
        </p>
        <p className="cube-mail-subject">
          Backend Engineering Intern — Aarav Sharma
        </p>
        <p className="cube-mail-body">
          I rebuilt a payment reconciliation job in Python and cut median API
          latency from 420 ms to 180 ms. Your posting asks for exactly that.
        </p>
        <p className="cube-note">You review and send it yourself</p>
      </div>
    );
  }

  return (
    <>
      <div className="sim-grid">
        <div className="sim-tile">
          <span className="sim-avatar">AR</span>
          <span className="sim-name">A. Rivera — Interviewer</span>
        </div>
        <div className="sim-tile">
          <span className="sim-avatar">SC</span>
          <span className="sim-name">S. Chen — Panel</span>
        </div>
        <div className="sim-tile sim-tile--you">
          <span className="sim-avatar">You</span>
          <span className="sim-name">You — Sharing screen</span>
        </div>
        <div className="sim-tile">
          <span className="sim-avatar">MK</span>
          <span className="sim-name">M. Kim — Recruiter</span>
        </div>
      </div>
      <div className="sim-overlay">
        <p className="sim-overlay-head">UNVIEWABLE — STEALTH ON</p>
        <p className="sim-overlay-q">“How would you scale this 10×?”</p>
        <p className="sim-overlay-a">
          <strong>→</strong> Cache the read path, then split reads onto replicas.
        </p>
      </div>
    </>
  );
}

/** `null` cap means unlimited, matching the `feature_limits` convention. */
function quotaLine(label: string, cap: number | null, used: number): string {
  if (cap === null) return `${label}: unlimited`;
  return `${label}: ${Math.max(cap - used, 0)} of ${cap} left today`;
}
