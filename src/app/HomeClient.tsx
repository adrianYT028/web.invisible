'use client';

/**
 * HomeClient — auth-gated review form island for `/` (Req 13.7, 17.6).
 *
 * Lives at `src/app/HomeClient.tsx` (alongside the route's `page.tsx`)
 * because its sole responsibility is composing the home page's
 * authentication-gated review form. It is intentionally NOT under
 * `src/components/` — the file is route-specific home-page wiring, not
 * a reusable surface.
 *
 * Why a separate client island?
 *
 *   - `src/app/page.tsx` is a server component (Req 13.2). Server
 *     components cannot run Supabase's browser client or `useEffect`,
 *     so the auth check must live in a client child.
 *
 *   - The `<ReviewForm />` chunk should never ship to unauthenticated
 *     visitors (Req 13.7). We import it through `next/dynamic` with
 *     `{ ssr: false }`, and we only render the dynamic component once
 *     we have confirmed the visitor's session. Until then, this island
 *     returns `null`, so the rest of `/` is fully visible without any
 *     reserved placeholder, and the form's JavaScript bundle is never
 *     requested by anonymous traffic.
 *
 * Behavior contract:
 *
 *   1. On mount, call `supabase.auth.getUser()` exactly once. If the
 *      visitor is signed in, set `userEmail` (falling back to the empty
 *      string when the provider didn't supply one — same behavior as
 *      the legacy implementation in the old `page.tsx`) and fire a
 *      single `POST /api/signups/ensure` request (fire-and-forget). If
 *      they are not signed in, leave `userEmail` as `null` so this
 *      island stays hidden — no error UI, no toast, nothing visible.
 *
 *   2. The effect is cancellable. If the component unmounts before the
 *      `getUser()` promise resolves, we drop the result instead of
 *      attempting `setUserEmail` on an unmounted component.
 *
 *   3. The `/api/signups/ensure` POST is intentionally NOT awaited and
 *      its result is discarded. The original implementation in the
 *      legacy `page.tsx` did the same thing — the row is upserted on
 *      the server, and any failure is logged server-side, not surfaced
 *      to the visitor.
 *
 *   4. When `userEmail` is a string (including `''`), render the
 *      `.reviews-island` section (eyebrow + h2 + lede + form). The
 *      form itself is the lazy chunk; the section chrome around it is
 *      light enough to live in this client component without bloating
 *      the unauthed-visitor bundle, because every render path through
 *      `null` short-circuits before touching the dynamic import.
 */

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';

import { createSupabaseBrowserClient } from '@/lib/supabase/browser';

// `next/dynamic` with `{ ssr: false }` splits the form into its own
// chunk and skips rendering it during the initial server pass. The
// chunk is only requested when this component actually evaluates the
// `<ReviewForm …/>` JSX below — which only happens after the auth
// check resolves with a signed-in user — so anonymous visitors never
// download the form code. (Req 13.7)
const ReviewForm = dynamic(
  () => import('@/components/forms/ReviewForm').then((m) => m.ReviewForm),
  { ssr: false },
);

export function HomeClient() {
  // Memoize the client so React's strict-mode double-invoke in dev
  // does not create two Supabase clients per mount cycle. The browser
  // client is cheap, but reusing the same instance also keeps any
  // cached auth state coherent inside the component tree.
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  // `null` collapses both "not yet known" and "no signed-in user" into
  // a single render path that returns `null`. We don't need to
  // distinguish them at the UI layer because the desired output is
  // identical.
  const [userEmail, setUserEmail] = useState<string | null>(null);

  useEffect(() => {
    // Cancellation flag: if the component unmounts before `getUser()`
    // settles, we throw away the result rather than calling state
    // setters on an unmounted component.
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase.auth.getUser();
      if (cancelled) return;

      // Anonymous visitor: leave `userEmail` as `null`. The home page
      // is a public marketing surface, so an unauthenticated session
      // is expected and not an error condition we need to surface.
      if (error || !data?.user) return;

      // `data.user.email || ''` mirrors the legacy `page.tsx` exactly:
      // a signed-in visitor without an email on the provider record
      // still gets the form (read-only email field renders empty), and
      // we never block rendering on a missing email string.
      setUserEmail(data.user.email || '');

      // Fire-and-forget: the legacy `page.tsx` did exactly this — POST
      // to `/api/signups/ensure` on successful auth so the `signups`
      // row is upserted server-side. The catch swallows network errors
      // because the result is not used by the UI; the route itself
      // logs server-side warnings on failure.
      fetch('/api/signups/ensure', { method: 'POST' }).catch(() => {});
    })();

    return () => {
      cancelled = true;
    };
  }, [supabase]);

  if (userEmail === null) {
    // Unauthenticated (or auth check still in flight). Render nothing
    // — the rest of `/` is fully composed by `page.tsx` and is visible
    // without this island.
    return null;
  }

  return (
    <section className="reviews-island" id="reviews">
      <div className="reviews-island-section">
        <p className="eyebrow">Feedback</p>
        <h2>Tell us how it feels</h2>
        <p className="lede">
          Share your experience so we can harden the product. Your email
          stays private and is only used to follow up if there is an
          issue.
        </p>
        <ReviewForm userEmail={userEmail} />
      </div>
    </section>
  );
}

export default HomeClient;
