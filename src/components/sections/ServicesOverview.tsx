import {
  PLATFORM_SERVICES,
  SERVICE_LABELS,
  type PlatformService,
} from '@/lib/plans/services';

/**
 * `<ServicesOverview />` — the landing-page section that says the product is more
 * than the desktop app.
 *
 * ---------------------------------------------------------------------------
 * POSITIONING (updated 2026-09)
 *
 * The positioning has since changed: the hero now leads on the job-search suite
 * ("Everything you need to get hired"), and the site metadata, OG card and JSON-LD
 * were brought in line with it (see src/app/layout.tsx). This section is the
 * breadth statement directly under the hero; the desktop overlay is one of the
 * four services listed, not the headline.
 *
 * The list iterates `PLATFORM_SERVICES`, so marketing copy cannot claim a service
 * the code does not actually unlock.
 */

/** One line per service, aimed at someone who has not used the product. */
const PITCH: Record<PlatformService, string> = {
  resume:
    'Find out whether software can read your resume, see what a job asks for that yours does not show, and download a stronger version. Writes your LinkedIn profile too.',
  jobs: 'Openings matched to your resume, and a free tracker with follow-up reminders. Save jobs from any site with the browser extension.',
  outreach:
    'Prepare a batch of applications in one action — scored, rewritten toward each role, with the cold email drafted for you to send.',
  desktop:
    'Practise real interview questions on the website with feedback on every answer, then use the Windows app for notes on screen during the call.',
};

export function ServicesOverview() {
  return (
    // Structure mirrors <FeatureGrid /> exactly — `.features` > `.features-section`
    // > `.features-grid` > `.feature-card` — because those are the classes that
    // actually exist in globals.css. An earlier draft of this file invented
    // `.feature-grid` and `.section-inner`, which would have rendered the whole
    // section unstyled while typechecking and building perfectly happily.
    <section className="features" id="services">
      <div className="features-section">
        <p className="eyebrow">What you get</p>
        <h2>
          The whole job hunt, <em>not just</em> the interview
        </h2>
        <p className="lede">
          Finding a role, tailoring your resume to it, writing the cold email, and
          getting through the interview. Start free: the job tracker, openings, a
          daily resume check and interview practice cost nothing.
        </p>

        {/* `services-grid` pins this to two columns. The shared `features-grid`
            goes to three at desktop, which is right for the feature list but
            leaves FOUR services as 3 + 1 — an orphan on its own row, which is
            what made the desktop-app card look short and left dead space beside
            it. Two columns is 2x2, so both rows are full and equal height. */}
        <div className="features-grid services-grid">
          {PLATFORM_SERVICES.map((service) => (
            <article className="feature-card" key={service}>
              <h3>{SERVICE_LABELS[service]}</h3>
              <p>{PITCH[service]}</p>
            </article>
          ))}
        </div>

        {/* PRIMARY. This is the only action in the section and the conversion path
            out of it — a marketing block that ends in a ghost link is asking for
            nothing. `ServicePaywall` already treats /pricing as primary, so this
            also makes the two agree. */}
        <p className="account-actions">
          <a className="cta cta-primary" href="/ats-checker">
            Check my resume free
          </a>
          <a className="cta cta-secondary" href="/pricing">
            See pricing
          </a>
        </p>
      </div>
    </section>
  );
}

export default ServicesOverview;
