/**
 * AuthCard — server component
 *
 * Tokenized visual surface for the login and reset views. Wraps content
 * in `<section class="auth-shell"><div class="auth-card">…</div></section>`
 * so existing class names stay intact (Req 17.1) — only their CSS rule
 * bodies in `globals.css` change to read from the redesign token layer.
 *
 * The container does NOT use `glass-panel` blur (design.md → Auth Cards):
 * the surface is a flat tokenized card with `--surface-raised` background,
 * `--border` border, `--shadow-card` shadow, and `--radius-card` corners.
 *
 * Optional `title` and `sub` render an `<h1>` + `<p>` header above the
 * caller-supplied children. Pages that build their own header (such as
 * the existing `LoginClient` with a logo block and tab strip) can omit
 * both props and render the header elements themselves inside `children`.
 */

import type { ReactNode } from 'react';

export type AuthCardProps = {
  /** Card body — typically the auth form, tabs, and any footer notes. */
  children: ReactNode;
  /** Optional heading rendered as `<h1 class="auth-title">`. */
  title?: string;
  /** Optional sub-heading rendered as `<p class="auth-sub">`. */
  sub?: string;
};

export function AuthCard({ children, title, sub }: AuthCardProps) {
  return (
    <section className="auth-shell">
      <div className="auth-card">
        {title ? <h1 className="auth-title">{title}</h1> : null}
        {sub ? <p className="auth-sub">{sub}</p> : null}
        <div>{children}</div>
      </div>
    </section>
  );
}

export default AuthCard;
