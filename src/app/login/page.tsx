import { Suspense } from 'react';

import { SiteShell } from '@/components/chrome/SiteShell';

import LoginClient from './LoginClient';

/**
 * `/login` — server component shell for the auth surface.
 *
 * Wraps the client island in `<SiteShell hideFooter />` so the header
 * (and theme toggle) appears on the auth page while the footer is
 * intentionally omitted — auth surfaces are deliberately bare-chrome to
 * keep focus on the form. The `Suspense` boundary continues to fence
 * `LoginClient`'s `useSearchParams()` call so Next.js can statically
 * render the wrapper without bailing out at build time.
 *
 * Splitting `<SiteShell />` into this server wrapper keeps `<Header />`,
 * `<Footer />`, and `<SkipToContent />` as true server components in the
 * tree — none of them are pulled across the client boundary by the
 * `'use client'` directive in `LoginClient.tsx`.
 *
 * No Supabase calls, no form state, no redirects live here — every piece
 * of behaviour stays in `LoginClient.tsx` so the migration preserves the
 * existing auth contract verbatim (Req 17.1–17.8, 18.1).
 */
export default function LoginPage() {
  return (
    <SiteShell hideFooter>
      <Suspense fallback={null}>
        <LoginClient />
      </Suspense>
    </SiteShell>
  );
}
