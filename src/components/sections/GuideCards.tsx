import { GuideCard } from './GuideCard';
import { Reveal } from '@/components/motion/Reveal';

/**
 * GuideCards — the "Get Started" two-card surface on the home page.
 *
 * Server component. Renders exactly two `<GuideCard>` instances, one
 * pointing at `/guides/setup` and one at `/guides/usage`, satisfying
 * Req 9.1's "exactly two cards" requirement.
 *
 * Layout chrome:
 *   - `<section class="guide-cards-section">` wraps the surface in a
 *     `--section-y` vertical rhythm and a `--max-width` horizontal cap
 *     so the cards align with the `<FeatureGrid />` and `<HowItWorks />`
 *     sections that flank it on `/`.
 *   - The eyebrow "Get Started" + `<h2>` heading + lede paragraph carry
 *     the section's introductory copy. The lede is intentionally short
 *     so the cards stay above the fold on a 1366×768 laptop window.
 *   - `.guide-cards-grid` is a single column up to 768px and a 2-column
 *     grid above. The card widths are equal (1fr each) so the two paths
 *     read as peers, not a primary/secondary pair.
 *
 * Touch-target separation:
 *   The `.guide-cards-grid` gap is `var(--space-6)` (24px), already well
 *   above the 8px floor Req 12.2 enforces on `(pointer: coarse)`. The
 *   matching CSS rule re-states the floor explicitly via
 *   `gap: max(var(--space-6), 12px)` on `(pointer: coarse)` so future
 *   spacing-scale tweaks can never silently drop separation below 8px.
 *
 * Card content (text only — design owns this copy):
 *   - Setup Guide: download → install → launch in under two minutes,
 *     four bullets covering installer download, SmartScreen approval,
 *     overlay launch, and screen-share verification.
 *   - Usage Guide: how to operate the overlay during a live meeting,
 *     four bullets covering pre-call launch, region selection, hotkey
 *     control, and AI suggestion review.
 *
 * Icons:
 *   Inline SVG, 24×24, stroke-width 1.5, currentColor, `aria-hidden`.
 *   Setup uses a download-into-tray glyph; Usage uses an eye-on-monitor
 *   glyph. Both icons inherit color from the card so they retheme with
 *   the active theme without per-icon CSS.
 */
export function GuideCards() {
  return (
    <section className="guide-cards-section" aria-labelledby="guide-cards-heading">
      <div className="guide-cards-inner">
        <p className="eyebrow">Get Started</p>
        <h2 id="guide-cards-heading" className="guide-cards-title">
          Two short guides to get you <em>running</em>
        </h2>
        <p className="guide-cards-lede lede">
          Pick the guide that matches where you are. Setup walks you through
          installation in under two minutes; Usage shows you how to drive the
          overlay during a live call.
        </p>

        <div className="guide-cards-grid">
          <Reveal delay={0}>
            <GuideCard
              href="/guides/setup"
              icon={<SetupIcon />}
              title="Setup Guide"
              description="Download, install, and launch Unviewable on Windows in under two minutes — straight from the installer to a working stealth overlay."
              bullets={[
                'Download the Windows installer',
                'Approve SmartScreen and run setup',
                'Launch the stealth overlay',
                'Verify invisibility in Zoom or OBS',
              ]}
            />
          </Reveal>
          <Reveal delay={120}>
            <GuideCard
              href="/guides/usage"
              icon={<UsageIcon />}
              title="Usage Guide"
              description="Run the overlay discreetly during a live call — capture context, drive it with hotkeys, and read AI suggestions without anyone noticing."
              bullets={[
                'Launch before the call starts',
                'Select your context region',
                'Control with keyboard hotkeys',
                'Review AI suggestions in real time',
              ]}
            />
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/**
 * Setup icon — a download arrow descending into a tray. 24×24, stroke
 * `currentColor`, stroke-width 1.5 to match the rest of the icon system
 * (feature icons, CTA arrow). Decorative — `aria-hidden` because the
 * card's heading + description carry the accessible name.
 */
function SetupIcon() {
  return (
    <svg
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  );
}

/**
 * Usage icon — an eye on a monitor frame, evoking "watch the meeting,
 * read the suggestions". 24×24, stroke `currentColor`, stroke-width 1.5.
 * Decorative — `aria-hidden`.
 */
function UsageIcon() {
  return (
    <svg
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x={3} y={4} width={18} height={13} rx={2} />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
      <path d="M7.5 10.5c1.2-1.8 2.8-2.7 4.5-2.7s3.3.9 4.5 2.7c-1.2 1.8-2.8 2.7-4.5 2.7s-3.3-.9-4.5-2.7Z" />
      <circle cx={12} cy={10.5} r={1.25} />
    </svg>
  );
}
