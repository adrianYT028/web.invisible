type EnvValue = string | undefined;

function pick(...values: EnvValue[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function required(name: string, value: EnvValue): string {
  if (!value) {
    // During build/prerender, env vars may not be available — return placeholder
    // so static page collection succeeds. At runtime the real values will be present.
    if (typeof window === 'undefined' && process.env.NODE_ENV === 'production') {
      return '';
    }
    throw new Error(
      `Missing env var: ${name}. Add it to .env.local (recommended) or configure it in Vercel Environment Variables.`
    );
  }
  return value;
}

function optional(value: EnvValue): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  return undefined;
}

export const env = {
  // -----------------------------------------------------------------
  // Public — safe to ship to the browser bundle (NEXT_PUBLIC_*).
  // -----------------------------------------------------------------
  get supabaseUrl() {
    return required(
      'NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL)',
      pick(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_URL)
    );
  },
  get supabaseAnonKey() {
    return required(
      'NEXT_PUBLIC_SUPABASE_ANON_KEY (or SUPABASE_ANON_KEY)',
      pick(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, process.env.SUPABASE_ANON_KEY)
    );
  },
  get siteUrl() {
    // Used for server-side fetches and the unviewable:// redirect base.
    return required(
      'NEXT_PUBLIC_SITE_URL',
      pick(process.env.NEXT_PUBLIC_SITE_URL, 'http://localhost:3000')
    );
  },

  // -----------------------------------------------------------------
  // Server-only — NEVER reference these from a 'use client' component.
  // Reading them in client code at build time will fail Next.js's
  // "secret env var leaked to client bundle" check.
  // -----------------------------------------------------------------
  get supabaseServiceRoleKey() {
    return required(
      'SUPABASE_SERVICE_ROLE_KEY',
      pick(process.env.SUPABASE_SERVICE_ROLE_KEY)
    );
  },
  get desktopAccessTokenSecret() {
    return required(
      'DESKTOP_ACCESS_TOKEN_SECRET',
      pick(process.env.DESKTOP_ACCESS_TOKEN_SECRET)
    );
  },
  get groqApiKey() {
    // Optional today (AI proxy is deferred). Will be required once the
    // /api/ai/* routes ship.
    return optional(process.env.GROQ_API_KEY);
  },
  get kvRestApiUrl() {
    // Optional in dev — ratelimit.ts falls back to in-memory when absent.
    return optional(process.env.KV_REST_API_URL);
  },
  get kvRestApiToken() {
    return optional(process.env.KV_REST_API_TOKEN);
  },
};
