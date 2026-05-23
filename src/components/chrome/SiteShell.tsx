import type { ReactNode } from 'react';

import { Footer } from './Footer';
import { Header } from './Header';
import { SkipToContent } from './SkipToContent';

/**
 * Top-level chrome wrapper rendered around every public route.
 *
 * Server component — ships zero JS itself. The only client-component
 * descendants are the ones that genuinely require runtime behaviour
 * (`<Header />` for the sentinel-based scroll observer + auth state, and
 * the theme toggle + mobile menu mounted inside it). Footer and the skip
 * link are server components and contribute no JS to the client bundle.
 *
 * DOM contract (Req 5.1, 14.4):
 *   1. `<SkipToContent />` is the first focusable element in the document
 *      so the very first Tab press from initial focus state lands on it.
 *   2. `<Header />` is the fixed top chrome.
 *   3. `<main id="main-content">` is the skip-link target. Its very first
 *      child is the 1px `.header-sentinel` element — the `Header`'s
 *      `IntersectionObserver` watches this sentinel to toggle the
 *      `data-scrolled` attribute on the header without ever attaching a
 *      scroll listener (design.md → Header + Mobile Menu → Scroll-blur
 *      Detection). Placing the sentinel inside `<main>` (rather than as a
 *      sibling) means it sits exactly under the fixed header at the top of
 *      page content, so its intersection state corresponds 1:1 with
 *      "have we scrolled past the top of main content?".
 *   4. `<Footer />` follows `<main>` and is omitted only when the caller
 *      passes `hideFooter` — used by routes that intentionally render a
 *      bare layout (e.g. modal-style auth flows, if introduced later).
 *
 * The `id="main-content"` matches the `href="#main-content"` on
 * `<SkipToContent />` so activating the skip link moves focus and viewport
 * to the start of page content.
 */

type SiteShellProps = {
  children: ReactNode;
  hideFooter?: boolean;
};

export function SiteShell({ children, hideFooter = false }: SiteShellProps) {
  return (
    <>
      <SkipToContent />
      <Header />
      <main id="main-content">
        <div className="header-sentinel" aria-hidden="true" />
        {children}
      </main>
      {hideFooter ? null : <Footer />}
    </>
  );
}
