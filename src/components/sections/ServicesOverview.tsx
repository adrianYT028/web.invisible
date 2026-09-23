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
 * WHY THIS IS ADDITIVE RATHER THAN A REWRITE
 *
 * The hero above it still positions Unviewable as the invisible overlay, and that
 * copy is deliberate brand work ("The intelligence they can't see"). Rewriting it
 * to lead on four services is a positioning decision with real consequences for
 * how the product is understood, and it belongs to whoever owns the brand — not
 * to a refactor.
 *
 * So this section adds the breadth without touching the hero: a visitor arriving
 * for the overlay still finds what they came for, and now also learns the other
 * three services exist. If the positioning does change later, this is the section
 * that gets promoted, and nothing has to be untangled first.
 *
 * The list iterates `PLATFORM_SERVICES`, so marketing copy cannot claim a service
 * the code does not actually unlock.
 */

/** One line per service, aimed at someone who has not used the product. */
const PITCH: Record<PlatformService, string> = {
  resume:
    'Find out whether a parser can even read your resume, then see requirement by requirement what a job asks for and what you actually evidence.',
  jobs: 'Live openings from company job boards, ordered by how much of your resume they ask for.',
  outreach:
    'Prepare a batch of applications in one action — scored, rewritten toward each role, with the cold email drafted for you to send.',
  desktop:
    'Answers on your screen during interviews and meetings, invisible to screen capture.',
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
          getting through the call itself. One payment covers all four.
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
          <a className="cta cta-primary" href="/pricing">
            See pricing
          </a>
        </p>
      </div>
    </section>
  );
}

export default ServicesOverview;
