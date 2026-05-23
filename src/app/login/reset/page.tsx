import { SiteShell } from '@/components/chrome/SiteShell';

import ResetClient from './ResetClient';

/**
 * `/login/reset` — server component shell for the reset auth surface.
 *
 * Wraps the client island in `<SiteShell hideFooter />` so the header
 * (and theme toggle) appears while the footer stays omitted, matching
 * the bare-chrome treatment used on `/login`. Rendering `<SiteShell />`
 * here — not inside `ResetClient.tsx` — keeps `<Header />`, `<Footer />`,
 * and `<SkipToContent />` as true server components, so the auth view
 * never widens its client-bundle footprint with chrome that does not
 * need to ship JS.
 *
 * No Supabase calls, no form state, and no redirects live in this file;
 * every piece of behaviour belongs to `ResetClient.tsx`. The Supabase
 * `exchangeCodeForSession` and `updateUser` calls are preserved verbatim
 * (Req 17.1–17.8).
 */
export default function ResetPasswordPage() {
  return (
    <SiteShell hideFooter>
      <ResetClient />
    </SiteShell>
  );
}
