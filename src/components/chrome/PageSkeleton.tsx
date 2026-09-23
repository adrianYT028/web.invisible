import { SiteShell } from '@/components/chrome/SiteShell';

// -----------------------------------------------------------------------------
// Loading placeholder for the server-rendered pages
// -----------------------------------------------------------------------------
//
// WHY THIS EXISTS
//
// Ten pages read the database inside the server component before returning any
// markup, and none of them had a Suspense boundary. Without one, Next has nothing
// to paint for the new route, so it keeps the OLD page on screen until the server
// is done. Measured against production: static pages settle around 175ms while
// `/pricing` is consistently 390-450ms, and `/services` does more than twice its
// database work. That gap is dead time where a click looks ignored — which reads
// as the app being stuck rather than as the app loading.
//
// A `loading.tsx` exporting this turns that into an immediate paint: the header
// and footer are real, the page body is a placeholder, and the content streams in
// when it is ready. The navigation stops feeling blocked without the pages
// themselves getting any faster.
//
// ---------------------------------------------------------------------------
// WHY IT DOES NOT SHIMMER
//
// A sweeping gradient is the usual house style for this and it is wrong here.
// This stylesheet turns down animation deliberately and repeatedly — "no shimmer
// sweep, no pulsing border, no animated gradient stroke, no glow" appears against
// several components. A skeleton that sweeps would be the loudest thing on a
// quiet site, and it would draw the eye for 400ms and then vanish.
//
// So the blocks are flat, static, and low contrast. They mark out where content
// will be without asking to be looked at. `--skeleton-fade` is a single gentle
// opacity settle, disabled under `prefers-reduced-motion`.
//
// ---------------------------------------------------------------------------
// ACCESSIBILITY
//
// `aria-busy` with a polite live region announces the state once, rather than
// letting a screen reader read out a dozen meaningless empty boxes. The blocks
// themselves are `aria-hidden` for the same reason.
// -----------------------------------------------------------------------------

interface PageSkeletonProps {
  /**
   * Matches `.account-inner--wide` on the real page. Getting this wrong is
   * visible: the placeholder would sit at a different width than the content that
   * replaces it, so the layout jumps at exactly the moment it settles.
   */
  wide?: boolean;
  /** Roughly how many content blocks the real page shows. */
  rows?: number;
  /** Set when the real page leads with a large heading and a lede paragraph. */
  hasLede?: boolean;
}

export function PageSkeleton({
  wide = false,
  rows = 3,
  hasLede = true,
}: PageSkeletonProps) {
  return (
    <SiteShell>
      <section className="account-section">
        <div
          className={`account-inner${wide ? ' account-inner--wide' : ''}`}
          aria-busy="true"
        >
          {/* Announced once. Without this the only cue is visual. */}
          <p className="sr-only" role="status">
            Loading…
          </p>

          <div className="skeleton-group" aria-hidden="true">
            <div className="skeleton-block skeleton-title" />
            {hasLede ? <div className="skeleton-block skeleton-lede" /> : null}

            <div className="skeleton-rows">
              {Array.from({ length: rows }, (_, i) => (
                <div className="skeleton-card" key={i}>
                  <div className="skeleton-block skeleton-line skeleton-line--head" />
                  <div className="skeleton-block skeleton-line" />
                  <div className="skeleton-block skeleton-line skeleton-line--short" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </SiteShell>
  );
}
