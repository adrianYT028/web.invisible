/**
 * Skip-to-content anchor.
 *
 * Server component — ships zero JS. Rendered as the first focusable element
 * inside `<SiteShell />` so the very first Tab press from the document's
 * initial focus state moves focus to this link (Req 14.4).
 *
 * The link sits visually off-screen until it receives focus, at which point
 * the `.skip-to-content` rule in `globals.css` slides it into view via a
 * `transform: translateY(0)` transition. Activating the link jumps focus
 * to `#main-content` — the `<main>` element rendered by `<SiteShell />`.
 *
 * No props: the target id is fixed (`#main-content`) and the visible label
 * is intentionally constant for screen-reader and translation predictability.
 */
export function SkipToContent() {
  return (
    <a href="#main-content" className="skip-to-content">
      Skip to content
    </a>
  );
}
