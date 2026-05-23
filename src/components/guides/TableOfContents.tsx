'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * TableOfContents — sticky in-page TOC for guide routes.
 *
 * Why this is a client component:
 *   The active-step indicator depends on which `<h2>` step heading is
 *   currently in view, which can only be computed at runtime in the
 *   browser. We use a single `IntersectionObserver` to track that, plus
 *   one piece of local state (`activeId`) to drive the visible
 *   highlight. No scroll listener — the observer batches all heading
 *   intersections internally, so the cost on every scroll tick is the
 *   browser's native compositor work, not user JS.
 *
 * Item shape (Req 9.4):
 *   The caller (`<GuideShell />`) pre-computes `items` from the same
 *   `steps` array it passes to `<GuideStep />`. We do NOT query the DOM
 *   for headings ourselves — that would force a render → DOM-read →
 *   render cycle and risk drift between the rendered TOC and the
 *   actual headings. Sharing the source data keeps the two views of
 *   the page in lockstep.
 *
 * Active-step tracking:
 *   The observer watches every `#${id}` element produced by
 *   `<GuideStep />` (the `id` lives on the outer `<section>`, not the
 *   `<h2>`, so the smooth-scroll target lands above the heading rather
 *   than flush against it under the fixed header). Each callback batch
 *   updates a Set of currently-intersecting ids; we then pick the
 *   first id from `items` (document order) that's still in the Set
 *   and mark it active. This produces a deterministic active step even
 *   when several sections overlap the trigger band.
 *
 *   `rootMargin: '-64px 0px -75% 0px'` shrinks the observation root so
 *   only sections whose top edge has crossed below the fixed header
 *   (`--nav-height` = 64px) but is still in the upper quarter of the
 *   viewport count as active. That trigger band is small enough that
 *   only one or two steps overlap at any scroll position, and the
 *   document-order tiebreaker resolves the rest.
 *
 * Visibility (Req 9.4):
 *   Rendered as `<nav class="guide-toc">` and surfaced inside an
 *   `<aside class="guide-toc-aside">` by `<GuideShell />`. The aside is
 *   `display: none` below 1280px and `display: block; position: sticky`
 *   at and above 1280px, with the sticky offset accounting for the
 *   fixed header height. The component itself ships zero conditional
 *   rendering for viewport width — CSS handles it so the JS cost is
 *   identical at every breakpoint.
 *
 * Accessibility (Req 14.5, 14.9):
 *   `<nav aria-label="On this page">` gives screen readers a concise
 *   landmark name. Each link carries `aria-current="true"` when active
 *   so assistive tech announces the user's current position in the
 *   guide. `aria-current` is omitted (rather than set to `'false'`)
 *   when the link is not active — that's the WAI-ARIA-recommended
 *   shape for `aria-current`.
 *
 *   Each `<a>` is a real anchor, so native browser features (right-
 *   click "open in new tab", keyboard activation via Enter, copy
 *   link) all work without any extra wiring.
 */
export type TocItem = {
  /** Anchor id matching the corresponding `<GuideStep />` section. */
  id: string;
  /** Title text shown in the TOC link — typically the step's `<h2>`. */
  title: string;
};

export type TableOfContentsProps = {
  items: TocItem[];
};

export function TableOfContents({ items }: TableOfContentsProps) {
  // Initial active id is the first item, so the TOC reads as
  // "you are at the top" before the first scroll event arrives. If
  // `items` is empty we fall back to `null` so the rendered tree
  // contains no `aria-current` markers at all.
  const [activeId, setActiveId] = useState<string | null>(
    items[0]?.id ?? null
  );

  // Set of section ids currently intersecting the trigger band. Held in
  // a ref so the observer callback can read/write it across multiple
  // entries in the same batch without forcing a re-render between each
  // entry — we re-render once per batch, after the Set has settled.
  const visibleIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (items.length === 0) return;

    // Reset the visible set whenever `items` changes (e.g. route
    // navigation re-mounting the same component with a different
    // guide). Without this reset, stale ids from a previous guide
    // would linger and confuse the document-order tiebreaker below.
    visibleIds.current = new Set();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            visibleIds.current.add(entry.target.id);
          } else {
            visibleIds.current.delete(entry.target.id);
          }
        }
        // Pick the first item in document order that's currently in
        // the trigger band. `items` is the document-order array, so
        // `find` here implicitly resolves overlaps by selecting the
        // topmost active section.
        const next = items.find((item) => visibleIds.current.has(item.id));
        if (next) {
          setActiveId(next.id);
        }
      },
      {
        // Trigger band: top edge sits 64px below viewport top (matching
        // `--nav-height`), bottom edge sits 75% down the viewport. Any
        // section heading whose box overlaps this thin band counts as
        // "active". The narrow band keeps the active highlight crisp
        // — usually only one section overlaps at any moment.
        rootMargin: '-64px 0px -75% 0px',
        threshold: 0,
      },
    );

    // Observe every section the TOC links to. We tolerate missing
    // elements silently — a step whose `id` does not resolve simply
    // never becomes active, which is preferable to throwing during
    // render.
    for (const item of items) {
      const el = document.getElementById(item.id);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, [items]);

  // Empty input → render nothing. Avoids an empty `<nav>` landmark
  // which would otherwise pollute the screen-reader landmark list.
  if (items.length === 0) return null;

  return (
    <nav aria-label="On this page" className="guide-toc">
      <p className="guide-toc-label">On this page</p>
      <ol>
        {items.map((item) => {
          const isActive = activeId === item.id;
          return (
            <li key={item.id}>
              <a
                href={`#${item.id}`}
                aria-current={isActive ? 'true' : undefined}
              >
                {item.title}
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export default TableOfContents;
