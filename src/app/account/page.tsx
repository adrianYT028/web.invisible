import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { SiteShell } from '@/components/chrome/SiteShell';
import { createSupabaseRouteClient } from '@/lib/supabase/route';
import { supabaseAdmin } from '@/lib/supabase/admin';

import { ApiKeyManager } from './ApiKeyManager';
import { LogoutButton } from './LogoutButton';
import { SignOutAllButton } from './SignOutAllButton';

/**
 * `/account` — authenticated user landing page.
 *
 * Server component: it reads the Supabase session via cookies on every
 * request, so Next.js will mark the route as `force-dynamic` automatically
 * (cookies access opts the route out of static generation). We also
 * re-export `dynamic = 'force-dynamic'` for explicitness so future
 * refactors that touch this file cannot accidentally tip the route into
 * static rendering and cache a stale session view.
 *
 * Redirect contract (Req 17.7):
 *   When `supabase.auth.getUser()` resolves with no user, we call
 *   `redirect('/login?redirectedFrom=%2Faccount')`. The `%2F` URL-encoding
 *   for the leading slash matches the existing pre-redesign contract — the
 *   middleware in `src/proxy.ts` produces the same URL when it intercepts
 *   an unauthed visit, and `LoginClient.tsx` parses it back via
 *   `searchParams.get('redirectedFrom')` to bounce the user home after a
 *   successful login.
 *
 * Indexing (Req 18.2):
 *   Account pages should never appear in search results, so the metadata
 *   exports `robots: { index: false }`. The canonical alternate is still
 *   set to `/account` for cleanliness even though the page is
 *   non-indexable. The title `"Account"` flows through the
 *   `%s | Unviewable` template defined in `app/layout.tsx`, producing the
 *   final tab title `"Account | Unviewable"` — consistent with the rest of
 *   the marketing surface.
 *
 * Validates: 17.7, 18.2.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Account',
  alternates: { canonical: '/account' },
  robots: { index: false },
};

export default async function AccountPage() {
  const supabase = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // Pre-redesign redirect contract — `%2F` is the URL-encoded leading
    // slash for `/account` so `LoginClient` reads back the original path
    // unchanged via `searchParams.get('redirectedFrom')`.
    redirect('/login?redirectedFrom=%2Faccount');
  }

  // Fetch the user's Groq key status server-side, mirroring the GET /api/keys
  // logic: select ONLY `last_four` (never ciphertext/nonce/tag) via the
  // service-role client, scoped explicitly to this user (Req 2.1, 2.3).
  const admin = supabaseAdmin();
  const { data: keyRow } = await admin
    .from('user_api_keys')
    .select('last_four')
    .eq('user_id', user.id)
    .maybeSingle();
  const lastFour = keyRow?.last_four ?? null;
  const hasKey = lastFour !== null;

  return (
    <SiteShell>
      <section className="account-section">
        <div className="account-inner">
          <p className="eyebrow">Account</p>
          <h1>
            Your <em>account</em>
          </h1>
          <p className="lede">
            Signed in as <strong>{user.email ?? 'unknown'}</strong>.
          </p>
          <div className="account-actions">
            <LogoutButton />
          </div>
          <div className="account-block">
            <p className="eyebrow">AI key</p>
            <p className="lede">
              Add your own Groq key to enable AI features. Your key is
              encrypted and stored securely — we only ever show the last four
              characters.
            </p>
            <ApiKeyManager hasKey={hasKey} lastFour={lastFour} />
          </div>
          <div className="account-block">
            <p className="eyebrow">Desktop sessions</p>
            <p className="lede">
              Sign out from every device that has installed the Unviewable
              desktop app. This does not sign you out of this browser session.
            </p>
            <SignOutAllButton />
          </div>
        </div>
      </section>
    </SiteShell>
  );
}
