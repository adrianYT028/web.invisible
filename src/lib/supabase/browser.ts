import { createBrowserClient } from '@supabase/ssr';

import { env } from '@/lib/env';

export function createSupabaseBrowserClient() {
  // In the browser, @supabase/ssr uses document.cookie automatically.
  return createBrowserClient(env.supabaseUrl, env.supabaseAnonKey);
}
