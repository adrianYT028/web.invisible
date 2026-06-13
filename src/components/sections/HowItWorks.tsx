/**
 * HowItWorks — server-rendered three-step pipeline section.
 *
 * Renders the eyebrow, the section heading, the lede, three `<StepCard />`
 * instances numbered "01", "02", "03", and the compatibility callout. All
 * copy is hard-coded here because it is product copy — the strings stay
 * byte-identical to the legacy implementation in `src/app/page.tsx` so the
 * redesign is purely presentational (no SEO / IA shifts). The titles
 * `Launch the Overlay`, `Capture Context`, `Get Live Intelligence` and the
 * tech-note compatibility paragraph match the existing surface verbatim
 * (Req 8.1, 8.5).
 *
 * Layout responsibilities (Req 8.3, 8.4):
 *   The `.steps` grid is single-column under 1024px and switches to three
 *   equal columns at and above 1024px. A single absolutely positioned
 *   `<div class="steps-connector" aria-hidden="true">` is rendered as the
 *   first child of the grid; its `display` flips from `none` to `block` at
 *   the same breakpoint, so on mobile/tablet the connector is hidden and
 *   the cards stack vertically without any decorative line. The connector
 *   is a single 1px stroke painted in `var(--border)` — no animation, no
 *   gradient sweep, no expanding hover state (Req 8.4, 8.6).
 *
 * Accessibility:
 *   The eyebrow is a `<p class="eyebrow">` rather than a heading so the
 *   document outline goes `<h2>How It Works</h2>` directly — no skipped
 *   heading levels. The connector is `aria-hidden` because it carries no
 *   information that the visible step ordering does not already convey.
 *
 * Server-component rationale (Req 13.7, 13.8):
 *   Zero client interactivity. Every nested element is static markup.
 *   Marking this file `'use client'` would force the React handler runtime
 *   to ship for the home page even though nothing here listens for events.
 */

import { StepCard } from './StepCard';
import { Reveal } from '@/components/motion/Reveal';

export function HowItWorks() {
  return (
    <section className="how-it-works">
      <div className="how-it-works-section">
        <p className="eyebrow">How It Works</p>
        <h2>
          Three steps. Zero <em>traces</em>.
        </h2>
        <p className="lede">
          From launch to live intelligence — the entire pipeline runs silently in under 2 seconds.
        </p>
        <div className="steps">
          <div className="steps-connector" aria-hidden="true" />
          <Reveal delay={0}>
            <StepCard
              number="01"
              title="Launch the Overlay"
              description="Start the assistant with a single hotkey. The overlay attaches to your display and immediately becomes unviewable to every screen-capture and screen-share pipeline."
            />
          </Reveal>
          <Reveal delay={120}>
            <StepCard
              number="02"
              title="Capture Context"
              description="The system silently captures meeting audio and selected screen regions, feeding real-time context to the AI model — no virtual cables, no plugins."
            />
          </Reveal>
          <Reveal delay={240}>
            <StepCard
              number="03"
              title="Get Live Intelligence"
              description="AI-generated suggestions, answers, and talking points appear directly on your screen. Only you can see them. Screen recorders and participants see nothing."
            />
          </Reveal>
        </div>
        <div className="callout">
          <p>
            <strong>Compatibility:</strong> Requires Windows 10 version 2004 or later. Works with Zoom, Teams, Google Meet, Discord, OBS, and all DXGI-based capture tools.
          </p>
        </div>
      </div>
    </section>
  );
}
