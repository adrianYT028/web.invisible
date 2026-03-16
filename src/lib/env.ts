type EnvValue = string | undefined;

function pick(...values: EnvValue[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function required(name: string, value: EnvValue): string {
  if (!value) {
    throw new Error(
      `Missing env var: ${name}. Add it to .env.local (recommended) or configure it in Vercel Environment Variables.`
    );
  }
  return value;
}

export const env = {
  supabaseUrl: required(
    'NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL)',
    pick(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_URL)
  ),
  supabaseAnonKey: required(
    'NEXT_PUBLIC_SUPABASE_ANON_KEY (or SUPABASE_ANON_KEY)',
    pick(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, process.env.SUPABASE_ANON_KEY)
  ),
};
