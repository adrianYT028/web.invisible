/**
 * StepCard — token-driven server component used by `<HowItWorks />`.
 *
 * Renders one cell of the three-step pipeline with a single mono numeral,
 * an `<h3>` title, and a short description paragraph. The numeral is
 * marked `aria-hidden` so assistive tech reads the title rather than the
 * raw "01" / "02" / "03" string — the position of the step is conveyed by
 * the document order of the cards in `<HowItWorks />`, not the digit.
 *
 * Why this is a server component (Req 13.7, 13.8):
 *   The card has no state, no event handlers, no observers. Hover styling
 *   (border colour + shadow only — no transform on the numeral) lives in
 *   `globals.css` under `.step-card`, so React never has to cross the
 *   client boundary for any of this.
 *
 * Numbering is typed as the literal union `'01' | '02' | '03'` so callers
 * cannot accidentally pass an unzero-padded value or a non-step number.
 * The numeral is rendered with `font-family: var(--font-mono)` and
 * `clamp(2rem, 2vw + 1.5rem, 3rem)` for a 32–48px range that scales
 * smoothly between mobile and desktop without the discrete breakpoints
 * the legacy `.step-number` rule used (Req 8.4).
 *
 * What this component does NOT do (Req 8.6, 8.7, 15.2, 15.6):
 *   - No `.scale-in`, `.fade-in-up`, or any other entrance animation
 *     class. Step cards are visible from the first paint.
 *   - No `IntersectionObserver` watching the card. Scroll position has no
 *     effect on the rendering.
 *   - No hover transform on `.step-number`. Only `border-color` and
 *     `box-shadow` on the card itself transition on hover.
 */

type StepNumber = '01' | '02' | '03';

type StepCardProps = {
  number: StepNumber;
  title: string;
  description: string;
};

export function StepCard({ number, title, description }: StepCardProps) {
  return (
    <article className="step-card">
      <span className="step-number" aria-hidden="true">
        {number}
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
    </article>
  );
}
