import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { env } from '@/lib/env';

// -----------------------------------------------------------------------------
// Service-role Supabase client.
//
// This client bypasses Row-Level Security and can read/write any row. It MUST
// only be used inside Next.js route handlers (Node.js runtime). Importing
// this module from a 'use client' component or Edge runtime will fail because
// SUPABASE_SERVICE_ROLE_KEY is server-only.
//
// We memoize a single instance per process. Vercel cold starts get a fresh
// client; warm invocations reuse it.
// -----------------------------------------------------------------------------

let cached: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  if (cached) return cached;

  // Defense in depth: refuse to construct in non-Node runtimes (Edge, browser).
  if (typeof window !== 'undefined') {
    throw new Error('supabaseAdmin() must not be called from the browser.');
  }

  cached = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  return cached;
}
