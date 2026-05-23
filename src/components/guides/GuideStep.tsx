import type { ReactNode } from 'react';

import { ScreenshotFrame } from '@/components/guides/ScreenshotFrame';

/**
 * GuideStep — a single numbered step inside a guide route.
 *
 * Server component. Ships zero JS. The optional client island lives one
 * level deeper inside `<ScreenshotFrame />`, which only crosses the
 * server/client boundary because of its runtime `onError` callback.
 *
 * Heading discipline (Req 9.3, 14.5):
 *   The step renders an `<h2>` and only an `<h2>`. There is no nested
 *   `<h3>` before another `<h2>` anywhere in the tree, which keeps the
 *   guide page's heading hierarchy linear: a single `<h1>` (rendered by
 *   `<GuideShell />`) followed by a flat sequence of `<h2>` step
 *   headings. Screen readers can therefore navigate the page with the
 *   "next heading" command without skipping levels.
 *
 * Layout (Req 9.5, 9.6, 16.5):
 *   `<section>` so each step stands as a landmark in the accessibility
 *   tree. Inside, three children sit in document order:
 *     1. `<h2>{title}</h2>` — step heading. Wired to the optional `id`
 *        prop on the section so the table-of-contents can anchor to it.
 *     2. `<ScreenshotFrame …/>` — token-bordered screenshot, rendered
 *        only when the caller supplies an `image` prop. Some steps
 *        (e.g. a final summary) have no screenshot; the prop is
 *        optional so those don't render an empty frame.
 *     3. `<div class="guide-step-body">` — the body copy slot. Receives
 *        any ReactNode so callers can pass `<p>` paragraphs, lists,
 *        callouts, code samples, etc. The body container itself styles
 *        the inner content via descendant selectors in `globals.css`.
 *
 * Anchoring for the table of contents (Req 9.4):
 *   The optional `id` prop is forwarded to the outer `<section>` so the
 *   forthcoming `<TableOfContents />` (task 6.6) can build links to
 *   `#step-id`. The id is intentionally placed on the section, not on
 *   the heading — anchoring the section itself means the browser's
 *   smooth-scroll target lands above the heading, not flush against it,
 *   which reads better when the fixed header takes up the top 64px.
 */
export type GuideStepProps = {
  /** Optional anchor id consumed by `<TableOfContents />`. */
  id?: string;
  /** Step heading. Rendered as `<h2>`. */
  title: string;
  /**
   * Optional screenshot for the step. When omitted, no frame renders —
   * the step displays as title + body only. When supplied, the four
   * fields map 1:1 onto `<ScreenshotFrame />`'s contract.
   */
  image?: {
    src: string;
    alt: string;
    width: number;
    height: number;
  };
  /** Body copy. Any ReactNode (paragraphs, lists, callouts). */
  children: ReactNode;
};

export function GuideStep({ id, title, image, children }: GuideStepProps) {
  return (
    <section id={id} className="guide-step">
      <h2>{title}</h2>
      {image ? <ScreenshotFrame {...image} /> : null}
      <div className="guide-step-body">{children}</div>
    </section>
  );
}

export default GuideStep;
