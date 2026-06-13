import type { ReactNode } from 'react';

import { GuideStep } from '@/components/guides/GuideStep';
import { TableOfContents } from '@/components/guides/TableOfContents';

/**
 * GuideShell — top-level layout for `/guides/setup` and `/guides/usage`.
 *
 * Server component. Ships zero JS itself; the only client island in the
 * tree below is `<TableOfContents />`, which the layout mounts inside
 * an aside that's `display: none` below 1280px so the JS bundle still
 * downloads but never runs visible work on narrow viewports.
 *
 * Heading hierarchy (Req 9.3, 14.5):
 *   Each guide page has exactly one `<h1>` (rendered here in the hero
 *   band) followed by a flat sequence of `<h2>` step headings (rendered
 *   by `<GuideStep />`). No `<h3>` appears before the first `<h2>` —
 *   any sub-points inside a step body are paragraphs, not headings.
 *   The page-level Suspense and route metadata are owned by the route
 *   component (`src/app/guides/<slug>/page.tsx`) so this shell focuses
 *   purely on layout.
 *
 * Layout (Req 9.4):
 *   - Hero band: a centred eyebrow + h1 + lede stack with the same
 *     spacing rhythm as `<HeroSection />`. Lives inside `.guide-hero`.
 *   - Body: a single column at viewport widths below 1280px (the TOC
 *     aside is hidden via CSS), and a 2-column grid above with the
 *     sticky `<TableOfContents />` on the left and the step content
 *     on the right. The content column is `1fr` so step screenshots
 *     can occupy the full available width without the TOC squeezing
 *     them. The TOC column is fixed at `200px`.
 *
 *   Layout discipline:
 *     The layout breakpoint at 1280px is intentional and aligned with
 *     `--max-width: 1200px`. Below 1280 the TOC would compete with
 *     guide content for limited horizontal space; above 1280 the page
 *     has 80px of slack (1280 − 1200) into which the TOC's 200px
 *     column fits comfortably with a small grid gap.
 *
 * Step iteration:
 *   Each step in `steps` becomes a `<GuideStep>` instance. The shell
 *   forwards `id`, `title`, and `image` props directly, plus the
 *   per-step `body` ReactNode as children. The TOC is built by mapping
 *   `steps` to `{ id, title }` so the two views of the page share a
 *   single source of truth (the component does not query the DOM for
 *   headings — see `<TableOfContents />` doc).
 */
export type GuideStepData = {
  /** Anchor id used for the TOC link target and the section's `id`. */
  id: string;
  /** Step heading rendered as `<h2>` inside `<GuideStep />`. */
  title: string;
  /** Optional screenshot — see `<ScreenshotFrame />` for the contract. */
  image?: {
    src: string;
    alt: string;
    width: number;
    height: number;
  };
  /** Body copy for the step (paragraphs, lists, callouts). */
  body: ReactNode;
};

export type GuideShellProps = {
  /** Mono caption above the h1 (e.g. "Install & run"). */
  eyebrow: string;
  /**
   * The single h1 for the route (e.g. "Setup guide"). Accepts ReactNode so
   * callers can wrap one word in `<em>` for the editorial serif emphasis
   * the rest of the site's headlines use.
   */
  title: ReactNode;
  /** Sub-headline under the h1, body-lg type. */
  lede: string;
  /** Steps, in document order. The TOC is built from this array. */
  steps: GuideStepData[];
};

export function GuideShell({ eyebrow, title, lede, steps }: GuideShellProps) {
  // Pre-compute the TOC items from `steps` so the same data drives both
  // views of the page. Picks only `{ id, title }` to match the
  // `TableOfContents` props contract.
  const tocItems = steps.map((s) => ({ id: s.id, title: s.title }));

  return (
    <article className="guide-shell">
      <header className="guide-hero">
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="lede">{lede}</p>
      </header>
      <div className="guide-layout">
        <aside className="guide-toc-aside">
          <TableOfContents items={tocItems} />
        </aside>
        <div className="guide-content">
          {steps.map((s) => (
            <GuideStep key={s.id} id={s.id} title={s.title} image={s.image}>
              {s.body}
            </GuideStep>
          ))}
        </div>
      </div>
    </article>
  );
}

export default GuideShell;
